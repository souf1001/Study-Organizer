// Häufige Aktionen, die von mehreren Ansichten genutzt werden.
import { emptyNote, newFolder, newNoteItem } from '@shared/defaults'
import { today } from '@shared/dates'
import { moduleOccurrences, sessionFolderName, SESSION_LABELS, type Occurrence } from '@shared/schedule'
import { findSemesterAt } from '@shared/semester'
import type { Db, Folder, ID, Item, Module, Semester, SessionKind } from '@shared/types'
import { confirm, prompt } from '@/ui/Dialogs'
import { toast, toastError } from '@/ui/Toast'
import { api } from './api'
import { getDb, loadDb, putRecord, removeRecord } from './db'
import { openView } from './workspace'

// ---- Abfragen ----

export function activeSemester(db: Db): Semester | undefined {
  return db.semesters.find((s) => s.id === db.activeSemesterId) ?? findSemesterAt(db.semesters, today()) ?? db.semesters.at(-1)
}

export function semesterModules(db: Db, semesterId: ID | undefined): Module[] {
  return db.modules.filter((m) => m.semesterId === semesterId).sort((a, b) => a.order - b.order)
}

export function semesterOf(db: Db, module: Module): Semester | undefined {
  return db.semesters.find((s) => s.id === module.semesterId)
}

/** Alle Stundenplan-Termine der Module eines Semesters */
export function semesterOccurrences(db: Db, semester: Semester | undefined): Occurrence[] {
  if (!semester) return []
  return semesterModules(db, semester.id)
    .flatMap((m) => moduleOccurrences(m, semester))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
}

export function visibleItems(db: Db, folderId: ID | null, moduleId: ID): Item[] {
  return db.items
    .filter((i) => i.moduleId === moduleId && i.folderId === folderId && !i.attachedTo)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function childFolders(db: Db, moduleId: ID, parentId: ID | null): Folder[] {
  return db.folders
    .filter((f) => f.moduleId === moduleId && f.parentId === parentId)
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.order - b.order)
}

export function findSessionFolder(db: Db, moduleId: ID, date: string, kind: SessionKind): Folder | undefined {
  return db.folders.find((f) => f.moduleId === moduleId && f.kind === 'session' && f.date === date && f.sessionKind === kind)
}

export function folderPath(db: Db, folder: Folder): Folder[] {
  const path: Folder[] = [folder]
  let current = folder
  while (current.parentId) {
    const parent = db.folders.find((f) => f.id === current.parentId)
    if (!parent) break
    path.unshift(parent)
    current = parent
  }
  return path
}

// ---- Anlegen ----

export async function createNote(moduleId: ID, folderId: ID | null, event?: { metaKey: boolean; ctrlKey: boolean }): Promise<Item> {
  const db = getDb()
  const item = newNoteItem(moduleId, folderId)
  putRecord('items', item)
  await api.writeNote(item.id, emptyNote(db.settings.editor))
  openView({ type: 'item', id: item.id }, event)
  return item
}

/** Ordner für einen Vorlesungs-/Übungs-/Praktikumstermin – legt ihn bei Bedarf an */
export function ensureSessionFolder(occurrence: Pick<Occurrence, 'moduleId' | 'date' | 'kind' | 'index' | 'room'>): Folder {
  const db = getDb()
  const existing = findSessionFolder(db, occurrence.moduleId, occurrence.date, occurrence.kind)
  if (existing) return existing
  const folder = newFolder(occurrence.moduleId, {
    name: sessionFolderName(db.settings.study.sessionFolderName, occurrence),
    kind: 'session',
    sessionKind: occurrence.kind,
    date: occurrence.date,
    room: occurrence.room,
  })
  putRecord('folders', folder)
  return folder
}

export function openSession(occurrence: Occurrence, event?: { metaKey: boolean; ctrlKey: boolean }): void {
  const folder = ensureSessionFolder(occurrence)
  openView({ type: 'folder', id: folder.id }, event)
}

/** Zusätzlicher Termin ohne Stundenplan (z. B. Blockpraktikum) */
export async function createManualSession(module: Module, kind: SessionKind): Promise<void> {
  const date = await prompt({ title: `${SESSION_LABELS[kind]} anlegen`, label: 'Datum', initial: today(), placeholder: 'JJJJ-MM-TT' })
  if (!date) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Bitte das Datum als JJJJ-MM-TT eingeben.', { error: true })
  const count = getDb().folders.filter((f) => f.moduleId === module.id && f.sessionKind === kind).length
  const folder = ensureSessionFolder({ moduleId: module.id, date, kind, index: count + 1, room: '' })
  openView({ type: 'folder', id: folder.id })
}

export async function createFolder(moduleId: ID, parentId: ID | null): Promise<void> {
  const name = await prompt({ title: 'Neuer Ordner', label: 'Name', placeholder: 'z. B. Übungsblätter' })
  if (name) putRecord('folders', newFolder(moduleId, { name, parentId }))
}

// ---- Dateien ----

export function pickFiles(accept = ''): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = accept
    input.onchange = () => resolve([...(input.files ?? [])])
    input.click()
  })
}

/** Dateien übernehmen und bei PDFs im Hintergrund den Text für Suche/KI auslesen */
export async function uploadFiles(moduleId: ID, folderId: ID | null, files: File[]): Promise<Item[]> {
  if (files.length === 0) return []
  try {
    const items = await api.addFiles({ moduleId, folderId }, files)
    await loadDb()
    toast(items.length === 1 ? `„${items[0].title}“ hinzugefügt` : `${items.length} Dateien hinzugefügt`)
    void indexPdfs(items)
    return items
  } catch (error) {
    toastError(error)
    return []
  }
}

export async function indexPdfs(items: Item[]): Promise<void> {
  const { extractPdfText } = await import('./pdf')
  for (const item of items.filter((i) => i.fileType === 'pdf')) {
    try {
      await api.writeText(item.id, await extractPdfText(api.fileUrl(item)))
    } catch {
      // Ohne Text bleibt die Datei trotzdem nutzbar
    }
  }
}

/** Text einer Notiz oder Datei (für die KI); PDFs werden bei Bedarf nachträglich ausgelesen */
export async function itemText(item: Item): Promise<string> {
  if (item.kind === 'note') return (await api.readNote(item.id))?.text ?? ''
  if (item.fileType === 'pdf') {
    const cached = await api.readText(item.id)
    if (cached) return cached
    const { extractPdfText } = await import('./pdf')
    const text = await extractPdfText(api.fileUrl(item))
    await api.writeText(item.id, text)
    return text
  }
  if (item.fileType === 'text') {
    const response = await fetch(api.fileUrl(item))
    return (await response.text()).slice(0, 200_000)
  }
  return ''
}

// ---- Umbenennen & Löschen ----

export async function renameItem(item: Item): Promise<void> {
  const title = await prompt({ title: 'Umbenennen', initial: item.title })
  if (title) putRecord('items', { ...item, title, updatedAt: new Date().toISOString() })
}

export async function renameFolder(folder: Folder): Promise<void> {
  const name = await prompt({ title: 'Ordner umbenennen', initial: folder.name })
  if (name) putRecord('folders', { ...folder, name })
}

export async function deleteItem(item: Item): Promise<boolean> {
  const ok = await confirm({
    title: `„${item.title}“ löschen?`,
    message: 'Die Notiz bzw. Datei wird endgültig entfernt.',
    confirmLabel: 'Löschen',
    danger: true,
  })
  if (ok) await removeRecord('items', item.id)
  return ok
}

export async function deleteFolder(folder: Folder): Promise<boolean> {
  const db = getDb()
  const count = db.items.filter((i) => i.folderId === folder.id).length
  const ok = await confirm({
    title: `Ordner „${folder.name}“ löschen?`,
    message: count ? `Der Ordner enthält ${count} Einträge, die ebenfalls gelöscht werden.` : undefined,
    confirmLabel: 'Löschen',
    danger: true,
  })
  if (ok) await removeRecord('folders', folder.id)
  return ok
}

export async function deleteModule(module: Module): Promise<boolean> {
  const ok = await confirm({
    title: `Modul „${module.name}“ löschen?`,
    message: 'Alle Ordner, Notizen, Dateien, Aufgaben und Termine des Moduls werden gelöscht.',
    confirmLabel: 'Modul löschen',
    danger: true,
  })
  if (ok) await removeRecord('modules', module.id)
  return ok
}
