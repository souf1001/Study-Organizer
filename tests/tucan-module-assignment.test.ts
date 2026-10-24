import { describe, expect, it } from 'vitest'
import {
  classifyEvent,
  combineIcs,
  eventsFromIcs,
  extractCourseInfo,
  matchModule,
  stripModuleSuffix,
  normalizeRomanNumerals,
} from '../src/backend/ics'
import type { Module, Subscription } from '../src/shared/types'
import { newModule } from '../src/shared/defaults'
import { buildSemester } from '../src/shared/semester'
import { Store } from '../src/backend/store'
import { createService } from '../src/backend/service'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function sampleVEvent(opts: {
  uid: string
  summary: string
  start: string
  end: string
  categories?: string
  description?: string
}): string {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `SUMMARY:${opts.summary}`,
    `DTSTART:${opts.start}`,
    `DTEND:${opts.end}`,
  ]
  if (opts.categories) {
    lines.push(`CATEGORIES:${opts.categories}`)
  }
  if (opts.description) {
    lines.push(`DESCRIPTION:${opts.description.replace(/\n/g, '\\n')}`)
  }
  lines.push('END:VEVENT')
  return lines.join('\r\n')
}

function sampleVCalendar(events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TU Darmstadt//TUCaN//DE',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n')
}

describe('TUCaN Calendar Module Auto-Assignment (Non-AI Rule-Based)', () => {
  const activeSemesterId = 'sem-wise-2024'
  const pastSemesterId = 'sem-sose-2024'

  const mockModules: Module[] = [
    newModule(activeSemesterId, {
      id: 'mod-fop',
      name: 'Functional and Object-Oriented Programming Concepts',
      code: '20-00-0015',
      color: 'blue',
      lecturer: 'Prof. Mezini',
    }),
    newModule(activeSemesterId, {
      id: 'mod-se',
      name: 'Software Engineering',
      code: '20-00-0012',
      color: 'green',
      lecturer: 'Prof. Salvaneschi',
    }),
    newModule(pastSemesterId, {
      id: 'mod-ana1-past',
      name: 'Analysis 1',
      code: '04-00-0101',
      color: 'yellow',
    }),
    newModule(activeSemesterId, {
      id: 'mod-ana1-active',
      name: 'Analysis 1',
      code: '04-00-0101',
      color: 'purple',
    }),
    newModule(activeSemesterId, {
      id: 'mod-la2',
      name: 'Lineare Algebra 2',
      code: '04-00-0102',
      color: 'red',
    }),
  ]

  it('1. Extracts TUCaN course codes and strips university suffixes correctly', () => {
    expect(stripModuleSuffix('20-00-0015-iv')).toBe('20-00-0015')
    expect(stripModuleSuffix('20-00-0012-vl')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-ue')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-pr')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-tut')).toBe('20-00-0012')
    expect(stripModuleSuffix('18-kn-2010-vl')).toBe('18-kn-2010')

    const info1 = extractCourseInfo('20-00-0015-iv Functional and Object-Oriented Programming Concepts')
    expect(info1).not.toBeNull()
    expect(info1?.code).toBe('20-00-0015')
    expect(info1?.name).toBe('Functional and Object-Oriented Programming Concepts')

    const info2 = extractCourseInfo(
      '20-00-0012-vl Software Engineering (Vorlesung)',
      [],
      'Dozent: Prof. Salvaneschi',
    )
    expect(info2?.code).toBe('20-00-0012')
    expect(info2?.name).toBe('Software Engineering')
    expect(info2?.lecturer).toBe('Prof. Salvaneschi')

    const info3 = extractCourseInfo('20-00-0012-ue Software Engineering - Große Übung')
    expect(info3?.code).toBe('20-00-0012')
    expect(info3?.name).toBe('Software Engineering')
  })

  it('2. Maps TUCaN lecture and exercise events to existing modules by course code', () => {
    const lectureEvent = {
      uid: 'tucan-fop-vl',
      title: '20-00-0015-iv Functional and Object-Oriented Programming Concepts',
      start: new Date('2026-10-15T09:50:00Z'),
      end: new Date('2026-10-15T11:30:00Z'),
      allDay: false,
      location: 'S202/001',
      description: 'Integrierte Veranstaltung',
      categories: ['20-00-0015-iv'],
    }
    expect(matchModule(lectureEvent, mockModules, activeSemesterId)).toBe('mod-fop')

    const exerciseEvent = {
      uid: 'tucan-se-ue',
      title: '20-00-0012-ue Software Engineering - Übung',
      start: new Date('2026-10-16T13:30:00Z'),
      end: new Date('2026-10-16T15:10:00Z'),
      allDay: false,
      location: 'S101/A1',
      description: '',
      categories: ['20-00-0012-ue'],
    }
    expect(matchModule(exerciseEvent, mockModules, activeSemesterId)).toBe('mod-se')
  })

  it('3. Normalizes Roman numerals and matches TUCaN titles without AI', () => {
    expect(normalizeRomanNumerals('Analysis I')).toBe('Analysis 1')
    expect(normalizeRomanNumerals('Lineare Algebra II')).toBe('Lineare Algebra 2')

    const eventAnaI = {
      uid: 'tucan-ana-1',
      title: 'Analysis I (Vorlesung)',
      start: new Date('2026-10-14T08:00:00Z'),
      end: new Date('2026-10-14T09:40:00Z'),
      allDay: false,
      location: 'S105/122',
      description: '',
      categories: [],
    }
    // Should match active semester module 'mod-ana1-active' rather than past 'mod-ana1-past'
    expect(matchModule(eventAnaI, mockModules, activeSemesterId)).toBe('mod-ana1-active')

    const eventLaII = {
      uid: 'tucan-la-2',
      title: 'Lineare Algebra II - Hörsaalübung',
      start: new Date('2026-10-14T11:40:00Z'),
      end: new Date('2026-10-14T13:20:00Z'),
      allDay: false,
      location: 'S202/C120',
      description: '',
      categories: [],
    }
    expect(matchModule(eventLaII, mockModules, activeSemesterId)).toBe('mod-la2')
  })

  it('4. Classifies TUCaN event types (Vorlesung, Übung, Praktikum, Klausur, Abgabe)', () => {
    expect(classifyEvent('20-00-0015-iv Functional Programming Concepts')).toBe('exercise')
    expect(classifyEvent('Software Engineering (Vorlesung)')).toBe('lecture')
    expect(classifyEvent('Software Engineering - Große Übung')).toBe('exercise')
    expect(classifyEvent('Softwarepraktikum (Praktikum)')).toBe('lab')
    expect(classifyEvent('Klausur 20-00-0012-vl Software Engineering')).toBe('exam')
    expect(classifyEvent('Abgabe Übungsblatt 01')).toBe('deadline')
  })

  it('5. Auto-creates new modules and assigns multiple related events without AI', () => {
    const sub: Subscription = {
      id: 'sub-test',
      name: 'tucan-stundenplan.ics',
      kind: 'file',
      url: 'Datei-Import',
      enabled: false,
      lastSync: null,
      lastError: null,
    }

    const createdModules: Module[] = []
    const now = new Date('2026-10-20T10:00:00Z')

    const icsContent = sampleVCalendar([
      sampleVEvent({
        uid: 'ev-rn-vl',
        summary: '20-00-0112-vl Rechnernetze und verteilte Systeme',
        start: '20261021T080000Z',
        end: '20261021T094000Z',
        description: 'Dozent: Prof. Hollick',
      }),
      sampleVEvent({
        uid: 'ev-rn-ue',
        summary: '20-00-0112-ue Rechnernetze - Übung',
        start: '20261022T133000Z',
        end: '20261022T151000Z',
      }),
      sampleVEvent({
        uid: 'ev-rn-exam',
        summary: 'Klausur 20-00-0112 Rechnernetze und verteilte Systeme',
        start: '20270215T090000Z',
        end: '20270215T110000Z',
      }),
    ])

    const events = eventsFromIcs(icsContent, sub, [], {
      activeSemesterId,
      autoCreateModules: true,
      onModuleCreated: (m) => createdModules.push(m),
      now,
    })

    // Exactly 1 module created for Rechnernetze
    expect(createdModules.length).toBe(1)
    const newMod = createdModules[0]
    expect(newMod.code).toBe('20-00-0112')
    expect(newMod.name).toBe('Rechnernetze und verteilte Systeme')
    expect(newMod.lecturer).toBe('Prof. Hollick')
    expect(newMod.semesterId).toBe(activeSemesterId)

    // All 3 events (VL, UE, Exam) are mapped to this single new module
    expect(events.length).toBe(3)
    expect(events[0].moduleId).toBe(newMod.id)
    expect(events[0].kind).toBe('lecture')
    expect(events[1].moduleId).toBe(newMod.id)
    expect(events[1].kind).toBe('exercise')
    expect(events[2].moduleId).toBe(newMod.id)
    expect(events[2].kind).toBe('exam')
  })

  it('6. Combines multi-month TUCaN exports and deduplicates recurring events', () => {
    // Month 1: October export
    const octIcs = sampleVCalendar([
      sampleVEvent({
        uid: 'lecture-recur-1',
        summary: '20-00-0015-iv Functional Programming',
        start: '20261020T100000Z',
        end: '20261020T114000Z',
      }),
      sampleVEvent({
        uid: 'oct-only-event',
        summary: 'Einführungsveranstaltung Erstsemester',
        start: '20261014T090000Z',
        end: '20261014T100000Z',
      }),
    ])

    // Month 2: November export (includes the same recurring lecture UID)
    const novIcs = sampleVCalendar([
      sampleVEvent({
        uid: 'lecture-recur-1', // Duplicate UID from recurring lecture
        summary: '20-00-0015-iv Functional Programming',
        start: '20261020T100000Z',
        end: '20261020T114000Z',
      }),
      sampleVEvent({
        uid: 'nov-only-event',
        summary: 'Gastvortrag Industrie 4.0',
        start: '20261118T140000Z',
        end: '20261118T160000Z',
      }),
    ])

    const combined = combineIcs([octIcs, novIcs])
    expect(combined).toContain('BEGIN:VCALENDAR')
    expect(combined).toContain('UID:lecture-recur-1')
    expect(combined).toContain('UID:oct-only-event')
    expect(combined).toContain('UID:nov-only-event')

    // Count occurrences of 'UID:lecture-recur-1' in combined string
    const occurrences = (combined.match(/UID:lecture-recur-1/g) || []).length
    expect(occurrences).toBe(1)
  })

  it('7. End-to-End Service Integration: Multi-month TUCaN import creates modules & events cleanly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tucan-service-test-'))

    try {
      const store = await Store.open(tmpDir)
      const secrets = {
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
      }

      // Set up semester in DB
      store.put('semesters', {
        id: activeSemesterId,
        createdAt: new Date().toISOString(),
        ...buildSemester('uni', 'winter', 2024),
      })
      store.update({ activeSemesterId })

      const service = createService(store, secrets)

      const month1 = sampleVCalendar([
        sampleVEvent({
          uid: 'tucan-m1-vl',
          summary: '20-00-0015-iv Functional Programming Concepts',
          start: '20261020T100000Z',
          end: '20261020T114000Z',
        }),
      ])

      const month2 = sampleVCalendar([
        sampleVEvent({
          uid: 'tucan-m2-vl',
          summary: '20-00-0012-vl Software Engineering',
          start: '20261105T080000Z',
          end: '20261105T094000Z',
        }),
      ])

      const combined = combineIcs([month1, month2])
      const res = await service.calendarImportFile('tucan-stundenplan.ics', combined)

      expect(res.count).toBe(2)
      expect(res.error).toBeNull()

      const db = store.get()
      expect(db.modules.length).toBe(2)
      const fopMod = db.modules.find((m) => m.code === '20-00-0015')
      const seMod = db.modules.find((m) => m.code === '20-00-0012')
      expect(fopMod).toBeDefined()
      expect(seMod).toBeDefined()

      const events = db.events
      expect(events.length).toBe(2)
      expect(events.find((e) => e.externalId === 'tucan-m1-vl')?.moduleId).toBe(fopMod?.id)
      expect(events.find((e) => e.externalId === 'tucan-m2-vl')?.moduleId).toBe(seMod?.id)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('8. Retains distinct monthly lecture sessions when university exporter shares course UID with different DTSTART', () => {
    const octIcs = sampleVCalendar([
      sampleVEvent({
        uid: 'tucan-course-20-00-0015',
        summary: '20-00-0015-iv Functional Programming',
        start: '20261020T100000Z',
        end: '20261020T114000Z',
      }),
    ])

    const novIcs = sampleVCalendar([
      sampleVEvent({
        uid: 'tucan-course-20-00-0015',
        summary: '20-00-0015-iv Functional Programming',
        start: '20261103T100000Z',
        end: '20261103T114000Z',
      }),
    ])

    const combined = combineIcs([octIcs, novIcs])
    const occurrences = (combined.match(/UID:tucan-course-20-00-0015/g) || []).length
    expect(occurrences).toBe(2)
  })
})
