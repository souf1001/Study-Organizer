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

function makeVcal(eventsBody: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Empirical Challenger//DE',
    'CALSCALE:GREGORIAN',
    eventsBody,
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

function makeVevent(opts: {
  uid: string
  summary: string
  start: string
  end?: string
  description?: string
  categories?: string[]
}): string {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `SUMMARY:${opts.summary}`,
    `DTSTART:${opts.start}`,
  ]
  if (opts.end) lines.push(`DTEND:${opts.end}`)
  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`)
  if (opts.categories?.length) lines.push(`CATEGORIES:${opts.categories.join(',')}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

// ============================================================================
// STRESS TEST AREA 1: BOM STRIPPING & DECODING
// ============================================================================
describe('Empirical Stress: Area 1 - Fixed BOM Stripping & Decoding', () => {
  const minimalIcsBody =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Test\r\nDTSTART:20261012T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'

  it('strips triple UTF-8 BOM in Buffer', () => {
    const tripleBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(minimalIcsBody, 'utf-8'),
    ])
    const decoded = decodeIcsText(tripleBom)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('strips quintuple Unicode BOM in string (\uFEFF x 5)', () => {
    const multiBomStr = '\uFEFF\uFEFF\uFEFF\uFEFF\uFEFF' + minimalIcsBody
    const decoded = decodeIcsText(multiBomStr)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('strips mixed BOM and replacement characters (\uFEFF\uFFFD\uFEFF)', () => {
    const mixedBomStr = '\uFEFF\uFFFD\uFEFF\uFFFD' + minimalIcsBody
    const decoded = decodeIcsText(mixedBomStr)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('strips double UTF-16LE BOM in Buffer', () => {
    const doubleLeBom = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(minimalIcsBody, 'utf16le'),
    ])
    const decoded = decodeIcsText(doubleLeBom)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('strips double UTF-16BE BOM in Buffer', () => {
    const beBody = Buffer.from(minimalIcsBody, 'utf16le')
    for (let i = 0; i < beBody.length; i += 2) {
      const tmp = beBody[i]
      beBody[i] = beBody[i + 1]
      beBody[i + 1] = tmp
    }
    const doubleBeBom = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from([0xfe, 0xff]),
      beBody,
    ])
    const decoded = decodeIcsText(doubleBeBom)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('handles Latin-1 binary string containing UTF-8 BOM bytes', () => {
    const latin1Str = String.fromCharCode(0xef, 0xbb, 0xbf) + minimalIcsBody
    const decoded = decodeIcsText(latin1Str)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('handles Latin-1 binary string containing UTF-16LE BOM bytes', () => {
    const rawLe = Buffer.from(minimalIcsBody, 'utf16le')
    let latin1Str = String.fromCharCode(0xff, 0xfe)
    for (let i = 0; i < rawLe.length; i++) {
      latin1Str += String.fromCharCode(rawLe[i])
    }
    const decoded = decodeIcsText(latin1Str)
    expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(() => ICAL.parse(decoded)).not.toThrow()
  })

  it('survives empty input, whitespace-only, and BOM-only buffers', () => {
    expect(decodeIcsText(new Uint8Array(0))).toBe('')
    expect(decodeIcsText('')).toBe('')
    expect(decodeIcsText(Buffer.from([0xef, 0xbb, 0xbf]))).toBe('')
    expect(decodeIcsText(Buffer.from([0xff, 0xfe]))).toBe('')
    expect(decodeIcsText(Buffer.from([0xfe, 0xff]))).toBe('')
    expect(decodeIcsText('\uFEFF\uFEFF\uFEFF')).toBe('')
    expect(decodeIcsText('\uFFFD\uFFFD')).toBe('')
  })
})

// ============================================================================
// STRESS TEST AREA 2: ROMAN NUMERAL IV BOUNDARY IN CLASSIFYEVENT
// ============================================================================
describe('Empirical Stress: Area 2 - Roman Numeral IV Boundary in classifyEvent', () => {
  it('correctly does NOT classify Roman numeral IV course levels as exercise', () => {
    const ivCourses = [
      'Analysis IV',
      'Analysis IV Vorlesung',
      'Analysis IV - Raum S2|02',
      'Analysis IV (D-MAVT)',
      'Informatik IV',
      'Höhere Mathematik IV',
      'Physik IV',
      'Mathematik IV',
      'Theoretische Informatik IV',
      'Rechnernetze IV',
      'Elektrotechnik IV',
      'Chemie IV',
      'Modul IV',
      'Teil IV',
      'Kapitel IV',
      'Stufe IV',
      'Semester IV',
      'Gruppe IV',
      'Analysis [IV]',
      'Analysis - IV',
      'Analysis – IV',
      'Analysis IV.',
      'Analysis IV:',
      'Seminar Analysis IV',
    ]

    for (const title of ivCourses) {
      const kind = classifyEvent(title)
      expect(kind, `Failed for "${title}": classified as ${kind}`).not.toBe('exercise')
    }
  })

  it('correctly classifies standalone "IV" (Integrierte Veranstaltung) as exercise', () => {
    const standaloneIv = [
      'IV Rechnerarchitektur',
      'IV: Rechnerarchitektur',
      'IV - Rechnerarchitektur',
      'IV – Softwaretechnik',
      '(IV) Softwaretechnik',
      'Integrierte Veranstaltung Rechnernetze',
      'CS-101-iv',
      'Rechnerarchitektur -iv',
    ]

    for (const title of standaloneIv) {
      const kind = classifyEvent(title)
      expect(kind, `Expected "${title}" to be exercise, got ${kind}`).toBe('exercise')
    }
  })

  it('does NOT trigger on words or acronyms containing "iv"', () => {
    const falseIv = [
      'HIV Aufklärung und Prävention',
      'Aktivität im Semester',
      'Motivation und Lerntipps',
      'Kreatives Schreiben',
      'Archiv und Dokumentation',
      'Intensivkurs Deutsch',
      'Festival der Kulturen',
      'Privatrecht Einführung',
      'Naives Bayes Verfahren',
      'Universitätsarchiv Führung',
      'Super Bowl LIV Event',
      'Ludwig XIV Geschichte',
      'Heinrich IV Theaterstück',
    ]

    for (const title of falseIv) {
      const kind = classifyEvent(title)
      expect(kind, `Word containing iv falsely matched exercise for "${title}"`).not.toBe(
        'exercise',
      )
    }
  })

  it('Roman numerals normalization converts IV to 4 accurately in various contexts', () => {
    expect(normalizeRomanNumerals('Analysis IV')).toBe('Analysis 4')
    expect(normalizeRomanNumerals('Analysis [IV]')).toBe('Analysis [4]')
    expect(normalizeRomanNumerals('Analysis (IV)')).toBe('Analysis (4)')
    expect(normalizeRomanNumerals('Analysis I-IV')).toBe('Analysis 1-4')
    expect(normalizeRomanNumerals('Analysis I+IV')).toBe('Analysis 1+4')
    expect(normalizeRomanNumerals('Analysis IV & V')).toBe('Analysis 4 & 5')
    expect(normalizeRomanNumerals('IV Rechnerarchitektur')).toBe('4 Rechnerarchitektur')
    // Acronyms preserved:
    expect(normalizeRomanNumerals('GdI 1')).toBe('GdI 1')
    expect(normalizeRomanNumerals('TI Vorlesung')).toBe('TI Vorlesung')
    expect(normalizeRomanNumerals('KI Seminar')).toBe('KI Seminar')
  })
})

// ============================================================================
// STRESS TEST AREA 3: DEADLINE REGEX WITH INFLECTIONS
// ============================================================================
describe('Empirical Stress: Area 3 - Deadline Regex with Inflections', () => {
  it('recognizes all inflected and separable German forms of "einreichen"', () => {
    const deadlinePhrases = [
      'Übungsblatt 3 bis Freitag einzureichen',
      'Projektbericht einreichen',
      'Abschlussarbeit eingereicht',
      'Alle Unterlagen sind bis 18:00 einzureichen!',
      'Einreichung der Hausaufgaben',
      'Einreichungsfrist beachten',
      'Einzureichende Dokumente',
      'Fristgemäß einzureichen',
    ]

    for (const phrase of deadlinePhrases) {
      const kind = classifyEvent(phrase)
      expect(kind, `Expected deadline for "${phrase}", got ${kind}`).toBe('deadline')
    }
  })

  it('recognizes standard deadline keywords and compound deadlines', () => {
    const deadlines = [
      'Hausaufgabenabgabe',
      'Online-Abgabe',
      'Projekt-Abgabe',
      'Abgabetermin Meilenstein 1',
      'Abgabefrist beachten',
      'Aufgabe 1 ist fällig',
      'Hausarbeit faellig',
      'Submission due 23:59',
      'Assignment deadline',
      'Deadlines for semester',
      'Paper submission',
      'Bewerbungsfrist',
      'Ausschlussfrist',
      'Portal schließt um 23:59',
      'Upload schliesst bald',
      'Submission portal closes',
    ]

    for (const phrase of deadlines) {
      const kind = classifyEvent(phrase)
      expect(kind, `Expected deadline for "${phrase}", got ${kind}`).toBe('deadline')
    }
  })

  it('rejects German and English non-deadline words with embedded substrings', () => {
    const nonDeadlines = [
      'Vortrag: Steinreiche Dynastien im Mittelalter',
      'Vorlesung über das Deutsche Kaiserreich',
      'Exkursion nach Frankreich',
      'Studienfahrt nach Österreich',
      'Fachbereich Informatik',
      'Vergleich verschiedener Sortieralgorithmen',
      'Erfolgreich studieren',
      'Elektrotechnik: Was passiert, wenn die Schaltung kurzschließt?',
      'Wenn sich die Tür verschließt',
      'Mauer umschließt das Areal',
      'Guest Talk: How the algorithm discloses patterns',
      'The envelope encloses a letter',
      'Bank forecloses property',
      'Schlagfertigkeitstraining',
    ]

    for (const phrase of nonDeadlines) {
      const kind = classifyEvent(phrase)
      expect(kind, `Falsely classified as deadline for "${phrase}"`).not.toBe('deadline')
    }
  })
})

// ============================================================================
// STRESS TEST AREA 4: TRAILING ACTIVITY STRIPPING & MODULE MATCHING
// ============================================================================
describe('Empirical Stress: Area 4 - Trailing Activity Stripping & Module Linking', () => {
  it('strips activity keywords separated by whitespace, colon, hyphen, or parentheses', () => {
    const testCases: [string, string][] = [
      // Whitespace
      ['Analysis 1 Vorlesung', 'Analysis 1'],
      ['Analysis 1 Übung', 'Analysis 1'],
      ['Analysis 1 Uebung', 'Analysis 1'],
      ['Analysis 1 Praktikum', 'Analysis 1'],
      ['Analysis 1 Seminar', 'Analysis 1'],
      ['Analysis 1 Tutorium', 'Analysis 1'],
      ['Analysis 1 Kolloquium', 'Analysis 1'],
      ['Analysis 1 Klausur', 'Analysis 1'],
      ['Analysis 1 Prüfung', 'Analysis 1'],
      ['Analysis 1 Pruefung', 'Analysis 1'],
      ['Analysis 1 Exam', 'Analysis 1'],
      ['Analysis 1 Lecture', 'Analysis 1'],
      ['Analysis 1 Große Übung', 'Analysis 1'],
      ['Analysis 1 Grosse Uebung', 'Analysis 1'],
      ['Analysis 1 Hörsaalübung', 'Analysis 1'],
      ['Analysis 1 Zentralübung', 'Analysis 1'],
      ['Analysis 1 Zentraluebung', 'Analysis 1'],
      ['Analysis 1 Labor', 'Analysis 1'],
      ['Analysis 1 Laboratorium', 'Analysis 1'],
      // Short forms
      ['Analysis 1 VL', 'Analysis 1'],
      ['Analysis 1 UE', 'Analysis 1'],
      ['Analysis 1 Ü', 'Analysis 1'],
      ['Analysis 1 PR', 'Analysis 1'],
      ['Analysis 1 TUT', 'Analysis 1'],
      ['Analysis 1 SE', 'Analysis 1'],
      // Hyphen & Colon
      ['Analysis 1 - Vorlesung', 'Analysis 1'],
      ['Analysis 1 – Übung', 'Analysis 1'],
      ['Analysis 1: Praktikum', 'Analysis 1'],
      // Parentheses
      ['Analysis 1 (Vorlesung)', 'Analysis 1'],
      ['Analysis 1 (Übung)', 'Analysis 1'],
      ['Analysis 1 (Große Übung)', 'Analysis 1'],
      // Leading prefixes
      ['Vorlesung Analysis 1', 'Analysis 1'],
      ['Übung zu Analysis 1', 'Analysis 1'],
      ['Tutorium zu Analysis 1', 'Analysis 1'],
      ['Praktikum zu Analysis 1', 'Analysis 1'],
    ]

    for (const [raw, expected] of testCases) {
      const info = extractCourseInfo(raw)
      expect(info?.name, `Stripping failed for "${raw}"`).toBe(expected)
    }
  })

  it('guarantees that whitespace-separated course activities map to the EXACT same module', () => {
    const vlEvent = {
      uid: 'e1',
      title: 'Lineare Algebra 1 Vorlesung',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }
    const ueEvent = {
      uid: 'e2',
      title: 'Lineare Algebra 1 Übung',
      start: new Date(),
      end: new Date(),
      allDay: false,
      location: '',
      description: '',
      categories: [],
    }

    const mod = newModule('sem-1', { name: 'Lineare Algebra 1', code: '' })
    const modules = [mod]

    expect(matchModule(vlEvent, modules)).toBe(mod.id)
    expect(matchModule(ueEvent, modules)).toBe(mod.id)
  })

  it('guards auto-creation against non-academic and bogus general campus events', () => {
    const bogusEvents = [
      'Sommerfest der Fachschaft',
      'Campusführung für Erstsemester',
      'Grillfest der Fachschaft Informatik',
      'Vollversammlung der Studierenden',
      'Sprechstunde Prof. Schneider',
      'Infostand im Foyer',
    ]

    const sub = {
      id: 'sub-1',
      name: 'Test',
      kind: 'file' as const,
      url: '',
      enabled: true,
      lastSync: null,
      lastError: null,
    }

    for (const title of bogusEvents) {
      const ics = makeVcal(
        makeVevent({
          uid: 'bogus-1',
          summary: title,
          start: '20261015T140000Z',
          end: '20261015T160000Z',
        }),
      )
      const created: string[] = []
      const events = eventsFromIcs(ics, sub, [], {
        activeSemesterId: 'sem-active',
        autoCreateModules: true,
        onModuleCreated: (m) => created.push(m.name),
        now: new Date('2026-10-01'),
      })

      expect(created, `Bogus event "${title}" should NOT auto-create a module`).toHaveLength(0)
      expect(events[0].moduleId).toBeNull()
    }
  })

  it('allows auto-creation for genuine academic events or courses with course codes', () => {
    const sub = {
      id: 'sub-1',
      name: 'Test',
      kind: 'file' as const,
      url: '',
      enabled: true,
      lastSync: null,
      lastError: null,
    }

    const academicIcs = makeVcal(
      makeVevent({
        uid: 'ac-1',
        summary: 'Software Engineering Vorlesung',
        start: '20261015T100000Z',
        end: '20261015T113000Z',
      }),
    )
    const created1: string[] = []
    eventsFromIcs(academicIcs, sub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created1.push(m.name),
      now: new Date('2026-10-01'),
    })
    expect(created1).toHaveLength(1)
    expect(created1[0]).toBe('Software Engineering')

    const codeIcs = makeVcal(
      makeVevent({
        uid: 'ac-2',
        summary: 'CS-50 Special Research Project',
        start: '20261015T100000Z',
        end: '20261015T113000Z',
      }),
    )
    const created2: string[] = []
    eventsFromIcs(codeIcs, sub, [], {
      activeSemesterId: 'sem-active',
      autoCreateModules: true,
      onModuleCreated: (m) => created2.push(m.code),
      now: new Date('2026-10-01'),
    })
    expect(created2).toHaveLength(1)
    expect(created2[0]).toBe('CS-50')
  })
})

// ============================================================================
// STRESS TEST AREA 5: EMPIRICAL DEFECT DEMONSTRATION
// ============================================================================
describe('Empirical Stress: Area 5 - Defect in extractCourseInfo Roman Numeral IV Stripping', () => {
  it('DEMONSTRATES DEFECT: extractCourseInfo strips Roman numeral IV from courses (Analysis IV -> Analysis)', () => {
    // Analysis I, II, III keep their Roman numerals:
    expect(extractCourseInfo('Analysis I Vorlesung')?.name).toBe('Analysis I')
    expect(extractCourseInfo('Analysis II Vorlesung')?.name).toBe('Analysis II')
    expect(extractCourseInfo('Analysis III Vorlesung')?.name).toBe('Analysis III')

    // But Analysis IV has IV stripped because line 293 has \s+(?:VL|UE|Ü|PR|TUT|SE|IV)$!
    const infoIv = extractCourseInfo('Analysis IV Vorlesung')

    // On unpatched code, this evaluates to 'Analysis' instead of 'Analysis IV':
    // If this test asserts the EXPECTED behavior ('Analysis IV'), it FAILS on current codebase.
    expect(infoIv?.name).toBe('Analysis IV')
  })

  it('DEMONSTRATES DEFECT: Multi-semester collision when Analysis IV is imported before Analysis 1', () => {
    const sub = {
      id: 's',
      name: 'p',
      kind: 'file' as const,
      url: '',
      enabled: true,
      lastSync: null,
      lastError: null,
    }
    const ics = makeVcal(
      makeVevent({
        uid: 'iv-1',
        summary: 'Analysis IV Vorlesung',
        start: '20261012T080000Z',
        end: '20261012T090000Z',
      }) +
        makeVevent({
          uid: '1-1',
          summary: 'Analysis 1 Vorlesung',
          start: '20261012T100000Z',
          end: '20261012T110000Z',
        }),
    )

    const created: string[] = []
    const events = eventsFromIcs(ics, sub, [], {
      activeSemesterId: 'sem-1',
      autoCreateModules: true,
      onModuleCreated: (m) => created.push(m.name),
    })

    // Expected behavior: two distinct modules ('Analysis IV' and 'Analysis 1')
    // Actual behavior on current code: Analysis IV creates 'Analysis', which then hijacks Analysis 1,
    // resulting in only ONE module created ('Analysis') and both events sharing the same moduleId!
    expect(created).toEqual(['Analysis IV', 'Analysis 1'])
    expect(events[0].moduleId).not.toBe(events[1].moduleId)
  })
})
