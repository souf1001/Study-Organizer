import { describe, expect, it } from 'vitest'
import { findSeriesEvents } from '../src/shared/schedule'
import { eventsFromIcs } from '../src/backend/ics'
import type { CalendarEvent, Subscription } from '../src/shared/types'
import { newEvent, newModule } from '../src/shared/defaults'

describe('Calendar event series & module assignment', () => {
  it('findSeriesEvents finds all events of a recurrence by baseUid or subscription + title', () => {
    const events: CalendarEvent[] = [
      newEvent({
        id: 'e1',
        title: 'Analysis 1 Vorlesung',
        start: '2026-10-20T10:00:00Z',
        end: '2026-10-20T11:30:00Z',
        subscriptionId: 'sub-tucan',
        externalId: 'lecture-ana1#20261020T100000Z',
      }),
      newEvent({
        id: 'e2',
        title: 'Analysis 1 Vorlesung',
        start: '2026-10-27T10:00:00Z',
        end: '2026-10-27T11:30:00Z',
        subscriptionId: 'sub-tucan',
        externalId: 'lecture-ana1#20261027T100000Z',
      }),
      newEvent({
        id: 'e3',
        title: 'Analysis 1 Vorlesung',
        start: '2026-11-03T10:00:00Z',
        end: '2026-11-03T11:30:00Z',
        subscriptionId: 'sub-tucan',
        externalId: 'lecture-ana1#20261103T100000Z',
      }),
      newEvent({
        id: 'other',
        title: 'Lineare Algebra Vorlesung',
        start: '2026-10-21T10:00:00Z',
        end: '2026-10-21T11:30:00Z',
        subscriptionId: 'sub-tucan',
        externalId: 'lecture-la#20261021T100000Z',
      }),
    ]

    const series = findSeriesEvents(events, events[0])
    expect(series).toHaveLength(3)
    expect(series.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('eventsFromIcs keeps manual module assignments of events and series on re-sync', () => {
    const sub: Subscription = {
      id: 'sub-1',
      name: 'Stundenplan',
      kind: 'file',
      url: 'Datei',
      enabled: true,
      lastSync: null,
      lastError: null,
    }

    const modA = newModule('sem1', { id: 'mod-A', name: 'Altes Modul' })
    const modB = newModule('sem1', { id: 'mod-B', name: 'Neues Wunsch-Modul' })

    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//DE
BEGIN:VEVENT
UID:math-series#1
SUMMARY:Mathematik Vorlesung
DTSTART:20261101T080000Z
DTEND:20261101T093000Z
END:VEVENT
BEGIN:VEVENT
UID:math-series#2
SUMMARY:Mathematik Vorlesung
DTSTART:20261108T080000Z
DTEND:20261108T093000Z
END:VEVENT
END:VCALENDAR`

    // Suppose the user manually assigned the first event to mod-B:
    const existingEvents: CalendarEvent[] = [
      newEvent({
        id: 'custom-id-1',
        title: 'Mathematik Vorlesung',
        moduleId: modB.id,
        externalId: 'math-series#1',
        subscriptionId: sub.id,
      }),
    ]

    const parsed = eventsFromIcs(icsContent, sub, [modA, modB], {
      existingEvents,
      activeSemesterId: 'sem1',
      now: new Date('2026-10-24'),
    })

    expect(parsed).toHaveLength(2)
    // The first event keeps its manual assignment and ID:
    expect(parsed[0].id).toBe('custom-id-1')
    expect(parsed[0].moduleId).toBe(modB.id)
    // The second event of the same series also inherits modB:
    expect(parsed[1].moduleId).toBe(modB.id)
  })

  it('eventsFromIcs keeps user-defined notes on re-sync', () => {
    const sub: Subscription = {
      id: 'sub-2',
      name: 'Stundenplan',
      kind: 'file',
      url: 'Datei',
      enabled: true,
      lastSync: null,
      lastError: null,
    }

    const mod = newModule('sem1', { id: 'mod-1', name: 'Software Engineering' })
    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:se-event-1
SUMMARY:Software Engineering
DESCRIPTION:Originale Beschreibung aus Kalender
DTSTART:20261102T100000Z
DTEND:20261102T113000Z
END:VEVENT
END:VCALENDAR`

    const existingEvents: CalendarEvent[] = [
      newEvent({
        id: 'ev-1',
        title: 'Software Engineering',
        moduleId: mod.id,
        externalId: 'se-event-1',
        subscriptionId: sub.id,
        notes: 'Meine persönlichen Notizen zur Vorlesung',
      }),
    ]

    const parsed = eventsFromIcs(icsContent, sub, [mod], {
      existingEvents,
      activeSemesterId: 'sem1',
      now: new Date('2026-10-24'),
    })

    expect(parsed).toHaveLength(1)
    expect(parsed[0].notes).toBe('Meine persönlichen Notizen zur Vorlesung')
  })

  it('findSeriesEvents detects Moodle event series and manual series', () => {
    const events: CalendarEvent[] = [
      newEvent({
        id: 'm1',
        title: 'Moodle Test 1',
        start: '2026-11-01T10:00:00Z',
        end: '2026-11-01T11:00:00Z',
        externalId: 'moodle:event:101',
      }),
      newEvent({
        id: 'm2',
        title: 'Moodle Test 1',
        start: '2026-11-08T10:00:00Z',
        end: '2026-11-08T11:00:00Z',
        externalId: 'moodle:event:102',
      }),
      newEvent({
        id: 'man1',
        title: 'Lerngruppe Mathe',
        kind: 'other',
        start: '2026-11-02T16:00:00Z',
        end: '2026-11-02T18:00:00Z',
      }),
      newEvent({
        id: 'man2',
        title: 'Lerngruppe Mathe',
        kind: 'other',
        start: '2026-11-09T16:00:00Z',
        end: '2026-11-09T18:00:00Z',
      }),
    ]

    const moodleSeries = findSeriesEvents(events, events[0])
    expect(moodleSeries).toHaveLength(2)
    expect(moodleSeries.map((e) => e.id)).toEqual(['m1', 'm2'])

    const manualSeries = findSeriesEvents(events, events[2])
    expect(manualSeries).toHaveLength(2)
    expect(manualSeries.map((e) => e.id)).toEqual(['man1', 'man2'])
  })
})
