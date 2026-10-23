import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyEvent,
  decodeIcsText,
  eventsFromIcs,
  extractCourseInfo,
  fetchCalendar,
  maskCalendarUrl,
  matchModule,
  mergeSubscriptionEvents,
  normalizeCalendarUrl,
  normalizeIcsFilename,
  normalizeRomanNumerals,
  pickNextModuleColor,
  stripModuleSuffix,
} from '../src/backend/ics'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { isIcsDownload } from '../src/main/tucan-session'
import { MODULE_COLORS, newModule } from '../src/shared/defaults'
import type { CalendarEvent, Module, Subscription } from '../src/shared/types'

// ============================================================================
// Test Environment & Helpers
// ============================================================================

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, value: string) => void data.set(name, value),
    remove: async (name: string) => void data.delete(name),
  }
}

interface TestEnv {
  dir: string
  store: Store
  secrets: Secrets & { data: Map<string, string> }
  service: ReturnType<typeof createService>
  cleanup: () => Promise<void>
}

async function createTestEnv(fetchImpl?: typeof fetch): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cal-t5-'))
  const store = await Store.open(dir)
  const secrets = memorySecrets()
  const service = createService(store, secrets, { fetchImpl })
  return {
    dir,
    store,
    secrets,
    service,
    cleanup: async () => {
      await store.flush().catch(() => undefined)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
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
  allDay?: boolean
  location?: string
  description?: string
  categories?: string[]
  rrule?: string
  exdate?: string[]
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`]
  lines.push(`SUMMARY:${p.summary}`)
  if (p.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${p.start}`)
    if (p.end) lines.push(`DTEND;VALUE=DATE:${p.end}`)
  } else {
    lines.push(`DTSTART:${p.start}`)
    if (p.end) lines.push(`DTEND:${p.end}`)
  }
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  if (p.categories?.length) lines.push(`CATEGORIES:${p.categories.join(',')}`)
  if (p.rrule) lines.push(`RRULE:${p.rrule}`)
  if (p.exdate?.length) {
    for (const ex of p.exdate) lines.push(`EXDATE:${ex}`)
  }
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

// ============================================================================
// Tier 5 Adversarial Stress & Coverage Suite
// ============================================================================

describe('Tier 5 Adversarial Coverage Hardening', () => {
  let env: TestEnv

  beforeEach(async () => {
    env = await createTestEnv()
  })

  afterEach(async () => {
    await env.cleanup()
  })

  // --------------------------------------------------------------------------
  // 5.1: Pathological Encodings & Corrupted Byte Streams
  // --------------------------------------------------------------------------
  describe('5.1: Pathological Encodings & Corrupted Byte Streams', () => {
    it('strips multiple consecutive BOM characters (\uFEFF\uFEFF\uFEFF)', () => {
      const input = '\uFEFF\uFEFF\uFEFFBEGIN:VCALENDAR\r\nEND:VCALENDAR'
      const decoded = decodeIcsText(input)
      expect(decoded.startsWith('BEGIN:VCALENDAR')).toBe(true)
      expect(decoded).not.toContain('\uFEFF')
    })

    it('safely handles empty buffer and single-byte buffers without indexing errors', () => {
      expect(decodeIcsText(Buffer.alloc(0))).toBe('')
      expect(decodeIcsText(new Uint8Array([0xef]))).toBe('')
      expect(decodeIcsText(new Uint8Array([0xff]))).toBe('')
      const zeroByteDecoded = decodeIcsText(new Uint8Array([0x00]))
      expect(typeof zeroByteDecoded).toBe('string')
    })

    it('handles odd-length byte arrays in UTF-16LE without crashing', () => {
      // 0xFF, 0xFE (BOM) + 'A' (0x41, 0x00) + dangling byte 0x42
      const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42])
      const decoded = decodeIcsText(bytes)
      expect(decoded.length).toBeGreaterThan(0)
      expect(decoded).toContain('A')
    })

    it('handles UTF-16LE without BOM containing German umlauts and null bytes', () => {
      const text = 'BEGIN:VCALENDAR\r\nSUMMARY:Höhere Mathematik\r\nEND:VCALENDAR'
      const buf = Buffer.alloc(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        buf.writeUInt16LE(text.charCodeAt(i), i * 2)
      }
      const decoded = decodeIcsText(new Uint8Array(buf))
      expect(decoded).toContain('Höhere Mathematik')
      expect(decoded).toContain('BEGIN:VCALENDAR')
    })

    it('decodes Latin-1 binary strings containing UTF-16LE byte sequences', () => {
      // Simulating FileReader.readAsBinaryString on a UTF-16LE file
      const rawText = 'BEGIN:VCALENDAR\r\nSUMMARY:Physik\r\nEND:VCALENDAR'
      const buf = Buffer.alloc(rawText.length * 2 + 2)
      buf[0] = 0xff
      buf[1] = 0xfe
      for (let i = 0; i < rawText.length; i++) {
        buf.writeUInt16LE(rawText.charCodeAt(i), 2 + i * 2)
      }
      const binaryString = buf.toString('binary')
      const decoded = decodeIcsText(binaryString)
      expect(decoded).toContain('BEGIN:VCALENDAR')
      expect(decoded).toContain('Physik')
    })

    it('preserves multi-byte Unicode astral plane characters (emojis / surrogate pairs)', () => {
      const ics = vcal(vevent({
        uid: 'emoji-1',
        summary: '🚀 Informatik & Robotik 💻',
        start: '20261012T100000Z',
        end: '20261012T113000Z',
        description: 'Toller Kurs 🎉',
      }))
      const sub: Subscription = { id: 's1', name: 'Test', kind: 'file', url: 'Datei', enabled: false, lastSync: null, lastError: null }
      const events = eventsFromIcs(ics, sub, [])
      expect(events).toHaveLength(1)
      expect(events[0].title).toBe('🚀 Informatik & Robotik 💻')
      expect(events[0].notes).toBe('Toller Kurs 🎉')
    })
  })

  // --------------------------------------------------------------------------
  // 5.2: Pathological ICS Syntax & Parser Resilience
  // --------------------------------------------------------------------------
  describe('5.2: Pathological ICS Syntax & Parser Resilience', () => {
    const sub: Subscription = { id: 's1', name: 'Test', kind: 'file', url: 'Datei', enabled: false, lastSync: null, lastError: null }

    it('converts zero-duration event (start === end) of kind "other" to "deadline"', () => {
      const ics = vcal(vevent({
        uid: 'zero-dur-1',
        summary: 'Projekt-Meilenstein', // no explicit kind keyword -> 'other'
        start: '20261015T120000Z',
        end: '20261015T120000Z',
      }))
      const events = eventsFromIcs(ics, sub, [])
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('deadline')
    })

    it('handles inverted time range (DTSTART > DTEND) gracefully without crashing', () => {
      const ics = vcal(vevent({
        uid: 'inverted-1',
        summary: 'Zeitreise Vorlesung',
        start: '20261015T140000Z',
        end: '20261015T120000Z',
      }))
      expect(() => eventsFromIcs(ics, sub, [])).not.toThrow()
    })

    it('enforces maximum character length clamps on title (300), notes (2000), location (300)', () => {
      const longTitle = 'Vorlesung '.repeat(50) // 500 chars
      const longDesc = 'Sehr ausführliche Beschreibung. '.repeat(100) // 3200 chars
      const longLoc = 'Raum S2|02 '.repeat(40) // 440 chars

      const ics = vcal(vevent({
        uid: 'clamp-1',
        summary: longTitle,
        start: '20261015T100000Z',
        end: '20261015T113000Z',
        description: longDesc,
        location: longLoc,
      }))
      const events = eventsFromIcs(ics, sub, [])
      expect(events).toHaveLength(1)
      expect(events[0].title.length).toBeLessThanOrEqual(300)
      expect(events[0].notes.length).toBeLessThanOrEqual(2000)
      expect(events[0].location.length).toBeLessThanOrEqual(300)
    })

    it('caps unbounded high-frequency recurrence rules to MAX_OCCURRENCES', () => {
      // RRULE daily forever starting 2026-10-01
      const ics = vcal(vevent({
        uid: 'recur-daily-1',
        summary: 'Tägliche Vorlesung',
        start: '20261001T080000Z',
        end: '20261001T090000Z',
        rrule: 'FREQ=DAILY;INTERVAL=1',
      }))
      const now = new Date('2026-10-01T00:00:00Z')
      const events = eventsFromIcs(ics, sub, [], { now })
      // Bounded by query window (400 days) and MAX_OCCURRENCES (1000)
      expect(events.length).toBeGreaterThan(0)
      expect(events.length).toBeLessThanOrEqual(450)
    })

    it('handles EXDATE to skip canceled recurring instances', () => {
      const ics = vcal(vevent({
        uid: 'recur-exdate-1',
        summary: 'Wöchentliche Übung',
        start: '20261005T080000Z',
        end: '20261005T093000Z',
        rrule: 'FREQ=WEEKLY;COUNT=3',
        exdate: ['20261012T080000Z'], // Cancel week 2
      }))
      const now = new Date('2026-10-01T00:00:00Z')
      const events = eventsFromIcs(ics, sub, [], { now })
      expect(events).toHaveLength(2)
      const dates = events.map((e) => e.start.slice(0, 10))
      expect(dates).toContain('2026-10-05')
      expect(dates).not.toContain('2026-10-12')
      expect(dates).toContain('2026-10-19')
    })

    it('parses VCALENDAR without any VEVENTs returning empty array', () => {
      const ics = vcal('')
      const events = eventsFromIcs(ics, sub, [])
      expect(events).toEqual([])
    })
  })

  // --------------------------------------------------------------------------
  // 5.3: Adversarial Academic Event Classification & Negative Lookahead Rules
  // --------------------------------------------------------------------------
  describe('5.3: Adversarial Academic Event Classification & Negative Lookahead Rules', () => {
    it('negative lookahead: spatial locations and non-deadline verb compounds are NOT classified as deadline', () => {
      expect(classifyEvent('schließt am Campus')).not.toBe('deadline')
      expect(classifyEvent('schließt am Gebäude')).not.toBe('deadline')
      expect(classifyEvent('schließt ab um 18:00')).not.toBe('deadline')
      expect(classifyEvent('schließt auf am Morgen')).not.toBe('deadline')
      expect(classifyEvent('Elektrotechnik: Was passiert, wenn die Schaltung kurzschließt?')).not.toBe('deadline')
      expect(classifyEvent('Wenn sich die Tür verschließt')).not.toBe('deadline')
      expect(classifyEvent('Mauer umschließt das Areal')).not.toBe('deadline')
    })

    it('positive match: academic submission deadlines with closing phrases ARE classified as deadline', () => {
      expect(classifyEvent('Abgabeportal schließt am Sonntag um 23:59')).toBe('deadline')
      expect(classifyEvent('Aufgabe schließt um 23:59')).toBe('deadline')
      expect(classifyEvent('Registrierung schließt morgen')).toBe('deadline')
      expect(classifyEvent('Upload schließt bald')).toBe('deadline')
    })

    it('classifies integrated courses ("Integrierte Veranstaltung") as exercise while preserving Roman numerals', () => {
      expect(classifyEvent('Integrierte Veranstaltung Algorithmen')).toBe('exercise')
      expect(classifyEvent('IV: Rechnerorganisation')).toBe('exercise')
      expect(classifyEvent('Rechnernetze -iv')).toBe('exercise')

      // Roman numeral IV in "Analysis IV" or "Mathematik IV" must NOT be misclassified as exercise
      expect(classifyEvent('Analysis IV')).not.toBe('exercise')
    })

    it('negative lookahead: "IV Vorlesung" is classified as lecture, not exercise', () => {
      expect(classifyEvent('IV Vorlesung Rechnertechnik')).toBe('lecture')
    })

    it('classifies German academic colloquia and tutorials as exercise', () => {
      expect(classifyEvent('Kolloquium für Abschlussarbeiten')).toBe('exercise')
      expect(classifyEvent('Colloquium Informatik')).toBe('exercise')
      expect(classifyEvent('Große Hörsaalübung')).toBe('exercise')
      expect(classifyEvent('Zentralübung Lineare Algebra')).toBe('exercise')
      expect(classifyEvent('HÜ Technische Mechanik')).toBe('exercise')
      expect(classifyEvent('GÜ Physik')).toBe('exercise')
    })

    it('classifies specialized lab and exam terminology', () => {
      expect(classifyEvent('Fachpraktikum Software Engineering')).toBe('lab')
      expect(classifyEvent('Laboratorium für Hochfrequenztechnik')).toBe('lab')
      expect(classifyEvent('Nachschreibeklausur Mathe 1')).toBe('exam')
    })

    it('protects against description poisoning: title kind takes precedence over description', () => {
      const kind = classifyEvent(
        'Vorlesung Einführung in die Programmierung',
        'In diesem Kurs gibt es am Ende eine Klausur und wöchentliche Abgaben.',
      )
      expect(kind).toBe('lecture')
    })
  })

  // --------------------------------------------------------------------------
  // 5.4: Intelligent Module Disambiguation & Roman Numeral Stress
  // --------------------------------------------------------------------------
  describe('5.4: Intelligent Module Disambiguation & Roman Numeral Stress', () => {
    it('prevents short module shadowing: longer specific module name wins', () => {
      const shortMod = newModule('sem1', { name: 'Analysis', code: 'ANA' })
      const longMod = newModule('sem1', { name: 'Analysis für Informatiker', code: 'ANA-INF' })
      const modules = [shortMod, longMod]

      const matched = matchModule(
        'Analysis für Informatiker Vorlesung',
        '',
        [],
        modules,
      )
      expect(matched?.id).toBe(longMod.id)
    })

    it('normalizes Roman numerals without mutating regular words', () => {
      expect(normalizeRomanNumerals('Analysis I')).toBe('Analysis 1')
      expect(normalizeRomanNumerals('Physik II')).toBe('Physik 2')
      expect(normalizeRomanNumerals('Informatik III')).toBe('Informatik 3')
      expect(normalizeRomanNumerals('Chemie IV')).toBe('Chemie 4')
      expect(normalizeRomanNumerals('Mathematik IX')).toBe('Mathematik 9')
      expect(normalizeRomanNumerals('Kryptographie XII')).toBe('Kryptographie 12')
      expect(normalizeRomanNumerals('Seminar XX')).toBe('Seminar 20')

      // Words containing roman numeral substrings must NOT be corrupted
      expect(normalizeRomanNumerals('Initial Testing')).toBe('Initial Testing')
      expect(normalizeRomanNumerals('Civil Law')).toBe('Civil Law')
      expect(normalizeRomanNumerals('Six Sigma')).toBe('Six Sigma')
      expect(normalizeRomanNumerals('Exit Interview')).toBe('Exit Interview')
      expect(normalizeRomanNumerals('Dividend')).toBe('Dividend')
    })

    it('strips all documented course code suffixes', () => {
      const suffixes = ['vl', 'ue', 'üe', 'pr', 'tut', 'iv', 'se', 'ku', 'pj', 'pl', 'sl', 'ko', 'ex', 'vo']
      for (const suf of suffixes) {
        expect(stripModuleSuffix(`20-00-0012-${suf}`)).toBe('20-00-0012')
        expect(stripModuleSuffix(`CS-101-${suf.toUpperCase()}`)).toBe('CS-101')
      }
    })

    it('prioritizes active semester when identically named modules exist in multiple semesters', () => {
      const modOld = newModule('sem-old', { name: 'Software Engineering', code: 'SE' })
      const modActive = newModule('sem-active', { name: 'Software Engineering', code: 'SE' })
      const modules = [modOld, modActive]

      const matched = matchModule(
        'Software Engineering Vorlesung',
        '',
        [],
        modules,
        'sem-active',
      )
      expect(matched?.id).toBe(modActive.id)
    })

    it('fairly distributes colors across MODULE_COLORS during module auto-creation', () => {
      const existing: Module[] = []
      const assignedColors: string[] = []

      for (let i = 0; i < MODULE_COLORS.length; i++) {
        const color = pickNextModuleColor(existing)
        assignedColors.push(color)
        existing.push(newModule('sem1', { name: `Kurs ${i}`, color }))
      }

      // Every color in MODULE_COLORS must be utilized before repeating
      for (const c of MODULE_COLORS) {
        expect(assignedColors).toContain(c)
      }
    })
  })

  // --------------------------------------------------------------------------
  // 5.5: Filename Normalization & Snapshot Replacement Idempotency
  // --------------------------------------------------------------------------
  describe('5.5: Filename Normalization & Snapshot Replacement Idempotency', () => {
    it('normalizes single, multiple, and padded browser download counter suffixes', () => {
      expect(normalizeIcsFilename('stundenplan (1).ics')).toBe('stundenplan.ics')
      expect(normalizeIcsFilename('stundenplan (1) (2).ics')).toBe('stundenplan.ics')
      expect(normalizeIcsFilename('export (999).ICS')).toBe('export.ICS')
      expect(normalizeIcsFilename('  stundenplan (2).ics  ')).toBe('stundenplan.ics')
      expect(normalizeIcsFilename('tu.darmstadt.cs (3).ics')).toBe('tu.darmstadt.cs.ics')
      expect(normalizeIcsFilename('calendar (1)')).toBe('calendar')
      expect(normalizeIcsFilename('.ics')).toBe('.ics')
    })

    it('re-importing stundenplan (1).ics cleanly replaces stundenplan.ics without duplicate subscriptions or events', async () => {
      const ics1 = vcal(vevent({ uid: 'ev1', summary: 'Vorlesung A', start: '20261012T080000Z', end: '20261012T093000Z' }))
      const ics2 = vcal(vevent({ uid: 'ev1', summary: 'Vorlesung A (Raum neu)', start: '20261012T080000Z', end: '20261012T093000Z' }))

      await env.service.calendarImportFile('stundenplan.ics', ics1)
      expect(env.store.get().subscriptions).toHaveLength(1)
      expect(env.store.get().events).toHaveLength(1)
      expect(env.store.get().events[0].title).toBe('Vorlesung A')

      // Second download dropped with browser suffix " (1)"
      await env.service.calendarImportFile('stundenplan (1).ics', ics2)
      expect(env.store.get().subscriptions).toHaveLength(1)
      expect(env.store.get().subscriptions[0].name).toBe('stundenplan.ics')
      expect(env.store.get().events).toHaveLength(1)
      expect(env.store.get().events[0].title).toBe('Vorlesung A (Raum neu)')
    })

    it('matches file subscriptions case-insensitively during re-import', async () => {
      const ics = vcal(vevent({ uid: 'ev1', summary: 'Mathe', start: '20261012T080000Z', end: '20261012T093000Z' }))
      await env.service.calendarImportFile('timetable.ics', ics)
      await env.service.calendarImportFile('TIMETABLE.ICS', ics)
      expect(env.store.get().subscriptions).toHaveLength(1)
    })
  })

  // --------------------------------------------------------------------------
  // 5.6: WebCal URL Normalization, Masking & Network Security Boundaries
  // --------------------------------------------------------------------------
  describe('5.6: WebCal URL Normalization, Masking & Network Security Boundaries', () => {
    it('normalizes webcal and webcals schemes to https', () => {
      expect(normalizeCalendarUrl('webcal://tucan.tu-darmstadt.de/feed.ics')).toBe('https://tucan.tu-darmstadt.de/feed.ics')
      expect(normalizeCalendarUrl('webcals://tucan.tu-darmstadt.de/feed.ics')).toBe('https://tucan.tu-darmstadt.de/feed.ics')
      expect(normalizeCalendarUrl('https://example.com/cal')).toBe('https://example.com/cal')
      expect(normalizeCalendarUrl('http://example.com/cal')).toBe('http://example.com/cal')
    })

    it('rejects dangerous protocols (ftp, file, javascript)', () => {
      expect(() => normalizeCalendarUrl('ftp://example.com/feed.ics')).toThrow()
      expect(() => normalizeCalendarUrl('file:///etc/passwd')).toThrow()
      expect(() => normalizeCalendarUrl('javascript:alert(1)')).toThrow()
    })

    it('masks confidential query parameters in calendar URLs for UI display', () => {
      const masked = maskCalendarUrl('https://moodle.tu-darmstadt.de/cal.php?authtoken=secret_xyz123&user=999')
      expect(masked).toBe('moodle.tu-darmstadt.de/cal.php?…')
      expect(masked).not.toContain('secret_xyz123')

      const clean = maskCalendarUrl('https://moodle.tu-darmstadt.de/public/calendar.ics')
      expect(clean).toBe('moodle.tu-darmstadt.de/public/calendar.ics')
    })
  })

  // --------------------------------------------------------------------------
  // 5.7: Rolling Window Merge & History Preservation
  // --------------------------------------------------------------------------
  describe('5.7: Rolling Window Merge & History Preservation', () => {
    it('preserves historical past events beyond rolling window while cleanly updating active events', () => {
      const now = new Date('2026-11-20T12:00:00Z')
      const base = { kind: 'lecture' as const, allDay: false, moduleId: null, location: 'Hörsaal', notes: '', subscriptionId: 'sub1' }

      // Event from 20 days ago (past history)
      const historicalEvent: CalendarEvent = {
        ...base,
        id: 'hist-1',
        title: 'Vergangene Vorlesung',
        start: '2026-10-30T08:00:00Z',
        end: '2026-10-30T09:30:00Z',
        externalId: 'ext-hist',
      }

      // Existing future event
      const existingFuture: CalendarEvent = {
        ...base,
        id: 'fut-1',
        title: 'Zukünftige Vorlesung (Alt)',
        start: '2026-11-25T08:00:00Z',
        end: '2026-11-25T09:30:00Z',
        externalId: 'ext-fut',
      }

      // Incoming feed provides updated future event, but no historical event (typical rolling window)
      const incomingFuture: CalendarEvent = {
        ...base,
        id: 'fut-2',
        title: 'Zukünftige Vorlesung (Aktualisierter Raum)',
        start: '2026-11-25T08:00:00Z',
        end: '2026-11-25T09:30:00Z',
        location: 'Neuer Raum C201',
        externalId: 'ext-fut',
      }

      const merged = mergeSubscriptionEvents([historicalEvent, existingFuture], [incomingFuture], now)

      expect(merged).toHaveLength(2)
      const hist = merged.find((e) => e.externalId === 'ext-hist')
      const fut = merged.find((e) => e.externalId === 'ext-fut')

      expect(hist).toBeDefined()
      expect(hist?.title).toBe('Vergangene Vorlesung')
      expect(fut).toBeDefined()
      expect(fut?.title).toBe('Zukünftige Vorlesung (Aktualisierter Raum)')
      expect(fut?.location).toBe('Neuer Raum C201')
    })
  })

  // --------------------------------------------------------------------------
  // 5.8: TUCaN Session Wizard & Electron IPC Boundaries
  // --------------------------------------------------------------------------
  describe('5.8: TUCaN Session Wizard & Electron IPC Boundaries', () => {
    it('isIcsDownload identifies calendar downloads by extension, MIME, or query parameter', () => {
      const mockItem = (filename: string, mime: string, url: string) => ({
        getFilename: () => filename,
        getMimeType: () => mime,
        getURL: () => url,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any

      expect(isIcsDownload(mockItem('stundenplan.ics', 'application/octet-stream', 'https://tucan.de/file'))).toBe(true)
      expect(isIcsDownload(mockItem('EXPORT.ICS', 'application/octet-stream', 'https://tucan.de/file'))).toBe(true)
      expect(isIcsDownload(mockItem('export.php', 'text/calendar', 'https://tucan.de/file'))).toBe(true)
      expect(isIcsDownload(mockItem('download', 'application/ics', 'https://tucan.de/file'))).toBe(true)
      expect(isIcsDownload(mockItem('export', '', 'https://tucan.de/stundenplan?format=ics'))).toBe(true)

      // Dangerous or unrelated files are rejected
      expect(isIcsDownload(mockItem('trojan.exe', 'application/x-msdownload', 'https://bad.com/trojan.exe'))).toBe(false)
      expect(isIcsDownload(mockItem('notes.pdf', 'application/pdf', 'https://tucan.de/notes.pdf'))).toBe(false)
      expect(isIcsDownload(mockItem('archive.zip', 'application/zip', 'https://tucan.de/archive.zip'))).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // 5.9: Cross-Feature State Store & Cascade Operations
  // --------------------------------------------------------------------------
  describe('5.9: Cross-Feature State Store & Cascade Operations', () => {
    it('calendarUnsubscribe cascades cleanly removing subscription and all associated events', async () => {
      const ics = vcal(
        vevent({ uid: 'ev1', summary: 'Kurs 1', start: '20261012T080000Z', end: '20261012T093000Z' }) +
        vevent({ uid: 'ev2', summary: 'Kurs 2', start: '20261013T080000Z', end: '20261013T093000Z' }),
      )
      await env.service.calendarImportFile('schedule.ics', ics)
      const sub = env.store.get().subscriptions[0]
      expect(sub).toBeDefined()
      expect(env.store.get().events.filter((e) => e.subscriptionId === sub.id)).toHaveLength(2)

      // Unsubscribe / remove subscription
      await env.service.calendarUnsubscribe(sub.id)
      expect(env.store.get().subscriptions.find((s) => s.id === sub.id)).toBeUndefined()
      expect(env.store.get().events.filter((e) => e.subscriptionId === sub.id)).toHaveLength(0)
    })

    it('frontend EVENT_KINDS and KIND_COLOR in entries.ts correctly include "exercise"', () => {
      const entriesPath = path.resolve(__dirname, '../src/renderer/src/views/calendar/entries.ts')
      const content = readFileSync(entriesPath, 'utf-8')
      expect(content).toContain("exercise: 'Übung'")
      expect(content).toContain("exercise: 'purple'")
    })

    it('calendar.css provides distinct styling for kind-exercise and drag-and-drop overlay', () => {
      const cssPath = path.resolve(__dirname, '../src/renderer/src/views/calendar/calendar.css')
      const css = readFileSync(cssPath, 'utf-8')
      expect(css).toContain('.cal-event.kind-exercise')
      expect(css).toContain('border-left-style: dashed')
      expect(css).toContain('.calendar.dropping')
      expect(css).toContain('.cal-drop-hint')
    })
  })

  // --------------------------------------------------------------------------
  // 5.10: High-Volume Ingestion & Transaction Integrity
  // --------------------------------------------------------------------------
  describe('5.10: High-Volume Ingestion & Transaction Integrity', () => {
    it('imports 250 distinct events in a single transaction without data loss or corruption', async () => {
      let bulkIcs = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//DE\r\n'
      for (let i = 0; i < 250; i++) {
        const day = String((i % 28) + 1).padStart(2, '0')
        bulkIcs += `BEGIN:VEVENT\r\nUID:bulk-event-${i}\r\nSUMMARY:Vorlesung ${i}\r\nDTSTART:202611${day}T080000Z\r\nDTEND:202611${day}T093000Z\r\nEND:VEVENT\r\n`
      }
      bulkIcs += 'END:VCALENDAR\r\n'

      const res = await env.service.calendarImportFile('semester_full.ics', bulkIcs)
      expect(res.count).toBe(250)
      expect(env.store.get().events).toHaveLength(250)

      // Replace with shrunk dataset of 2 events
      const smallIcs = vcal(
        vevent({ uid: 'bulk-event-0', summary: 'Vorlesung 0 (Neu)', start: '20261101T080000Z', end: '20261101T093000Z' }) +
        vevent({ uid: 'bulk-event-1', summary: 'Vorlesung 1 (Neu)', start: '20261102T080000Z', end: '20261102T093000Z' }),
      )
      const shrinkRes = await env.service.calendarImportFile('semester_full.ics', smallIcs)
      expect(shrinkRes.count).toBe(2)
      // Exactly 2 events remaining, old 248 purged
      expect(env.store.get().events).toHaveLength(2)
      expect(env.store.get().events.map((e) => e.title)).toContain('Vorlesung 0 (Neu)')
    })
  })

  // --------------------------------------------------------------------------
  // 5.11: Folded Lines and Fallback Titles
  // --------------------------------------------------------------------------
  describe('5.11: Folded Lines and Fallback Titles', () => {
    it('correctly unfolds long folded lines in ICS parameters according to RFC 5545', () => {
      const foldedIcs =
        'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//Test//DE\r\n' +
        'BEGIN:VEVENT\r\n' +
        'UID:folded-1\r\n' +
        'SUMMARY:Line unfolding in \r\n' +
        ' RFC 5545 calendar specifications\r\n' +
        'DTSTART:20261015T100000Z\r\n' +
        'DTEND:20261015T113000Z\r\n' +
        'END:VEVENT\r\n' +
        'END:VCALENDAR\r\n'

      const sub: Subscription = { id: 'sub', name: 'test', kind: 'file', url: '', enabled: false, lastSync: null, lastError: null }
      const events = eventsFromIcs(foldedIcs, sub, [])
      expect(events).toHaveLength(1)
      expect(events[0].title).toBe('Line unfolding in RFC 5545 calendar specifications')
    })

    it('assigns fallback title "(ohne Titel)" when SUMMARY is completely absent', () => {
      const noSummaryIcs =
        'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//Test//DE\r\n' +
        'BEGIN:VEVENT\r\n' +
        'UID:no-summary-1\r\n' +
        'DTSTART:20261015T100000Z\r\n' +
        'DTEND:20261015T113000Z\r\n' +
        'END:VEVENT\r\n' +
        'END:VCALENDAR\r\n'

      const sub: Subscription = { id: 'sub', name: 'test', kind: 'file', url: '', enabled: false, lastSync: null, lastError: null }
      const events = eventsFromIcs(noSummaryIcs, sub, [])
      expect(events).toHaveLength(1)
      expect(events[0].title).toBe('(ohne Titel)')
    })
  })

  // --------------------------------------------------------------------------
  // 5.12: Course Extraction & Lecturer Parsing
  // --------------------------------------------------------------------------
  describe('5.12: Course Extraction & Lecturer Parsing', () => {
    it('extracts module codes, titles, and lecturers from realistic description text', () => {
      const info = extractCourseInfo(
        '20-00-0012-vl Software Engineering - Vorlesung',
        ['Informatik'],
        'Dozent: Prof. Dr. Mira Mezini\r\nRaum: S2|02 C110',
      )
      expect(info).not.toBeNull()
      expect(info?.code).toBe('20-00-0012')
      expect(info?.name).toBe('Software Engineering')
      expect(info?.lecturer).toBe('Prof. Dr. Mira Mezini')
    })

    it('handles German prefix variations like "Übung zu" and "Tutorium für"', () => {
      const info1 = extractCourseInfo('Übung zu Funktionale Programmierung')
      expect(info1?.name).toBe('Funktionale Programmierung')

      const info2 = extractCourseInfo('Tutorium für Lineare Algebra (Online)')
      expect(info2?.name).toBe('Lineare Algebra')
    })
  })

  // --------------------------------------------------------------------------
  // 5.13: Network Resilience & HTTP Error Boundaries
  // --------------------------------------------------------------------------
  describe('5.13: Network Resilience & HTTP Error Boundaries', () => {
    it('fetchCalendar throws descriptive error on HTTP 404', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }))

      await expect(fetchCalendar('https://moodle.org/feed.ics', mockFetch)).rejects.toThrow(
        'Kalender nicht erreichbar (HTTP 404)',
      )
    })

    it('fetchCalendar throws error when payload is HTML rather than VCALENDAR', async () => {
      const htmlResponse = '<html><body>Not a calendar</body></html>'
      const mockFetch = vi.fn().mockResolvedValue(new Response(htmlResponse, { status: 200 }))

      await expect(fetchCalendar('https://moodle.org/feed.ics', mockFetch)).rejects.toThrow(
        'Die Adresse liefert keinen iCal-Kalender',
      )
    })
  })

  // --------------------------------------------------------------------------
  // 5.14: Concurrency & Isolation
  // --------------------------------------------------------------------------
  describe('5.14: Concurrency & Isolation', () => {
    it('concurrent imports of different files preserve independent subscriptions and events', async () => {
      const icsA = vcal(vevent({ uid: 'a1', summary: 'File A Event', start: '20261012T080000Z', end: '20261012T090000Z' }))
      const icsB = vcal(vevent({ uid: 'b1', summary: 'File B Event', start: '20261012T100000Z', end: '20261012T110000Z' }))

      await Promise.all([
        env.service.calendarImportFile('fileA.ics', icsA),
        env.service.calendarImportFile('fileB.ics', icsB),
      ])

      const subs = env.store.get().subscriptions.filter((s) => s.kind === 'file')
      expect(subs).toHaveLength(2)
      expect(env.store.get().events).toHaveLength(2)

      const subA = subs.find((s) => s.name === 'fileA.ics')!
      const subB = subs.find((s) => s.name === 'fileB.ics')!

      expect(env.store.get().events.find((e) => e.subscriptionId === subA.id)?.title).toBe('File A Event')
      expect(env.store.get().events.find((e) => e.subscriptionId === subB.id)?.title).toBe('File B Event')
    })
  })
})
