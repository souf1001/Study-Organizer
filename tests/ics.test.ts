import { describe, expect, it } from 'vitest'
import { classifyEvent, eventsFromIcs, normalizeCalendarUrl, parseIcs } from '../src/backend/ics'
import { newModule } from '../src/shared/defaults'

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

describe('iCal-Import', () => {
  it('liest Einzeltermine, Serien und Ausnahmen', () => {
    const list = parseIcs(ICS, new Date('2026-09-01'), new Date('2027-03-01'))
    expect(list).toHaveLength(4)
    const moved = list.find((e) => e.title.includes('Raumänderung'))
    expect(moved?.location).toBe('D15/1.01')
    expect(list.filter((e) => e.uid.startsWith('weekly@hda#'))).toHaveLength(3)
  })

  it('erkennt Terminarten', () => {
    expect(classifyEvent('Klausur Analysis')).toBe('exam')
    expect(classifyEvent('Übungsblatt 3 ist fällig')).toBe('deadline')
    expect(classifyEvent('Praktikum Termin 2')).toBe('lab')
    expect(classifyEvent('Analysis 1 Vorlesung')).toBe('lecture')
    expect(classifyEvent('Sommerfest')).toBe('other')
  })

  it('ordnet Termine Modulen zu', () => {
    const ana = newModule('s', { name: 'Analysis 1', code: 'ANA1' })
    const events = eventsFromIcs(ICS, { id: 'sub', name: 'Moodle', kind: 'url', url: '', enabled: true, lastSync: null, lastError: null }, [ana], new Date('2026-10-01'))
    expect(events.every((e) => e.moduleId === ana.id)).toBe(true)
    expect(events.every((e) => e.subscriptionId === 'sub')).toBe(true)
  })

  it('akzeptiert webcal-Links und lehnt andere Protokolle ab', () => {
    expect(normalizeCalendarUrl('webcal://moodle.example.de/cal.ics')).toBe('https://moodle.example.de/cal.ics')
    expect(() => normalizeCalendarUrl('file:///etc/passwd')).toThrow()
  })
})

describe('Abo-Abgleich', () => {
  it('maskiert geheime Parameter', async () => {
    const { maskCalendarUrl } = await import('../src/backend/ics')
    expect(maskCalendarUrl('https://lernen.h-da.de/calendar/export_execute.php?userid=1&authtoken=geheim')).toBe(
      'lernen.h-da.de/calendar/export_execute.php?…',
    )
  })

  it('behält ältere Termine, die im rollierenden Fenster fehlen', async () => {
    const { mergeSubscriptionEvents } = await import('../src/backend/ics')
    const now = new Date('2026-11-20T12:00:00Z')
    const base = { kind: 'deadline' as const, allDay: false, moduleId: null, location: '', notes: '', subscriptionId: 's' }
    const old = { ...base, id: 'a', title: 'Alt', start: '2026-10-01T10:00:00Z', end: '2026-10-01T10:00:00Z', externalId: 'old' }
    const future = { ...base, id: 'b', title: 'Veraltet', start: '2026-12-01T10:00:00Z', end: '2026-12-01T10:00:00Z', externalId: 'gone' }
    const incoming = [{ ...base, id: 'c', title: 'Neu', start: '2026-12-05T10:00:00Z', end: '2026-12-05T10:00:00Z', externalId: 'new' }]
    const merged = mergeSubscriptionEvents([old, future], incoming, now)
    expect(merged.map((e) => e.title)).toEqual(['Alt', 'Neu'])
  })
})

describe('Modulzuordnung', () => {
  it('trifft Kürzel nur als ganzes Wort', async () => {
    const { matchModule } = await import('../src/backend/ics')
    const se = newModule('s', { name: 'Software Engineering', code: 'SE' })
    const ma = newModule('s', { name: 'Mathematik', code: 'MA' })
    const base = { uid: 'x', start: new Date(), end: new Date(), allDay: false, location: '', description: '', categories: [] as string[] }
    expect(matchModule({ ...base, title: 'Seminar Datenbanken' }, [se, ma])).toBeNull()
    expect(matchModule({ ...base, title: 'Klausur SE', description: 'Material mitbringen' }, [se, ma])).toBe(se.id)
    expect(matchModule({ ...base, title: 'Abgabe', categories: ['MA'] }, [se, ma])).toBe(ma.id)
  })
})

describe('Schutz vor übergroßen Kalendern', () => {
  const vcal = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`

  it('kürzt lange Titel und begrenzt die Zahl der Termine', () => {
    const text = vcal(`BEGIN:VEVENT\nUID:viel\nSUMMARY:${'x'.repeat(5000)}\nDTSTART:20260901T000000Z\nDTEND:20260901T001000Z\nRRULE:FREQ=HOURLY\nEND:VEVENT`)
    const sub = { id: 'sub1', name: 'x', kind: 'url' as const, url: '', enabled: true, lastSync: null, lastError: null }
    const events = eventsFromIcs(text, sub, [], new Date('2026-09-02'))
    expect(events.length).toBeLessThanOrEqual(1000)
    expect(events[0].title).toHaveLength(300)
  })

  it('ein Kalender verändert nicht die Zeitzonen eines anderen', () => {
    const withoutZone = vcal('BEGIN:VEVENT\nUID:b\nSUMMARY:B\nDTSTART;TZID=Europe/Berlin:20261012T100000\nEND:VEVENT')
    const before = parseIcs(withoutZone, new Date('2026-01-01'), new Date('2027-01-01'))[0].start.getTime()
    // Kalender mit gefälschter Zeitzone „Europe/Berlin“ (+10 Stunden)
    const fake = vcal(
      'BEGIN:VTIMEZONE\nTZID:Europe/Berlin\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+1000\nTZOFFSETTO:+1000\nEND:STANDARD\nEND:VTIMEZONE\n' +
        'BEGIN:VEVENT\nUID:a\nSUMMARY:A\nDTSTART;TZID=Europe/Berlin:20261012T100000\nEND:VEVENT',
    )
    expect(parseIcs(fake, new Date('2026-01-01'), new Date('2027-01-01'))[0].start.toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(parseIcs(withoutZone, new Date('2026-01-01'), new Date('2027-01-01'))[0].start.getTime()).toBe(before)
  })

  it('bricht zu große Downloads ab', async () => {
    const { readLimited } = await import('../src/backend/http')
    await expect(readLimited(new Response(new Uint8Array(2048)), 1024, 'Der Kalender')).rejects.toThrow('zu groß')
    expect((await readLimited(new Response(new Uint8Array(10)), 1024, 'Der Kalender')).length).toBe(10)
  })
})
