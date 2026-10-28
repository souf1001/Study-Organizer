import { describe, expect, it } from 'vitest'
import ICAL from 'ical.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  autoCreateModule,
  classifyEvent,
  combineIcs,
  decodeIcsText,
  eventsFromIcs,
  extractCourseInfo,
  matchModule,
  normalizeCalendarUrl,
  normalizeIcsFilename,
  normalizeRomanNumerals,
  normalizeTextForMatching,
  parseIcs,
  pickNextModuleColor,
  stripModuleSuffix,
} from '../src/backend/ics'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { MODULE_COLORS, newModule } from '../src/shared/defaults'
import type { Module, ModuleColor } from '../src/shared/types'

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Moodle//NONSGML Moodle//EN
BEGIN:VEVENT
UID:1@moodle
SUMMARY:Übungsblatt 3 ist fällig
DTSTART:20261104T225900Z
DTEND:20261104T225900Z
CATEGORIES:ANA1
END:VEVENT
BEGIN:VEVENT
UID:weekly@hda
SUMMARY:Analysis 1 Vorlesung
LOCATION:D14/0.04
DTSTART:20261012T081500Z
DTEND:20261012T094500Z
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:weekly@hda
RECURRENCE-ID:20261019T081500Z
SUMMARY:Analysis 1 Vorlesung (Raumänderung)
LOCATION:D15/1.01
DTSTART:20261019T081500Z
DTEND:20261019T094500Z
END:VEVENT
END:VCALENDAR`

const SAMPLE_TUCAN_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//TU Darmstadt//TUCaN//DE',
  'BEGIN:VEVENT',
  'UID:tucan-101@tu-darmstadt.de',
  'SUMMARY:20-00-0012-ue Höhere Mathematik I (Große Übung)',
  'LOCATION:S2|02 Raum C120',
  'DESCRIPTION:Dozent: Prof. Dr. Muster; Wöchentliche Übung; Prüfungsrelevant!',
  'DTSTART:20261015T080000Z',
  'DTEND:20261015T093000Z',
  'CATEGORIES:20-00-0012-ue',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

describe('iCal import', () => {
  it('reads single events, series and exceptions', () => {
    const list = parseIcs(ICS, new Date('2026-09-01'), new Date('2027-03-01'))
    expect(list).toHaveLength(4)
    const moved = list.find((e) => e.title.includes('Raumänderung'))
    expect(moved?.location).toBe('D15/1.01')
    expect(list.filter((e) => e.uid.startsWith('weekly@hda#'))).toHaveLength(3)
  })

  it('detects event kinds', () => {
    expect(classifyEvent('Klausur Analysis')).toBe('exam')
    expect(classifyEvent('Übungsblatt 3 ist fällig')).toBe('deadline')
    expect(classifyEvent('Praktikum Termin 2')).toBe('lab')
    expect(classifyEvent('Analysis 1 Vorlesung')).toBe('lecture')
    expect(classifyEvent('Sommerfest')).toBe('other')
  })

  it('assigns events to modules', () => {
    const ana = newModule('s', { name: 'Analysis 1', code: 'ANA1' })
    const events = eventsFromIcs(
      ICS,
      {
        id: 'sub',
        name: 'Moodle',
        kind: 'url',
        url: '',
        enabled: true,
        lastSync: null,
        lastError: null,
      },
      [ana],
      new Date('2026-10-01'),
    )
    expect(events.every((e) => e.moduleId === ana.id)).toBe(true)
    expect(events.every((e) => e.subscriptionId === 'sub')).toBe(true)
  })

  it('accepts webcal links and rejects other protocols', () => {
    expect(normalizeCalendarUrl('webcal://moodle.example.de/cal.ics')).toBe(
      'https://moodle.example.de/cal.ics',
    )
    expect(() => normalizeCalendarUrl('file:///etc/passwd')).toThrow()
  })
})

describe('decodeIcsText & Encoding Detection', () => {
  it('decodes plain UTF-8 without BOM', () => {
    const buf = Buffer.from(SAMPLE_TUCAN_ICS, 'utf-8')
    const decoded = decodeIcsText(buf)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Höhere Mathematik I (Große Übung)')
    expect(decoded).toContain('Prüfungsrelevant!')
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('decodes UTF-8 with BOM (0xEF, 0xBB, 0xBF) and strips the BOM', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const buf = Buffer.concat([bom, Buffer.from(SAMPLE_TUCAN_ICS, 'utf-8')])
    const decoded = decodeIcsText(buf)
    expect(decoded.charCodeAt(0)).not.toBe(0xfeff)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Große Übung')
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('decodes UTF-16LE with BOM (0xFF, 0xFE) - TUCaN / Windows format', () => {
    const bom = Buffer.from([0xff, 0xfe])
    const content = Buffer.from(SAMPLE_TUCAN_ICS, 'utf16le')
    const buf = Buffer.concat([bom, content])
    const decoded = decodeIcsText(buf)
    expect(decoded.charCodeAt(0)).not.toBe(0xfeff)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Höhere Mathematik I (Große Übung)')
    expect(() => ICAL.parse(decoded)).not.toThrow()
    const parsed = parseIcs(decoded, new Date('2026-01-01'), new Date('2027-01-01'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].title).toBe('20-00-0012-ue Höhere Mathematik I (Große Übung)')
  })

  it('decodes UTF-16BE with BOM (0xFE, 0xFF)', () => {
    const bom = Buffer.from([0xfe, 0xff])
    const le = Buffer.from(SAMPLE_TUCAN_ICS, 'utf16le')
    const be = Buffer.alloc(le.length)
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]
      be[i + 1] = le[i]
    }
    const buf = Buffer.concat([bom, be])
    const decoded = decodeIcsText(buf)
    expect(decoded.charCodeAt(0)).not.toBe(0xfeff)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Höhere Mathematik I (Große Übung)')
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('detects BOM-less UTF-16LE heuristically via null bytes', () => {
    const buf = Buffer.from(SAMPLE_TUCAN_ICS, 'utf16le')
    const decoded = decodeIcsText(buf)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Große Übung')
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('detects BOM-less UTF-16BE heuristically via null bytes', () => {
    const le = Buffer.from(SAMPLE_TUCAN_ICS, 'utf16le')
    const be = Buffer.alloc(le.length)
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]
      be[i + 1] = le[i]
    }
    const decoded = decodeIcsText(be)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Große Übung')
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('strips a leading Unicode BOM (\\uFEFF) from strings and prevents a parser crash', () => {
    const stringWithBom = '\uFEFF' + SAMPLE_TUCAN_ICS
    // ICAL.parse would fail on the raw string:
    expect(() => ICAL.parse(stringWithBom)).toThrow()
    const decoded = decodeIcsText(stringWithBom)
    expect(decoded.charCodeAt(0)).toBe(0x42) // 'B'
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('decodes strings read as binary (Latin-1 / binary representation)', () => {
    const bom = Buffer.from([0xff, 0xfe])
    const content = Buffer.from(SAMPLE_TUCAN_ICS, 'utf16le')
    const binaryStr = Buffer.concat([bom, content]).toString('binary')
    const decoded = decodeIcsText(binaryStr)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(decoded).toContain('Große Übung')
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('recovers corrupted strings with null bytes (B\\0E\\0G\\0I\\0N...) as a fallback', () => {
    const corrupted =
      'B\0E\0G\0I\0N\0:\0V\0C\0A\0L\0E\0N\0D\0A\0R\0\r\0\n\0E\0N\0D\0:\0V\0C\0A\0L\0E\0N\0D\0A\0R\0'
    const decoded = decodeIcsText(corrupted)
    expect(decoded).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR')
    expect(decoded.includes('\0')).toBe(false)
  })

  it('handles empty and minimal input cleanly', () => {
    expect(decodeIcsText('')).toBe('')
    expect(decodeIcsText(new Uint8Array(0))).toBe('')
    expect(decodeIcsText(Buffer.from('A', 'utf-8'))).toBe('A')
  })
})

describe('Extended event kind classification & EventKind exercise', () => {
  it('classifies German exercise and tutorial events as exercise', () => {
    expect(classifyEvent('Analysis 1 Übung')).toBe('exercise')
    expect(classifyEvent('Mathematik Uebung')).toBe('exercise')
    expect(classifyEvent('Tutorium Informatik')).toBe('exercise')
    expect(classifyEvent('Kolloquium Rechnernetze')).toBe('exercise')
    expect(classifyEvent('Hörsaalübung Höhere Mathematik')).toBe('exercise')
    expect(classifyEvent('Gruppenübung Physik')).toBe('exercise')
    expect(classifyEvent('Analysis 1 HÜ')).toBe('exercise')
    expect(classifyEvent('Analysis 1 GÜ')).toBe('exercise')
    expect(classifyEvent('Analysis (Ü)')).toBe('exercise')
    expect(classifyEvent('Analysis 1 (UE)')).toBe('exercise')
    expect(classifyEvent('20-00-0012-ue')).toBe('exercise')
    expect(classifyEvent('20-00-0012-tut')).toBe('exercise')
    expect(classifyEvent('Integrierte Veranstaltung Softwaretechnik')).toBe('exercise')
    expect(classifyEvent('IV Rechnerarchitektur')).toBe('exercise')
    expect(classifyEvent('Übung zur Vorlesung Analysis 1')).toBe('exercise')
  })

  it('classifies lectures as lecture', () => {
    expect(classifyEvent('Analysis 1 Vorlesung')).toBe('lecture')
    expect(classifyEvent('Guest Lecture AI')).toBe('lecture')
    expect(classifyEvent('Ringvorlesung KI')).toBe('lecture')
    expect(classifyEvent('Seminar Web-Technologien')).toBe('lecture')
    expect(classifyEvent('20-00-0012-vl')).toBe('lecture')
    expect(classifyEvent('Analysis IV Vorlesung')).toBe('lecture')
    expect(classifyEvent('Analysis IV (VL)')).toBe('lecture')
  })

  it('classifies exams as exam', () => {
    expect(classifyEvent('Klausur Analysis')).toBe('exam')
    expect(classifyEvent('Abschlussprüfung')).toBe('exam')
    expect(classifyEvent('Pruefung Lineare Algebra')).toBe('exam')
    expect(classifyEvent('Final Exam')).toBe('exam')
    expect(classifyEvent('Nachschreibetermin Physik')).toBe('exam')
    expect(classifyEvent('Midterm-Exam Software')).toBe('exam')
  })

  it('classifies due dates and submissions as deadline', () => {
    expect(classifyEvent('Übungsblatt 3 ist fällig')).toBe('deadline')
    expect(classifyEvent('Abgabe Projektbericht')).toBe('deadline')
    expect(classifyEvent('Submission Deadline')).toBe('deadline')
    expect(classifyEvent('Einreichung Exposé')).toBe('deadline')
    expect(classifyEvent('Frist zur Einreichung')).toBe('deadline')
  })

  it('classifies practicals and labs as lab', () => {
    expect(classifyEvent('Praktikum Termin 2')).toBe('lab')
    expect(classifyEvent('Robotik Labor')).toBe('lab')
    expect(classifyEvent('Physiklabor')).toBe('lab')
    expect(classifyEvent('Hardware Lab')).toBe('lab')
    expect(classifyEvent('Testat 1')).toBe('lab')
    expect(classifyEvent('20-00-0012-pr')).toBe('lab')
  })

  it('avoids false positives for words with partial matches', () => {
    expect(classifyEvent('Frühstückstreffen')).toBe('other')
    expect(classifyEvent('Günstiges Angebot')).toBe('other')
    expect(classifyEvent('Collaborative work')).toBe('other')
    expect(classifyEvent('Example Problem')).toBe('other')
  })

  it('supports multiple parameters (title, description, categories)', () => {
    expect(classifyEvent('20-00-0012', undefined, ['Übung'])).toBe('exercise')
    expect(classifyEvent('Analysis 1', 'Tutorium für Erstsemester')).toBe('exercise')
    expect(classifyEvent('Übung Lineare Algebra', 'Klausur am 15.02.')).toBe('exercise')
    expect(classifyEvent('Mathematik 1', 'Abgabe bis Freitag einreichen')).toBe('deadline')
    expect(classifyEvent('20-00-0012', 'Labortermin D14', ['Praktikum'])).toBe('lab')
  })
})

describe('Module code suffixes, Roman numerals & file names', () => {
  it('strips university suffixes with stripModuleSuffix', () => {
    expect(stripModuleSuffix('20-00-0012-vl')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-ue')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-üe')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-tut')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-pr')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-se')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-iv')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-pl')).toBe('20-00-0012')
    expect(stripModuleSuffix('20-00-0012-sl')).toBe('20-00-0012')
    expect(stripModuleSuffix('CS-101-vl')).toBe('CS-101')
    expect(stripModuleSuffix('20-00-0012')).toBe('20-00-0012')
  })

  it('normalizes Roman numerals without breaking acronyms', () => {
    expect(normalizeRomanNumerals('Analysis I')).toBe('Analysis 1')
    expect(normalizeRomanNumerals('Lineare Algebra II')).toBe('Lineare Algebra 2')
    expect(normalizeRomanNumerals('Informatik III')).toBe('Informatik 3')
    expect(normalizeRomanNumerals('Physik IV')).toBe('Physik 4')
    expect(normalizeRomanNumerals('Chemie V')).toBe('Chemie 5')
    expect(normalizeRomanNumerals('Mathematik XX')).toBe('Mathematik 20')
    // Acronyms stay intact
    expect(normalizeRomanNumerals('GdI')).toBe('GdI')
    expect(normalizeRomanNumerals('TI')).toBe('TI')
    expect(normalizeRomanNumerals('KI')).toBe('KI')
    expect(normalizeRomanNumerals('GdI I')).toBe('GdI 1')
  })

  it('normalizes text for robust comparisons with normalizeTextForMatching', () => {
    expect(normalizeTextForMatching('Analysis I')).toBe('analysis 1')
    expect(normalizeTextForMatching('Analysis 1')).toBe('analysis 1')
    expect(normalizeTextForMatching('Höhere Mathematik II')).toBe('hoehere mathematik 2')
    expect(normalizeTextForMatching('Höhere Mathematik 2')).toBe('hoehere mathematik 2')
  })

  it('normalizes file names of duplicate downloads with normalizeIcsFilename', () => {
    expect(normalizeIcsFilename('stundenplan.ics')).toBe('stundenplan.ics')
    expect(normalizeIcsFilename('stundenplan (1).ics')).toBe('stundenplan.ics')
    expect(normalizeIcsFilename('stundenplan (2).ics')).toBe('stundenplan.ics')
    expect(normalizeIcsFilename('stundenplan (1) (1).ics')).toBe('stundenplan.ics')
    expect(normalizeIcsFilename('schedule (1).ICS')).toBe('schedule.ICS')
    expect(normalizeIcsFilename('analysis (1) part 2.ics')).toBe('analysis (1) part 2.ics')
  })
})

describe('Smart module matching (matchModule)', () => {
  it('matches module codes despite differing course suffixes (-vl vs base / -ue)', () => {
    const mod = newModule('s1', { name: 'Software Engineering', code: '20-00-0012' })
    const base = {
      uid: 'x',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }

    // Event has suffix -vl
    expect(matchModule({ ...base, title: '20-00-0012-vl Software Engineering' }, [mod])).toBe(
      mod.id,
    )
    // Event has a category with suffix -ue
    expect(matchModule({ ...base, title: 'Übung', categories: ['20-00-0012-ue'] }, [mod])).toBe(
      mod.id,
    )
  })

  it('matches modules with a suffix in the module code against events with a different suffix', () => {
    const modWithVl = newModule('s1', { name: 'Einführung', code: '20-00-0012-vl' })
    const base = {
      uid: 'x',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: ['20-00-0012-ue'],
    }
    expect(matchModule({ ...base, title: 'Übung' }, [modWithVl])).toBe(modWithVl.id)
  })

  it('matches Roman and Arabic numerals in module names in both directions', () => {
    const modArabic = newModule('s1', { name: 'Analysis 1', code: 'ANA1' })
    const modRoman = newModule('s1', { name: 'Lineare Algebra II', code: 'LA2' })
    const base = {
      uid: 'x',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }

    expect(matchModule({ ...base, title: 'Analysis I Vorlesung' }, [modArabic])).toBe(modArabic.id)
    expect(matchModule({ ...base, title: 'Lineare Algebra 2 Übung' }, [modRoman])).toBe(modRoman.id)
  })

  it('prefers modules of the active semester when module names are equal', () => {
    const pastMod = newModule('sem-past', { name: 'Mathematik 1', code: 'MAT1' })
    const activeMod = newModule('sem-active', { name: 'Mathematik 1', code: 'MAT1' })
    const base = {
      uid: 'x',
      title: 'Mathematik 1 Vorlesung',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }

    const matchedId = matchModule(base, [pastMod, activeMod], 'sem-active')
    expect(matchedId).toBe(activeMod.id)
  })

  it('supports the multi-parameter signature (summary, desc, cats, modules) and returns the module object', () => {
    const mod = newModule('s1', { name: 'Rechnerarchitektur', code: 'CS-200' })
    const result = matchModule('Rechnerarchitektur Vorlesung', '', [], [mod])
    expect(result).toBeDefined()
    expect(result?.id).toBe(mod.id)
  })
})

describe('Module auto-creation & color assignment', () => {
  it('picks module colors deterministically and evenly', () => {
    const mods: Module[] = []
    const colors: ModuleColor[] = []
    for (let i = 0; i < MODULE_COLORS.length; i++) {
      const color = pickNextModuleColor(mods)
      colors.push(color)
      mods.push(newModule('s1', { color }))
    }
    // All 9 colors must have been used
    expect(new Set(colors).size).toBe(MODULE_COLORS.length)
    // Beyond that, the least used color is picked
    const tenthColor = pickNextModuleColor(mods)
    expect(tenthColor).toBe(MODULE_COLORS[0])
  })

  it('extracts course info and cleans titles with extractCourseInfo', () => {
    const info1 = extractCourseInfo({
      uid: '1',
      title: '20-00-0012-vl Höhere Mathematik I',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: 'Dozent: Prof. Dr. Muster',
      categories: [],
    })
    expect(info1).toEqual({
      name: 'Höhere Mathematik I',
      code: '20-00-0012',
      lecturer: 'Prof. Dr. Muster',
    })

    const info2 = extractCourseInfo({
      uid: '2',
      title: 'Übung zu Algorithmen und Datenstrukturen',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: ['CS-101-ue'],
    })
    expect(info2?.name).toBe('Algorithmen und Datenstrukturen')
    expect(info2?.code).toBe('CS-101')

    const info3 = extractCourseInfo({
      uid: '3',
      title: 'Sommerfest',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    })
    expect(info3).toBeDefined()
    expect(info3?.name).toBe('Sommerfest')
  })

  it('creates a new module with autoCreateModule', () => {
    const mod = autoCreateModule(
      { name: 'Datenbanksysteme', code: 'CS-300', lecturer: 'Dr. Test' },
      'sem-1',
      [],
    )
    expect(mod.semesterId).toBe('sem-1')
    expect(mod.name).toBe('Datenbanksysteme')
    expect(mod.code).toBe('CS-300')
    expect(mod.lecturer).toBe('Dr. Test')
    expect(MODULE_COLORS).toContain(mod.color)
  })

  it('eventsFromIcs with autoCreateModules creates new modules and links subsequent events', () => {
    const testIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:hm1-vl',
      'SUMMARY:20-00-0012-vl Höhere Mathematik I',
      'DTSTART:20261012T080000Z',
      'DTEND:20261012T093000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:hm1-ue',
      'SUMMARY:20-00-0012-ue Höhere Mathematik I (Übung)',
      'DTSTART:20261014T100000Z',
      'DTEND:20261014T113000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const sub = {
      id: 'sub-test',
      name: 'Plan',
      kind: 'file' as const,
      url: '',
      enabled: true,
      lastSync: null,
      lastError: null,
    }
    const created: Module[] = []

    const events = eventsFromIcs(testIcs, sub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m),
      now: new Date('2026-10-01'),
    })

    expect(created).toHaveLength(1)
    expect(created[0].name).toBe('Höhere Mathematik I')
    expect(created[0].code).toBe('20-00-0012')
    expect(events).toHaveLength(2)
    // Both events (lecture and exercise) must be assigned to the same newly created module
    expect(events[0].moduleId).toBe(created[0].id)
    expect(events[1].moduleId).toBe(created[0].id)
    expect(events[0].kind).toBe('lecture')
    expect(events[1].kind).toBe('exercise')
  })
})

describe('Subscription sync', () => {
  it('masks secret parameters', async () => {
    const { maskCalendarUrl } = await import('../src/backend/ics')
    expect(
      maskCalendarUrl(
        'https://lernen.h-da.de/calendar/export_execute.php?userid=1&authtoken=geheim',
      ),
    ).toBe('lernen.h-da.de/calendar/export_execute.php?…')
  })

  it('keeps older events that are missing from the rolling window', async () => {
    const { mergeSubscriptionEvents } = await import('../src/backend/ics')
    const now = new Date('2026-11-20T12:00:00Z')
    const base = {
      kind: 'deadline' as const,
      allDay: false,
      moduleId: null,
      location: '',
      notes: '',
      subscriptionId: 's',
    }
    const old = {
      ...base,
      id: 'a',
      title: 'Alt',
      start: '2026-10-01T10:00:00Z',
      end: '2026-10-01T10:00:00Z',
      externalId: 'old',
    }
    const future = {
      ...base,
      id: 'b',
      title: 'Veraltet',
      start: '2026-12-01T10:00:00Z',
      end: '2026-12-01T10:00:00Z',
      externalId: 'gone',
    }
    const incoming = [
      {
        ...base,
        id: 'c',
        title: 'Neu',
        start: '2026-12-05T10:00:00Z',
        end: '2026-12-05T10:00:00Z',
        externalId: 'new',
      },
    ]
    const merged = mergeSubscriptionEvents([old, future], incoming, now)
    expect(merged.map((e) => e.title)).toEqual(['Alt', 'Neu'])
  })
})

describe('Module matching', () => {
  it('matches codes only as whole words', async () => {
    const { matchModule: match } = await import('../src/backend/ics')
    const se = newModule('s', { name: 'Software Engineering', code: 'SE' })
    const ma = newModule('s', { name: 'Mathematik', code: 'MA' })
    const base = {
      uid: 'x',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [] as string[],
    }
    expect(match({ ...base, title: 'Seminar Datenbanken' }, [se, ma])).toBeNull()
    expect(
      match({ ...base, title: 'Klausur SE', description: 'Material mitbringen' }, [se, ma]),
    ).toBe(se.id)
    expect(match({ ...base, title: 'Abgabe', categories: ['MA'] }, [se, ma])).toBe(ma.id)
  })
})

describe('calendarImportFile Service End-to-End', () => {
  const memorySecrets = (): Secrets => {
    const data = new Map<string, string>()
    return {
      get: async (name: string) => data.get(name) ?? null,
      set: async (name: string, value: string) => void data.set(name, value),
      remove: async (name: string) => void data.delete(name),
    }
  }

  it('imports a UTF-16LE Uint8Array with BOM and normalizes download file names', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cal-service-test-'))
    try {
      const store = await Store.open(dir)
      const service = createService(store, memorySecrets())

      // Create an active semester
      store.put('semesters', {
        id: 'sem-active',
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
      store.update({ activeSemesterId: 'sem-active' })

      // First import: UTF-16LE with BOM
      const bom = Buffer.from([0xff, 0xfe])
      const content = Buffer.from(SAMPLE_TUCAN_ICS, 'utf16le')
      const bytes = new Uint8Array(Buffer.concat([bom, content]))

      const res1 = await service.calendarImportFile('tucan_plan.ics', bytes)
      expect(res1.count).toBe(1)
      expect(res1.error).toBeNull()
      expect(res1.newModules).toBe(1)

      const db1 = store.get()
      expect(db1.subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
      expect(db1.subscriptions[0].name).toBe('tucan_plan.ics')
      expect(db1.modules).toHaveLength(1)
      expect(db1.modules[0].name).toBe('Höhere Mathematik I')
      expect(db1.events).toHaveLength(1)
      expect(db1.events[0].kind).toBe('exercise')
      expect(db1.events[0].moduleId).toBe(db1.modules[0].id)

      // Second import: new download with browser counter "(1)"
      const res2 = await service.calendarImportFile('tucan_plan (1).ics', bytes)
      expect(res2.count).toBe(1)
      expect(res2.error).toBeNull()

      const db2 = store.get()
      // No duplicate subscriptions or events!
      expect(db2.subscriptions.filter((s) => s.kind === 'file')).toHaveLength(1)
      expect(db2.events).toHaveLength(1)
      expect(db2.modules).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

describe('Protection against oversized calendars', () => {
  const vcal = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`

  it('truncates long titles and limits the number of events', () => {
    const text = vcal(
      `BEGIN:VEVENT\nUID:viel\nSUMMARY:${'x'.repeat(5000)}\nDTSTART:20260901T000000Z\nDTEND:20260901T001000Z\nRRULE:FREQ=HOURLY\nEND:VEVENT`,
    )
    const sub = {
      id: 'sub1',
      name: 'x',
      kind: 'url' as const,
      url: '',
      enabled: true,
      lastSync: null,
      lastError: null,
    }
    const events = eventsFromIcs(text, sub, [], new Date('2026-09-02'))
    expect(events.length).toBeLessThanOrEqual(1000)
    expect(events[0].title).toHaveLength(300)
  })

  it('one calendar does not change the time zones of another', () => {
    const withoutZone = vcal(
      'BEGIN:VEVENT\nUID:b\nSUMMARY:B\nDTSTART;TZID=Europe/Berlin:20261012T100000\nEND:VEVENT',
    )
    const before = parseIcs(
      withoutZone,
      new Date('2026-01-01'),
      new Date('2027-01-01'),
    )[0].start.getTime()
    // Calendar with a forged "Europe/Berlin" time zone (+10 hours)
    const fake = vcal(
      'BEGIN:VTIMEZONE\nTZID:Europe/Berlin\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+1000\nTZOFFSETTO:+1000\nEND:STANDARD\nEND:VTIMEZONE\n' +
        'BEGIN:VEVENT\nUID:a\nSUMMARY:A\nDTSTART;TZID=Europe/Berlin:20261012T100000\nEND:VEVENT',
    )
    expect(
      parseIcs(fake, new Date('2026-01-01'), new Date('2027-01-01'))[0].start.toISOString(),
    ).toBe('2026-10-12T00:00:00.000Z')
    expect(
      parseIcs(withoutZone, new Date('2026-01-01'), new Date('2027-01-01'))[0].start.getTime(),
    ).toBe(before)
  })

  it('aborts downloads that are too large', async () => {
    const { readLimited } = await import('../src/backend/http')
    await expect(
      readLimited(new Response(new Uint8Array(2048)), 1024, 'Der Kalender'),
    ).rejects.toThrow('zu groß')
    expect((await readLimited(new Response(new Uint8Array(10)), 1024, 'Der Kalender')).length).toBe(
      10,
    )
  })
})

describe('decodeIcsText multiple BOM handling', () => {
  it('strips multiple consecutive BOM characters from string', () => {
    const raw = '\uFEFF\uFEFFBEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'
    const decoded = decodeIcsText(raw)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('strips triple UTF-8 BOM from byte buffer', () => {
    const tripleBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', 'utf-8'),
    ])
    const decoded = decodeIcsText(tripleBom)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('preserves zero-width non-breaking spaces within text body', () => {
    const textWithZwnbsp = 'SUMMARY:ZWNBSP \uFEFF Test'
    expect(decodeIcsText(textWithZwnbsp)).toBe(textWithZwnbsp)
  })
})

describe('classifyEvent: Roman numeral IV and Integrierte Veranstaltung', () => {
  it('does NOT classify Roman numeral IV course titles as exercise', () => {
    expect(classifyEvent('Analysis IV')).toBe('other')
    expect(classifyEvent('Analysis IV - Raum S2|02')).toBe('other')
    expect(classifyEvent('Informatik IV')).toBe('other')
    expect(classifyEvent('Mathematik IV')).toBe('other')
    expect(classifyEvent('Physik IV')).toBe('other')
  })

  it('still classifies Integrierte Veranstaltung as exercise', () => {
    expect(classifyEvent('IV Rechnerarchitektur')).toBe('exercise')
    expect(classifyEvent('IV: Rechnerarchitektur')).toBe('exercise')
    expect(classifyEvent('Softwaretechnik (IV)')).toBe('exercise')
    expect(classifyEvent('Integrierte Veranstaltung Softwaretechnik')).toBe('exercise')
    expect(classifyEvent('20-00-0012-iv')).toBe('exercise')
  })

  it('classifies Analysis IV Vorlesung as lecture', () => {
    expect(classifyEvent('Analysis IV Vorlesung')).toBe('lecture')
    expect(classifyEvent('Analysis IV (VL)')).toBe('lecture')
  })
})

describe('classifyEvent: Deadline keywords boundaries and inflections', () => {
  it('rejects substring false positives like steinreich, kurzschließt, discloses', () => {
    expect(classifyEvent('Vortrag: Steinreiche Dynastien im Mittelalter')).not.toBe('deadline')
    expect(
      classifyEvent('Elektrotechnik: Was passiert, wenn die Schaltung kurzschließt?'),
    ).not.toBe('deadline')
    expect(classifyEvent('Guest Talk: How the algorithm discloses patterns')).not.toBe('deadline')
  })

  it('recognizes inflected German submission deadline einzureichen and compounds', () => {
    expect(classifyEvent('Übungszettel bis Freitag einzureichen')).toBe('deadline')
    expect(classifyEvent('Hausarbeit bitte pünktlich einreichen')).toBe('deadline')
    expect(classifyEvent('Bewerbungsfrist')).toBe('deadline')
    expect(classifyEvent('Portal schließt um 23:59 Uhr')).toBe('deadline')
  })
})

describe('combineIcs: TUCaN Multi-Month Merge & Cancellation Filtering', () => {
  it('combines multiple monthly exports into a single valid calendar', () => {
    const oct = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:oct1@tucan
SUMMARY:Mathematik 1 Vorlesung
DTSTART:20261015T095000Z
DTEND:20261015T113000Z
END:VEVENT
END:VCALENDAR`

    const nov = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:nov1@tucan
SUMMARY:Mathematik 1 Übung
DTSTART:20261105T133000Z
DTEND:20261105T151000Z
END:VEVENT
END:VCALENDAR`

    const combined = combineIcs([oct, nov])
    expect(combined).toContain('BEGIN:VCALENDAR')
    expect(combined).toContain('END:VCALENDAR')
    expect(combined).toContain('UID:oct1@tucan')
    expect(combined).toContain('UID:nov1@tucan')

    const from = new Date('2026-10-01T00:00:00Z')
    const to = new Date('2026-12-01T00:00:00Z')
    const events = parseIcs(combined, from, to)
    expect(events).toHaveLength(2)
  })

  it('deduplicates recurring or identical events across monthly files', () => {
    const oct = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:same-event@tucan
SUMMARY:Informatik 1
DTSTART:20261020T100000Z
DTEND:20261020T113000Z
END:VEVENT
END:VCALENDAR`

    const nov = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:same-event@tucan
SUMMARY:Informatik 1
DTSTART:20261020T100000Z
DTEND:20261020T113000Z
END:VEVENT
END:VCALENDAR`

    const combined = combineIcs([oct, nov])
    const from = new Date('2026-10-01T00:00:00Z')
    const to = new Date('2026-12-01T00:00:00Z')
    const events = parseIcs(combined, from, to)
    expect(events).toHaveLength(1)
  })

  it('filters out cancelled events with STATUS:CANCELLED or entfällt in title', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:active@tucan
SUMMARY:Physik 1
DTSTART:20261021T100000Z
DTEND:20261021T113000Z
END:VEVENT
BEGIN:VEVENT
UID:cancelled1@tucan
SUMMARY:Physik 1 (entfällt)
DTSTART:20261022T100000Z
DTEND:20261022T113000Z
END:VEVENT
BEGIN:VEVENT
UID:cancelled2@tucan
SUMMARY:Physik 1 Übung
STATUS:CANCELLED
DTSTART:20261023T100000Z
DTEND:20261023T113000Z
END:VEVENT
END:VCALENDAR`

    const from = new Date('2026-10-01T00:00:00Z')
    const to = new Date('2026-10-30T00:00:00Z')
    const events = parseIcs(ics, from, to)
    expect(events).toHaveLength(1)
    expect(events[0].title).toBe('Physik 1')
  })
})
