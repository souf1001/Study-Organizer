// Data store for the Android app (and any browser): persists into IndexedDB through the
// KeyValueStore abstraction. Files are kept as Blobs and shown through object URLs.
import { normalizeDb } from '../shared/defaults'
import type { Annotations, Db, FileInput, Item, NoteDoc } from '../shared/types'
import { detectFile } from './files'
import { TABLES, createMemoryKeyValueStore, openIndexedDb, type KeyValueStore } from './key-value'
import { RecordStore } from './record-store'
import type { Secrets } from './secrets'

const DB_KEY = 'db'

export class BrowserStore extends RecordStore {
  readonly dir = 'App-Speicher auf diesem Gerät'
  /** Object URLs of stored files, so the UI can show them synchronously */
  private fileUrls = new Map<string, string>()

  private constructor(readonly storage: KeyValueStore) {
    super()
  }

  /** Opens the IndexedDB store; falls back to memory (data is then lost on restart) */
  static async open(storage?: KeyValueStore): Promise<BrowserStore> {
    const store = new BrowserStore(storage ?? (await openPersistentStorage()))
    store.db = normalizeDb(await store.storage.get<Db>('meta', DB_KEY))
    await store.createFileUrls()
    return store
  }

  private async createFileUrls(): Promise<void> {
    for (const fileName of await this.storage.keys('files')) {
      const blob = await this.storage.get<Blob>('files', fileName)
      if (blob) this.fileUrls.set(fileName, URL.createObjectURL(blob))
    }
  }

  private setFileBlob(fileName: string, blob: Blob): void {
    this.revokeFileUrl(fileName)
    this.fileUrls.set(fileName, URL.createObjectURL(blob))
  }

  private revokeFileUrl(fileName: string): void {
    const url = this.fileUrls.get(fileName)
    if (url) URL.revokeObjectURL(url)
    this.fileUrls.delete(fileName)
  }

  /** URL under which the UI can display a stored file ('' if the file is missing) */
  fileUrl(item: Item): string {
    return item.fileName ? (this.fileUrls.get(item.fileName) ?? '') : ''
  }

  protected saveDb(db: Db): Promise<void> {
    return this.storage.put('meta', DB_KEY, db)
  }

  protected loadNote(id: string): Promise<NoteDoc | null> {
    return this.storage.get<NoteDoc>('notes', id)
  }

  protected saveNote(id: string, doc: NoteDoc): Promise<void> {
    return this.storage.put('notes', id, doc)
  }

  protected loadAnnotations(id: string): Promise<Annotations | null> {
    return this.storage.get<Annotations>('annotations', id)
  }

  protected saveAnnotations(id: string, annotations: Annotations): Promise<void> {
    return this.storage.put('annotations', id, annotations)
  }

  protected loadText(id: string): Promise<string | null> {
    return this.storage.get<string>('text', id)
  }

  protected saveText(id: string, text: string): Promise<void> {
    return this.storage.put('text', id, text)
  }

  protected async loadFile(fileName: string): Promise<Uint8Array | null> {
    const blob = await this.storage.get<Blob>('files', fileName)
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  }

  protected async saveFile(fileName: string, bytes: Uint8Array): Promise<void> {
    const blob = new Blob([bytes as BlobPart], { type: detectFile(fileName).mime })
    await this.storage.put('files', fileName, blob)
    this.setFileBlob(fileName, blob)
  }

  protected async saveFileInput(fileName: string, input: FileInput): Promise<number> {
    if (!input.bytes) throw new Error('Datei ohne Inhalt')
    const blob = new Blob([input.bytes as BlobPart], {
      type: input.type || detectFile(fileName).mime,
    })
    await this.storage.put('files', fileName, blob)
    this.setFileBlob(fileName, blob)
    return blob.size
  }

  protected async deleteItemContent(item: Item): Promise<void> {
    await this.storage.delete('notes', item.id)
    await this.storage.delete('annotations', item.id)
    await this.storage.delete('text', item.id)
    if (item.fileName) {
      await this.storage.delete('files', item.fileName)
      this.revokeFileUrl(item.fileName)
    }
  }

  protected async clearContent(): Promise<void> {
    for (const fileName of [...this.fileUrls.keys()]) this.revokeFileUrl(fileName)
    for (const table of TABLES) {
      // Secrets are cleared separately (see KeyValueSecrets): a setup import resets the data
      // but must keep the credentials it is about to write.
      if (table !== 'secrets') await this.storage.clear(table)
    }
  }
}

async function openPersistentStorage(): Promise<KeyValueStore> {
  if (typeof indexedDB === 'undefined') return createMemoryKeyValueStore()
  try {
    const storage = await openIndexedDb()
    // Ask the browser not to evict our data under storage pressure
    void navigator.storage?.persist?.().catch(() => undefined)
    return storage
  } catch (error) {
    console.warn('IndexedDB is not available, data will not be kept:', error)
    return createMemoryKeyValueStore()
  }
}

/**
 * Secrets in the app's private IndexedDB. Android keeps app data private to the app, so the
 * values are not encrypted a second time here.
 */
export class KeyValueSecrets implements Secrets {
  constructor(private storage: KeyValueStore) {}

  get(name: string): Promise<string | null> {
    return this.storage.get<string>('secrets', name)
  }

  set(name: string, value: string): Promise<void> {
    return this.storage.put('secrets', name, value)
  }

  remove(name: string): Promise<void> {
    return this.storage.delete('secrets', name)
  }

  clear(): Promise<void> {
    return this.storage.clear('secrets')
  }
}
