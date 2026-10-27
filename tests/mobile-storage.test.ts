import { describe, expect, it } from 'vitest'
import { ClientStore, ClientSecrets } from '../src/backend/client-store'
import { DEFAULT_SETTINGS, emptyNote, newId, newModule } from '../src/shared/defaults'
import { buildSemester } from '../src/shared/semester'
import type { Semester } from '../src/shared/types'

function makeSemester(kind: 'winter' | 'summer', year: number): Semester {
  return {
    ...buildSemester('uni', kind, year),
    id: newId(),
    createdAt: new Date().toISOString(),
  }
}

describe('ClientStore (In-Memory / IndexedDB)', () => {
  it('initialisiert eine Standard-Datenbank mit Semester und Einstellungen', async () => {
    const store = await ClientStore.open()
    const db = store.get()
    expect(db.settings).toBeDefined()
    expect(db.settings.appearance).toBeDefined()
    expect(db.modules).toEqual([])
    expect(db.items).toEqual([])
  })

  it('unterstützt put, update und replaceMany', async () => {
    const store = await ClientStore.open()
    const sem = makeSemester('winter', 2026)
    store.put('semesters', sem)
    expect(store.get().semesters).toContainEqual(sem)

    const mod = newModule(sem.id, { name: 'Mathematik 1', code: 'MAT1', color: 'blue' })
    store.put('modules', mod)
    expect(store.get().modules).toHaveLength(1)

    store.update({ onboarded: true, activeSemesterId: sem.id })
    expect(store.get().onboarded).toBe(true)
    expect(store.get().activeSemesterId).toBe(sem.id)

    store.replaceMany('modules', (m) => m.id === mod.id, [{ ...mod, name: 'Mathematik I (angepasst)' }])
    expect(store.get().modules[0].name).toBe('Mathematik I (angepasst)')
  })

  it('führt kaskadierende Löschungen sauber durch', async () => {
    const store = await ClientStore.open()
    const sem = makeSemester('summer', 2026)
    store.put('semesters', sem)
    const mod = newModule(sem.id, { name: 'Informatik', code: 'INF', color: 'green' })
    store.put('modules', mod)

    const fileItem = await store.addFile({ moduleId: mod.id, folderId: null }, {
      name: 'Uebung01.pdf',
      type: 'application/pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    })
    expect(store.get().items).toHaveLength(1)

    await store.writeNote(fileItem.id, { ...emptyNote(DEFAULT_SETTINGS.editor), text: 'Notiz' })
    expect((await store.readNote(fileItem.id))?.text).toBe('Notiz')

    // Modul löschen -> Item und zugehörige Daten werden mitgelöscht
    await store.remove('modules', mod.id)
    expect(store.get().modules).toHaveLength(0)
    expect(store.get().items).toHaveLength(0)
    expect(await store.readNote(fileItem.id)).toBeNull()
  })

  it('unterstützt Notizen, Annotationen und Volltext-Suche', async () => {
    const store = await ClientStore.open()
    const sem = makeSemester('winter', 2026)
    store.put('semesters', sem)
    const mod = newModule(sem.id, { name: 'Physik', code: 'PHY', color: 'orange' })
    store.put('modules', mod)

    const item = await store.addFile({ moduleId: mod.id, folderId: null }, {
      name: 'Skript_Quantenmechanik.pdf',
      type: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    })
    await store.writeText(item.id, 'Dies ist ein Kapitel über Schrödinger-Gleichungen und Wellenfunktionen.')

    const hits = await store.search('Schrödinger')
    expect(hits).toHaveLength(1)
    expect(hits[0].itemId).toBe(item.id)
    expect(hits[0].snippet).toContain('Schrödinger')
  })

  it('speichert und liest ClientSecrets getrennt', async () => {
    const store = await ClientStore.open()
    const secrets = new ClientSecrets(store)
    await secrets.set('ai:openai', 'sk-test-secret-123')
    expect(await secrets.get('ai:openai')).toBe('sk-test-secret-123')
    await secrets.remove('ai:openai')
    expect(await secrets.get('ai:openai')).toBeNull()
  })
})

describe('ClientStore mit createService', () => {
  it('funktioniert nahtlos mit createService der Backend-Logik', async () => {
    const store = await ClientStore.open()
    const secrets = new ClientSecrets(store)
    const { createService } = await import('../src/backend/service')
    const service = createService(store as any, secrets)

    expect(typeof service.loadDb).toBe('function')
    expect(typeof service.calendarSubscribe).toBe('function')
    expect(typeof service.calendarSync).toBe('function')
    expect(typeof service.moodleConnect).toBe('function')
    expect(typeof service.aiStream).toBe('function')

    const db = service.loadDb()
    expect(db).toBeDefined()
    expect(db.settings).toBeDefined()
  })
})
