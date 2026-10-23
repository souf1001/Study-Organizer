import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyEvent,
  eventsFromIcs,
  matchModule,
  normalizeRomanNumerals,
} from '../src/backend/ics'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { newModule } from '../src/shared/defaults'
import type { Module, Subscription } from '../src/shared/types'

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, value: string) => void data.set(name, value),
    remove: async (name: string) => void data.delete(name),
  }
}

function vcal(body: string, prodid = '-//TU Darmstadt//TUCaN//DE'): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:${prodid}\r\nCALSCALE:GREGORIAN\r\n${body}\r\nEND:VCALENDAR\r\n`
}

function vevent(p: {
  uid: string
  summary: string
  start: string
  end?: string
  location?: string
  description?: string
  categories?: string[]
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`]
  lines.push(`SUMMARY:${p.summary}`)
  lines.push(`DTSTART:${p.start}`)
  if (p.end) lines.push(`DTEND:${p.end}`)
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  if (p.categories?.length) lines.push(`CATEGORIES:${p.categories.join(',')}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

describe('Empirical Stress: Two-Stage Module Matching & Description Poisoning', () => {
  it('Title match ALWAYS overrides description match regardless of module ordering in DB', () => {
    const modDesc = newModule('sem-1', { id: 'mod-desc', name: 'Mathematik 1', code: 'MATH-1' })
    const modTitle = newModule('sem-1', { id: 'mod-title', name: 'Physik 1', code: 'PHYS-1' })

    const event = {
      uid: 'ev-1',
      title: 'Physik 1 Vorlesung',
      description: 'Voraussetzung: Kenntnisse in Mathematik 1 (MATH-1) erforderlich!',
      categories: [],
      start: new Date('2026-10-12T08:00:00Z'),
      end: new Date('2026-10-12T09:30:00Z'),
      allDay: false,
      location: 'Hörsaal 1',
    }

    // Test with modDesc FIRST in array
    expect(matchModule(event, [modDesc, modTitle])).toBe('mod-title')

    // Test with modTitle FIRST in array
    expect(matchModule(event, [modTitle, modDesc])).toBe('mod-title')
  })

  it('Stage 2 executes and matches description when title has no match', () => {
    const mod = newModule('sem-1', { id: 'mod-algo', name: 'Algorithmen', code: 'CS-201' })

    const eventWithNoTitleMatch = {
      uid: 'ev-2',
      title: 'Zusatztermin Fragestunde',
      description: 'Sprechstunde für das Modul Algorithmen (CS-201)',
      categories: [],
      start: new Date('2026-10-12T10:00:00Z'),
      end: new Date('2026-10-12T11:00:00Z'),
      allDay: false,
      location: 'Online',
    }

    expect(matchModule(eventWithNoTitleMatch, [mod])).toBe('mod-algo')
  })

  it('Stage 2 code match takes precedence over Stage 2 name match in description', () => {
    const modCode = newModule('sem-1', { id: 'mod-code', name: 'Rechnerarchitektur', code: 'RA-100' })
    const modName = newModule('sem-1', { id: 'mod-name', name: 'Betriebssysteme', code: 'BS-200' })

    const event = {
      uid: 'ev-3',
      title: 'Kolloquium',
      description: 'Thema: RA-100 im Vergleich zu Konzepten aus Betriebssysteme',
      categories: [],
      start: new Date('2026-10-12T12:00:00Z'),
      end: new Date('2026-10-12T13:00:00Z'),
      allDay: false,
      location: '',
    }

    // RA-100 is code-matched in description before name match
    expect(matchModule(event, [modName, modCode])).toBe('mod-code')
  })

  it('Category match in Stage 1 wins over Description match in Stage 2', () => {
    const modCat = newModule('sem-1', { id: 'mod-cat', name: 'Softwaretechnik', code: 'SWT-01' })
    const modDesc = newModule('sem-1', { id: 'mod-desc', name: 'Datenbanken', code: 'DB-01' })

    const event = {
      uid: 'ev-4',
      title: 'Vorlesung',
      categories: ['SWT-01'],
      description: 'Bezug zu Datenbanken (DB-01)',
      start: new Date('2026-10-12T14:00:00Z'),
      end: new Date('2026-10-12T15:30:00Z'),
      allDay: false,
      location: '',
    }

    expect(matchModule(event, [modDesc, modCat])).toBe('mod-cat')
  })
})

describe('Empirical Stress: Candidate Length Descending Sort & Shadowing Protection', () => {
  it('prevents 3-level hierarchical prefix shadowing (Informatik -> Theoretische Informatik -> Angewandte Theoretische Informatik)', () => {
    const mShort = newModule('sem-1', { id: 'm-short', name: 'Informatik', code: 'INF' })
    const mMed = newModule('sem-1', { id: 'm-med', name: 'Theoretische Informatik', code: 'TI' })
    const mLong = newModule('sem-1', { id: 'm-long', name: 'Angewandte Theoretische Informatik', code: 'ATI' })

    // Put mShort first in list
    const modules = [mShort, mMed, mLong]

    const evLong = {
      uid: 'ev-l',
      title: 'Angewandte Theoretische Informatik Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(evLong, modules)).toBe('m-long')

    const evMed = {
      uid: 'ev-m',
      title: 'Theoretische Informatik Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(evMed, modules)).toBe('m-med')

    const evShort = {
      uid: 'ev-s',
      title: 'Informatik Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(evShort, modules)).toBe('m-short')
  })

  it('prevents code prefix shadowing (CS-1 vs CS-10 vs CS-100)', () => {
    const m1 = newModule('sem-1', { id: 'm-1', name: 'Intro CS', code: 'CS-1' })
    const m10 = newModule('sem-1', { id: 'm-10', name: 'Intermediate CS', code: 'CS-10' })
    const m100 = newModule('sem-1', { id: 'm-100', name: 'Advanced CS', code: 'CS-100' })

    const modules = [m1, m10, m100] // CS-1 is first

    const ev100 = {
      uid: 'e-100',
      title: 'CS-100 Lecture',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(ev100, modules)).toBe('m-100')

    const ev10 = {
      uid: 'e-10',
      title: 'CS-10 Lecture',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(ev10, modules)).toBe('m-10')

    const ev1 = {
      uid: 'e-1',
      title: 'CS-1 Lecture',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(ev1, modules)).toBe('m-1')
  })

  it('prioritizes active semester even when an inactive semester has a longer name', () => {
    const mInactive = newModule('sem-inactive', {
      id: 'm-inactive',
      name: 'Allgemeine Informatik Vertiefung',
      code: 'INF-OLD',
    })
    const mActive = newModule('sem-active', {
      id: 'm-active',
      name: 'Informatik',
      code: 'INF-NEW',
    })

    const event = {
      uid: 'e-sem',
      title: 'Informatik Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }

    // Active semester should be selected
    expect(matchModule(event, [mInactive, mActive], 'sem-active')).toBe('m-active')
  })
})

describe('Empirical Stress: Non-Academic Auto-Creation Guard', () => {
  const dummySub: Subscription = {
    id: 'sub-guard',
    name: 'test.ics',
    kind: 'file',
    url: '',
    enabled: true,
    lastSync: null,
    lastError: null,
  }

  it('rejects auto-creation for social, administrative, and general events', () => {
    const testCases = [
      'Sommerfest der Fachschaft',
      'Fachschaftssitzung FB20',
      'Ersti-Kneipentour',
      'Grillabend im Schlossgarten',
      'Wartungsarbeiten TUCaN Server',
      'Wahlen zum Studierendenparlament',
      'Campusführung',
      'Sprechstunde Studienberatung',
      'Alumni Treffen 2026',
    ]

    for (const title of testCases) {
      const ics = vcal(
        vevent({
          uid: 'ev-' + title.slice(0, 5),
          summary: title,
          start: '20261015T180000Z',
          end: '20261015T210000Z',
        }),
      )

      const created: Module[] = []
      const events = eventsFromIcs(ics, dummySub, [], {
        activeSemesterId: 'sem-active',
        autoCreateModules: true,
        onModuleCreated: (m) => created.push(m),
        now: new Date('2026-10-01'),
      })

      expect(created).toHaveLength(0)
      expect(events[0].moduleId).toBeNull()
    }
  })

  it('rejects auto-creation for deadline events without course code (e.g. general task deadlines)', () => {
    const ics = vcal(
      vevent({
        uid: 'dl-1',
        summary: 'Frist: Rückmeldung zum Sommersemester',
        start: '20261015T235959Z',
        end: '20261015T235959Z',
      }),
    )

    const created: Module[] = []
    const events = eventsFromIcs(ics, dummySub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m),
      now: new Date('2026-10-01'),
    })

    expect(events[0].kind).toBe('deadline')
    expect(created).toHaveLength(0)
    expect(events[0].moduleId).toBeNull()
  })

  it('allows auto-creation for deadline events IF a valid course code is present', () => {
    const ics = vcal(
      vevent({
        uid: 'dl-code',
        summary: 'CS-101 Abgabe Meilenstein 1',
        start: '20261015T235959Z',
        end: '20261015T235959Z',
      }),
    )

    const created: Module[] = []
    const events = eventsFromIcs(ics, dummySub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m),
      now: new Date('2026-10-01'),
    })

    expect(created).toHaveLength(1)
    expect(created[0].code).toBe('CS-101')
    expect(events[0].moduleId).toBe(created[0].id)
  })

  it('allows auto-creation for all academic kinds (lecture, exercise, lab, exam)', () => {
    const academicEvents = [
      { summary: 'Mathematik 1 Vorlesung', expectedKind: 'lecture' },
      { summary: 'Mathematik 1 Übung', expectedKind: 'exercise' },
      { summary: 'Physikalisches Praktikum', expectedKind: 'lab' },
      { summary: 'Lineare Algebra Klausur', expectedKind: 'exam' },
    ]

    for (const { summary, expectedKind } of academicEvents) {
      const ics = vcal(
        vevent({
          uid: 'ev-' + expectedKind,
          summary,
          start: '20261015T100000Z',
          end: '20261015T120000Z',
        }),
      )

      const created: Module[] = []
      const events = eventsFromIcs(ics, dummySub, [], {
        activeSemesterId: 'sem-active',
        autoCreateModules: true,
        onModuleCreated: (m) => created.push(m),
        now: new Date('2026-10-01'),
      })

      expect(events[0].kind).toBe(expectedKind)
      expect(created).toHaveLength(1)
      expect(events[0].moduleId).toBe(created[0].id)
    }
  })

  it('rejects auto-creation if stripped module name is less than 3 characters', () => {
    // "VL AI" -> stripped of "VL " -> "AI" (length 2)
    const ics = vcal(
      vevent({
        uid: 'short-ai',
        summary: 'Vorlesung AI',
        start: '20261015T100000Z',
        end: '20261015T120000Z',
      }),
    )

    const created: Module[] = []
    eventsFromIcs(ics, dummySub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m),
      now: new Date('2026-10-01'),
    })

    expect(created).toHaveLength(0)
  })
})

describe('Empirical Stress: Case-Insensitive Filename Deduplication in Service', () => {
  let dir: string
  let store: Store
  let service: ReturnType<typeof createService>

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-deep-service-'))
    store = await Store.open(dir)
    service = createService(store, memorySecrets())

    store.put('semesters', {
      id: 'sem-test',
      name: 'Wintersemester 2026',
      kind: 'winter',
      year: 2026,
      start: '2026-10-01',
      end: '2027-03-31',
      lectureStart: '2026-10-12',
      lectureEnd: '2027-02-12',
      breaks: [],
      createdAt: new Date().toISOString(),
    })
    store.update({ activeSemesterId: 'sem-test' })
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('deduplicates across various casing, whitespace, and browser numbered downloads', async () => {
    const fileVariants = [
      'Stundenplan.ics',
      'stundenplan.ics',
      'STUNDENPLAN.ICS',
      'stundenplan (1).ics',
      'Stundenplan (2).ics',
      'STUNDENPLAN (3) .ICS',
      'stundenplan (1) (2).ics',
      '  stundenplan.ics  ',
    ]

    const baseContent = vcal(
      vevent({ uid: 'c1', summary: 'Chemie 1 Vorlesung', start: '20261012T080000Z', end: '20261012T093000Z' }),
    )

    for (const filename of fileVariants) {
      const res = await service.calendarImportFile(filename, baseContent)
      expect(res.count).toBe(1)
    }

    const fileSubs = store.get().subscriptions.filter((s) => s.kind === 'file')
    expect(fileSubs).toHaveLength(1)
    expect(store.get().events).toHaveLength(1)
  })

  it('keeps distinct filenames separate regardless of casing in different file roots', async () => {
    const content = vcal(
      vevent({ uid: 'c1', summary: 'Chemie 1 Vorlesung', start: '20261012T080000Z', end: '20261012T093000Z' }),
    )

    await service.calendarImportFile('Plan_A.ics', content)
    await service.calendarImportFile('Plan_B.ics', content)
    await service.calendarImportFile('plan_a (1).ics', content) // Replaces Plan_A

    const fileSubs = store.get().subscriptions.filter((s) => s.kind === 'file')
    expect(fileSubs).toHaveLength(2)
  })
})

describe('Empirical Stress: Roman Numerals & Keyword Boundaries', () => {
  it('correctly distinguishes Roman numeral IV in German course titles', () => {
    // Should NOT be exercise
    expect(classifyEvent('Analysis IV')).not.toBe('exercise')
    expect(classifyEvent('Informatik IV')).not.toBe('exercise')
    expect(classifyEvent('Theoretische Informatik IV')).not.toBe('exercise')
    expect(classifyEvent('Höhere Mathematik IV')).not.toBe('exercise')

    // Should be exercise (IV used as standalone Integrierte Veranstaltung)
    expect(classifyEvent('IV Rechnerarchitektur')).toBe('exercise')
    expect(classifyEvent('Integrierte Veranstaltung Rechnerorganisation')).toBe('exercise')
  })

  it('normalizes Roman numerals without corrupting non-Roman tokens', () => {
    expect(normalizeRomanNumerals('Analysis I')).toBe('Analysis 1')
    expect(normalizeRomanNumerals('Analysis II')).toBe('Analysis 2')
    expect(normalizeRomanNumerals('Analysis III')).toBe('Analysis 3')
    expect(normalizeRomanNumerals('Analysis IV')).toBe('Analysis 4')
    expect(normalizeRomanNumerals('Analysis V')).toBe('Analysis 5')
    expect(normalizeRomanNumerals('Analysis VI')).toBe('Analysis 6')
    expect(normalizeRomanNumerals('Analysis VII')).toBe('Analysis 7')
    expect(normalizeRomanNumerals('Analysis VIII')).toBe('Analysis 8')
    expect(normalizeRomanNumerals('Analysis IX')).toBe('Analysis 9')
    expect(normalizeRomanNumerals('Analysis X')).toBe('Analysis 10')
    expect(normalizeRomanNumerals('Analysis XI')).toBe('Analysis 11')
    expect(normalizeRomanNumerals('Analysis XII')).toBe('Analysis 12')

    // Compound numerals
    expect(normalizeRomanNumerals('Analysis I+II')).toBe('Analysis 1+2')
    expect(normalizeRomanNumerals('Analysis [I]')).toBe('Analysis [1]')
    expect(normalizeRomanNumerals('Analysis (II)')).toBe('Analysis (2)')

    // Acronyms containing I, V, X must NOT be corrupted
    expect(normalizeRomanNumerals('TI Vorlesung')).toBe('TI Vorlesung')
    expect(normalizeRomanNumerals('KI Grundlagen')).toBe('KI Grundlagen')
    expect(normalizeRomanNumerals('GdI I')).toBe('GdI 1')
    expect(normalizeRomanNumerals('VI-Seminar')).toBe('6-Seminar') // VI is 6
  })

  it('observes behavior when module names only differ by non-alphanumeric symbols (C++ vs C#)', () => {
    // When module names differ only by symbols stripped by normalizeTextForMatching (like + and #),
    // normalizeTextForMatching('C++') -> 'c', and normalizeTextForMatching('C#') -> 'c'.
    // If they have distinct codes, codes disambiguate them cleanly:
    const modCppWithCode = newModule('sem-1', { id: 'm-cpp', name: 'Programmieren in C++', code: 'CS-CPP' })
    const modCsWithCode = newModule('sem-1', { id: 'm-cs', name: 'Programmieren in C#', code: 'CS-CSHARP' })

    const evCppWithCode = {
      uid: 'cpp-1',
      title: 'CS-CPP Programmieren in C++ Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(evCppWithCode, [modCppWithCode, modCsWithCode])).toBe('m-cpp')

    const evCsWithCode = {
      uid: 'cs-1',
      title: 'CS-CSHARP Programmieren in C# Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }
    expect(matchModule(evCsWithCode, [modCppWithCode, modCsWithCode])).toBe('m-cs')
  })

  it('investigates description matching when an event title contains an uncreated course but description mentions an existing course', () => {
    const modMath = newModule('sem-active', { id: 'm-math', name: 'Mathematik 1', code: 'MATH-1' })
    const ics = vcal(
      vevent({
        uid: 'crypto-1',
        summary: 'Kryptographie Vorlesung',
        description: 'Voraussetzung: Erfolgreicher Abschluss von Mathematik 1 wird dringend empfohlen.',
        start: '20261012T080000Z',
        end: '20261012T093000Z',
      }),
    )

    const dummySub: Subscription = {
      id: 'sub-test',
      name: 'plan.ics',
      kind: 'file',
      url: '',
      enabled: true,
      lastSync: null,
      lastError: null,
    }

    const created: Module[] = []
    const events = eventsFromIcs(ics, dummySub, [modMath], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m),
      now: new Date('2026-10-01'),
    })

    // Because Kryptographie is not yet in DB, Stage 1 finds no module.
    // Stage 2 then searches the description and finds "Mathematik 1".
    // As a result, Kryptographie Vorlesung is assigned to Mathematik 1, and no Kryptographie module is auto-created.
    expect(events[0].moduleId).toBe('m-math')
    expect(created).toHaveLength(0)
  })
})
