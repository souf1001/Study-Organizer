// iCal-/ICS-Kalender abonnieren (Moodle-Kalenderexport, Stundenplan aus my h_da, HISinOne, Stud.IP …).
import ICAL from 'ical.js'
import type { CalendarEvent, EventKind, Module, Subscription } from '../shared/types'
import { newId } from '../shared/defaults'

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

export function parseIcs(text: string, from: Date, to: Date): ParsedEvent[] {
  const root = new ICAL.Component(ICAL.parse(text))
  for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz)

  const vevents = root.getAllSubcomponents('vevent')
  const exceptions = vevents.filter((v) => v.hasProperty('recurrence-id'))
  const result: ParsedEvent[] = []

  for (const component of vevents.filter((v) => !v.hasProperty('recurrence-id'))) {
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
      const startDate = start.toJSDate()
      const endDate = end ? end.toJSDate() : startDate
      if (endDate < from || startDate > to) return
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
  [/klausur|prüfung|pruefung|exam|nachschreib/i, 'exam'],
  [/abgabe|fällig|faellig|\bdue\b|deadline|einreich|submission|schließt|closes/i, 'deadline'],
  [/praktikum|labor|\blab\b|testat/i, 'lab'],
  [/vorlesung|übung|uebung|lecture|tutorium|seminar|\bvl\b|\bü\b/i, 'lecture'],
]

export function classifyEvent(text: string): EventKind {
  return KIND_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'other'
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Ganzes Wort (nicht Teil eines anderen Worts), ohne Groß-/Kleinschreibung */
const wordPattern = (s: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(s)}($|[^\\p{L}\\p{N}])`, 'iu')

/** Ordnet einen Termin einem Modul zu: Kategorie (Moodle-Kurzname), dann Kürzel, dann Name */
export function matchModule(event: ParsedEvent, modules: Module[]): string | null {
  const categories = event.categories.map((c) => c.trim().toLowerCase())
  const text = `${event.title} ${event.categories.join(' ')} ${event.description}`
  const code = (m: Module) => m.code.trim()
  const name = (m: Module) => m.name.trim()
  return (
    modules.find((m) => categories.includes(code(m).toLowerCase()) || categories.includes(name(m).toLowerCase()))?.id ??
    modules.find((m) => code(m).length >= 2 && wordPattern(code(m)).test(text))?.id ??
    modules.find((m) => name(m).length >= 3 && wordPattern(name(m)).test(text))?.id ??
    null
  )
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
  const text = await response.text()
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

/** Wandelt eine iCal-Datei in Termine des Abos um. */
export function eventsFromIcs(
  text: string,
  subscription: Subscription,
  modules: Module[],
  now = new Date(),
): CalendarEvent[] {
  const from = new Date(now.getTime() - 90 * 86_400_000)
  const to = new Date(now.getTime() + 400 * 86_400_000)
  return parseIcs(text, from, to).map((e) => {
    const kind = classifyEvent(`${e.title} ${e.categories.join(' ')}`)
    return {
      id: newId(),
      title: e.title,
      // Termine ohne Dauer (z. B. Moodle-Abgaben) sind Fristen
      kind: kind === 'other' && e.start.getTime() === e.end.getTime() ? 'deadline' : kind,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      allDay: e.allDay,
      moduleId: matchModule(e, modules),
      location: e.location,
      notes: e.description.slice(0, 2000),
      subscriptionId: subscription.id,
      externalId: e.uid,
    }
  })
}
