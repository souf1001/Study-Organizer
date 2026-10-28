// Desktop storage. The documents themselves live in a readable folder structure (by default
// in the user's Documents folder, see documents-layout.ts); the app's own data stays in <dir>:
//
//   <dir>/db.json               semesters, modules, folders, items, events, tasks, settings
//   <dir>/layout.json           where each document currently is in the documents folder
//   <dir>/notes/<id>.json       content of a note (text + drawings); also exported as Markdown
//   <dir>/files/<id>.<ext>      new uploads until they are moved, and images pasted into notes
//   <dir>/text/<id>.txt         text extracted from PDFs (search, AI)
//   <dir>/annotations/<id>.json drawings on PDF pages
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizeDb } from '../shared/defaults'
import { noteToMarkdown } from '../shared/note-markdown'
import type { Annotations, Db, FileInput, ID, Item, NoteDoc } from '../shared/types'
import {
  clearLayout,
  emptyLayoutState,
  planLayout,
  syncLayout,
  type LayoutFs,
  type LayoutState,
} from './documents-layout'
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

async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (error) {
    // Another drive: copy, then delete the original
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.copyFile(from, to)
    await fs.rm(from, { force: true })
  }
}

interface LayoutFile extends LayoutState {
  /** Documents folder chosen by the user (absent: the default) */
  root?: string
}

export class Store extends RecordStore {
  private layout: LayoutState = emptyLayoutState()
  private syncing: Promise<void> | null = null
  private syncAgain = false

  private constructor(
    readonly dir: string,
    private root: string,
    private customRoot: boolean,
  ) {
    super()
  }

  /**
   * @param dir           folder for the app's own data
   * @param documentsDir  default documents folder (readable structure of all modules)
   */
  static async open(dir: string, documentsDir = path.join(dir, 'Dokumente')): Promise<Store> {
    const saved = await readJson<LayoutFile>(path.join(dir, 'layout.json'))
    const store = new Store(dir, saved?.root ?? documentsDir, Boolean(saved?.root))
    if (saved) store.layout = { entries: saved.entries ?? {}, dirs: saved.dirs ?? [] }
    await store.createSubfolders()
    store.db = normalizeDb(await readJson<Db>(store.dbFile))
    await store.syncDocuments()
    return store
  }

  /** Folder with the readable structure of all semesters, modules and documents */
  get documentsDir(): string {
    return this.root
  }

  private get layoutFile(): string {
    return path.join(this.dir, 'layout.json')
  }

  private inRoot(rel: string): string {
    const resolved = path.resolve(this.root, ...rel.split('/'))
    const relative = path.relative(this.root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Ungültiger Pfad')
    }
    return resolved
  }

  private layoutFs(): LayoutFs {
    return {
      exists: async (rel) => (await fs.stat(this.inRoot(rel)).catch(() => null)) !== null,
      mkdir: async (rel) => {
        await fs.mkdir(rel ? this.inRoot(rel) : this.root, { recursive: true })
      },
      move: (from, to) => moveFile(this.inRoot(from), this.inRoot(to)),
      remove: (rel) => fs.rm(this.inRoot(rel), { force: true }),
      removeDirIfEmpty: (rel) => fs.rmdir(this.inRoot(rel)).catch(() => undefined),
      createFile: async (item, rel) => {
        const staged = this.stagingPath(item.fileName!)
        if (!(await fs.stat(staged).catch(() => null))) return false
        await moveFile(staged, this.inRoot(rel))
        return true
      },
      writeText: (rel, text) => writeAtomic(this.inRoot(rel), text),
    }
  }

  /** Moves documents to where they belong; runs one at a time and again if requested meanwhile */
  syncDocuments(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true
      return this.syncing
    }
    const run = async () => {
      do {
        this.syncAgain = false
        await fs.mkdir(this.root, { recursive: true })
        this.layout = await syncLayout(this.db, this.layout, this.layoutFs(), {
          noteMarkdown: async (item) => noteToMarkdown(item.title, await this.loadNote(item.id)),
          onError: (error, item) =>
            console.warn(`Could not place ${item?.title ?? 'a folder'} in the documents:`, error),
        })
        await this.saveLayout()
      } while (this.syncAgain)
    }
    this.syncing = run()
      .catch((error) => console.error('Could not update the documents folder:', error))
      .finally(() => {
        this.syncing = null
      })
    return this.syncing
  }

  private saveLayout(): Promise<void> {
    const file: LayoutFile = { ...this.layout, ...(this.customRoot ? { root: this.root } : {}) }
    return writeAtomic(this.layoutFile, JSON.stringify(file))
  }

  /** Path of an item's document (or folder) in the documents folder, if it is placed there */
  documentPath(itemId: ID): string | null {
    const rel = this.layout.entries[itemId]
    return rel ? this.inRoot(rel) : null
  }

  /** Path of a module's or folder's directory in the documents folder */
  async directoryOf(target: { moduleId: ID; folderId?: ID | null }): Promise<string> {
    await this.syncDocuments()
    const plan = planLayout(this.db)
    const rel =
      (target.folderId && plan.folderDirs.get(target.folderId)) ||
      plan.moduleDirs.get(target.moduleId)
    return rel ? this.inRoot(rel) : this.root
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

  /** Where a file is kept until it has been placed in the documents folder */
  private stagingPath(fileName: string): string {
    assertFileName(fileName)
    return path.join(this.dir, 'files', fileName)
  }

  /** Path of a stored file on disk (used by the file protocol and "open with") */
  filePath(fileName: string): string {
    assertFileName(fileName)
    const placed = this.layout.entries[fileName.split('.')[0]]
    return placed ? this.inRoot(placed) : this.stagingPath(fileName)
  }

  /**
   * Moves the documents folder, e.g. into a cloud folder. Only the files and folders the app
   * placed there are moved; anything else stays where it is.
   */
  async setDocumentsDir(newRoot: string): Promise<void> {
    const target = path.resolve(newRoot)
    const inside = (child: string, parent: string) => {
      const relative = path.relative(parent, child)
      return !relative.startsWith('..') && !path.isAbsolute(relative)
    }
    if (target === this.root) return
    if (inside(target, this.root) || inside(this.root, target) || inside(target, this.dir)) {
      throw new Error('Bitte einen Ordner außerhalb des bisherigen Speicherorts wählen.')
    }
    await this.syncing
    await fs.mkdir(target, { recursive: true })
    const entries: Record<ID, string> = {}
    for (const [id, rel] of Object.entries(this.layout.entries)) {
      const from = this.inRoot(rel)
      let moved = rel
      const ext = /\.[A-Za-z0-9]{1,10}$/.exec(rel)?.[0] ?? ''
      for (let n = 2; await fs.stat(path.join(target, moved)).catch(() => null); n++) {
        moved = `${rel.slice(0, rel.length - ext.length)} (${n})${ext}`
      }
      try {
        await moveFile(from, path.join(target, ...moved.split('/')))
        entries[id] = moved
      } catch (error) {
        // Missing file: it is created again where it belongs (notes) or stays missing
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const fsOld = this.layoutFs()
    for (const dir of [...this.layout.dirs].sort((a, b) => b.length - a.length)) {
      await fsOld.removeDirIfEmpty(dir)
    }
    await fs.rmdir(this.root).catch(() => undefined)
    this.root = target
    this.customRoot = true
    this.layout = { entries, dirs: [] }
    await this.saveLayout()
    await this.syncDocuments()
  }

  protected async saveDb(db: Db): Promise<void> {
    await writeAtomic(this.dbFile, JSON.stringify(db))
    await this.syncDocuments()
  }

  protected loadNote(id: string): Promise<NoteDoc | null> {
    return readJson<NoteDoc>(this.pathFor('notes', id))
  }

  protected async saveNote(id: string, doc: NoteDoc): Promise<void> {
    await writeAtomic(this.pathFor('notes', id), JSON.stringify(doc))
    // Keep the Markdown copy in the documents folder up to date
    const placed = this.layout.entries[id]
    const item = this.db.items.find((i) => i.id === id)
    if (placed && item) {
      await writeAtomic(this.inRoot(placed), noteToMarkdown(item.title, doc)).catch((error) =>
        console.warn('Could not export the note as Markdown:', error),
      )
    }
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
    // Placed in the documents folder by the next sync (the item does not exist yet)
    const dest = this.stagingPath(fileName)
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
    if (item.fileName) files.push(this.stagingPath(item.fileName))
    const placed = this.layout.entries[item.id]
    if (placed) {
      files.push(this.inRoot(placed))
      delete this.layout.entries[item.id]
    }
    await Promise.all(files.map((file) => fs.rm(file, { force: true })))
  }

  protected async clearContent(): Promise<void> {
    // Let a pending database write finish first so it cannot recreate old data
    await (fileQueues.get(this.dbFile) ?? Promise.resolve())
    await this.syncing
    await clearLayout(this.layout, this.layoutFs())
    this.layout = emptyLayoutState()
    await this.saveLayout()
    for (const sub of DATA_SUBFOLDERS) {
      await fs.rm(path.join(this.dir, sub), { recursive: true, force: true })
    }
    await this.createSubfolders()
  }
}
