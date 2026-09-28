// Datenhaltung: eine JSON-Datei für alle Metadaten plus Ordner für Notizen und Dateien.
//
//   <dir>/db.json              Semester, Module, Ordner, Einträge, Termine, Aufgaben, Einstellungen
//   <dir>/notes/<id>.json      Inhalt einer Notiz (Text + Zeichnungen)
//   <dir>/files/<id>.<ext>     hochgeladene Dateien
//   <dir>/text/<id>.txt        aus PDFs extrahierter Text (Suche, KI)
//   <dir>/annotations/<id>.json Markierungen auf PDF-Seiten
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { COLLECTIONS, type Annotations, type CollectionName, type Db, type DbPatch, type FileInput, type FileTarget, type Item, type NoteDoc, type RecordOf, type SearchHit } from '../shared/types'
import { createDefaultDb, newId, normalizeDb } from '../shared/defaults'
import { assertFileName, assertId, detectFile, titleFromFileName } from './files'

const SAVE_DELAY_MS = 250
const PATCH_KEYS: (keyof DbPatch)[] = ['onboarded', 'activeSemesterId', 'profile', 'settings']

let tmpCounter = 0
const fileQueues = new Map<string, Promise<void>>()

/** Schreibt über eine eigene Temp-Datei und benennt dann um – nie halb geschriebene Dateien. */
async function writeFileNow(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode })
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

/** Schreibvorgänge auf dieselbe Datei nacheinander ausführen, damit der neueste Stand gewinnt */
export function writeAtomic(file: string, data: string, mode?: number): Promise<void> {
  const previous = fileQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => writeFileNow(file, data, mode))
  const settled = next.catch(() => undefined)
  fileQueues.set(file, settled)
  void settled.then(() => fileQueues.get(file) === settled && fileQueues.delete(file))
  return next
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class Store {
  private db: Db = createDefaultDb()
  private saveTimer: NodeJS.Timeout | null = null
  private textCache = new Map<string, string>()

  private constructor(readonly dir: string) {}

  static async open(dir: string): Promise<Store> {
    const store = new Store(dir)
    for (const sub of ['notes', 'files', 'text', 'annotations']) {
      await fs.mkdir(path.join(dir, sub), { recursive: true })
    }
    store.db = normalizeDb(await readJson<Db>(store.dbFile))
    return store
  }

  private get dbFile(): string {
    return path.join(this.dir, 'db.json')
  }

  private pathFor(kind: 'notes' | 'annotations' | 'text', id: string): string {
    assertId(id)
    return path.join(this.dir, kind, kind === 'text' ? `${id}.txt` : `${id}.json`)
  }

  filePath(fileName: string): string {
    assertFileName(fileName)
    return path.join(this.dir, 'files', fileName)
  }

  get(): Db {
    return this.db
  }

  // ---- Speichern ----

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      // Fehler landen im Log; die nächste Änderung versucht es erneut
      this.flush().catch((error) => console.error('db.json konnte nicht gespeichert werden:', error))
    }, SAVE_DELAY_MS)
  }

  /** Schreibt ausstehende Änderungen sofort (z. B. vor dem Beenden) */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    return writeAtomic(this.dbFile, JSON.stringify(this.db))
  }

  // ---- Datensätze ----

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

  /** Ersetzt alle Datensätze, auf die `match` zutrifft, durch `records` (z. B. Termine eines Abos) */
  replaceMany<C extends CollectionName>(collection: C, match: (r: RecordOf<C>) => boolean, records: RecordOf<C>[]): void {
    for (const r of records) assertId(r.id)
    const kept = this.list(collection).filter((r) => !match(r))
    ;(this.db[collection] as RecordOf<C>[]) = [...kept, ...records]
    this.scheduleSave()
  }

  update(patch: DbPatch): void {
    for (const key of Object.keys(patch) as (keyof DbPatch)[]) {
      if (!PATCH_KEYS.includes(key)) throw new Error(`Feld nicht erlaubt: ${key}`)
    }
    Object.assign(this.db, patch)
    this.scheduleSave()
  }

  /** Löscht einen Datensatz samt allem, was daran hängt */
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
      const files = [
        this.pathFor('notes', item.id),
        this.pathFor('annotations', item.id),
        this.pathFor('text', item.id),
      ]
      if (item.fileName) files.push(this.filePath(item.fileName))
      await Promise.all(files.map((f) => fs.rm(f, { force: true })))
    }
  }

  private touchItem(id: string): void {
    const item = this.db.items.find((i) => i.id === id)
    if (item) {
      item.updatedAt = new Date().toISOString()
      this.scheduleSave()
    }
  }

  // ---- Notizen, Markierungen, Text ----

  async readNote(id: string): Promise<NoteDoc | null> {
    return readJson<NoteDoc>(this.pathFor('notes', id))
  }

  async writeNote(id: string, doc: NoteDoc): Promise<void> {
    await writeAtomic(this.pathFor('notes', id), JSON.stringify(doc))
    this.textCache.set(id, doc.text ?? '')
    this.touchItem(id)
  }

  async readAnnotations(id: string): Promise<Annotations | null> {
    return readJson<Annotations>(this.pathFor('annotations', id))
  }

  async writeAnnotations(id: string, annotations: Annotations): Promise<void> {
    await writeAtomic(this.pathFor('annotations', id), JSON.stringify(annotations))
  }

  async readText(id: string): Promise<string | null> {
    try {
      return await fs.readFile(this.pathFor('text', id), 'utf8')
    } catch {
      return null
    }
  }

  async writeText(id: string, text: string): Promise<void> {
    await writeAtomic(this.pathFor('text', id), String(text))
    this.textCache.set(id, String(text))
  }

  // ---- Dateien ----

  async addFile(target: FileTarget, input: FileInput): Promise<Item> {
    assertId(target.moduleId)
    if (target.folderId) assertId(target.folderId)
    const { ext, mime, fileType } = detectFile(input.name)
    const id = newId()
    const fileName = ext ? `${id}.${ext}` : id
    const dest = this.filePath(fileName)
    if (input.path) await fs.copyFile(input.path, dest)
    else if (input.bytes) await fs.writeFile(dest, input.bytes)
    else throw new Error('Datei ohne Inhalt')
    const { size } = await fs.stat(dest)
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

  // ---- Suche ----

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

  // ---- Alles zurücksetzen ----

  async reset(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    await (fileQueues.get(this.dbFile) ?? Promise.resolve())
    for (const sub of ['notes', 'files', 'text', 'annotations']) {
      await fs.rm(path.join(this.dir, sub), { recursive: true, force: true })
      await fs.mkdir(path.join(this.dir, sub), { recursive: true })
    }
    this.textCache.clear()
    this.db = createDefaultDb()
    await this.flush()
  }
}
