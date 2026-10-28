import { describe, expect, it } from 'vitest'
import { BrowserStore, KeyValueSecrets } from '../src/backend/browser-store'
import { readLimited } from '../src/backend/http'
import type { LayoutFs } from '../src/backend/documents-layout'
import { createMemoryKeyValueStore } from '../src/backend/key-value'
import { createService } from '../src/backend/service'
import { DEFAULT_SETTINGS, emptyNote, newId, newModule } from '../src/shared/defaults'
import { buildSemester } from '../src/shared/semester'
import type { Semester } from '../src/shared/types'

function makeSemester(kind: 'winter' | 'summer', year: number): Semester {
  return { ...buildSemester('uni', kind, year), id: newId(), createdAt: new Date().toISOString() }
}

const openStore = () => BrowserStore.open(createMemoryKeyValueStore())

/** A store with one semester and one module */
async function storeWithModule(name = 'Informatik') {
  const store = await openStore()
  const semester = makeSemester('winter', 2026)
  store.put('semesters', semester)
  const module = newModule(semester.id, { name, code: 'INF', color: 'green' })
  store.put('modules', module)
  return { store, module }
}

const pdf = (name: string) => ({
  name,
  type: 'application/pdf',
  bytes: new Uint8Array([37, 80, 68, 70]),
})

describe('BrowserStore (Android storage)', () => {
  it('starts with an empty default database', async () => {
    const db = (await openStore()).get()
    expect(db.settings.appearance).toBeDefined()
    expect(db.modules).toEqual([])
    expect(db.items).toEqual([])
  })

  it('supports put, update and replaceMany', async () => {
    const { store, module } = await storeWithModule('Mathematik 1')
    store.update({ onboarded: true })
    expect(store.get().onboarded).toBe(true)
    store.replaceMany('modules', (m) => m.id === module.id, [{ ...module, name: 'Mathematik I' }])
    expect(store.get().modules[0].name).toBe('Mathematik I')
  })

  it('persists the database and reloads it', async () => {
    const storage = createMemoryKeyValueStore()
    const store = await BrowserStore.open(storage)
    store.update({ onboarded: true })
    await store.flush()
    expect((await BrowserStore.open(storage)).get().onboarded).toBe(true)
  })

  it('deletes dependent items and their content with a module', async () => {
    const { store, module } = await storeWithModule()
    const file = await store.addFile({ moduleId: module.id, folderId: null }, pdf('Uebung01.pdf'))
    await store.writeNote(file.id, { ...emptyNote(DEFAULT_SETTINGS.editor), text: 'Notiz' })
    expect((await store.readNote(file.id))?.text).toBe('Notiz')

    await store.remove('modules', module.id)
    expect(store.get().items).toHaveLength(0)
    expect(await store.readNote(file.id)).toBeNull()
    expect(await store.readFile(file.fileName!)).toBeNull()
    expect(store.fileUrl(file)).toBe('')
  })

  it('searches extracted text', async () => {
    const { store, module } = await storeWithModule('Physik')
    const item = await store.addFile({ moduleId: module.id, folderId: null }, pdf('Skript.pdf'))
    await store.writeText(item.id, 'Ein Kapitel über Schrödinger-Gleichungen.')
    const hits = await store.search('Schrödinger')
    expect(hits.map((h) => h.itemId)).toEqual([item.id])
  })

  it('serves stored files through object URLs and returns their bytes', async () => {
    const { store, module } = await storeWithModule('Chemie')
    const item = await store.addFile({ moduleId: module.id, folderId: null }, pdf('Protokoll.pdf'))
    expect(store.fileUrl(item)).toMatch(/^blob:/)
    expect(await store.readFile(item.fileName!)).toEqual(new Uint8Array([37, 80, 68, 70]))
  })

  it('keeps secrets across a data reset until they are cleared explicitly', async () => {
    const store = await openStore()
    const secrets = new KeyValueSecrets(store.storage)
    await secrets.set('ai:openai', 'sk-test')
    await store.reset()
    expect(await secrets.get('ai:openai')).toBe('sk-test')
    await secrets.clear()
    expect(await secrets.get('ai:openai')).toBeNull()
  })

  it('runs the backend service and imports a setup file', async () => {
    const source = await storeWithModule('Analysis')
    const sourceService = createService(source.store, new KeyValueSecrets(source.store.storage))
    const file = await sourceService.setupExport({ scope: 'study', includeCredentials: false })

    const target = await openStore()
    const service = createService(target, new KeyValueSecrets(target.storage), {
      platform: 'android',
    })
    await service.setupImport(JSON.stringify(file))
    expect(target.get().modules.map((m) => m.name)).toEqual(['Analysis'])
  })
})

describe('readLimited', () => {
  const responseOf = (chunks: Uint8Array[], contentLength = '') =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
      { headers: contentLength ? { 'content-length': contentLength } : {} },
    )

  it('concatenates all chunks', async () => {
    const bytes = await readLimited(
      responseOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
      10,
      'X',
    )
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('stops at the size limit', async () => {
    await expect(
      readLimited(responseOf([new Uint8Array(8), new Uint8Array(8)]), 10, 'X'),
    ).rejects.toThrow('zu groß')
  })
})

describe('BrowserStore documents folder', () => {
  /** In-memory file system standing in for Android's Documents folder */
  function memoryFs() {
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    const fs: LayoutFs = {
      exists: async (rel) => files.has(rel) || dirs.has(rel),
      mkdir: async (rel) => {
        dirs.add(rel)
      },
      move: async (from, to) => {
        files.set(to, files.get(from)!)
        files.delete(from)
      },
      remove: async (rel) => {
        files.delete(rel)
      },
      removeDirIfEmpty: async (rel) => {
        const used = [...files.keys(), ...dirs].some((p) => p.startsWith(`${rel}/`))
        if (!used) dirs.delete(rel)
      },
      createFile: async (item, rel) => {
        files.set(rel, `file:${item.fileName}`)
        return true
      },
      writeText: async (rel, text) => {
        files.set(rel, text)
      },
    }
    return { fs, files, dirs }
  }

  it('copies documents into the readable structure and follows renames', async () => {
    const { store, module } = await storeWithModule('Analysis')
    const { fs, files } = memoryFs()
    await store.attachDocumentsFolder(fs)
    const item = await store.addFile({ moduleId: module.id, folderId: null }, pdf('Blatt_1.pdf'))
    await store.flush()
    await store.syncDocuments()
    const semesterName = store.get().semesters[0].name.replace('/', '-')
    expect(files.get(`${semesterName}/Analysis/Blatt 1.pdf`)).toBe(`file:${item.fileName}`)

    store.put('items', { ...item, title: 'Blatt eins' })
    await store.flush()
    await store.syncDocuments()
    expect([...files.keys()]).toEqual([`${semesterName}/Analysis/Blatt eins.pdf`])

    await store.remove('items', item.id)
    expect(files.size).toBe(0)
  })
})
