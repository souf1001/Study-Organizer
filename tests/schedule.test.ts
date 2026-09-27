import { describe, expect, it } from 'vitest'
import { newModule, newSlot } from '../src/shared/defaults'
import { expandSlot, moduleOccurrences, sessionFolderName } from '../src/shared/schedule'
import { buildSemester } from '../src/shared/semester'

const semester = { ...buildSemester('uni', 'winter', 2026), id: 's', createdAt: '' }

describe('Stundenplan', () => {
  it('erzeugt wöchentliche Termine und überspringt die Weihnachtspause', () => {
    const slot = newSlot({ weekday: 3, start: '10:00', end: '11:30', room: 'D14/0.04' })
    const list = expandSlot(slot, 'm', semester)
    expect(list[0].date).toBe('2026-10-14')
    expect(list[0].index).toBe(1)
    expect(list.every((o) => o.date < '2026-12-22' || o.date > '2027-01-06')).toBe(true)
    expect(list.at(-1)!.date <= semester.lectureEnd).toBe(true)
    expect(list[1].room).toBe('D14/0.04')
  })

  it('unterstützt 14-tägige Termine mit späterem Start und Ausfälle', () => {
    const slot = newSlot({ kind: 'lab', weekday: 1, everyTwoWeeks: true, firstDate: '2026-10-26', skip: ['2026-11-09'] })
    const dates = expandSlot(slot, 'm', semester).map((o) => o.date)
    expect(dates.slice(0, 3)).toEqual(['2026-10-26', '2026-11-23', '2026-12-07'])
  })

  it('sortiert alle Termine eines Moduls', () => {
    const module = newModule('s', {
      schedule: [newSlot({ weekday: 4, start: '14:00' }), newSlot({ weekday: 2, start: '08:15' })],
    })
    const list = moduleOccurrences(module, semester)
    expect(list[0].date).toBe('2026-10-13')
    expect(list[1].date).toBe('2026-10-15')
  })

  it('baut Ordnernamen aus der Vorlage', () => {
    expect(sessionFolderName('{kind} {n} · {date}', { kind: 'lecture', index: 3, date: '2026-10-28' })).toBe('Vorlesung 3 · 28.10.')
    expect(sessionFolderName('', { kind: 'lab', index: 1, date: '2026-11-02' })).toBe('Praktikum 1 · 02.11.')
  })
})
