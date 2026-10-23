import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractCourseInfo,
  normalizeIcsFilename,
  normalizeRomanNumerals,
  stripModuleSuffix,
} from '../src/backend/ics'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { MODULE_COLORS } from '../src/shared/defaults'
import type { ModuleColor } from '../src/shared/types'

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
  rrule?: string
  recurrenceId?: string
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`]
  if (p.recurrenceId) lines.push(`RECURRENCE-ID:${p.recurrenceId}`)
  lines.push(`SUMMARY:${p.summary}`)
  lines.push(`DTSTART:${p.start}`)
  if (p.end) lines.push(`DTEND:${p.end}`)
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  if (p.categories?.length) lines.push(`CATEGORIES:${p.categories.join(',')}`)
  if (p.rrule) lines.push(`RRULE:${p.rrule}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

describe('Challenger M1: Duplicate Prevention & Snapshot Replacement in Service', () => {
  let dir: string
  let store: Store
  let service: ReturnType<typeof createService>

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m1-'))
    store = await Store.open(dir)
    service = createService(store, memorySecrets())

    // Setup active semester
    store.put('semesters', {
      id: 'sem-wise-2026',
      name: 'Wintersemester 2026/27',
      kind: 'winter',
      year: 2026,
      start: '2026-10-01',
      end: '2027-03-31',
      lectureStart: '2026-10-12',
      lectureEnd: '2027-02-12',
      breaks: [],
      createdAt: new Date().toISOString(),
    })
    store.update({ activeSemesterId: 'sem-wise-2026' })
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('handles sequential download duplicates: schedule.ics -> (1) -> (2) -> (3) without duplicating subscriptions or events', async () => {
    const content = vcal(
      vevent({ uid: 'ev1', summary: 'Analysis 1 Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'ev2', summary: 'Analysis 1 Übung', start: '20261014T100000Z', end: '20261014T113000Z' }),
    )

    // 1st import: schedule.ics
    const r1 = await service.calendarImportFile('schedule.ics', content)
    expect(r1.count).toBe(2)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().events).toHaveLength(2)

    const subId = store.get().subscriptions[0].id

    // 2nd import: schedule (1).ics
    const r2 = await service.calendarImportFile('schedule (1).ics', content)
    expect(r2.count).toBe(2)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().subscriptions[0].id).toBe(subId)
    expect(store.get().events).toHaveLength(2)

    // 3rd import: schedule (2).ics
    const r3 = await service.calendarImportFile('schedule (2).ics', content)
    expect(r3.count).toBe(2)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().subscriptions[0].id).toBe(subId)
    expect(store.get().events).toHaveLength(2)

    // 4th import: schedule (3).ics
    const r4 = await service.calendarImportFile('schedule (3).ics', content)
    expect(r4.count).toBe(2)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().subscriptions[0].id).toBe(subId)
    expect(store.get().events).toHaveLength(2)
  })

  it('handles reverse order: user imports schedule (2).ics first, then schedule (1).ics, then schedule.ics', async () => {
    const content = vcal(
      vevent({ uid: 'ev1', summary: 'Lineare Algebra Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }),
    )

    const r1 = await service.calendarImportFile('schedule (2).ics', content)
    expect(r1.count).toBe(1)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().subscriptions[0].name).toBe('schedule.ics')
    const subId = store.get().subscriptions[0].id

    const r2 = await service.calendarImportFile('schedule (1).ics', content)
    expect(r2.count).toBe(1)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().subscriptions[0].id).toBe(subId)
    expect(store.get().events).toHaveLength(1)

    const r3 = await service.calendarImportFile('schedule.ics', content)
    expect(r3.count).toBe(1)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().subscriptions[0].id).toBe(subId)
    expect(store.get().events).toHaveLength(1)
  })

  it('handles chained browser duplicate suffixes like "schedule (1) (2).ics" and "schedule(1).ics"', async () => {
    const content = vcal(
      vevent({ uid: 'ev1', summary: 'Physik 1 Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }),
    )

    await service.calendarImportFile('schedule (1) (2).ics', content)
    expect(store.get().subscriptions[0].name).toBe('schedule.ics')

    await service.calendarImportFile('schedule(1).ics', content)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().events).toHaveLength(1)
  })

  it('filename with space before extension "schedule (1) .ics" normalizes cleanly', () => {
    const norm = normalizeIcsFilename('schedule (1) .ics')
    expect(norm).toBe('schedule.ics')
  })

  it('case mismatch "Schedule.ics" vs "schedule (1).ics" reuses existing subscription', async () => {
    const content = vcal(
      vevent({ uid: 'ev1', summary: 'Physik 1', start: '20261012T081500Z', end: '20261012T094500Z' }),
    )

    await service.calendarImportFile('Schedule.ics', content)
    await service.calendarImportFile('schedule (1).ics', content)

    const subs = store.get().subscriptions.filter((s) => s.kind === 'file')
    expect(subs).toHaveLength(1)
  })

  it('snapshot replacement: event addition updates the event list cleanly', async () => {
    const v1 = vcal(
      vevent({ uid: 'ev1', summary: 'Event 1', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'ev2', summary: 'Event 2', start: '20261013T081500Z', end: '20261013T094500Z' }),
    )
    const v2 = vcal(
      vevent({ uid: 'ev1', summary: 'Event 1', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'ev2', summary: 'Event 2', start: '20261013T081500Z', end: '20261013T094500Z' }) +
        vevent({ uid: 'ev3', summary: 'Event 3', start: '20261014T081500Z', end: '20261014T094500Z' }),
    )

    await service.calendarImportFile('my_plan.ics', v1)
    expect(store.get().events).toHaveLength(2)

    await service.calendarImportFile('my_plan (1).ics', v2)
    const events = store.get().events
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.externalId).sort()).toEqual(['ev1', 'ev2', 'ev3'])
  })

  it('snapshot replacement: event deletion (cancelled course) removes the event from DB without leaving ghost events', async () => {
    const v1 = vcal(
      vevent({ uid: 'ev1', summary: 'Event 1', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'ev2', summary: 'Cancelled Event', start: '20261013T081500Z', end: '20261013T094500Z' }) +
        vevent({ uid: 'ev3', summary: 'Event 3', start: '20261014T081500Z', end: '20261014T094500Z' }),
    )
    const v2 = vcal(
      vevent({ uid: 'ev1', summary: 'Event 1', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'ev3', summary: 'Event 3', start: '20261014T081500Z', end: '20261014T094500Z' }),
    )

    await service.calendarImportFile('timetable.ics', v1)
    expect(store.get().events).toHaveLength(3)

    // Re-importing timetable without ev2 replaces snapshot
    await service.calendarImportFile('timetable (1).ics', v2)
    const events = store.get().events
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.externalId).sort()).toEqual(['ev1', 'ev3'])
    expect(events.find((e) => e.externalId === 'ev2')).toBeUndefined()
  })

  it('snapshot replacement: event modifications (room, time, title) are updated in-place', async () => {
    const v1 = vcal(
      vevent({
        uid: 'ev1',
        summary: 'Höhere Mathematik 1 Vorlesung',
        start: '20261012T081500Z',
        end: '20261012T094500Z',
        location: 'Hörsaal A',
      }),
    )
    const v2 = vcal(
      vevent({
        uid: 'ev1',
        summary: 'Höhere Mathematik 1 Vorlesung (Raumänderung)',
        start: '20261012T100000Z',
        end: '20261012T113000Z',
        location: 'Hörsaal B (Neubau)',
      }),
    )

    await service.calendarImportFile('hm1.ics', v1)
    expect(store.get().events[0].location).toBe('Hörsaal A')

    await service.calendarImportFile('hm1 (1).ics', v2)
    const events = store.get().events
    expect(events).toHaveLength(1)
    expect(events[0].title).toBe('Höhere Mathematik 1 Vorlesung (Raumänderung)')
    expect(events[0].location).toBe('Hörsaal B (Neubau)')
    expect(events[0].start).toBe('2026-10-12T10:00:00.000Z')
    expect(events[0].end).toBe('2026-10-12T11:30:00.000Z')
  })

  it('multiple distinct subscriptions do not interfere or overwrite each other', async () => {
    const mathContent = vcal(
      vevent({ uid: 'm1', summary: 'Mathe VL', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'm2', summary: 'Mathe UE', start: '20261013T081500Z', end: '20261013T094500Z' }),
    )
    const csContent = vcal(
      vevent({ uid: 'cs1', summary: 'Informatik VL', start: '20261014T081500Z', end: '20261014T094500Z' }),
    )

    // Import math
    await service.calendarImportFile('mathe.ics', mathContent)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
    expect(store.get().events).toHaveLength(2)

    // Import cs
    await service.calendarImportFile('informatik.ics', csContent)
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(2)
    expect(store.get().events).toHaveLength(3)

    // Re-import math with 3 events
    const mathContentV2 = vcal(
      vevent({ uid: 'm1', summary: 'Mathe VL', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'm2', summary: 'Mathe UE', start: '20261013T081500Z', end: '20261013T094500Z' }) +
        vevent({ uid: 'm3', summary: 'Mathe TUT', start: '20261015T081500Z', end: '20261015T094500Z' }),
    )
    await service.calendarImportFile('mathe (1).ics', mathContentV2)

    // Subscriptions still 2
    expect(store.get().subscriptions.filter((s) => s.kind === 'file')).toHaveLength(2)
    // Math has 3 events, CS still has its 1 event, total 4 events
    const events = store.get().events
    expect(events).toHaveLength(4)
    expect(events.filter((e) => e.externalId?.startsWith('m'))).toHaveLength(3)
    expect(events.filter((e) => e.externalId === 'cs1')).toHaveLength(1)
  })
})

describe('Challenger M1: Active Semester Module Auto-Creation & Color Cycling', () => {
  let dir: string
  let store: Store
  let service: ReturnType<typeof createService>

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m1-mod-'))
    store = await Store.open(dir)
    service = createService(store, memorySecrets())

    store.put('semesters', {
      id: 'sem-active-test',
      name: 'WiSe 2026/27',
      kind: 'winter',
      year: 2026,
      start: '2026-10-01',
      end: '2027-03-31',
      lectureStart: '2026-10-12',
      lectureEnd: '2027-02-12',
      breaks: [],
      createdAt: new Date().toISOString(),
    })
    store.update({ activeSemesterId: 'sem-active-test' })
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('cycles colors evenly across MODULE_COLORS when auto-creating > 9 modules', async () => {
    // Generate 15 distinct courses
    let icsBody = ''
    for (let i = 1; i <= 15; i++) {
      icsBody += vevent({
        uid: `course-${i}`,
        summary: `Modul ${i} Vorlesung`,
        start: '20261012T080000Z',
        end: '20261012T090000Z',
      })
    }
    const content = vcal(icsBody)

    const res = await service.calendarImportFile('all_courses.ics', content)
    expect(res.newModules).toBe(15)

    const modules = store.get().modules
    expect(modules).toHaveLength(15)

    // Check module properties
    for (const mod of modules) {
      expect(mod.semesterId).toBe('sem-active-test')
      expect(MODULE_COLORS).toContain(mod.color)
      expect(typeof mod.id).toBe('string')
      expect(mod.id.length).toBeGreaterThan(0)
    }

    // Verify all module IDs are unique
    const idSet = new Set(modules.map((m) => m.id))
    expect(idSet.size).toBe(15)

    // Verify first 9 modules each received a unique color from MODULE_COLORS
    const first9Colors = new Set(modules.slice(0, 9).map((m) => m.color))
    expect(first9Colors.size).toBe(9)
    for (const c of MODULE_COLORS) {
      expect(first9Colors.has(c)).toBe(true)
    }

    // Next 6 modules (indices 9 to 14) cycle into the first 6 colors
    const counts = new Map<ModuleColor, number>()
    for (const c of MODULE_COLORS) counts.set(c, 0)
    for (const m of modules) counts.set(m.color, counts.get(m.color)! + 1)

    // First 6 colors have count 2, remaining 3 colors have count 1
    for (let i = 0; i < 6; i++) {
      expect(counts.get(MODULE_COLORS[i])).toBe(2)
    }
    for (let i = 6; i < MODULE_COLORS.length; i++) {
      expect(counts.get(MODULE_COLORS[i])).toBe(1)
    }
  })

  it('foreign key linking: multiple events of same course link to the EXACT same moduleId when codes or delimiters exist', async () => {
    // HM1 has course code, Info 1 uses hyphen delimiter
    const content = vcal(
      vevent({ uid: 'hm-vl', summary: '20-00-0012-vl Höhere Mathematik I', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'hm-ue', summary: '20-00-0012-ue Höhere Mathematik I (Große Übung)', start: '20261014T100000Z', end: '20261014T113000Z' }) +
        vevent({ uid: 'hm-tut', summary: '20-00-0012-tut Höhere Mathematik I Tutorium', start: '20261015T140000Z', end: '20261015T153000Z' }) +
        vevent({ uid: 'hm-exam', summary: '20-00-0012 Klausur Höhere Mathematik I', start: '20270220T090000Z', end: '20270220T120000Z' }) +
        // Course with hyphen delimiter
        vevent({ uid: 'info-vl', summary: 'Informatik 1 - Vorlesung', start: '20261013T081500Z', end: '20261013T094500Z' }) +
        vevent({ uid: 'info-ue', summary: 'Informatik 1 - Übung', start: '20261016T100000Z', end: '20261016T113000Z' }),
    )

    const res = await service.calendarImportFile('semester_plan.ics', content)
    expect(res.newModules).toBe(2)

    const modules = store.get().modules
    expect(modules).toHaveLength(2)

    const hmMod = modules.find((m) => m.code === '20-00-0012')
    const infoMod = modules.find((m) => m.name === 'Informatik 1')
    expect(hmMod).toBeDefined()
    expect(infoMod).toBeDefined()

    const events = store.get().events
    expect(events).toHaveLength(6)

    // HM events all link to hmMod.id
    const hmEvents = events.filter((e) => e.externalId?.startsWith('hm-'))
    expect(hmEvents).toHaveLength(4)
    for (const ev of hmEvents) {
      expect(ev.moduleId).toBe(hmMod!.id)
    }

    // Info events all link to infoMod.id
    const infoEvents = events.filter((e) => e.externalId?.startsWith('info-'))
    expect(infoEvents).toHaveLength(2)
    for (const ev of infoEvents) {
      expect(ev.moduleId).toBe(infoMod!.id)
    }

    // Event kinds classification check
    expect(events.find((e) => e.externalId === 'hm-vl')?.kind).toBe('lecture')
    expect(events.find((e) => e.externalId === 'hm-ue')?.kind).toBe('exercise')
    expect(events.find((e) => e.externalId === 'hm-tut')?.kind).toBe('exercise')
    expect(events.find((e) => e.externalId === 'hm-exam')?.kind).toBe('exam')
    expect(events.find((e) => e.externalId === 'info-vl')?.kind).toBe('lecture')
    expect(events.find((e) => e.externalId === 'info-ue')?.kind).toBe('exercise')
  })

  it('re-importing the same file does NOT create duplicate modules or orphan links', async () => {
    const content = vcal(
      vevent({ uid: 'c1', summary: 'Algorithmen und Datenstrukturen - Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'c2', summary: 'Algorithmen und Datenstrukturen - Übung', start: '20261014T100000Z', end: '20261014T113000Z' }),
    )

    const r1 = await service.calendarImportFile('algo.ics', content)
    expect(r1.newModules).toBe(1)
    expect(store.get().modules).toHaveLength(1)
    const modId = store.get().modules[0].id

    // Re-importing algo (1).ics
    const r2 = await service.calendarImportFile('algo (1).ics', content)
    expect(r2.newModules).toBe(0) // No new modules!
    expect(store.get().modules).toHaveLength(1)
    expect(store.get().modules[0].id).toBe(modId)

    // Events still link to the same module
    expect(store.get().events).toHaveLength(2)
    expect(store.get().events[0].moduleId).toBe(modId)
    expect(store.get().events[1].moduleId).toBe(modId)
  })

  it('whitespace-separated activity titles ("Course Vorlesung" vs "Course Übung") share a single module', async () => {
    const content = vcal(
      vevent({ uid: 'ad-vl', summary: 'Algorithmen Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }) +
        vevent({ uid: 'ad-ue', summary: 'Algorithmen Übung', start: '20261014T100000Z', end: '20261014T113000Z' }),
    )

    const res = await service.calendarImportFile('algo_plain.ics', content)
    expect(res.newModules).toBe(1)
    const moduleNames = store.get().modules.map((m) => m.name).sort()
    expect(moduleNames).toEqual(['Algorithmen'])
  })

  it('fallbacks to first semester if activeSemesterId is null but semesters exist', async () => {
    store.update({ activeSemesterId: null })

    const content = vcal(
      vevent({ uid: 'sem-fb', summary: 'Datenbanken Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }),
    )

    const res = await service.calendarImportFile('db.ics', content)
    expect(res.newModules).toBe(1)
    expect(store.get().modules[0].semesterId).toBe('sem-active-test')
  })

  it('handles empty database with no semesters gracefully without crashing', async () => {
    store.update({ activeSemesterId: null })
    await store.remove('semesters', 'sem-active-test')

    const content = vcal(
      vevent({ uid: 'no-sem', summary: 'Vorlesung Ohne Semester', start: '20261012T081500Z', end: '20261012T094500Z' }),
    )

    const res = await service.calendarImportFile('nosem.ics', content)
    expect(res.count).toBe(1)
    expect(res.newModules).toBe(0)
    expect(store.get().modules).toHaveLength(0)
    expect(store.get().events[0].moduleId).toBeNull()
  })
})

describe('Challenger M1: Adversarial Stress & Edge Cases', () => {
  it('rejects invalid or non-calendar inputs with descriptive errors', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-err-'))
    try {
      const store = await Store.open(dir)
      const service = createService(store, memorySecrets())

      await expect(service.calendarImportFile('not_cal.txt', 'This is a text file')).rejects.toThrow(
        'keine iCal-Datei',
      )
      await expect(service.calendarImportFile('empty.ics', '')).rejects.toThrow('keine iCal-Datei')
      await expect(service.calendarImportFile('binary.dat', new Uint8Array([0x00, 0x11, 0x22]))).rejects.toThrow(
        'keine iCal-Datei',
      )
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('handles Roman numerals normalization without corrupting acronyms', () => {
    expect(normalizeRomanNumerals('Analysis I')).toBe('Analysis 1')
    expect(normalizeRomanNumerals('Analysis II')).toBe('Analysis 2')
    expect(normalizeRomanNumerals('Physik III')).toBe('Physik 3')
    expect(normalizeRomanNumerals('Mathematik IV')).toBe('Mathematik 4')
    expect(normalizeRomanNumerals('GdI 1')).toBe('GdI 1') // GdI must remain GdI
    expect(normalizeRomanNumerals('GdI II')).toBe('GdI 2')
    expect(normalizeRomanNumerals('TI Vorlesung')).toBe('TI Vorlesung') // TI must remain TI
    expect(normalizeRomanNumerals('KI Seminar')).toBe('KI Seminar') // KI must remain KI
  })

  it('symmetrically strips university course code suffixes', () => {
    expect(stripModuleSuffix('20-00-0012-vl')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-ue')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-üe')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-pr')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-tut')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-se')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-iv')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-pl')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-sl')).toBe('20-00-0012')
  })

  it('extractCourseInfo parses course name, code, and lecturer correctly', () => {
    const info = extractCourseInfo({
      uid: '1',
      title: '20-00-0012-ue Höhere Mathematik I (Große Übung)',
      description: 'Dozent: Prof. Dr. Muster; Wöchentliche Übung',
      categories: ['20-00-0012-ue'],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: 'C120',
    })

    expect(info).not.toBeNull()
    expect(info?.name).toBe('Höhere Mathematik I')
    expect(info?.code).toBe('20-00-0012')
    expect(info?.lecturer).toBe('Prof. Dr. Muster')
  })

  it('probes extractCourseInfo with whitespace-separated activity titles', () => {
    // With hyphen or parentheses or short code: stripped!
    expect(extractCourseInfo('Analysis 1 - Vorlesung')?.name).toBe('Analysis 1')
    expect(extractCourseInfo('Analysis 1 (Vorlesung)')?.name).toBe('Analysis 1')
    expect(extractCourseInfo('Analysis 1 VL')?.name).toBe('Analysis 1')
    expect(extractCourseInfo('Vorlesung Analysis 1')?.name).toBe('Analysis 1')

    // With plain whitespace: Vorlesung and Übung are also cleanly stripped!
    const resVl = extractCourseInfo('Analysis 1 Vorlesung')?.name
    const resUe = extractCourseInfo('Analysis 1 Übung')?.name
    expect(resVl).toBe('Analysis 1')
    expect(resUe).toBe('Analysis 1')
  })

  it('snapshot replacement: recurring event series update cleanly replaces all occurrences', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-rec-'))
    try {
      const store = await Store.open(dir)
      const service = createService(store, memorySecrets())

      // V1 has weekly series with count 3
      const v1 = vcal(
        vevent({
          uid: 'series-1',
          summary: 'Wöchentliche Vorlesung',
          start: '20261012T080000Z',
          end: '20261012T093000Z',
          rrule: 'FREQ=WEEKLY;COUNT=3',
        }),
      )

      await service.calendarImportFile('series.ics', v1)
      expect(store.get().events).toHaveLength(3)

      // V2 expands the series to count 5
      const v2 = vcal(
        vevent({
          uid: 'series-1',
          summary: 'Wöchentliche Vorlesung',
          start: '20261012T080000Z',
          end: '20261012T093000Z',
          rrule: 'FREQ=WEEKLY;COUNT=5',
        }),
      )

      await service.calendarImportFile('series (1).ics', v2)
      const events = store.get().events
      expect(events).toHaveLength(5)
      // Verify each event has correct uid recurrence format
      expect(events.filter((e) => e.externalId?.startsWith('series-1#'))).toHaveLength(5)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('handles events without summary or title gracefully without creating bogus modules', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-nosum-'))
    try {
      const store = await Store.open(dir)
      const service = createService(store, memorySecrets())

      const content = vcal(
        'BEGIN:VEVENT\r\nUID:no-summary\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nEND:VEVENT\r\n' +
          vevent({ uid: 'only-kind', summary: 'Vorlesung', start: '20261013T080000Z', end: '20261013T090000Z' }),
      )

      const res = await service.calendarImportFile('edge_titles.ics', content)
      expect(res.count).toBe(2)
      // 'Vorlesung' alone has name stripped to empty string, so no module is created
      expect(store.get().events.find((e) => e.externalId === 'only-kind')?.moduleId).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('preserves user events from different sources when replacing snapshots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-iso-'))
    try {
      const store = await Store.open(dir)
      const service = createService(store, memorySecrets())

      // Manually add a user event (not attached to a file subscription)
      store.put('events', {
        id: 'user-event-1',
        title: 'Lernen in der Bib',
        kind: 'other',
        start: '2026-10-12T14:00:00Z',
        end: '2026-10-12T16:00:00Z',
        allDay: false,
        moduleId: null,
        location: 'ULB',
        notes: '',
        subscriptionId: null,
        externalId: null,
      })

      const content = vcal(
        vevent({ uid: 'imported-1', summary: 'Vorlesung', start: '20261012T081500Z', end: '20261012T094500Z' }),
      )
      await service.calendarImportFile('schedule.ics', content)
      expect(store.get().events).toHaveLength(2)

      // Re-import schedule (1).ics
      await service.calendarImportFile('schedule (1).ics', content)
      const events = store.get().events
      expect(events).toHaveLength(2)
      // The user event must still exist!
      expect(events.find((e) => e.id === 'user-event-1')).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
