// Lokale Datenhaltung für Android und Web über IndexedDB.
// Verhält sich 1:1 wie der Electron-Store, sodass dieselbe Backend-Logik (Service) unverändert läuft.
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
import { createDefaultDb, newId, normalizeDb } from '../shared/defaults'
import { assertFileName, assertId, detectFile, titleFromFileName } from './files'
import type { Secrets } from './service'

const DB_NAME = 'study_organizer_storage'
const DB_VERSION = 1
const SAVE_DELAY_MS = 250
const PATCH_KEYS: (keyof DbPatch)[] = ['onboarded', 'activeSemesterId', 'profile', 'settings', 'moodleDiscussions']

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes')
      if (!db.objectStoreNames.contains('annotations')) db.createObjectStore('annotations')
      if (!db.objectStoreNames.contains('text')) db.createObjectStore('text')
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
      if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, storeName: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbDelete(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbClear(db: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbGetAllKeys(db: IDBDatabase, storeName: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).getAllKeys()
    req.onsuccess = () => resolve((req.result as string[]) ?? [])
    req.onerror = () => reject(req.error)
  })
}

export class ClientStore {
  private db: Db = createDefaultDb()
  private idb: IDBDatabase | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private textCache = new Map<string, string>()
  private fileUrls = new Map<string, string>()

  // In-Memory-Fallbacks für Tests oder Umgebungen ohne IndexedDB
  private memMeta = new Map<string, unknown>()
  private memNotes = new Map<string, NoteDoc>()
  private memAnnotations = new Map<string, Annotations>()
  private memText = new Map<string, string>()
  private memFiles = new Map<string, Blob>()
  private memSecrets = new Map<string, string>()

  readonly dir = 'Android Lokaler Speicher'

  static async open(): Promise<ClientStore> {
    const store = new ClientStore()
    if (typeof indexedDB !== 'undefined') {
      try {
        store.idb = await openIdb()
        const savedDb = await idbGet<Db>(store.idb, 'meta', 'db')
        store.db = normalizeDb(savedDb)
        void store.precacheFileUrls()
      } catch (e) {
        console.warn('IndexedDB konnte nicht geöffnet werden, verwende In-Memory-Speicher:', e)
        store.db = createDefaultDb()
      }
    } else {
      store.db = createDefaultDb()
    }
    return store
  }

  private async precacheFileUrls(): Promise<void> {
    if (!this.idb) return
    try {
      const keys = await idbGetAllKeys(this.idb, 'files')
      for (const fileName of keys) {
        const blob = await idbGet<Blob>(this.idb, 'files', fileName)
        if (blob && !this.fileUrls.has(fileName)) {
          this.fileUrls.set(fileName, URL.createObjectURL(blob))
        }
      }
    } catch {
      // Ignorieren falls nicht möglich
    }
  }

  get(): Db {
    return this.db
  }

  filePath(fileName: string): string {
    assertFileName(fileName)
    return fileName
  }

  fileUrl(item: Item): string {
    if (!item.fileName) return ''
    const cached = this.fileUrls.get(item.fileName)
    if (cached) return cached
    void this.fileBlob(item.fileName).then((blob) => {
      if (blob && !this.fileUrls.has(item.fileName!)) {
        this.fileUrls.set(item.fileName!, URL.createObjectURL(blob))
      }
    })
    return ''
  }

  async fileBlob(fileName: string): Promise<Blob | null> {
    assertFileName(fileName)
    if (this.idb) {
      return (await idbGet<Blob>(this.idb, 'files', fileName)) ?? null
    }
    return this.memFiles.get(fileName) ?? null
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.flush().catch((err) => console.error('Fehler beim Speichern der Db:', err))
    }, SAVE_DELAY_MS)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.idb) {
      await idbPut(this.idb, 'meta', 'db', this.db)
    } else {
      this.memMeta.set('db', JSON.parse(JSON.stringify(this.db)))
    }
  }

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
    match: (r: RecordOf<C>) => boolean,
    records: RecordOf<C>[],
  ): void {
    for (const r of records) assertId(r.id)
    const kept = this.list(collection).filter((r) => !match(r))
    ;(this.db[collection] as RecordOf<C>[]) = [...kept, ...records]
    this.scheduleSave()
  }

  update(patch: DbPatch): void {
    if (!isObject(patch)) throw new Error('Ungültige Änderung')
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCH_KEYS.includes(key as keyof DbPatch)) throw new Error(`Feld nicht erlaubt: ${key}`)
      const valid =
        key === 'onboarded' ? typeof value === 'boolean'
        : key === 'activeSemesterId' ? value === null || typeof value === 'string'
        : key === 'moodleDiscussions' ? Array.isArray(value)
        : isObject(value)
      if (!valid) throw new Error(`Ungültiger Wert für ${key}`)
    }
    Object.assign(this.db, patch)
    this.scheduleSave()
  }

  async remove(collection: CollectionName, id: string): Promise<void> {
    assertId(id)
    const db = this.db
    const itemIds: string[] = []
    const drop = <C extends CollectionName>(c: C, keep: (r: RecordOf<C>) => boolean): void => {
      ;(db[c] as RecordOf<C>[]) = (db[c] as RecordOf<C>[]).filter(keep)
    }

    if (collection === 'semesters') {
      for (const m of db.modules.filter((m) => m.semesterId === id)) await this.remove('modules', m.id)
      if (db.activeSemesterId === id) db.activeSemesterId = null
    }
    if (collection === 'modules') {
      itemIds.push(...db.items.filter((i) => i.moduleId === id).map((i) => i.id))
      drop('folders', (f) => f.moduleId !== id)
      drop('events', (e) => e.moduleId !== id)
      drop('tasks', (t) => t.moduleId !== id)
      drop('chats', (c) => c.moduleId !== id)
    }
    if (collection === 'folders') {
      const folderIds = new Set([id])
      let grew = true
      while (grew) {
        grew = false
        for (const f of db.folders) {
          if (f.parentId && folderIds.has(f.parentId) && !folderIds.has(f.id)) {
            folderIds.add(f.id)
            grew = true
          }
        }
      }
      itemIds.push(...db.items.filter((i) => i.folderId && folderIds.has(i.folderId)).map((i) => i.id))
      drop('folders', (f) => !folderIds.has(f.id))
    }
    if (collection === 'items') {
      itemIds.push(id, ...db.items.filter((i) => i.attachedTo === id).map((i) => i.id))
    }
    if (collection === 'subscriptions') {
      drop('events', (e) => e.subscriptionId !== id)
    }

    await this.deleteItemData(db.items.filter((i) => itemIds.includes(i.id)))
    drop('items', (i) => !itemIds.includes(i.id))
    drop(collection, (r) => r.id !== id)
    this.scheduleSave()
  }

  private async deleteItemData(items: Item[]): Promise<void> {
    for (const item of items) {
      this.textCache.delete(item.id)
      if (this.idb) {
        await idbDelete(this.idb, 'notes', item.id).catch(() => undefined)
        await idbDelete(this.idb, 'annotations', item.id).catch(() => undefined)
        await idbDelete(this.idb, 'text', item.id).catch(() => undefined)
        if (item.fileName) {
          await idbDelete(this.idb, 'files', item.fileName).catch(() => undefined)
          const url = this.fileUrls.get(item.fileName)
          if (url) {
            URL.revokeObjectURL(url)
            this.fileUrls.delete(item.fileName)
          }
        }
      } else {
        this.memNotes.delete(item.id)
        this.memAnnotations.delete(item.id)
        this.memText.delete(item.id)
        if (item.fileName) {
          this.memFiles.delete(item.fileName)
          const url = this.fileUrls.get(item.fileName)
          if (url) {
            URL.revokeObjectURL(url)
            this.fileUrls.delete(item.fileName)
          }
        }
      }
    }
  }

  private touchItem(id: string): void {
    const item = this.db.items.find((i) => i.id === id)
    if (item) {
      item.updatedAt = new Date().toISOString()
      this.scheduleSave()
    }
  }

  async readNote(id: string): Promise<NoteDoc | null> {
    assertId(id)
    if (this.idb) return idbGet<NoteDoc>(this.idb, 'notes', id)
    return this.memNotes.get(id) ?? null
  }

  async writeNote(id: string, doc: NoteDoc): Promise<void> {
    assertId(id)
    if (this.idb) {
      await idbPut(this.idb, 'notes', id, doc)
    } else {
      this.memNotes.set(id, doc)
    }
    this.textCache.set(id, doc.text ?? '')
    this.touchItem(id)
  }

  async readAnnotations(id: string): Promise<Annotations | null> {
    assertId(id)
    if (this.idb) return idbGet<Annotations>(this.idb, 'annotations', id)
    return this.memAnnotations.get(id) ?? null
  }

  async writeAnnotations(id: string, annotations: Annotations): Promise<void> {
    assertId(id)
    if (this.idb) {
      await idbPut(this.idb, 'annotations', id, annotations)
    } else {
      this.memAnnotations.set(id, annotations)
    }
  }

  async readText(id: string): Promise<string | null> {
    assertId(id)
    if (this.idb) return idbGet<string>(this.idb, 'text', id)
    return this.memText.get(id) ?? null
  }

  async writeText(id: string, text: string): Promise<void> {
    assertId(id)
    if (this.idb) {
      await idbPut(this.idb, 'text', id, String(text))
    } else {
      this.memText.set(id, String(text))
    }
    this.textCache.set(id, String(text))
  }

  async addFile(target: FileTarget, input: FileInput): Promise<Item> {
    assertId(target.moduleId)
    if (target.folderId) assertId(target.folderId)
    const { ext, mime, fileType } = detectFile(input.name)
    const id = newId()
    const fileName = ext ? `${id}.${ext}` : id
    let blob: Blob
    if (input.bytes) {
      blob = new Blob([input.bytes as BlobPart], { type: input.type || mime })
    } else {
      blob = new Blob([], { type: input.type || mime })
    }

    if (this.idb) {
      await idbPut(this.idb, 'files', fileName, blob)
    } else {
      this.memFiles.set(fileName, blob)
    }
    const url = URL.createObjectURL(blob)
    this.fileUrls.set(fileName, url)

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
      size: blob.size,
      attachedTo: target.attachedTo ?? null,
      source: null,
      externalId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.put('items', item)
    return item
  }

  private async textOf(item: Item): Promise<string> {
    const cached = this.textCache.get(item.id)
    if (cached !== undefined) return cached
    const text =
      item.kind === 'note' ? ((await this.readNote(item.id))?.text ?? '') : ((await this.readText(item.id)) ?? '')
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
      const snippet = text.slice(start, index + needle.length + 60).replace(/\s+/g, ' ').trim()
      hits.push({ itemId: item.id, snippet: (start > 0 ? '…' : '') + snippet })
      if (hits.length >= 50) break
    }
    return hits
  }

  async reset(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    for (const url of this.fileUrls.values()) {
      URL.revokeObjectURL(url)
    }
    this.fileUrls.clear()
    this.textCache.clear()

    if (this.idb) {
      await idbClear(this.idb, 'meta')
      await idbClear(this.idb, 'notes')
      await idbClear(this.idb, 'annotations')
      await idbClear(this.idb, 'text')
      await idbClear(this.idb, 'files')
      await idbClear(this.idb, 'secrets')
    } else {
      this.memMeta.clear()
      this.memNotes.clear()
      this.memAnnotations.clear()
      this.memText.clear()
      this.memFiles.clear()
      this.memSecrets.clear()
    }
    this.db = createDefaultDb()
    await this.flush()
  }

  async exportAll(): Promise<string> {
    return JSON.stringify(this.db, null, 2)
  }
}

export class ClientSecrets implements Secrets {
  constructor(private store: ClientStore) {}

  async get(name: string): Promise<string | null> {
    const idb = (this.store as unknown as { idb: IDBDatabase | null }).idb
    if (idb) {
      return (await idbGet<string>(idb, 'secrets', name)) ?? null
    }
    const mem = (this.store as unknown as { memSecrets: Map<string, string> }).memSecrets
    return mem.get(name) ?? null
  }

  async set(name: string, value: string): Promise<void> {
    const idb = (this.store as unknown as { idb: IDBDatabase | null }).idb
    if (idb) {
      await idbPut(idb, 'secrets', name, value)
    } else {
      const mem = (this.store as unknown as { memSecrets: Map<string, string> }).memSecrets
      mem.set(name, value)
    }
  }

  async remove(name: string): Promise<void> {
    const idb = (this.store as unknown as { idb: IDBDatabase | null }).idb
    if (idb) {
      await idbDelete(idb, 'secrets', name)
    } else {
      const mem = (this.store as unknown as { memSecrets: Map<string, string> }).memSecrets
      mem.delete(name)
    }
  }
}
