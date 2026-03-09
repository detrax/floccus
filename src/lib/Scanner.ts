import * as Parallel from 'async-parallel'
import Diff, { ActionType, CreateAction, MoveAction, RemoveAction, ReorderAction, UpdateAction } from './Diff'
import { Bookmark, Folder, ItemLocation, ItemType, TItem, TItemLocation, TItemType } from './Tree'
import Logger from './Logger'
import { IHashSettings } from './interfaces/Resource'
import { yieldToEventLoop } from './yieldToEventLoop'

export interface ScanResult<L1 extends TItemLocation, L2 extends TItemLocation> {
  CREATE: Diff<L1, L2, CreateAction<L1, L2>>
  UPDATE: Diff<L1, L2, UpdateAction<L1, L2>>
  MOVE: Diff<L1, L2, MoveAction<L1, L2>>
  REMOVE: Diff<L2, L1, RemoveAction<L2, L1>>
  REORDER: Diff<L1, L2, ReorderAction<L1, L2>>
}

export default class Scanner<L1 extends TItemLocation, L2 extends TItemLocation> {
  private oldTree: TItem<L1>
  private newTree: TItem<L2>
  private mergeable: (i1: TItem<TItemLocation>, i2: TItem<TItemLocation>) => boolean
  private hashSettings: IHashSettings
  private checkHashes: boolean
  private hasCache: boolean

  private result: ScanResult<L2, L1>

  constructor(oldTree:TItem<L1>, newTree:TItem<L2>, mergeable:(i1:TItem<TItemLocation>, i2:TItem<TItemLocation>)=>boolean, hashSettings: IHashSettings, checkHashes = true, hasCache = true) {
    this.oldTree = oldTree
    this.newTree = newTree
    this.mergeable = mergeable
    this.hashSettings = hashSettings
    this.checkHashes = typeof checkHashes === 'undefined' ? true : checkHashes
    this.hasCache = hasCache
    this.result = {
      CREATE: new Diff(),
      UPDATE: new Diff(),
      MOVE: new Diff(),
      REMOVE: new Diff(),
      REORDER: new Diff(),
    }
  }

  getDiffs(): ScanResult<L2, L1> {
    return this.result
  }

  async run():Promise<ScanResult<L2, L1>> {
    await this.diffItem(this.oldTree, this.newTree)
    await this.findMoves()
    await this.addReorders()
    return this.result
  }

  async diffItem(oldItem:TItem<L1>, newItem:TItem<L2>):Promise<void> {
    if (oldItem.type === 'folder' && newItem.type === 'folder') {
      return this.diffFolder(oldItem, newItem)
    } else if (oldItem.type === 'bookmark' && newItem.type === 'bookmark') {
      return this.diffBookmark(oldItem, newItem)
    } else {
      throw new Error('Mismatched diff items: ' + oldItem.type + ', ' + newItem.type)
    }
  }

  async diffFolder(oldFolder:Folder<L1>, newFolder:Folder<L2>):Promise<void> {
    // give the browser time to breathe
    await yieldToEventLoop()
    if (this.checkHashes) {
      const hasChanged = await this.folderHasChanged(oldFolder, newFolder)
      if (!hasChanged) {
        return
      }
    }

    if (oldFolder.title !== newFolder.title && typeof oldFolder.parentId !== 'undefined' && typeof newFolder.parentId !== 'undefined') {
      // folder title changed and it's not the root folder
      this.result.UPDATE.commit({type: ActionType.UPDATE, payload: newFolder, oldItem: oldFolder})
    }

    // Generate REORDERS before diffing anything to make sure REORDERS are from top to bottom (necessary for tab sync)
    if (newFolder.children.length > 1) {
      let needReorder = false
      for (let i = 0; i < Math.max(newFolder.children.length, oldFolder.children.length); i++) {
        if (!oldFolder.children[i] || !newFolder.children[i] || !this.mergeable(oldFolder.children[i], newFolder.children[i])) {
          needReorder = true
          break
        }
      }
      if (needReorder) {
        this.result.REORDER.commit({
          type: ActionType.REORDER,
          payload: newFolder,
          order: newFolder.children.map(i => ({ type: i.type, id: i.id })),
        })
      }
    }

    // Preserved Items and removed Items
    // (using map here, because 'each' doesn't provide indices)
    const unmatchedChildren = newFolder.children.slice(0)
    await Parallel.map(oldFolder.children, async(old, index) => {
      const newItem = unmatchedChildren.find((child) => old.type === child.type && this.mergeable(old, child))
      // we found an item in the new folder that matches the one in the old folder
      if (newItem) {
        await this.diffItem(old, newItem)
        unmatchedChildren.splice(unmatchedChildren.indexOf(newItem), 1)
        return
      }

      if (newFolder.isRoot && newFolder.location === ItemLocation.LOCAL) {
        // We can't remove root folders locally
        return
      }

      this.result.REMOVE.commit({type: ActionType.REMOVE, payload: old, index})
    }, 1)

    // created Items
    // (using map here, because 'each' doesn't provide indices)
    await Parallel.map(unmatchedChildren, async(newChild) => {
      if (oldFolder.isRoot && oldFolder.location === ItemLocation.LOCAL) {
        // We can't create root folders locally
        return
      }
      this.result.CREATE.commit({type: ActionType.CREATE, payload: newChild, index: newFolder.children.findIndex(child => child === newChild)})
    }, 1)
  }

  async diffBookmark(oldBookmark:Bookmark<L1>, newBookmark:Bookmark<L2>):Promise<void> {
    let hasChanged
    if (this.checkHashes) {
      hasChanged = await this.bookmarkHasChanged(oldBookmark, newBookmark)
    } else {
      hasChanged = oldBookmark.title !== newBookmark.title || oldBookmark.url !== newBookmark.url
    }
    if (hasChanged) {
      this.result.UPDATE.commit({ type: ActionType.UPDATE, payload: newBookmark, oldItem: oldBookmark })
    }
  }

  async bookmarkHasChanged(oldBookmark:Bookmark<L1>, newBookmark:Bookmark<L2>):Promise<boolean> {
    const oldHash = await oldBookmark.hash(this.hashSettings)
    const newHash = await newBookmark.hash(this.hashSettings)
    return oldHash !== newHash
  }

  async folderHasChanged(oldFolder:Folder<L1>, newFolder:Folder<L2>):Promise<boolean> {
    const oldHash = await oldFolder.hash(this.hashSettings)
    const newHash = await newFolder.hash(this.hashSettings)
    return oldHash !== newHash
  }

  /**
   * Build a merge key for an item used to find direct move matches in O(1).
   * For bookmarks: type + url (title may change during a move).
   * For folders: type + title (folders have no url).
   */
  private mergeKey(item: TItem<TItemLocation>): string {
    if (item.type === 'bookmark' && 'url' in item) {
      return `bookmark\0${(item as Bookmark<TItemLocation>).url}`
    }
    return `folder\0${item.title}`
  }

  async findMoves():Promise<void> {
    Logger.log('Scanner: Finding moves')
    let reconciled = true

    // Phase 1: Hash-based direct matching — O(n) instead of O(n²)
    // Build a lookup map from merge keys to remove actions
    const removeMap = new Map<string, RemoveAction<L1, L2>[]>()
    for (const removeAction of this.result.REMOVE.getActions()) {
      const key = this.mergeKey(removeAction.payload)
      if (!removeMap.has(key)) {
        removeMap.set(key, [])
      }
      removeMap.get(key).push(removeAction)
    }

    // Match each create action against the map in O(1) per lookup
    const createActions = this.result.CREATE.getActions()
    for (const createAction of createActions) {
      await yieldToEventLoop()
      const createdItem = createAction.payload
      const key = this.mergeKey(createdItem)
      const candidates = removeMap.get(key)
      if (!candidates || candidates.length === 0) {
        continue
      }

      // Find best candidate: for folders without cache, check mergeable AND children similarity
      let bestRemoveAction: RemoveAction<L1, L2> | null = null
      if (createdItem.type === 'folder' && !this.hasCache) {
        let bestSimilarity = 0
        for (const removeAction of candidates) {
          if (!this.mergeable(removeAction.payload, createdItem)) continue
          const similarity = removeAction.payload.childrenSimilarity(createdItem)
          if (similarity > 0.8 && similarity > bestSimilarity) {
            bestSimilarity = similarity
            bestRemoveAction = removeAction
          }
        }
      } else {
        // For bookmarks or when we have a cache, first match wins
        bestRemoveAction = candidates.find(ra => this.mergeable(ra.payload, createdItem)) || null
      }

      if (bestRemoveAction) {
        this.result.CREATE.retract(createAction)
        this.result.REMOVE.retract(bestRemoveAction)
        // Remove from map to avoid reuse
        const idx = candidates.indexOf(bestRemoveAction)
        candidates.splice(idx, 1)
        this.result.MOVE.commit({
          type: ActionType.MOVE,
          payload: createdItem,
          oldItem: bestRemoveAction.payload,
          index: createAction.index,
          oldIndex: bestRemoveAction.index,
        })
        await this.diffItem(bestRemoveAction.payload, createdItem)
      }
    }

    // Phase 2: Descendant matches for remaining unmatched items
    // This handles cases where an item was moved AND its parent was removed
    reconciled = true
    while (reconciled) {
      reconciled = false
      const remainingCreates = this.result.CREATE.getActions()
      const remainingRemoves = this.result.REMOVE.getActions()

      // Build index of all items inside remaining removes for O(1) lookup
      const descendantIndex = new Map<string, { removeAction: RemoveAction<L1, L2>, item: TItem<L1> }>()
      for (const removeAction of remainingRemoves) {
        const removedItem = removeAction.payload
        if (removedItem.type !== 'folder') continue
        if (!removedItem.index) removedItem.createIndex()
        // Index all descendants
        for (const type of [ItemType.BOOKMARK, ItemType.FOLDER] as TItemType[]) {
          if (!removedItem.index[type]) continue
          for (const item of Object.values(removedItem.index[type]) as TItem<L1>[]) {
            const itemKey = this.mergeKey(item)
            if (!descendantIndex.has(itemKey)) {
              descendantIndex.set(itemKey, { removeAction, item })
            }
          }
        }
      }

      for (const createAction of remainingCreates) {
        if (reconciled) break
        await yieldToEventLoop()
        const createdItem = createAction.payload
        const key = this.mergeKey(createdItem)
        const match = descendantIndex.get(key)

        if (match && this.mergeable(match.item, createdItem)) {
          const { removeAction, item: oldItem } = match
          let oldIndex
          this.result.CREATE.retract(createAction)
          if (oldItem === removeAction.payload) {
            this.result.REMOVE.retract(removeAction)
          } else {
            const removedItemClone = removeAction.payload.copy(true)
            const oldParentClone = removedItemClone.findItem(ItemType.FOLDER, oldItem.parentId) as Folder<L1>
            const oldItemClone = removedItemClone.findItem(oldItem.type, oldItem.id)
            oldIndex = oldParentClone.children.indexOf(oldItemClone)
            oldParentClone.children.splice(oldIndex, 1)
            removeAction.payload = removedItemClone
            removeAction.payload.createIndex()
          }
          this.result.MOVE.commit({
            type: ActionType.MOVE,
            payload: createdItem,
            oldItem,
            index: createAction.index,
            oldIndex: oldIndex || removeAction.index
          })
          reconciled = true
          if (oldItem.type === ItemType.FOLDER) {
            await this.diffItem(oldItem, createdItem)
          }
        }
      }

      // Reverse direction: look for removed items inside created subtrees
      if (!reconciled) {
        const remainingCreates2 = this.result.CREATE.getActions()
        const remainingRemoves2 = this.result.REMOVE.getActions()

        const createDescendantIndex = new Map<string, { createAction: CreateAction<L2, L1>, item: TItem<L2> }>()
        for (const createAction of remainingCreates2) {
          const createdItem = createAction.payload
          if (createdItem.type !== 'folder') continue
          if (!createdItem.index) createdItem.createIndex()
          for (const type of [ItemType.BOOKMARK, ItemType.FOLDER] as TItemType[]) {
            if (!createdItem.index[type]) continue
            for (const item of Object.values(createdItem.index[type]) as TItem<L2>[]) {
              const itemKey = this.mergeKey(item)
              if (!createDescendantIndex.has(itemKey)) {
                createDescendantIndex.set(itemKey, { createAction, item })
              }
            }
          }
        }

        for (const removeAction of remainingRemoves2) {
          if (reconciled) break
          await yieldToEventLoop()
          const removedItem = removeAction.payload
          const key = this.mergeKey(removedItem)
          const match = createDescendantIndex.get(key)

          if (match && this.mergeable(removedItem, match.item)) {
            const { createAction, item: newItem } = match
            let index
            this.result.REMOVE.retract(removeAction)
            if (newItem === createAction.payload) {
              this.result.CREATE.retract(createAction)
            } else {
              const createdItemClone = createAction.payload.copy(true)
              const newParentClone = createdItemClone.findItem(ItemType.FOLDER, newItem.parentId) as Folder<L2>
              const newClonedItem = createdItemClone.findItem(newItem.type, newItem.id)
              index = newParentClone.children.indexOf(newClonedItem)
              newParentClone.children.splice(index, 1)
              createAction.payload = createdItemClone
              createAction.payload.createIndex()
            }
            this.result.MOVE.commit({
              type: ActionType.MOVE,
              payload: newItem,
              oldItem: removedItem,
              index: index || createAction.index,
              oldIndex: removeAction.index
            })
            reconciled = true
            if (removedItem.type === ItemType.FOLDER) {
              await this.diffItem(removedItem, newItem)
            }
          }
        }
      }
    }

    // Remove all UPDATEs that have already been handled by a MOVE
    const moveSet = new Set(this.result.MOVE.getActions().map(move => String(move.payload.id)))
    const updates = this.result.UPDATE.getActions()
    updates.forEach(update => {
      if (moveSet.has(String(update.payload.id))) {
        this.result.UPDATE.retract(update)
      }
    })
  }

  async addReorders(): Promise<void> {
    Logger.log('Scanner: Generate reorders')
    const targets = {}
    const sources = {}

    // Collect folders to reorder

    this.result.CREATE.getActions()
      .forEach(action => {
        targets[action.payload.parentId] = true
      })
    // Give the browser time to breathe
    await yieldToEventLoop()
    this.result.REMOVE.getActions()
      .forEach(action => {
        sources[action.payload.parentId] = true
      })
    // Give the browser time to breathe
    await yieldToEventLoop()
    this.result.MOVE.getActions()
      .forEach(action => {
        targets[action.payload.parentId] = true
        sources[action.oldItem.parentId] = true
      })

    for (const folderId in sources) {
      // Give the browser time to breathe
      await yieldToEventLoop()
      const oldFolder = this.oldTree.findItem(ItemType.FOLDER, folderId) as Folder<L1>
      if (!oldFolder) {
        // In case a MOVE's old parent was removed
        continue
      }
      const newFolder = this.newTree.findItemFilter(ItemType.FOLDER, (item) => this.mergeable(oldFolder, item)) as Folder<L2>
      if (newFolder) {
        targets[newFolder.id] = true
      }
    }

    for (const folderId in targets) {
      // Give the browser time to breathe
      await yieldToEventLoop()
      const newFolder = this.newTree.findItem(ItemType.FOLDER, folderId) as Folder<L2>
      const duplicate = this.result.REORDER.getActions().find(a => String(a.payload.id) === String(newFolder.id))
      if (duplicate) {
        this.result.REORDER.retract(duplicate)
      }
      if (newFolder.children.length > 10000) {
        continue
      }
      this.result.REORDER.commit({
        type: ActionType.REORDER,
        payload: newFolder,
        order: newFolder.children.map(i => ({ type: i.type, id: i.id })),
      })
    }
  }
}
