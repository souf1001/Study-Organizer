import { access, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planLayout, safeName } from '../src/backend/documents-layout'
import { Store } from '../src/backend/store'
import { createDefaultDb, newFolder, newModule, newNoteItem } from '../src/shared/defaults'
import { noteToMarkdown } from '../src/shared/note-markdown'
import type { NoteDoc, Semester } from '../src/shared/types'

const semester = (name: string): Semester => ({
  id: `sem${name.replace(/\W/g, '')}`,
  name,
  kind: 'winter',
  year: 2026,
  start: '2026-10-01',
  end: '2027-03-31',
  lectureStart: '2026-10-12',
  lectureEnd: '2027-02-05',
  breaks: [],
  createdAt: '2026-10-01T00:00:00.000Z',
})

const note = (text: string, content: NoteDoc['content'] = null): NoteDoc => ({
  content,
  strokes: [],
  paper: 'plain',
  paperColor: 'auto',
  font: 'inter',
  height: 1000,
  text,
})

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

describe('safeName', () => {
  it('removes characters that are not allowed in file names', () => {
    expect(safeName('WiSe 2026/27')).toBe('WiSe 2026-27')
    expect(safeName('Vorlesung 3 · 14.10.')).toBe('Vorlesung 3 · 14.10')
    expect(safeName('a:b*c?')).toBe('a-b-c-')
    expect(safeName('  ')).toBe('Unbenannt')
    expect(safeName('CON')).toBe('_CON')
    expect(safeName('..')).toBe('Unbenannt')
  })
})

describe('planLayout', () => {
  it('mirrors semesters, modules, folders and items as paths', () => {
    const db = createDefaultDb()
    const sem = semester('WiSe 2026/27')
    const module = newModule(sem.id, { name: 'Analysis 1' })
    const moodle = newFolder(module.id, { name: 'Moodle' })
    const section = newFolder(module.id, { name: 'Woche 1', parentId: moodle.id })
    const pdf = {
      ...newNoteItem(module.id, section.id, 'Folien'),
      kind: 'file' as const,
      fileName: 'abc.pdf',
    }
    const notes = newNoteItem(module.id, null, 'Mitschrift')
    const twin = { ...newNoteItem(module.id, null, 'Mitschrift'), createdAt: '2099-01-01' }
    db.semesters.push(sem)
    db.modules.push(module)
    db.folders.push(section, moodle)
    db.items.push(pdf, notes, twin)

    const plan = planLayout(db)
    expect(plan.files.get(pdf.id)).toBe('WiSe 2026-27/Analysis 1/Moodle/Woche 1/Folien.pdf')
    expect(plan.files.get(notes.id)).toBe('WiSe 2026-27/Analysis 1/Mitschrift.md')
    expect(plan.files.get(twin.id)).toBe('WiSe 2026-27/Analysis 1/Mitschrift (2).md')
    expect(plan.dirs).toContain('WiSe 2026-27/Analysis 1/Moodle/Woche 1')
  })

  it('leaves out images pasted into notes', () => {
    const db = createDefaultDb()
    const module = newModule('none', { name: 'M' })
    const image = {
      ...newNoteItem(module.id, null, 'Bild'),
      kind: 'file' as const,
      fileName: 'img.png',
      attachedTo: 'note1',
    }
    db.modules.push(module)
    db.items.push(image)
    const plan = planLayout(db)
    expect(plan.files.has(image.id)).toBe(false)
    expect(plan.dirs).toEqual(['Ohne Semester', 'Ohne Semester/M'])
  })
})

describe('noteToMarkdown', () => {
  it('converts headings, lists, math and tables', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Satz' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'fett', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' und ' },
            { type: 'inlineMath', attrs: { latex: 'a^2' } },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'erledigt' }] }],
            },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(noteToMarkdown('Titel', note('', content))).toBe(
      '# Titel\n\n## Satz\n\n**fett** und $a^2$\n\n- [x] erledigt\n\n| A | B |\n| --- | --- |\n',
    )
  })

  it('falls back to the plain text', () => {
    expect(noteToMarkdown('T', note('Hallo'))).toBe('# T\n\nHallo\n')
  })
})

describe('Store with documents folder', () => {
  let dir: string
  let docs: string
  let store: Store

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'study-layout-'))
    docs = path.join(dir, 'Dokumente')
    store = await Store.open(path.join(dir, 'data'), docs)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    const sem = semester('SoSe 2027')
    const module = newModule(sem.id, { name: 'Physik' })
    const folder = newFolder(module.id, { name: 'Vorlesung 1' })
    store.put('semesters', sem)
    store.put('modules', module)
    store.put('folders', folder)
    const upload = path.join(dir, 'upload.pdf')
    await writeFile(upload, 'pdf')
    const file = await store.addFile(
      { moduleId: module.id, folderId: folder.id },
      { name: 'Skript_Kapitel_1.pdf', type: '', path: upload },
    )
    await store.flush()
    return { sem, module, folder, file }
  }

  it('places uploads under semester / module / folder with their title', async () => {
    const { file } = await setup()
    const expected = path.join(docs, 'SoSe 2027', 'Physik', 'Vorlesung 1', 'Skript Kapitel 1.pdf')
    expect(await readFile(expected, 'utf8')).toBe('pdf')
    expect(store.filePath(file.fileName!)).toBe(expected)
    expect(await readdir(path.join(dir, 'data', 'files'))).toEqual([])
  })

  it('follows renames and moves, and removes folders that became empty', async () => {
    const { module, folder, file } = await setup()
    store.put('modules', { ...module, name: 'Physik 2' })
    store.put('items', { ...file, title: 'Skript' })
    await store.flush()
    expect(
      await exists(path.join(docs, 'SoSe 2027', 'Physik 2', 'Vorlesung 1', 'Skript.pdf')),
    ).toBe(true)
    expect(await exists(path.join(docs, 'SoSe 2027', 'Physik'))).toBe(false)

    store.put('items', { ...file, title: 'Skript', folderId: null })
    await store.remove('folders', folder.id)
    await store.flush()
    expect(await exists(path.join(docs, 'SoSe 2027', 'Physik 2', 'Skript.pdf'))).toBe(true)
    expect(await exists(path.join(docs, 'SoSe 2027', 'Physik 2', 'Vorlesung 1'))).toBe(false)
  })

  it('never overwrites or deletes files it did not create', async () => {
    const { module } = await setup()
    const foreignDir = path.join(docs, 'SoSe 2027', 'Physik', 'Agent')
    await mkdir(foreignDir, { recursive: true })
    await writeFile(path.join(foreignDir, 'todo.md'), 'eigene Datei')
    const taken = path.join(docs, 'SoSe 2027', 'Physik', 'Notiz.md')
    await writeFile(taken, 'fremd')

    const item = newNoteItem(module.id, null, 'Notiz')
    store.put('items', item)
    await store.writeNote(item.id, note('Inhalt'))
    await store.flush()
    expect(await readFile(taken, 'utf8')).toBe('fremd')
    expect(await readFile(path.join(docs, 'SoSe 2027', 'Physik', 'Notiz (2).md'), 'utf8')).toBe(
      '# Notiz\n\nInhalt\n',
    )

    await store.remove('modules', module.id)
    await store.flush()
    expect(await readFile(path.join(foreignDir, 'todo.md'), 'utf8')).toBe('eigene Datei')
    expect(await exists(path.join(docs, 'SoSe 2027', 'Physik', 'Notiz (2).md'))).toBe(false)
  })

  it('keeps the Markdown copy of a note up to date', async () => {
    const { module } = await setup()
    const item = newNoteItem(module.id, null, 'Mitschrift')
    store.put('items', item)
    await store.writeNote(item.id, note('Erste Fassung'))
    await store.flush()
    const md = path.join(docs, 'SoSe 2027', 'Physik', 'Mitschrift.md')
    expect(await readFile(md, 'utf8')).toContain('Erste Fassung')
    await store.writeNote(item.id, note('Zweite Fassung'))
    expect(await readFile(md, 'utf8')).toContain('Zweite Fassung')
  })

  it('moves files of older versions out of the data folder on start', async () => {
    const legacy = path.join(dir, 'legacy')
    const first = await Store.open(legacy, path.join(dir, 'unused'))
    const module = newModule('x', { name: 'Alt' })
    first.put('modules', module)
    first.put('items', {
      ...newNoteItem(module.id, null, 'Blatt'),
      id: 'old1',
      kind: 'file',
      fileName: 'old1.pdf',
    })
    await first.flush()
    // Simulate the old layout: file in <data>/files, no layout.json
    await rm(path.join(legacy, 'layout.json'))
    await rm(path.join(dir, 'unused'), { recursive: true, force: true })
    await writeFile(path.join(legacy, 'files', 'old1.pdf'), 'alt')

    const reopened = await Store.open(legacy, path.join(dir, 'neu'))
    const moved = path.join(dir, 'neu', 'Ohne Semester', 'Alt', 'Blatt.pdf')
    expect(await readFile(moved, 'utf8')).toBe('alt')
    expect(reopened.filePath('old1.pdf')).toBe(moved)
  })

  it('moves the documents folder to a new location', async () => {
    const { file } = await setup()
    const target = path.join(dir, 'Cloud', 'Study Organizer')
    await store.setDocumentsDir(target)
    expect(store.documentsDir).toBe(target)
    expect(store.filePath(file.fileName!)).toBe(
      path.join(target, 'SoSe 2027', 'Physik', 'Vorlesung 1', 'Skript Kapitel 1.pdf'),
    )
    expect(await exists(docs)).toBe(false)
    const reopened = await Store.open(path.join(dir, 'data'), docs)
    expect(reopened.documentsDir).toBe(target)
  })

  it('reset removes only what the app created', async () => {
    await setup()
    await writeFile(path.join(docs, 'eigene.txt'), 'bleibt')
    await store.reset()
    expect(await readdir(docs)).toEqual(['eigene.txt'])
  })
})
