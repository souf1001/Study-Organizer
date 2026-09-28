// Fest hinterlegte Semester-Modelle für deutsche Hochschulen.
// Die Termine sind Vorschläge – beim Anlegen eines Semesters lassen sie sich anpassen.
import { addDays, diffDays, nextWeekday, parseISODate } from './dates'
import type { DateRange, ISODate, Semester, SemesterKind, SemesterModelId } from './types'

type MonthDay = [month: number, day: number]

interface SemesterRule {
  label: string
  description: string
  /** Beginn des Semesterzeitraums */
  winterStart: MonthDay
  summerStart: MonthDay
  /** Vorlesungsbeginn = erster Montag ab diesem Datum */
  winterLectureFrom: MonthDay
  summerLectureFrom: MonthDay
  /** Dauer der Vorlesungszeit in Wochen (Vorlesungsende = Freitag der letzten Woche) */
  winterLectureWeeks: number
  summerLectureWeeks: number
  /** Weihnachtspause (Dezember → Januar) */
  christmasBreak: [from: MonthDay, to: MonthDay]
}

// Quellen: Vorgaben des MKW NRW für Universitäten und Fachhochschulen (WiSe 2026/27, SoSe 2027),
// Merkblätter der h_da (WiSe 2025/26 bis WiSe 2026/27). Einzelne Hochschulen weichen ab.
export const SEMESTER_MODELS: Record<SemesterModelId, SemesterRule> = {
  uni: {
    label: 'Universität',
    description: 'WiSe 1.10.–31.3., SoSe 1.4.–30.9. · Vorlesungen ab Mitte Oktober bzw. Mitte April',
    winterStart: [10, 1],
    summerStart: [4, 1],
    winterLectureFrom: [10, 11],
    summerLectureFrom: [4, 11],
    winterLectureWeeks: 17,
    summerLectureWeeks: 14,
    christmasBreak: [[12, 22], [1, 6]],
  },
  hochschule: {
    label: 'Hochschule (HAW/FH)',
    description: 'WiSe 1.9.–28.2., SoSe 1.3.–31.8. · Vorlesungen ab Ende September bzw. Ende März',
    winterStart: [9, 1],
    summerStart: [3, 1],
    winterLectureFrom: [9, 25],
    summerLectureFrom: [3, 25],
    winterLectureWeeks: 20,
    summerLectureWeeks: 17,
    christmasBreak: [[12, 22], [1, 6]],
  },
  hda: {
    label: 'Hochschule Darmstadt (h_da)',
    description: 'WiSe 1.10.–31.3., SoSe 1.4.–30.9. · Vorlesungen ab Anfang/Mitte Oktober bzw. Mitte April',
    winterStart: [10, 1],
    summerStart: [4, 1],
    winterLectureFrom: [10, 6],
    summerLectureFrom: [4, 11],
    winterLectureWeeks: 17,
    summerLectureWeeks: 15,
    christmasBreak: [[12, 21], [1, 8]],
  },
}

export type SemesterDraft = Omit<Semester, 'id' | 'createdAt'>

const iso = (year: number, [month, day]: MonthDay): ISODate =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

export function semesterName(kind: SemesterKind, year: number): string {
  return kind === 'winter' ? `WiSe ${year}/${String(year + 1).slice(2)}` : `SoSe ${year}`
}

/** Baut ein Semester (Winter: `year` = Jahr des Semesterbeginns) */
export function buildSemester(
  modelId: SemesterModelId,
  kind: SemesterKind,
  year: number,
): SemesterDraft {
  const rule = SEMESTER_MODELS[modelId]
  const winter = kind === 'winter'
  const start = iso(year, winter ? rule.winterStart : rule.summerStart)
  const nextStart = winter ? iso(year + 1, rule.summerStart) : iso(year, rule.winterStart)
  const lectureStart = nextWeekday(
    iso(year, winter ? rule.winterLectureFrom : rule.summerLectureFrom),
    1,
  )
  const weeks = winter ? rule.winterLectureWeeks : rule.summerLectureWeeks
  const lectureEnd = addDays(lectureStart, (weeks - 1) * 7 + 4)
  const [breakFrom, breakTo] = rule.christmasBreak
  const breaks: DateRange[] = winter
    ? [{ start: iso(year, breakFrom), end: iso(year + 1, breakTo), label: 'Weihnachtspause' }]
    : []
  return {
    name: semesterName(kind, year),
    kind,
    year,
    start,
    end: addDays(nextStart, -1),
    lectureStart,
    lectureEnd,
    breaks,
  }
}

/** Semester, in dessen Zeitraum das Datum liegt */
export function semesterForDate(modelId: SemesterModelId, date: ISODate): SemesterDraft {
  const year = parseISODate(date).getFullYear()
  const candidates = [
    buildSemester(modelId, 'winter', year - 1),
    buildSemester(modelId, 'summer', year),
    buildSemester(modelId, 'winter', year),
  ]
  return candidates.find((s) => date >= s.start && date <= s.end) ?? candidates[2]
}

/** Vorschlag bei der Einrichtung: nach Vorlesungsende schon das kommende Semester */
export function suggestedSemester(modelId: SemesterModelId, date: ISODate): SemesterDraft {
  const current = semesterForDate(modelId, date)
  return date > current.lectureEnd ? nextSemesterDraft(modelId, current) : current
}

export function nextSemesterDraft(modelId: SemesterModelId, semester: SemesterDraft): SemesterDraft {
  return semester.kind === 'winter'
    ? buildSemester(modelId, 'summer', semester.year + 1)
    : buildSemester(modelId, 'winter', semester.year)
}

export function findSemesterAt<T extends SemesterDraft>(semesters: T[], date: ISODate): T | undefined {
  return semesters.find((s) => date >= s.start && date <= s.end)
}

/** Vorlesungswoche (ab 1) und Gesamtzahl – null außerhalb der Vorlesungszeit */
export function lectureWeek(
  semester: SemesterDraft,
  date: ISODate,
): { week: number; total: number } | null {
  if (date < semester.lectureStart || date > semester.lectureEnd) return null
  const total = Math.ceil((diffDays(semester.lectureStart, semester.lectureEnd) + 1) / 7)
  const week = Math.floor(diffDays(semester.lectureStart, date) / 7) + 1
  return { week, total }
}

export function isInBreak(semester: Pick<Semester, 'breaks'>, date: ISODate): boolean {
  return semester.breaks.some((b) => date >= b.start && date <= b.end)
}
