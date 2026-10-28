import { describe, expect, it } from 'vitest'
import ICAL from 'ical.js'
import {
  classifyEvent,
  decodeIcsText,
  eventsFromIcs,
  extractCourseInfo,
  matchModule,
  normalizeRomanNumerals,
} from '../src/backend/ics'
import { newModule } from '../src/shared/defaults'
import type { Module } from '../src/shared/types'

describe('M1 Adversarial: decodeIcsText', () => {
  it('handles zero-byte buffer and empty string', () => {
    expect(decodeIcsText(new Uint8Array(0))).toBe('')
    expect(decodeIcsText(Buffer.alloc(0))).toBe('')
    expect(decodeIcsText('')).toBe('')
  })

  it('handles single-byte buffers without crashing', () => {
    expect(decodeIcsText(Buffer.from([0xef]))).toBeDefined()
    expect(decodeIcsText(Buffer.from([0xff]))).toBeDefined()
    expect(decodeIcsText(Buffer.from([0xfe]))).toBeDefined()
    expect(decodeIcsText(Buffer.from([0x00]))).toBeDefined()
  })

  it('handles corrupted/incomplete BOMs (2 bytes of 3-byte UTF-8 BOM)', () => {
    const incompleteUtf8Bom = Buffer.from([0xef, 0xbb])
    const res = decodeIcsText(incompleteUtf8Bom)
    expect(typeof res).toBe('string')
  })

  it('handles odd-length UTF-16LE and UTF-16BE buffers (truncated stream)', () => {
    // UTF-16LE BOM + 3 bytes (incomplete code unit at end)
    const oddLe = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42])
    const decodedLe = decodeIcsText(oddLe)
    expect(decodedLe.startsWith('A')).toBe(true)

    // UTF-16BE BOM + 3 bytes
    const oddBe = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00])
    const decodedBe = decodeIcsText(oddBe)
    expect(decodedBe.startsWith('A')).toBe(true)
  })

  it('handles double/multiple BOMs in string (\\uFEFF\\uFEFF)', () => {
    const doubleBomString = '\uFEFF\uFEFFBEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'
    const decoded = decodeIcsText(doubleBomString)
    // If double BOM is not completely stripped, ICAL.parse will crash:
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('handles double UTF-8 BOM in buffer', () => {
    const doubleBomBuf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', 'utf-8'),
    ])
    const decoded = decodeIcsText(doubleBomBuf)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('handles massive strings (5MB)', () => {
    const largeSummary = 'X'.repeat(5 * 1024 * 1024)
    const largeIcs = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nSUMMARY:${largeSummary}\r\nEND:VCALENDAR`
    const decoded = decodeIcsText(largeIcs)
    expect(decoded.length).toBe(largeIcs.length)
  })

  it('handles mixed UTF-16LE/BE in a single buffer gracefully', () => {
    const lePart = Buffer.from('BEGIN:VCALENDAR\r\n', 'utf16le')
    const rawBe = Buffer.from('END:VCALENDAR\r\n', 'utf16le')
    const bePart = Buffer.alloc(rawBe.length)
    for (let i = 0; i < rawBe.length; i += 2) {
      bePart[i] = rawBe[i + 1]
      bePart[i + 1] = rawBe[i]
    }
    const mixed = Buffer.concat([Buffer.from([0xff, 0xfe]), lePart, bePart])
    const decoded = decodeIcsText(mixed)
    expect(typeof decoded).toBe('string')
  })
})

describe('M1 Adversarial: classifyEvent Tricky Academic & Compound Words', () => {
  it('tests Roman numeral IV in course titles: Analysis IV, Informatik IV, etc.', () => {
    // "Analysis IV" is a 4th-semester course, NOT an exercise!
    // But does \biv\b classify it as exercise?
    const kind = classifyEvent('Analysis IV')
    expect(kind).not.toBe('exercise')
  })

  it('tests Roman numeral IV with campus rooms or details: Analysis IV - S2|02', () => {
    const kind = classifyEvent('Analysis IV - Raum S2|02')
    expect(kind).not.toBe('exercise')
  })

  it('tests German common academic formats: Zentralübung and Rechnerübung', () => {
    expect(classifyEvent('Zentralübung Höhere Mathematik')).toBe('exercise')
    expect(classifyEvent('Rechnerübung Programmierung')).toBe('exercise')
  })

  it('tests German compound words with exercise roots', () => {
    expect(classifyEvent('Mathematik Großübung')).toBe('exercise')
    expect(classifyEvent('Physik Vorlesungsübung')).toBe('exercise')
  })

  it('tests German words that contain substrings like einreich, closes, etc.', () => {
    // "steinreich" should NOT be a deadline
    expect(classifyEvent('Vortrag: Steinreiche Dynastien im Mittelalter')).not.toBe('deadline')

    // "einzureichen" SHOULD be a deadline
    expect(classifyEvent('Übungszettel bis Freitag einzureichen')).toBe('deadline')

    // "kurzschließt" in Elektrotechnik should NOT be a deadline
    expect(
      classifyEvent('Elektrotechnik: Was passiert, wenn die Schaltung kurzschließt?'),
    ).not.toBe('deadline')

    // English "discloses" should NOT be a deadline
    expect(classifyEvent('Guest Talk: How the algorithm discloses patterns')).not.toBe('deadline')
  })

  it('tests Laboratorium and Laboratorien (classic university terminology)', () => {
    expect(classifyEvent('Laboratorium für Hochspannungstechnik')).toBe('lab')
    expect(classifyEvent('Besuch der Laboratorien')).toBe('lab')
  })

  it('tests negative cases: general campus events should be other', () => {
    expect(classifyEvent('Sprechstunde Prof. Müller')).toBe('other')
    expect(classifyEvent('Campusführung für Erstsemester')).toBe('other')
    expect(classifyEvent('Vollversammlung der Fachschaft')).toBe('other')
    expect(classifyEvent('Grillfest der Fachschaft Informatik')).toBe('other')
  })
})

describe('M1 Adversarial: matchModule Course Codes, Numerals & Poisoning', () => {
  it('matches course codes with group suffixes (-ue1, -ue2, -tut01)', () => {
    const mod = newModule('s1', { name: 'Mathematik 1', code: '20-00-0012' })
    const base = {
      uid: 'x',
      title: '20-00-0012-ue1 Mathematik 1 Übungsgruppe 1',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }
    expect(matchModule(base, [mod])).toBe(mod.id)
  })

  it('matches Roman numerals enclosed in brackets: Analysis [I]', () => {
    const mod = newModule('s1', { name: 'Analysis 1', code: 'ANA1' })
    const base = {
      uid: 'x',
      title: 'Analysis [I] Vorlesung',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }
    expect(matchModule(base, [mod])).toBe(mod.id)
  })

  it('matches Roman numerals with plus: Analysis I+II', () => {
    expect(normalizeRomanNumerals('Analysis I+II')).toBe('Analysis 1+2')
  })

  it('does NOT misattribute an event when a previous module is mentioned in description (poisoning)', () => {
    const mathMod = newModule('s1', { name: 'Mathematik 1', code: 'MATH-101' })
    const physMod = newModule('s1', { name: 'Physik 1', code: 'PHYS-101' })

    const physEvent = {
      uid: 'phys-1',
      title: 'Physik 1 Vorlesung',
      description: 'Voraussetzung: Grundkenntnisse aus Mathematik 1 werden empfohlen.',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }

    // In the modules list, mathMod comes FIRST!
    const matched = matchModule(physEvent, [mathMod, physMod])
    // The event title is clearly "Physik 1 Vorlesung", it should match Physik 1, NOT Mathematik 1!
    expect(matched).toBe(physMod.id)
  })

  it('extracts 2-digit course codes (CS-50, MA-10)', () => {
    const info = extractCourseInfo('CS-50 Introduction to Computer Science')
    expect(info?.code).toBe('CS-50')
  })
})

describe('M1 Adversarial: Short vs Long Module Name Collision', () => {
  it('does NOT match short module (Informatik) when event is for specific longer module (Theoretische Informatik)', () => {
    const generalMod = newModule('s1', { name: 'Informatik', code: 'INF' })
    const specificMod = newModule('s1', { name: 'Theoretische Informatik', code: 'TI' })

    const event = {
      uid: 'ti-1',
      title: 'Theoretische Informatik Vorlesung',
      description: '',
      categories: [],
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
    }

    // generalMod comes FIRST in array:
    const matched = matchModule(event, [generalMod, specificMod])
    expect(matched).toBe(specificMod.id)
  })
})

describe('M1 Adversarial: Auto-creation for non-academic events', () => {
  it('creates bogus modules for non-academic general events like Sommerfest', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:sommerfest',
      'SUMMARY:Sommerfest der Fachschaft',
      'DTSTART:20261020T160000Z',
      'DTEND:20261020T220000Z',
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

    eventsFromIcs(ics, sub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m),
      now: new Date('2026-10-01'),
    })

    // An event of kind 'other' with no course code should NOT auto-create a module!
    expect(created).toHaveLength(0)
  })
})
