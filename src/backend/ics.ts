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

    const push = (item: InstanceType<typeof ICAL.Event>, start: InstanceType<typeof ICAL.Time>, end: InstanceType<typeof ICAL.Time>, uid: string): void => {
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
      for (let i = 0, next = iterator.next(); next && i < MAX_OCCURRENCES; i++, next = iterator.next()) {
        const details = event.getOccurrenceDetails(next)
        if (details.startDate.toJSDate() > to) break
        push(details.item, details.startDate, details.endDate, `${event.uid}#${details.recurrenceId.toString()}`)
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

/** Ordnet einen Termin einem Modul zu (über Kürzel oder Namen) */
export function matchModule(event: ParsedEvent, modules: Module[]): string | null {
  const haystack = `${event.title} ${event.categories.join(' ')} ${event.description}`.toLowerCase()
  const byCode = modules.find((m) => m.code.trim().length >= 2 && haystack.includes(m.code.trim().toLowerCase()))
  if (byCode) return byCode.id
  const byName = modules.find((m) => m.name.trim().length >= 3 && haystack.includes(m.name.trim().toLowerCase()))
  return byName?.id ?? null
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
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Die Adresse liefert keinen iCal-Kalender.')
  return text
}

/** Wandelt ein Abo in Termine um. Bestehende Termine desselben Abos werden ersetzt. */
export function eventsFromIcs(text: string, subscription: Subscription, modules: Module[], now = new Date()): CalendarEvent[] {
  const from = new Date(now.getTime() - 90 * 86_400_000)
  const to = new Date(now.getTime() + 400 * 86_400_000)
  return parseIcs(text, from, to).map((e) => ({
    id: newId(),
    title: e.title,
    kind: classifyEvent(`${e.title} ${e.categories.join(' ')}`),
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    allDay: e.allDay,
    moduleId: matchModule(e, modules),
    location: e.location,
    notes: e.description.slice(0, 2000),
    subscriptionId: subscription.id,
    externalId: e.uid,
  }))
}
