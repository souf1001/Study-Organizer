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
    const events = eventsFromIcs(ICS, { id: 'sub', name: 'Moodle', url: '', enabled: true, lastSync: null, lastError: null }, [ana], new Date('2026-10-01'))
    expect(events.every((e) => e.moduleId === ana.id)).toBe(true)
    expect(events.every((e) => e.subscriptionId === 'sub')).toBe(true)
  })

  it('akzeptiert webcal-Links und lehnt andere Protokolle ab', () => {
    expect(normalizeCalendarUrl('webcal://moodle.example.de/cal.ics')).toBe('https://moodle.example.de/cal.ics')
    expect(() => normalizeCalendarUrl('file:///etc/passwd')).toThrow()
  })
})
