import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/backend/store'
import { newFolder, newModule, newNoteItem, newTask } from '../src/shared/defaults'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'study-'))
  store = await Store.open(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const exists = (p: string) => access(p).then(() => true, () => false)

describe('Store', () => {
  it('speichert und lädt Datensätze', async () => {
    const module = newModule('sem', { name: 'Mathe 1' })
    store.put('modules', module)
    await store.flush()
    const reopened = await Store.open(dir)
    expect(reopened.get().modules[0].name).toBe('Mathe 1')
  })

  it('aktualisiert bestehende Datensätze statt sie zu verdoppeln', () => {
    const module = newModule('sem', { name: 'A' })
    store.put('modules', module)
    store.put('modules', { ...module, name: 'B' })
    expect(store.get().modules).toHaveLength(1)
    expect(store.get().modules[0].name).toBe('B')
  })

  it('löscht ein Modul samt Ordnern, Notizen, Dateien und Aufgaben', async () => {
    const module = newModule('sem')
    const folder = newFolder(module.id)
    const sub = newFolder(module.id, { parentId: folder.id })
    const note = newNoteItem(module.id, sub.id)
    store.put('modules', module)
    store.put('folders', folder)
    store.put('folders', sub)
    store.put('items', note)
    store.put('tasks', newTask({ moduleId: module.id }))
    await store.writeNote(note.id, { content: null, strokes: [], paper: 'plain', paperColor: 'auto', font: 'inter', height: 1000, text: 'Hallo' })
    const tmpFile = path.join(dir, 'upload.pdf')
    await writeFile(tmpFile, 'pdf')
    const file = await store.addFile({ moduleId: module.id, folderId: folder.id }, { name: 'Folien_1.pdf', type: '', path: tmpFile })
    expect(file.title).toBe('Folien 1')
    expect(file.fileType).toBe('pdf')

    await store.remove('modules', module.id)
    const db = store.get()
    expect(db.modules).toHaveLength(0)
    expect(db.folders).toHaveLength(0)
    expect(db.items).toHaveLength(0)
    expect(db.tasks).toHaveLength(0)
    expect(await exists(path.join(dir, 'notes', `${note.id}.json`))).toBe(false)
    expect(await exists(store.filePath(file.fileName!))).toBe(false)
  })

  it('löscht Unterordner rekursiv', async () => {
    const a = newFolder('m')
    const b = newFolder('m', { parentId: a.id })
    const c = newFolder('m', { parentId: b.id })
    const other = newFolder('m')
    for (const f of [a, b, c, other]) store.put('folders', f)
    store.put('items', newNoteItem('m', c.id))
    await store.remove('folders', a.id)
    expect(store.get().folders.map((f) => f.id)).toEqual([other.id])
    expect(store.get().items).toHaveLength(0)
  })

  it('lehnt unsichere IDs und Sammlungen ab', async () => {
    await expect(store.readNote('../../etc/passwd')).rejects.toThrow('Ungültige ID')
    expect(() => store.filePath('../db.json')).toThrow('Ungültiger Dateiname')
    // @ts-expect-error absichtlich falsche Sammlung
    expect(() => store.put('profile', { id: 'x' })).toThrow('Unbekannte Sammlung')
    // @ts-expect-error absichtlich falsches Feld
    expect(() => store.update({ semesters: [] })).toThrow('Feld nicht erlaubt')
  })

  it('durchsucht Notizen und PDF-Texte', async () => {
    const note = newNoteItem('m', null)
    store.put('items', note)
    await store.writeNote(note.id, { content: null, strokes: [], paper: 'plain', paperColor: 'auto', font: 'inter', height: 1000, text: 'Die Fourier-Transformation zerlegt Signale.' })
    const hits = await store.search('fourier')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('Fourier')
  })

  it('schreibt db.json atomar als gültiges JSON', async () => {
    store.put('modules', newModule('s'))
    await store.flush()
    const text = await readFile(path.join(dir, 'db.json'), 'utf8')
    expect(JSON.parse(text).modules).toHaveLength(1)
  })
})

describe('Atomares Schreiben', () => {
  it('überlebt einen fehlgeschlagenen Schreibvorgang und schreibt parallele Änderungen der Reihe nach', async () => {
    const { writeAtomic } = await import('../src/backend/store')
    const file = path.join(dir, 'x.json')
    await expect(writeAtomic(path.join(dir, 'fehlt', 'x.json'), '1')).rejects.toThrow()
    await Promise.all([writeAtomic(file, '"a"'), writeAtomic(file, '"b"'), writeAtomic(file, '"c"')])
    expect(await readFile(file, 'utf8')).toBe('"c"')
    store.put('modules', newModule('s'))
    await store.flush()
    expect(JSON.parse(await readFile(path.join(dir, 'db.json'), 'utf8')).modules).toHaveLength(1)
  })
})
