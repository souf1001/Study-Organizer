// iCal-/ICS-Kalender abonnieren (Moodle-Kalenderexport, Stundenplan aus my h_da, HISinOne, Stud.IP …).
import ICAL from 'ical.js'
import type { CalendarEvent, EventKind, ID, Module, ModuleColor, Subscription } from '../shared/types'
import { MODULE_COLORS, newId, newModule } from '../shared/defaults'
import { readLimited } from './http'

/**
 * Dekodiert ICS-Inhalte zuverlässig in einen bereinigten UTF-8-String.
 * Erkennt und verarbeitet:
 * - UTF-8 mit BOM (0xEF, 0xBB, 0xBF)
 * - UTF-16LE mit BOM (0xFF, 0xFE)
 * - UTF-16BE mit BOM (0xFE, 0xFF)
 * - UTF-16LE / UTF-16BE ohne BOM (über Null-Byte-Muster bei ASCII-Start)
 * - Plain UTF-8
 * - Strings mit führendem Unicode-BOM (\uFEFF)
 * - Binär kodierte Strings (z. B. aus FileReader binary / Latin-1)
 */
export function decodeIcsText(input: Buffer | Uint8Array | string): string {
  if (typeof input === 'string') {
    // 1. Führende Unicode-BOMs / Replacement-Chars vollständig entfernen
    const clean = input.replace(/^[\uFEFF\uFFFD]+/, '')

    // 2. Binär-String-Erkennung (wenn Bytes 1:1 als Latin-1 Chars übergeben wurden)
    if (
      clean.length >= 2 &&
      ((clean.charCodeAt(0) === 0xFF && clean.charCodeAt(1) === 0xFE) ||
        (clean.charCodeAt(0) === 0xFE && clean.charCodeAt(1) === 0xFF) ||
        (clean.length >= 3 && clean.charCodeAt(0) === 0xEF && clean.charCodeAt(1) === 0xBB && clean.charCodeAt(2) === 0xBF))
    ) {
      const bytes = new Uint8Array(clean.length)
      for (let i = 0; i < clean.length; i++) {
        bytes[i] = clean.charCodeAt(i) & 0xFF
      }
      return decodeIcsBytes(bytes)
    }

    // 3. Notfallbereinigung für versehentlich als UTF-8 gelesene UTF-16LE Strings
    if (clean.includes('\0') && clean.includes('B\0E\0G\0I\0N\0:\0V\0C\0A\0L\0E\0N\0D\0A\0R')) {
      return clean.replace(/\0/g, '').replace(/^[\uFFFD\uFEFF]+/, '')
    }

    return clean
  }

  return decodeIcsBytes(input)
}

function decodeIcsBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''

  let encoding = 'utf-8'
  let offset = 0

  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    encoding = 'utf-8'
    offset = 3
  } else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    encoding = 'utf-16le'
    offset = 2
  } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    encoding = 'utf-16be'
    offset = 2
  } else if (bytes.length >= 2 && bytes[0] === 0x00 && bytes[1] !== 0x00) {
    encoding = 'utf-16be'
    offset = 0
  } else if (bytes.length >= 2 && bytes[0] !== 0x00 && bytes[1] === 0x00) {
    encoding = 'utf-16le'
    offset = 0
  }

  const decoder = new TextDecoder(encoding)
  const slice = offset > 0 ? bytes.subarray(offset) : bytes
  const text = decoder.decode(slice)

  // Absicherung gegen alle verbleibenden BOM- und Replacement-Zeichen am Anfang
  return text.replace(/^[\uFEFF\uFFFD]+/, '')
}

/**
 * Kombiniert mehrere separate monatliche oder wöchentliche iCal-Exporte (z. B. aus TUCaN / CampusNet)
 * zu einem einzigen vollständigen Semester-Kalender.
 * Entfernt doppelte VEVENTs anhand ihrer UID oder des Inhalts.
 */
export function combineIcs(icsList: (string | Buffer | Uint8Array)[]): string {
  const events: string[] = []
  const seenEventKeys = new Set<string>()

  for (const item of icsList) {
    const text = decodeIcsText(item)
    const matches = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) ?? []
    for (const block of matches) {
      const uidMatch = block.match(/^UID:(.+?)$/mi)
      const dtstartMatch = block.match(/^DTSTART(?:;.+?)?:(.+?)$/mi)
      const recurrenceIdMatch = block.match(/^RECURRENCE-ID(?:;.+?)?:(.+?)$/mi)
      const rruleMatch = block.match(/^RRULE:(.+?)$/mi)

      const uid = uidMatch ? uidMatch[1].trim() : ''
      const dtstart = dtstartMatch ? dtstartMatch[1].trim() : ''
      const recurrenceId = recurrenceIdMatch ? recurrenceIdMatch[1].trim() : ''
      const rrule = rruleMatch ? rruleMatch[1].trim() : ''

      const dedupKey = uid
        ? `${uid}#${dtstart}#${recurrenceId}#${rrule}`
        : block.trim()

      if (!seenEventKeys.has(dedupKey)) {
        seenEventKeys.add(dedupKey)
        events.push(block.trim())
      }
    }
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Study Organizer//TUCaN Semester Schedule//DE',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n')
}

export interface ParsedEvent {
  uid: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  location: string
  description: string
  categories: string[]
}

const MAX_OCCURRENCES = 1000
/** Höchstens so viele Termine pro Kalender (ein Stundenplan hat wenige hundert) */
const MAX_EVENTS = 5000
const MAX_CALENDAR_BYTES = 10 * 1024 * 1024

export function parseIcs(text: string, from: Date, to: Date): ParsedEvent[] {
  // Zeitzonen (VTIMEZONE) löst ical.js aus der Datei selbst auf. Nicht global registrieren,
  // sonst könnte ein Kalender die Zeitzonen anderer Kalender verändern.
  const clean = decodeIcsText(text)
  const root = new ICAL.Component(ICAL.parse(clean))

  const vevents = root.getAllSubcomponents('vevent')
  const exceptions = vevents.filter((v) => v.hasProperty('recurrence-id'))
  const result: ParsedEvent[] = []

  for (const component of vevents.filter((v) => !v.hasProperty('recurrence-id'))) {
    const status = String(component.getFirstPropertyValue('status') || '').toUpperCase()
    if (status === 'CANCELLED') continue
    const event = new ICAL.Event(component)
    for (const ex of exceptions) {
      if (ex.getFirstPropertyValue('uid') === event.uid) event.relateException(ex)
    }
    const categories = component
      .getAllProperties('categories')
      .flatMap((p) => p.getValues().map((v) => String(v)))

    const push = (
      item: InstanceType<typeof ICAL.Event>,
      start: InstanceType<typeof ICAL.Time>,
      end: InstanceType<typeof ICAL.Time>,
      uid: string,
    ): void => {
      const title = item.summary || '(ohne Titel)'
      if (
        /\b(?:entfällt|abgesagt|fällt\s+aus)\b|\((?:entfällt|abgesagt|ausfall)\)|\[(?:entfällt|abgesagt|ausfall)\]/i.test(
          title,
        )
      )
        return
      const startDate = start.toJSDate()
      const endDate = end ? end.toJSDate() : startDate
      if (endDate < from || startDate > to || result.length >= MAX_EVENTS) return
      result.push({
        uid,
        title: item.summary || '(ohne Titel)',
        start: startDate,
        end: endDate,
        allDay: start.isDate,
        location: item.location || '',
        description: item.description || '',
        categories,
      })
    }

    if (event.isRecurring()) {
      const iterator = event.iterator()
      for (
        let i = 0, next = iterator.next();
        next && i < MAX_OCCURRENCES;
        i++, next = iterator.next()
      ) {
        const details = event.getOccurrenceDetails(next)
        if (details.startDate.toJSDate() > to) break
        push(
          details.item,
          details.startDate,
          details.endDate,
          `${event.uid}#${details.recurrenceId.toString()}`,
        )
      }
    } else {
      push(event, event.startDate, event.endDate, event.uid)
    }
  }
  return result
}

const KIND_RULES: [RegExp, EventKind][] = [
  [/klausur|prüfung|pruefung|\bexams?\b|\bexamination\b|nachschreib/iu, 'exam'],
  [
    /\b(?:abgabe\w*|\w*abgabe|fällig|faellig|due|deadlines?|submission|\w*frist\w*)\b|\bein(?:zu|ge)?reich\w*|(?:\b(?:portal|upload|submission|anmeldung|bewerbung|einreichung|abgabe|registrierung|registration|quiz|test|aufgabe)\b[^\n.]{0,25}\b(?:schlie[ßs]{1,2}t|closes?)\b|\b(?:schlie[ßs]{1,2}t|closes?)\b\s+(?:am|um|\d|heute|morgen|bald|in\b)(?!\s+(?:ort|raum|saal|gebäude|gebaeude|mensa|bibliothek|campus|tür|tuer|pforte|fenster|schrank))\b(?!\s+(?:an|ab|aus|ein|auf|zusammen|mit|sich\b)))/iu,
    'deadline',
  ],
  [/praktikum|testat|-pr\b|\blabs?\b|\b\w*labor(?:atorium|atorien|e|ien)?\b/iu, 'lab'],
  [
    /übung|uebung|tutor|tutorial|\btut\b|[ck]olloqui|hörsaalübung|hoersaaluebung|gruppenübung|gruppenuebung|(?<!\p{L})(?:[hg]ü|[hg]ue|ü|ue)(?!\p{L})|-ue\b|-tut\b|(?<!\p{L})[-–]iv\b|integrierte veranstaltung|(?<![\p{L}\p{N}]\s*(?:[-–]|\[)?\s*)\biv\b(?!\s*[([]?(?:vorlesung|lecture|seminar|vl\b))/iu,
    'exercise',
  ],
  [/vorlesung|lecture|seminar|ringvorlesung|\bvl\b|-vl\b/iu, 'lecture'],
]

/**
 * Klassifiziert einen Termin nach Titel/Summary, optionalen Kategorien und optionaler Beschreibung.
 * Stufenweise Prüfung verhindert, dass Lehrplantexte in der Beschreibung den Termintyp verfälschen.
 */
export function classifyEvent(
  summaryOrText: string,
  description?: string,
  categories?: string[],
): EventKind {
  const primaryText = [summaryOrText, ...(categories ?? [])].filter(Boolean).join(' ')
  const primaryKind = KIND_RULES.find(([pattern]) => pattern.test(primaryText))?.[1]
  if (primaryKind) return primaryKind

  if (description) {
    const descKind = KIND_RULES.find(([pattern]) => pattern.test(description))?.[1]
    if (descKind) return descKind
  }

  return 'other'
}

export function stripModuleSuffix(code: string): string {
  return code.trim().replace(/-(?:vl|ue|ueb|üe|pr|se|tut|iv|pl|sl|ko|ex|vo|ku|pj|lab)$/i, '')
}

const ROMAN_NUMERALS: [RegExp, string][] = [
  ['xx', '20'],
  ['xix', '19'],
  ['xviii', '18'],
  ['xvii', '17'],
  ['xvi', '16'],
  ['xv', '15'],
  ['xiv', '14'],
  ['xiii', '13'],
  ['xii', '12'],
  ['xi', '11'],
  ['x', '10'],
  ['ix', '9'],
  ['viii', '8'],
  ['vii', '7'],
  ['vi', '6'],
  ['v', '5'],
  ['iv', '4'],
  ['iii', '3'],
  ['ii', '2'],
  ['i', '1'],
].map(([rom, num]) => [new RegExp(`(?<=^|[\\s\\-–_/(,.:[+])${rom}(?=$|[\\s\\-–_/),.:+\\]])`, 'gi'), num])

export function normalizeRomanNumerals(text: string): string {
  let result = text
  for (const [pattern, val] of ROMAN_NUMERALS) {
    result = result.replace(pattern, val)
  }
  return result
}

export function normalizeTextForMatching(text: string): string {
  return normalizeRomanNumerals(text)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function normalizeIcsFilename(filename: string): string {
  const trimmed = filename.trim()
  const lastDot = trimmed.lastIndexOf('.')
  const rawBase = lastDot !== -1 ? trimmed.slice(0, lastDot) : trimmed
  const ext = lastDot !== -1 ? trimmed.slice(lastDot).trim() : ''
  const cleanBase = rawBase.trim().replace(/(\s*\(\d+\))+$/g, '').trim()
  return `${cleanBase}${ext}`
}

export function pickNextModuleColor(existingModules: Module[]): ModuleColor {
  const used = new Set(existingModules.map((m) => m.color))
  for (const color of MODULE_COLORS) {
    if (!used.has(color)) return color
  }
  const counts = new Map<ModuleColor, number>()
  for (const c of MODULE_COLORS) counts.set(c, 0)
  for (const m of existingModules) counts.set(m.color, (counts.get(m.color) ?? 0) + 1)
  let best: ModuleColor = MODULE_COLORS[0]
  let min = Infinity
  for (const c of MODULE_COLORS) {
    const count = counts.get(c) ?? 0
    if (count < min) {
      min = count
      best = c
    }
  }
  return best
}

export function extractCourseInfo(
  eventOrSummary: ParsedEvent | string,
  categories: string[] = [],
  description = '',
): { name: string; code: string; lecturer?: string } | null {
  const summary = typeof eventOrSummary === 'string' ? eventOrSummary : eventOrSummary.title
  const cats = typeof eventOrSummary === 'string' ? categories : eventOrSummary.categories
  const desc = typeof eventOrSummary === 'string' ? description : eventOrSummary.description

  const codeRegex = /\b(\d{2}-[a-zA-Z0-9]{2}-\d{4}(?:-[a-zA-Z0-9]+)?|[A-Z]{2,5}\s*-\s*\d{2,4}(?:-[a-zA-Z0-9]+)?|[A-Z]{2,5}\s*\d{3,4}(?:-[a-zA-Z0-9]+)?)\b/i
  const titleCodeMatch = summary.match(codeRegex)
  const catCodeMatch = cats.map((c) => c.match(codeRegex)?.[1]).find(Boolean)
  const rawCode = titleCodeMatch?.[1] || catCodeMatch || ''
  const code = rawCode ? stripModuleSuffix(rawCode) : ''

  let name = summary
  if (rawCode) {
    name = name.replace(rawCode, '').trim()
  }
  name = name
    .replace(/^[:\s\-–]+/, '')
    .replace(/^(?:Übung zu|Uebung zu|Tutorium zu|Tutorium für|Vorlesung zu|Praktikum zu|Seminar zu|Kolloquium zu)\s+/i, '')
    .replace(/^(?:Vorlesung|Übung|Uebung|Praktikum|Seminar|Tutorium|Klausur|Prüfung|Pruefung|Exam|Lecture)(?:[:\s\-–]+|$)/i, '')
    .replace(/\s*\((?:Vorlesung|Übung|Uebung|Praktikum|Seminar|Tutorium|Kolloquium|Klausur|Prüfung|Pruefung|Große Übung|Grosse Uebung|Hörsaalübung|Hoersaaluebung|Gruppenübung|Gruppenuebung|Raumänderung|Online)\)$/i, '')
    .replace(/(?:\s*[:\-–]\s*|\s+)(?:Vorlesung|Übung|Uebung|Praktikum|Seminar|Tutorium|Kolloquium|Klausur|Prüfung|Pruefung|Exam|Lecture|Große Übung|Grosse Uebung|Hörsaalübung|Hoersaaluebung|Gruppenübung|Gruppenuebung|Zentralübung|Zentraluebung|Labor|Laboratorium)$/i, '')
    .replace(/\s+(?:VL|UE|Ü|PR|TUT|SE)$/i, '')
    .trim()

  if (!name && cats.length > 0) {
    const firstCat = cats[0].trim()
    if (!firstCat.match(codeRegex)) name = firstCat
  }
  if (!name && code) name = code
  if (!name) return null

  let lecturer: string | undefined
  const lecMatch = desc.match(/(?:Dozent(?:in)?|Prof(?:essor)?(?:\.|\b)|Lehrperson|Lecturer|Instructor)[\s:]*([^\r\n,;]+)/i)
  if (lecMatch) lecturer = lecMatch[1].trim()

  return { name, code, lecturer }
}

export function autoCreateModule(
  courseInfo: { name: string; code?: string; lecturer?: string },
  semesterId: ID,
  existingModules: Module[],
): Module {
  const color = pickNextModuleColor(existingModules)
  return newModule(semesterId, {
    name: courseInfo.name,
    code: courseInfo.code ?? '',
    lecturer: courseInfo.lecturer ?? '',
    color,
  })
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Ganzes Wort (nicht Teil eines anderen Worts), ohne Groß-/Kleinschreibung */
const wordPattern = (s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(s)}($|[^\\p{L}\\p{N}])`, 'iu')

function findModuleMatch(
  summary: string,
  description: string,
  categories: string[],
  modules: Module[],
  activeSemesterId?: string | null,
): Module | null {
  if (modules.length === 0) return null

  // Active semester prioritization comparator
  const activeFirst = (a: Module, b: Module): number => {
    if (!activeSemesterId) return 0
    const aActive = a.semesterId === activeSemesterId ? 1 : 0
    const bActive = b.semesterId === activeSemesterId ? 1 : 0
    return bActive - aActive
  }

  // Pre-prepare module candidates with extracted metadata
  interface PreparedModule {
    m: Module
    mCode: string
    mCodeStripped: string
    mExtCodeStripped: string
    mEffectiveCodeStripped: string
    mNameNorm: string
    mCleanNameNorm: string
  }

  const prepared: PreparedModule[] = modules.map((m) => {
    const mExtracted = extractCourseInfo(m.name)
    const mCode = m.code.trim().toLowerCase()
    const mCodeStripped = stripModuleSuffix(mCode)
    const mExtCodeStripped = mExtracted?.code ? stripModuleSuffix(mExtracted.code.toLowerCase()) : ''
    const mEffectiveCodeStripped = mCodeStripped || mExtCodeStripped
    const mNameNorm = normalizeTextForMatching(m.name)
    const mCleanNameNorm = mExtracted?.name ? normalizeTextForMatching(mExtracted.name) : mNameNorm
    return {
      m,
      mCode,
      mCodeStripped,
      mExtCodeStripped,
      mEffectiveCodeStripped,
      mNameNorm,
      mCleanNameNorm,
    }
  })

  // Baseline list: active semester first
  const sorted = [...prepared].sort((a, b) => activeFirst(a.m, b.m))

  // Candidate sorting for name matching: active semester first, then longest clean name length descending
  const sortedByNameLength = [...prepared].sort((a, b) => {
    const act = activeFirst(a.m, b.m)
    if (act !== 0) return act
    const aLen = Math.max(a.mCleanNameNorm.length, a.mNameNorm.length)
    const bLen = Math.max(b.mCleanNameNorm.length, b.mNameNorm.length)
    return bLen - aLen
  })

  // Candidate sorting for code matching: active semester first, then code length descending
  const sortedByCodeLength = [...prepared].sort((a, b) => {
    const act = activeFirst(a.m, b.m)
    if (act !== 0) return act
    return b.mEffectiveCodeStripped.length - a.mEffectiveCodeStripped.length
  })

  const normCategories = categories.map((c) => c.trim().toLowerCase())
  const strippedCategories = categories.map((c) => stripModuleSuffix(c.trim().toLowerCase()))
  const normSummary = normalizeTextForMatching(summary)
  const primaryText = [summary, ...categories].filter(Boolean).join(' ')
  const extracted = extractCourseInfo(summary, categories, description)
  const extNameNorm = extracted?.name ? normalizeTextForMatching(extracted.name) : ''
  const extCodeStripped = extracted?.code ? stripModuleSuffix(extracted.code.toLowerCase()) : ''

  // =========================================================================
  // STAGE 1: Primary Match (Title / Summary, Categories, Extracted Codes)
  // Prevents Description Poisoning by inspecting all title candidates first.
  // =========================================================================

  // 1. Direct Category Match (exact or stripped code or name)
  for (const item of sorted) {
    if (
      item.mCode &&
      (normCategories.includes(item.mCode) ||
        (item.mCodeStripped && strippedCategories.includes(item.mCodeStripped)))
    ) {
      return item.m
    }
    if (item.mEffectiveCodeStripped && strippedCategories.includes(item.mEffectiveCodeStripped)) {
      return item.m
    }
    if (
      item.mNameNorm &&
      (normCategories.includes(item.m.name.trim().toLowerCase()) ||
        categories.some((c) => normalizeTextForMatching(c) === item.mNameNorm))
    ) {
      return item.m
    }
    if (
      item.mCleanNameNorm &&
      item.mCleanNameNorm !== item.mNameNorm &&
      categories.some((c) => normalizeTextForMatching(c) === item.mCleanNameNorm)
    ) {
      return item.m
    }
  }

  // 2. Extracted Course Code Match (from summary or category)
  if (extCodeStripped) {
    for (const item of sortedByCodeLength) {
      if (item.mEffectiveCodeStripped && extCodeStripped === item.mEffectiveCodeStripped) {
        return item.m
      }
    }
  }

  // 3. Word Pattern match on Module Code in Summary / Categories
  for (const item of sortedByCodeLength) {
    const codes = [item.mCode, item.mCodeStripped, item.mEffectiveCodeStripped].filter(
      (c): c is string => Boolean(c) && c.length >= 2,
    )
    for (const code of codes) {
      if (wordPattern(code).test(primaryText)) {
        return item.m
      }
    }
  }

  // 4. Exact Course Name Match (m.name or clean name equals event summary or extracted name)
  for (const item of sortedByNameLength) {
    if (normSummary.length >= 3) {
      if (item.mNameNorm === normSummary || item.mCleanNameNorm === normSummary) {
        return item.m
      }
    }
    if (extNameNorm.length >= 3) {
      if (item.mNameNorm === extNameNorm || item.mCleanNameNorm === extNameNorm) {
        return item.m
      }
    }
  }

  // 5. Course Name Match in Title / Summary (Longest module clean name first, bidirectional)
  for (const item of sortedByNameLength) {
    const names = Array.from(
      new Set([item.mCleanNameNorm, item.mNameNorm].filter((n) => Boolean(n) && n.length >= 3)),
    )
    for (const name of names) {
      const namePattern = new RegExp(`(^|\\s)${escapeRegExp(name)}($|\\s)`)
      // Forward containment: module name in event summary
      if (normSummary && namePattern.test(normSummary)) {
        return item.m
      }
      if (extNameNorm && namePattern.test(extNameNorm)) {
        return item.m
      }
      // Reverse containment: event summary (or extracted name) in module name
      // (Crucial when module was copy-pasted as e.g. "20-00-0900 Digitaltechnik" and event is "Digitaltechnik")
      if (normSummary && normSummary.length >= 3) {
        const summaryPattern = new RegExp(`(^|\\s)${escapeRegExp(normSummary)}($|\\s)`)
        if (summaryPattern.test(name)) {
          return item.m
        }
      }
      if (extNameNorm && extNameNorm.length >= 3) {
        const extPattern = new RegExp(`(^|\\s)${escapeRegExp(extNameNorm)}($|\\s)`)
        if (extPattern.test(name)) {
          return item.m
        }
      }
    }

    // Word pattern fallback on raw names
    const rawNames = [item.m.name.trim()].filter((n) => n.length >= 3)
    for (const rName of rawNames) {
      if (wordPattern(rName).test(summary)) {
        return item.m
      }
    }
  }

  // =========================================================================
  // STAGE 2: Secondary Fallback Match (Description / Notes)
  // Only executed if Stage 1 found NO module match across all candidates.
  // =========================================================================
  const trimmedDesc = description.trim()
  if (trimmedDesc) {
    const normDesc = normalizeTextForMatching(trimmedDesc)

    // 6. Word Pattern match on Module Code in Description
    for (const item of sortedByCodeLength) {
      const codes = [item.mCode, item.mCodeStripped, item.mEffectiveCodeStripped].filter(
        (c): c is string => Boolean(c) && c.length >= 2,
      )
      for (const code of codes) {
        if (wordPattern(code).test(trimmedDesc)) {
          return item.m
        }
      }
    }

    // 7. Course Name Match in Description (Longest module clean name first)
    for (const item of sortedByNameLength) {
      const names = Array.from(
        new Set([item.mCleanNameNorm, item.mNameNorm].filter((n) => Boolean(n) && n.length >= 3)),
      )
      for (const name of names) {
        const namePattern = new RegExp(`(^|\\s)${escapeRegExp(name)}($|\\s)`)
        if (namePattern.test(normDesc)) {
          return item.m
        }
        if (wordPattern(name).test(trimmedDesc)) {
          return item.m
        }
      }
    }
  }

  return null
}

export function matchModule(
  event: ParsedEvent,
  modules: Module[],
  activeSemesterId?: string | null,
): string | null
export function matchModule(
  summary: string,
  description: string,
  categories: string[],
  modules: Module[],
  activeSemesterId?: string | null,
): Module | null
export function matchModule(
  arg1: ParsedEvent | string,
  arg2: Module[] | string,
  arg3?: string | null | string[],
  arg4?: Module[],
  arg5?: string | null,
): string | Module | null {
  if (typeof arg1 === 'object' && arg1 !== null && 'title' in arg1) {
    const event = arg1
    const modules = (Array.isArray(arg2) ? arg2 : []) as Module[]
    const activeSemesterId = typeof arg3 === 'string' ? arg3 : null
    const matched = findModuleMatch(event.title, event.description, event.categories, modules, activeSemesterId)
    return matched ? matched.id : null
  }

  const summary = typeof arg1 === 'string' ? arg1 : ''
  const description = typeof arg2 === 'string' ? arg2 : ''
  const categories = Array.isArray(arg3) ? arg3 : []
  const modules = Array.isArray(arg4) ? arg4 : []
  const activeSemesterId = typeof arg5 === 'string' ? arg5 : null

  return findModuleMatch(summary, description, categories, modules, activeSemesterId)
}

export function normalizeCalendarUrl(url: string): string {
  const trimmed = url.trim().replace(/^webcals?:\/\//i, 'https://')
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Nur http(s)- oder webcal-Adressen sind erlaubt.')
  }
  return parsed.toString()
}

export async function fetchCalendar(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(normalizeCalendarUrl(url), {
    headers: { Accept: 'text/calendar, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Kalender nicht erreichbar (HTTP ${response.status}).`)
  const bytes = await readLimited(response, MAX_CALENDAR_BYTES, 'Der Kalender')
  const text = decodeIcsText(bytes)
  if (!text.includes('BEGIN:VCALENDAR'))
    throw new Error('Die Adresse liefert keinen iCal-Kalender.')
  return text
}

/** Adresse ohne geheime Parameter (Token) – nur zur Anzeige */
export function maskCalendarUrl(url: string): string {
  const u = new URL(normalizeCalendarUrl(url))
  return `${u.host}${u.pathname}${u.search ? '?…' : ''}`
}

/**
 * Neue Termine eines Abos mit den vorhandenen zusammenführen. Viele Systeme (z. B. Moodle)
 * liefern nur ein rollierendes Zeitfenster – ältere Termine bleiben deshalb erhalten.
 */
export function mergeSubscriptionEvents(
  existing: CalendarEvent[],
  incoming: CalendarEvent[],
  now = new Date(),
): CalendarEvent[] {
  const cutoff = new Date(now.getTime() - 3 * 86_400_000).toISOString()
  const incomingIds = new Set(incoming.map((e) => e.externalId))
  const kept = existing.filter((e) => e.start < cutoff && !incomingIds.has(e.externalId))
  return [...kept, ...incoming]
}

export interface EventsFromIcsOptions {
  activeSemesterId?: ID | null
  autoCreateModules?: boolean
  onModuleCreated?: (mod: Module) => void
  now?: Date
}

/** Wandelt eine iCal-Datei in Termine des Abos um. */
export function eventsFromIcs(
  text: string,
  subscription: Subscription,
  modules: Module[],
  optionsOrNow?: EventsFromIcsOptions | Date,
): CalendarEvent[] {
  const options = optionsOrNow instanceof Date ? { now: optionsOrNow } : (optionsOrNow ?? {})
  const now = options.now ?? new Date()
  const from = new Date(now.getTime() - 90 * 86_400_000)
  const to = new Date(now.getTime() + 400 * 86_400_000)

  const activeSemesterId = options.activeSemesterId ?? null
  const autoCreate = Boolean(options.autoCreateModules && activeSemesterId)
  const currentModules = [...modules]

  return parseIcs(text, from, to).map((e) => {
    const kind = classifyEvent(e.title, e.description, e.categories)
    const finalKind = kind === 'other' && e.start.getTime() === e.end.getTime() ? 'deadline' : kind

    let matchedId = matchModule(e, currentModules, activeSemesterId)

    if (!matchedId && autoCreate && activeSemesterId) {
      const courseInfo = extractCourseInfo(e)
      const isAcademicKind =
        finalKind === 'lecture' || finalKind === 'exercise' || finalKind === 'lab' || finalKind === 'exam'
      if (courseInfo && (Boolean(courseInfo.code) || (isAcademicKind && courseInfo.name.length >= 3))) {
        const newMod = autoCreateModule(courseInfo, activeSemesterId, currentModules)
        currentModules.push(newMod)
        options.onModuleCreated?.(newMod)
        matchedId = newMod.id
      }
    }

    return {
      id: newId(),
      title: e.title.slice(0, 300),
      kind: finalKind,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      allDay: e.allDay,
      moduleId: matchedId,
      location: e.location.slice(0, 300),
      notes: e.description.slice(0, 2000),
      subscriptionId: subscription.id,
      externalId: e.uid,
    }
  })
}
