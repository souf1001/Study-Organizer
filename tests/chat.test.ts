import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/backend/store'
import { newChatSession, newModule, normalizeDb } from '../src/shared/defaults'
import type { ChatSession, Semester } from '../src/shared/types'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'study-chat-'))
  store = await Store.open(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ChatSession data model & normalization', () => {
  it('creates a valid ChatSession with default values', () => {
    const chat = newChatSession()
    expect(chat.id).toBeDefined()
    expect(chat.title).toBe('Neuer Chat')
    expect(chat.moduleId).toBeNull()
    expect(chat.messages).toEqual([])
    expect(chat.createdAt).toBeDefined()
    expect(chat.updatedAt).toBeDefined()
  })

  it('creates a ChatSession linked to a module', () => {
    const chat = newChatSession('mod-123', { title: 'Analysis Fragen' })
    expect(chat.moduleId).toBe('mod-123')
    expect(chat.title).toBe('Analysis Fragen')
  })

  it('normalizeDb initializes a missing chats field', () => {
    const db = normalizeDb({})
    expect(db.chats).toBeDefined()
    expect(Array.isArray(db.chats)).toBe(true)
    expect(db.chats).toHaveLength(0)
  })

  it('normalizeDb cleans up incomplete or corrupted chats', () => {
    const raw = {
      chats: [
        {
          id: 'chat-1',
          // title is missing
          // messages is not an array
          messages: 'ungültig' as unknown as [],
        },
      ],
    }
    const db = normalizeDb(raw as unknown as Parameters<typeof normalizeDb>[0])
    expect(db.chats).toHaveLength(1)
    expect(db.chats[0].id).toBe('chat-1')
    expect(db.chats[0].title).toBe('Neuer Chat')
    expect(db.chats[0].messages).toEqual([])
    expect(db.chats[0].moduleId).toBeNull()
    expect(db.chats[0].createdAt).toBeDefined()
    expect(db.chats[0].updatedAt).toBeDefined()
  })
})

describe('ChatSession persistence in the store', () => {
  it('persists and reloads chats via Store.open', async () => {
    const chat1: ChatSession = {
      id: 'chat-1',
      moduleId: 'mod-lin-alg',
      title: 'Eigenvektoren berechnen',
      messages: [
        { role: 'user', content: 'Wie bestimme ich Eigenwerte?' },
        {
          role: 'assistant',
          content: 'Über das charakteristische Polynom $\\det(A - \\lambda I) = 0$.',
        },
      ],
      createdAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T10:05:00.000Z',
    }

    const chat2: ChatSession = {
      id: 'chat-2',
      moduleId: null, // General chat
      title: 'Lernplan für die Semesterferien',
      messages: [{ role: 'user', content: 'Erstelle mir einen Zeitplan.' }],
      createdAt: '2026-10-24T11:00:00.000Z',
      updatedAt: '2026-10-24T11:00:00.000Z',
    }

    store.put('chats', chat1)
    store.put('chats', chat2)
    await store.flush()

    const reopened = await Store.open(dir)
    const chats = reopened.get().chats
    expect(chats).toHaveLength(2)

    const re1 = chats.find((c) => c.id === 'chat-1')
    expect(re1).toBeDefined()
    expect(re1?.title).toBe('Eigenvektoren berechnen')
    expect(re1?.moduleId).toBe('mod-lin-alg')
    expect(re1?.messages).toHaveLength(2)
    expect(re1?.messages[1].content).toContain('\\det(A - \\lambda I)')

    const re2 = chats.find((c) => c.id === 'chat-2')
    expect(re2).toBeDefined()
    expect(re2?.moduleId).toBeNull()
  })

  it('updates existing chats without creating duplicates', async () => {
    const chat: ChatSession = newChatSession('mod-1', { id: 'c-unique', title: 'Frage 1' })
    store.put('chats', chat)
    expect(store.get().chats).toHaveLength(1)

    // Add a reply and update
    store.put('chats', {
      ...chat,
      title: 'Umbenannte Frage 1',
      messages: [{ role: 'user', content: 'Hallo' }],
      updatedAt: '2026-10-24T12:00:00.000Z',
    })

    expect(store.get().chats).toHaveLength(1)
    expect(store.get().chats[0].title).toBe('Umbenannte Frage 1')
    expect(store.get().chats[0].messages).toHaveLength(1)
  })

  it('deletes a single chat', async () => {
    const chat1 = newChatSession('mod-1', { id: 'c-1' })
    const chat2 = newChatSession('mod-2', { id: 'c-2' })
    store.put('chats', chat1)
    store.put('chats', chat2)
    expect(store.get().chats).toHaveLength(2)

    await store.remove('chats', 'c-1')
    expect(store.get().chats).toHaveLength(1)
    expect(store.get().chats[0].id).toBe('c-2')
  })
})

describe('Per-module cascading & linking', () => {
  it('deletes all related chats when a module is removed (cascade)', async () => {
    const modA = newModule('sem-1', { id: 'mod-a', name: 'Softwaretechnik' })
    const modB = newModule('sem-1', { id: 'mod-b', name: 'Rechnerarchitektur' })
    store.put('modules', modA)
    store.put('modules', modB)

    const chatA1 = newChatSession(modA.id, { id: 'chat-a1', title: 'Design Patterns' })
    const chatA2 = newChatSession(modA.id, { id: 'chat-a2', title: 'Refactoring' })
    const chatB1 = newChatSession(modB.id, { id: 'chat-b1', title: 'Pipelining' })
    const chatGeneral = newChatSession(null, { id: 'chat-gen', title: 'Stipendium Bewerbung' })

    store.put('chats', chatA1)
    store.put('chats', chatA2)
    store.put('chats', chatB1)
    store.put('chats', chatGeneral)
    expect(store.get().chats).toHaveLength(4)

    // Delete module A
    await store.remove('modules', modA.id)

    const remainingChats = store.get().chats
    // Chats of module A must be removed
    expect(remainingChats.some((c) => c.moduleId === modA.id)).toBe(false)
    expect(remainingChats.find((c) => c.id === 'chat-a1')).toBeUndefined()
    expect(remainingChats.find((c) => c.id === 'chat-a2')).toBeUndefined()

    // Chats of module B and the general chat must be kept
    expect(remainingChats.find((c) => c.id === 'chat-b1')).toBeDefined()
    expect(remainingChats.find((c) => c.id === 'chat-gen')).toBeDefined()
    expect(remainingChats).toHaveLength(2)
  })

  it('filters chats by module and date', () => {
    const c1 = newChatSession('mod-1', { id: '1', updatedAt: '2026-10-20T10:00:00Z' })
    const c2 = newChatSession('mod-1', { id: '2', updatedAt: '2026-10-24T10:00:00Z' })
    const c3 = newChatSession('mod-2', { id: '3', updatedAt: '2026-10-22T10:00:00Z' })
    const c4 = newChatSession(null, { id: '4', updatedAt: '2026-10-23T10:00:00Z' })

    const all = [c1, c2, c3, c4]

    // Module 1 chats, most recent first
    const mod1Chats = all
      .filter((c) => c.moduleId === 'mod-1')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    expect(mod1Chats.map((c) => c.id)).toEqual(['2', '1'])

    // General chats (no module)
    const generalChats = all.filter((c) => !c.moduleId)
    expect(generalChats.map((c) => c.id)).toEqual(['4'])
  })

  it('deletes all chats of the contained modules when a semester is removed (cascade)', async () => {
    const sem: Semester = {
      id: 'sem-ws26',
      name: 'WS 26/27',
      kind: 'winter',
      year: 2026,
      start: '2026-10-01',
      end: '2027-03-31',
      lectureStart: '2026-10-12',
      lectureEnd: '2027-02-12',
      breaks: [],
      createdAt: new Date().toISOString(),
    }
    store.put('semesters', sem)

    const mod1 = newModule(sem.id, { id: 'mod-sem1', name: 'Mathematik 1' })
    const mod2 = newModule(sem.id, { id: 'mod-sem2', name: 'Informatik 1' })
    store.put('modules', mod1)
    store.put('modules', mod2)

    const chatMod1 = newChatSession(mod1.id, { id: 'c-m1', title: 'Mathe Chat' })
    const chatMod2 = newChatSession(mod2.id, { id: 'c-m2', title: 'Info Chat' })
    const chatOther = newChatSession(null, { id: 'c-oth', title: 'Allgemein' })

    store.put('chats', chatMod1)
    store.put('chats', chatMod2)
    store.put('chats', chatOther)

    expect(store.get().chats).toHaveLength(3)

    // Delete the semester
    await store.remove('semesters', sem.id)

    const remaining = store.get().chats
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('c-oth')
  })

  it('normalizeDb cleans up corrupt and non-conforming message objects', () => {
    const raw = {
      chats: [
        {
          id: 'chat-corrupt',
          title: 'Test',
          messages: [
            null,
            { role: 'user', content: 'Gültige Frage' },
            { role: 'unbekannt', content: 'Ungültige Rolle' },
            { role: 'assistant', content: 42 }, // content is not a string
            { role: 'assistant', content: 'Gültige Antwort' },
            undefined,
          ],
        },
      ],
    }

    const db = normalizeDb(raw as unknown as Parameters<typeof normalizeDb>[0])
    expect(db.chats[0].messages).toHaveLength(2)
    expect(db.chats[0].messages[0]).toEqual({ role: 'user', content: 'Gültige Frage' })
    expect(db.chats[0].messages[1]).toEqual({ role: 'assistant', content: 'Gültige Antwort' })
  })

  it('generates clean single-line chat titles without leading Markdown formatting or line breaks', () => {
    const generateCleanTitle = (question: string) => {
      const firstNonEmpty =
        question
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean) || question.trim()
      const firstLine = firstNonEmpty.replace(/^[#*`_\s-]+/, '').trim() || firstNonEmpty
      return firstLine.length > 45 ? firstLine.slice(0, 42) + '…' : firstLine
    }

    expect(generateCleanTitle('### Zusammenfassung von Kapitel 1\nZweite Zeile')).toBe(
      'Zusammenfassung von Kapitel 1',
    )
    expect(generateCleanTitle('\n\n* Was ist eine Matrix?')).toBe('Was ist eine Matrix?')
    expect(
      generateCleanTitle(
        'Dies ist ein extrem langer Text der definitiv mehr als fünfundvierzig Zeichen enthält und gekürzt werden muss',
      ),
    ).toBe('Dies ist ein extrem langer Text der defini…')
  })
})
