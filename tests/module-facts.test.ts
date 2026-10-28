import { describe, expect, it } from 'vitest'
import { createDefaultDb, newEvent, newModule, newSlot, newTask } from '../src/shared/defaults'
import type { Semester } from '../src/shared/types'
import { moduleFacts, nowFacts, studyOverview } from '../src/shared/module-facts'

const semester: Semester = {
  id: 'ws',
  name: 'WiSe 2026/27',
  kind: 'winter',
  year: 2026,
  start: '2026-10-01',
  end: '2027-03-31',
  lectureStart: '2026-10-12',
  lectureEnd: '2027-02-05',
  breaks: [],
  createdAt: '2026-10-01T00:00:00.000Z',
}

describe('moduleFacts', () => {
  const db = createDefaultDb()
  db.semesters.push(semester)
  db.activeSemesterId = 'ws'
  const module = newModule('ws', {
    name: 'Rechnernetze',
    code: 'RN',
    lecturer: 'Prof. Weber',
    schedule: [
      newSlot({ kind: 'lecture', weekday: 3, start: '10:00', end: '11:30', room: 'D14/0.04' }),
    ],
  })
  db.modules.push(module)
  db.events.push(
    newEvent({
      title: 'Klausur Rechnernetze',
      kind: 'exam',
      start: new Date(2027, 1, 10, 9, 0).toISOString(),
      end: new Date(2027, 1, 10, 11, 0).toISOString(),
      moduleId: module.id,
      location: 'Audimax',
    }),
  )
  db.tasks.push(
    newTask({ title: 'Übungsblatt 3', moduleId: module.id, due: '2026-10-30T23:59:00' }),
  )
  // Monday, 26.10.2026 12:00
  const now = new Date(2026, 9, 26, 12, 0)

  it('names the next lecture with its room, exams and tasks', () => {
    const text = moduleFacts(db, module, now)
    expect(text).toContain('Dozent/in: Prof. Weber')
    expect(text).toContain('Vorlesung: Mittwoch 10:00–11:30, Raum D14/0.04')
    expect(text).toContain('- Mittwoch, 28.10.2026 10:00–11:30: Vorlesung 3, Raum D14/0.04')
    expect(text).toContain(
      'Prüfung: Klausur Rechnernetze – Mittwoch, 10.02.2027, 09:00–11:00 – Ort: Audimax',
    )
    expect(text).toContain('Übungsblatt 3 – fällig Freitag, 30.10.2026, 23:59')
  })

  it('gives an overview of the semester and today’s date', () => {
    expect(nowFacts(now)).toBe('Heute ist Montag, 26.10.2026, es ist 12:00 Uhr.')
    expect(studyOverview(db, now)).toContain('- Rechnernetze (RN): Vorlesung Mi 10:00 (D14/0.04)')
  })
})
