// Platform independent part of the data store: keeps all metadata (the `Db`) in memory, saves it
// with a short delay, deletes dependent records, and searches notes and extracted text.
// Subclasses only decide *where* things are persisted (files on disk, IndexedDB …).
import { createDefaultDb, newId, normalizeDb } from '../shared/defaults'
import {
  COLLECTIONS,
  type Annotations,
  type CollectionName,
  type Db,
  type DbPatch,
  type FileInput,
  type FileTarget,
  type Item,
  type NoteDoc,
  type RecordOf,
  type SearchHit,
} from '../shared/types'
import type { DataStore } from './data-store'
import { assertFileName, assertId, detectFile, titleFromFileName } from './files'

const SAVE_DELAY_MS = 250
const MAX_SEARCH_HITS = 50
const PATCH_KEYS: (keyof DbPatch)[] = [
  'onboarded',
  'activeSemesterId',
  'profile',
  'settings',
  'moodleDiscussions',
]

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isValidPatchValue(key: keyof DbPatch, value: unknown): boolean {
  switch (key) {
    case 'onboarded':
      return typeof value === 'boolean'
    case 'activeSemesterId':
      return value === null || typeof value === 'string'
    case 'moodleDiscussions':
      return Array.isArray(value)
    default:
      return isObject(value)
  }
}

export abstract class RecordStore implements DataStore {
  abstract readonly dir: string
  protected db: Db = createDefaultDb()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private textCache = new Map<string, string>()

  // ---- Persistence, implemented per platform ----

  protected abstract saveDb(db: Db): Promise<void>
  protected abstract loadNote(id: string): Promise<NoteDoc | null>
  protected abstract saveNote(id: string, doc: NoteDoc): Promise<void>
  protected abstract loadAnnotations(id: string): Promise<Annotations | null>
  protected abstract saveAnnotations(id: string, annotations: Annotations): Promise<void>
  protected abstract loadText(id: string): Promise<string | null>
  protected abstract saveText(id: string, text: string): Promise<void>
  protected abstract loadFile(fileName: string): Promise<Uint8Array | null>
  protected abstract saveFile(fileName: string, bytes: Uint8Array): Promise<void>
  /** Stores the content of a new file and returns its size in bytes */
  protected abstract saveFileInput(fileName: string, input: FileInput): Promise<number>
  /** Deletes the note, annotations, text and file that belong to an item */
  protected abstract deleteItemContent(item: Item): Promise<void>
  /** Deletes everything except the database itself */
  protected abstract clearContent(): Promise<void>

  // ---- Database ----

  get(): Db {
    return this.db
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      // Errors are only logged: the next change tries again
      this.flush().catch((error) => console.error('Could not save the database:', error))
    }, SAVE_DELAY_MS)
  }

  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    return this.saveDb(this.db)
  }

  async replaceDb(db: Db): Promise<void> {
    this.db = normalizeDb(db)
    this.textCache.clear()
    await this.flush()
  }

  async reset(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.clearContent()
    this.textCache.clear()
    this.db = createDefaultDb()
    await this.flush()
  }

  // ---- Records ----

  private list<C extends CollectionName>(collection: C): RecordOf<C>[] {
    if (!COLLECTIONS.includes(collection)) throw new Error(`Unbekannte Sammlung: ${collection}`)
    return this.db[collection] as RecordOf<C>[]
  }

  put<C extends CollectionName>(collection: C, record: RecordOf<C>): void {
    if (!record || typeof record !== 'object') throw new Error('Ungültiger Datensatz')
    assertId(record.id)
    const list = this.list(collection)
    const index = list.findIndex((r) => r.id === record.id)
    if (index === -1) list.push(record)
    else list[index] = record
    this.scheduleSave()
  }

  replaceMany<C extends CollectionName>(
    collection: C,
    match: (record: RecordOf<C>) => boolean,
    records: RecordOf<C>[],
  ): void {
    for (const record of records) assertId(record.id)
    const kept = this.list(collection).filter((record) => !match(record))
    ;(this.db[collection] as RecordOf<C>[]) = [...kept, ...records]
    this.scheduleSave()
  }

  update(patch: DbPatch): void {
    if (!isObject(patch)) throw new Error('Ungültige Änderung')
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCH_KEYS.includes(key as keyof DbPatch)) throw new Error(`Feld nicht erlaubt: ${key}`)
      if (!isValidPatchValue(key as keyof DbPatch, value)) {
        throw new Error(`Ungültiger Wert für ${key}`)
      }
    }
    Object.assign(this.db, patch)
    this.scheduleSave()
  }

  private drop<C extends CollectionName>(collection: C, keep: (record: RecordOf<C>) => boolean) {
    ;(this.db[collection] as RecordOf<C>[]) = (this.db[collection] as RecordOf<C>[]).filter(keep)
  }

  /** A folder together with all of its subfolders */
  private folderTree(rootId: string): Set<string> {
    const ids = new Set([rootId])
    let grew = true
    while (grew) {
      grew = false
      for (const folder of this.db.folders) {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id)
          grew = true
        }
      }
    }
    return ids
  }

  async remove(collection: CollectionName, id: string): Promise<void> {
    assertId(id)
    const db = this.db
    const itemIds: string[] = []

    if (collection === 'semesters') {
      for (const module of db.modules.filter((m) => m.semesterId === id)) {
        await this.remove('modules', module.id)
      }
      if (db.activeSemesterId === id) db.activeSemesterId = null
    }
    if (collection === 'modules') {
      itemIds.push(...db.items.filter((i) => i.moduleId === id).map((i) => i.id))
      this.drop('folders', (f) => f.moduleId !== id)
      this.drop('events', (e) => e.moduleId !== id)
      this.drop('tasks', (t) => t.moduleId !== id)
      this.drop('chats', (c) => c.moduleId !== id)
    }
    if (collection === 'folders') {
      const folderIds = this.folderTree(id)
      itemIds.push(
        ...db.items.filter((i) => i.folderId && folderIds.has(i.folderId)).map((i) => i.id),
      )
      this.drop('folders', (f) => !folderIds.has(f.id))
    }
    if (collection === 'items') {
      itemIds.push(id, ...db.items.filter((i) => i.attachedTo === id).map((i) => i.id))
    }
    if (collection === 'subscriptions') {
      this.drop('events', (e) => e.subscriptionId !== id)
    }

    for (const item of this.db.items.filter((i) => itemIds.includes(i.id))) {
      this.textCache.delete(item.id)
      await this.deleteItemContent(item)
    }
    this.drop('items', (i) => !itemIds.includes(i.id))
    this.drop(collection, (r) => r.id !== id)
    this.scheduleSave()
  }

  private touchItem(id: string): void {
    const item = this.db.items.find((i) => i.id === id)
    if (!item) return
    item.updatedAt = new Date().toISOString()
    this.scheduleSave()
  }

  // ---- Notes, annotations, extracted text ----

  async readNote(id: string): Promise<NoteDoc | null> {
    assertId(id)
    return this.loadNote(id)
  }

  async writeNote(id: string, doc: NoteDoc): Promise<void> {
    assertId(id)
    await this.saveNote(id, doc)
    this.textCache.set(id, doc.text ?? '')
    this.touchItem(id)
  }

  async readAnnotations(id: string): Promise<Annotations | null> {
    assertId(id)
    return this.loadAnnotations(id)
  }

  async writeAnnotations(id: string, annotations: Annotations): Promise<void> {
    assertId(id)
    return this.saveAnnotations(id, annotations)
  }

  async readText(id: string): Promise<string | null> {
    assertId(id)
    return this.loadText(id)
  }

  async writeText(id: string, text: string): Promise<void> {
    assertId(id)
    await this.saveText(id, String(text))
    this.textCache.set(id, String(text))
  }

  // ---- Files ----

  async addFile(target: FileTarget, input: FileInput): Promise<Item> {
    assertId(target.moduleId)
    if (target.folderId) assertId(target.folderId)
    const { ext, mime, fileType } = detectFile(input.name)
    const id = newId()
    const fileName = ext ? `${id}.${ext}` : id
    const size = await this.saveFileInput(fileName, input)
    const now = new Date().toISOString()
    const item: Item = {
      id,
      moduleId: target.moduleId,
      folderId: target.folderId,
      kind: 'file',
      title: titleFromFileName(input.name),
      fileType,
      fileName,
      mime: input.type || mime,
      size,
      attachedTo: target.attachedTo ?? null,
      source: null,
      externalId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.put('items', item)
    return item
  }

  async readFile(fileName: string): Promise<Uint8Array | null> {
    assertFileName(fileName)
    return this.loadFile(fileName)
  }

  async writeFile(fileName: string, bytes: Uint8Array): Promise<void> {
    assertFileName(fileName)
    return this.saveFile(fileName, bytes)
  }

  // ---- Search ----

  private async textOf(item: Item): Promise<string> {
    const cached = this.textCache.get(item.id)
    if (cached !== undefined) return cached
    const text =
      item.kind === 'note'
        ? ((await this.readNote(item.id))?.text ?? '')
        : ((await this.readText(item.id)) ?? '')
    this.textCache.set(item.id, text)
    return text
  }

  async search(query: string): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase()
    if (needle.length < 2) return []
    const hits: SearchHit[] = []
    for (const item of this.db.items) {
      if (item.attachedTo) continue
      const text = await this.textOf(item)
      const index = text.toLowerCase().indexOf(needle)
      if (index === -1) continue
      const start = Math.max(0, index - 40)
      const snippet = text
        .slice(start, index + needle.length + 60)
        .replace(/\s+/g, ' ')
        .trim()
      hits.push({ itemId: item.id, snippet: (start > 0 ? '…' : '') + snippet })
      if (hits.length >= MAX_SEARCH_HITS) break
    }
    return hits
  }
}
