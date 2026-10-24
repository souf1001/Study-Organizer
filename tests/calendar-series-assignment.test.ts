import { describe, expect, it } from 'vitest'
import { findSeriesEvents } from '../src/shared/schedule'
import { eventsFromIcs } from '../src/backend/ics'
import type { CalendarEvent, Subscription } from '../src/shared/types'
import { newEvent, newModule } from '../src/shared/defaults'

describe('Kalender-Terminserien & Modulzuweisung', () => {
  it('findSeriesEvents erkennt alle Termine einer Wiederholung anhand baseUid oder Abo+Titel', () => {
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

  it('eventsFromIcs bewahrt manuelle Modulzuweisungen von Terminen und Serien bei Re-Sync', () => {
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

    // Angenommen, der Nutzer hat den ersten Termin manuell mod-B zugewiesen:
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
    // Erster Termin behält die manuelle Zuweisung und die ID:
    expect(parsed[0].id).toBe('custom-id-1')
    expect(parsed[0].moduleId).toBe(modB.id)
    // Zweiter Termin der gleichen Serie übernimmt ebenfalls modB:
    expect(parsed[1].moduleId).toBe(modB.id)
  })
})
