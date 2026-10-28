// Desktop storage: one JSON file for all metadata plus folders for notes and files.
//
//   <dir>/db.json               semesters, modules, folders, items, events, tasks, settings
//   <dir>/notes/<id>.json       content of a note (text + drawings)
//   <dir>/files/<id>.<ext>      uploaded files
//   <dir>/text/<id>.txt         text extracted from PDFs (search, AI)
//   <dir>/annotations/<id>.json drawings on PDF pages
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizeDb } from '../shared/defaults'
import type { Annotations, Db, FileInput, Item, NoteDoc } from '../shared/types'
import { assertFileName, assertId } from './files'
import { RecordStore } from './record-store'

const DATA_SUBFOLDERS = ['notes', 'files', 'text', 'annotations'] as const

/** Windows: mark a file as downloaded from the internet so SmartScreen and similar checks apply */
async function markAsDownloaded(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  await fs
    .writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
    .catch(() => undefined)
}

let tmpCounter = 0
const fileQueues = new Map<string, Promise<void>>()

/** Writes to a temporary file first and then renames it, so a file is never half written */
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

/** Serializes writes to the same file so the most recent write always wins */
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

export class Store extends RecordStore {
  private constructor(readonly dir: string) {
    super()
  }

  static async open(dir: string): Promise<Store> {
    const store = new Store(dir)
    await store.createSubfolders()
    store.db = normalizeDb(await readJson<Db>(store.dbFile))
    return store
  }

  private async createSubfolders(): Promise<void> {
    for (const sub of DATA_SUBFOLDERS) {
      await fs.mkdir(path.join(this.dir, sub), { recursive: true })
    }
  }

  private get dbFile(): string {
    return path.join(this.dir, 'db.json')
  }

  private pathFor(kind: 'notes' | 'annotations' | 'text', id: string): string {
    assertId(id)
    return path.join(this.dir, kind, kind === 'text' ? `${id}.txt` : `${id}.json`)
  }

  /** Path of a stored file on disk (used by the file protocol and "open with") */
  filePath(fileName: string): string {
    assertFileName(fileName)
    return path.join(this.dir, 'files', fileName)
  }

  protected saveDb(db: Db): Promise<void> {
    return writeAtomic(this.dbFile, JSON.stringify(db))
  }

  protected loadNote(id: string): Promise<NoteDoc | null> {
    return readJson<NoteDoc>(this.pathFor('notes', id))
  }

  protected saveNote(id: string, doc: NoteDoc): Promise<void> {
    return writeAtomic(this.pathFor('notes', id), JSON.stringify(doc))
  }

  protected loadAnnotations(id: string): Promise<Annotations | null> {
    return readJson<Annotations>(this.pathFor('annotations', id))
  }

  protected saveAnnotations(id: string, annotations: Annotations): Promise<void> {
    return writeAtomic(this.pathFor('annotations', id), JSON.stringify(annotations))
  }

  protected async loadText(id: string): Promise<string | null> {
    try {
      return await fs.readFile(this.pathFor('text', id), 'utf8')
    } catch {
      return null
    }
  }

  protected saveText(id: string, text: string): Promise<void> {
    return writeAtomic(this.pathFor('text', id), text)
  }

  protected async loadFile(fileName: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.filePath(fileName)))
    } catch {
      return null
    }
  }

  protected saveFile(fileName: string, bytes: Uint8Array): Promise<void> {
    return fs.writeFile(this.filePath(fileName), bytes)
  }

  protected async saveFileInput(fileName: string, input: FileInput): Promise<number> {
    const dest = this.filePath(fileName)
    if (input.path) await fs.copyFile(input.path, dest)
    else if (input.bytes) await fs.writeFile(dest, input.bytes)
    else throw new Error('Datei ohne Inhalt')
    if (input.fromInternet) await markAsDownloaded(dest)
    return (await fs.stat(dest)).size
  }

  protected async deleteItemContent(item: Item): Promise<void> {
    const files = [
      this.pathFor('notes', item.id),
      this.pathFor('annotations', item.id),
      this.pathFor('text', item.id),
    ]
    if (item.fileName) files.push(this.filePath(item.fileName))
    await Promise.all(files.map((file) => fs.rm(file, { force: true })))
  }

  protected async clearContent(): Promise<void> {
    // Let a pending database write finish first so it cannot recreate old data
    await (fileQueues.get(this.dbFile) ?? Promise.resolve())
    for (const sub of DATA_SUBFOLDERS) {
      await fs.rm(path.join(this.dir, sub), { recursive: true, force: true })
    }
    await this.createSubfolders()
  }
}
