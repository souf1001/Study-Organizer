// Readable folder structure for documents: every semester, module and folder of the app is a
// real folder, every file keeps its title as file name, and notes are written as Markdown.
//
//   <root>/<Semester>/<Module>/<Folder>/<Subfolder>/<Title>.<ext>
//   <root>/<Semester>/<Module>/<Note>.md
//
// planLayout() computes where everything belongs; syncLayout() moves the files there through a
// small file system adapter (disk on desktop, the public Documents folder on Android). Files
// the user or other programs put into these folders are never touched.
import type { Db, ID, Item } from '../shared/types'

export interface LayoutState {
  /** Item id → path relative to the root, where the item's file currently is */
  entries: Record<ID, string>
  /** Folders created by the app (relative paths) */
  dirs: string[]
}

export const emptyLayoutState = (): LayoutState => ({ entries: {}, dirs: [] })

export interface LayoutPlan {
  /** Item id → wanted relative path */
  files: Map<ID, string>
  /** All folders that should exist, parents first */
  dirs: string[]
  /** Module id / folder id → relative path of its folder */
  moduleDirs: Map<ID, string>
  folderDirs: Map<ID, string>
}

export interface LayoutFs {
  exists(rel: string): Promise<boolean>
  mkdir(rel: string): Promise<void>
  move(fromRel: string, toRel: string): Promise<void>
  remove(rel: string): Promise<void>
  /** Removes a folder only if it is empty; must not throw */
  removeDirIfEmpty(rel: string): Promise<void>
  /** Puts a file item's content at `rel` for the first time; false if there is no content yet */
  createFile(item: Item, rel: string): Promise<boolean>
  writeText(rel: string, text: string): Promise<void>
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
const MAX_NAME_LENGTH = 100

/** Makes a title usable as a file or folder name on Windows, macOS, Linux and Android */
export function safeName(name: string, fallback = 'Unbenannt'): string {
  let result = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  if (result.length > MAX_NAME_LENGTH) result = result.slice(0, MAX_NAME_LENGTH).trim()
  result = result.replace(/[. ]+$/, '').replace(/^\.+/, '')
  if (!result) return fallback
  if (WINDOWS_RESERVED.test(result)) result = `_${result}`
  return result
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/')

export function extensionOf(item: Item): string {
  if (item.kind === 'note') return 'md'
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(item.fileName ?? '')
  return match ? match[1].toLowerCase() : ''
}

/** Hands out unique names per folder (case-insensitive, as on Windows and macOS) */
class NameRegistry {
  private taken = new Map<string, Set<string>>()

  claim(dir: string, base: string, ext: string): string {
    const used = this.taken.get(dir) ?? new Set<string>()
    this.taken.set(dir, used)
    const withExt = (name: string) => (ext ? `${name}.${ext}` : name)
    let name = withExt(base)
    for (let n = 2; used.has(name.toLowerCase()); n++) name = withExt(`${base} (${n})`)
    used.add(name.toLowerCase())
    return name
  }
}

const byAge = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** Items that appear as files in the documents folder (images pasted into notes do not) */
export function isLayoutItem(item: Item): boolean {
  if (item.attachedTo) return false
  return item.kind === 'note' || Boolean(item.fileName)
}

export function planLayout(db: Db): LayoutPlan {
  const names = new NameRegistry()
  const dirs: string[] = []
  const semesterDir = new Map<ID, string>()
  const moduleDir = new Map<ID, string>()
  const folderDir = new Map<ID, string>()

  const addDir = (parent: string, name: string): string => {
    const dir = join(parent, names.claim(parent, safeName(name), ''))
    dirs.push(dir)
    return dir
  }

  for (const semester of [...db.semesters].sort(byAge)) {
    semesterDir.set(semester.id, addDir('', semester.name))
  }
  const modules = [...db.modules].sort((a, b) => a.order - b.order || byAge(a, b))
  for (const module of modules) {
    let parent = semesterDir.get(module.semesterId)
    if (parent === undefined) {
      parent = addDir('', 'Ohne Semester')
      semesterDir.set(module.semesterId, parent)
    }
    moduleDir.set(module.id, addDir(parent, module.name))
  }

  // Folders: parents before children, so the parent path is known
  const folders = [...db.folders].sort((a, b) => a.order - b.order || byAge(a, b))
  let pending = folders.filter((f) => moduleDir.has(f.moduleId))
  while (pending.length > 0) {
    const next = pending.filter((f) => f.parentId && !folderDir.has(f.parentId))
    const ready = pending.filter((f) => !next.includes(f))
    // Folders whose parent no longer exists end up at the top of the module
    const placeable = ready.length > 0 ? ready : next
    for (const folder of placeable) {
      const parent =
        (folder.parentId && folderDir.get(folder.parentId)) || moduleDir.get(folder.moduleId)!
      folderDir.set(folder.id, addDir(parent, folder.name))
    }
    pending = pending.filter((f) => !placeable.includes(f))
  }

  const files = new Map<ID, string>()
  for (const item of [...db.items].sort(byAge)) {
    if (!isLayoutItem(item)) continue
    const dir = (item.folderId && folderDir.get(item.folderId)) || moduleDir.get(item.moduleId)
    if (dir === undefined) continue
    files.set(item.id, join(dir, names.claim(dir, safeName(item.title), extensionOf(item))))
  }
  return { files, dirs, moduleDirs: moduleDir, folderDirs: folderDir }
}

const parentOf = (rel: string) => rel.split('/').slice(0, -1).join('/')

/** Next free path for `wanted`; a path is free if nothing is there or `current` itself is there */
async function freePath(
  fs: LayoutFs,
  wanted: string,
  current: string | undefined,
  taken: Set<string>,
): Promise<string> {
  const match = /^(.*?)(\.[A-Za-z0-9]{1,10})?$/.exec(wanted)!
  const [base, ext = ''] = [match[1], match[2]]
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? wanted : `${base} (${n})${ext}`
    if (candidate === current) return candidate
    if (taken.has(candidate.toLowerCase())) continue
    if (!(await fs.exists(candidate))) return candidate
  }
}

export interface SyncOptions {
  /** Markdown of a note, null if the note cannot be read */
  noteMarkdown(item: Item): Promise<string | null>
  onError?(error: unknown, item?: Item): void
}

/**
 * Brings the folder structure in line with the database: creates folders, moves renamed or
 * moved files, writes new notes and removes folders the app created that are now empty.
 * Returns the new state; errors for single files are reported and retried on the next run.
 */
export async function syncLayout(
  db: Db,
  state: LayoutState,
  fs: LayoutFs,
  options: SyncOptions,
): Promise<LayoutState> {
  const plan = planLayout(db)
  const entries = { ...state.entries }
  const known = new Set(state.dirs)

  for (const dir of plan.dirs) {
    if (known.has(dir)) continue
    try {
      await fs.mkdir(dir)
    } catch (error) {
      options.onError?.(error)
    }
  }

  // Paths that stay occupied by our own files during this run
  const taken = new Set(
    Object.entries(entries)
      .filter(([id]) => plan.files.has(id))
      .map(([, rel]) => rel.toLowerCase()),
  )
  const items = new Map(db.items.map((i) => [i.id, i]))
  for (const [id, wanted] of plan.files) {
    const item = items.get(id)!
    const current = entries[id]
    if (current === wanted) continue
    try {
      if (current) taken.delete(current.toLowerCase())
      const target = await freePath(fs, wanted, current, taken)
      if (target !== current) {
        await fs.mkdir(parentOf(target))
        if (current && (await fs.exists(current))) {
          await fs.move(current, target)
        } else if (item.kind === 'note') {
          const markdown = await options.noteMarkdown(item)
          if (markdown === null) {
            if (current) taken.add(current.toLowerCase())
            continue
          }
          await fs.writeText(target, markdown)
        } else if (!(await fs.createFile(item, target))) {
          if (current) taken.add(current.toLowerCase())
          continue
        }
        entries[id] = target
      }
      taken.add(target.toLowerCase())
    } catch (error) {
      if (current) taken.add(current.toLowerCase())
      options.onError?.(error, item)
    }
  }

  // Entries of items that no longer exist (e.g. deleted while the app was closed)
  for (const id of Object.keys(entries)) {
    if (items.has(id)) continue
    await fs.remove(entries[id]).catch((error) => options.onError?.(error))
    delete entries[id]
  }

  // Folders the app created that are no longer wanted: remove them if empty, deepest first
  const wantedDirs = new Set(plan.dirs)
  const stale = [...known].filter((dir) => !wantedDirs.has(dir))
  for (const dir of stale.sort((a, b) => b.split('/').length - a.split('/').length)) {
    await fs.removeDirIfEmpty(dir)
  }

  return { entries, dirs: plan.dirs }
}

/** Deletes all files and folders the app placed in the documents folder (used by "reset") */
export async function clearLayout(state: LayoutState, fs: LayoutFs): Promise<void> {
  for (const rel of Object.values(state.entries)) await fs.remove(rel).catch(() => undefined)
  for (const dir of [...state.dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    await fs.removeDirIfEmpty(dir)
  }
}
