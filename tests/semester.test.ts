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
    expect(s.lectureEnd).toBe('2026-02-06')
    expect(s.breaks[0].label).toBe('Weihnachtspause')
  })

  it('berechnet ein Uni-Sommersemester', () => {
    const s = buildSemester('uni', 'summer', 2026)
    expect(s.start).toBe('2026-04-01')
    expect(s.end).toBe('2026-09-30')
    expect(s.lectureStart).toBe('2026-04-13')
    expect(s.lectureEnd).toBe('2026-07-17')
  })

  it('trifft die veröffentlichten Termine (NRW 2026/27, h_da)', () => {
    const uni = buildSemester('uni', 'winter', 2026)
    expect([uni.lectureStart, uni.lectureEnd]).toEqual(['2026-10-12', '2027-02-05'])
    const fh = buildSemester('hochschule', 'winter', 2026)
    expect([fh.start, fh.end, fh.lectureStart, fh.lectureEnd]).toEqual(['2026-09-01', '2027-02-28', '2026-09-28', '2027-02-12'])
    const fhSummer = buildSemester('hochschule', 'summer', 2027)
    expect([fhSummer.lectureStart, fhSummer.lectureEnd]).toEqual(['2027-03-29', '2027-07-23'])
    const hdaWinter = buildSemester('hda', 'winter', 2026)
    expect([hdaWinter.lectureStart, hdaWinter.lectureEnd]).toEqual(['2026-10-12', '2027-02-05'])
    expect(hdaWinter.breaks[0]).toMatchObject({ start: '2026-12-21', end: '2027-01-08' })
    expect(buildSemester('hda', 'winter', 2025).lectureStart).toBe('2025-10-06')
    expect(buildSemester('hda', 'winter', 2025).lectureEnd).toBe('2026-01-30')
    const hdaSummer = buildSemester('hda', 'summer', 2026)
    expect([hdaSummer.lectureStart, hdaSummer.lectureEnd]).toEqual(['2026-04-13', '2026-07-24'])
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

describe('Vorschlag bei der Einrichtung', () => {
  it('schlägt nach Vorlesungsende schon das kommende Semester vor', async () => {
    const { suggestedSemester } = await import('../src/shared/semester')
    expect(suggestedSemester('hda', '2026-09-28').name).toBe('WiSe 2026/27')
    expect(suggestedSemester('hda', '2026-05-10').name).toBe('SoSe 2026')
  })
})
