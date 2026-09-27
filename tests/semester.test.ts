import { describe, expect, it } from 'vitest'
import { buildSemester, lectureWeek, nextSemesterDraft, semesterForDate, semesterName } from '../src/shared/semester'

describe('Semester-Modelle', () => {
  it('benennt Semester wie an deutschen Hochschulen üblich', () => {
    expect(semesterName('winter', 2026)).toBe('WiSe 2026/27')
    expect(semesterName('summer', 2027)).toBe('SoSe 2027')
  })

  it('berechnet ein Uni-Wintersemester', () => {
    const s = buildSemester('uni', 'winter', 2025)
    expect(s.start).toBe('2025-10-01')
    expect(s.end).toBe('2026-03-31')
    expect(s.lectureStart).toBe('2025-10-13')
    expect(s.lectureEnd).toBe('2026-02-13')
    expect(s.breaks[0].label).toBe('Weihnachtspause')
  })

  it('berechnet ein Uni-Sommersemester', () => {
    const s = buildSemester('uni', 'summer', 2026)
    expect(s.start).toBe('2026-04-01')
    expect(s.end).toBe('2026-09-30')
    expect(s.lectureStart).toBe('2026-04-13')
    expect(s.lectureEnd).toBe('2026-07-17')
  })

  it('findet das Semester zu einem Datum', () => {
    expect(semesterForDate('uni', '2026-02-10').name).toBe('WiSe 2025/26')
    expect(semesterForDate('uni', '2026-05-10').name).toBe('SoSe 2026')
    expect(semesterForDate('hochschule', '2026-09-15').name).toBe('WiSe 2026/27')
    expect(semesterForDate('hochschule', '2026-08-15').name).toBe('SoSe 2026')
  })

  it('liefert das Folgesemester', () => {
    expect(nextSemesterDraft('uni', buildSemester('uni', 'winter', 2026)).name).toBe('SoSe 2027')
    expect(nextSemesterDraft('uni', buildSemester('uni', 'summer', 2027)).name).toBe('WiSe 2027/28')
  })

  it('zählt Vorlesungswochen', () => {
    const s = buildSemester('uni', 'summer', 2026)
    expect(lectureWeek(s, '2026-04-13')).toEqual({ week: 1, total: 14 })
    expect(lectureWeek(s, '2026-04-20')?.week).toBe(2)
    expect(lectureWeek(s, '2026-08-01')).toBeNull()
  })
})
