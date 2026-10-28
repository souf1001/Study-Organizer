// Expands weekly module slots (lecture, exercise, lab, ...) into concrete dates.
import { addDays, nextWeekday, shortDate } from './dates'
import { isInBreak } from './semester'
import type {
  CalendarEvent,
  ID,
  ISODate,
  Module,
  ScheduleSlot,
  Semester,
  SessionKind,
} from './types'

export const SESSION_LABELS: Record<SessionKind, string> = {
  lecture: 'Vorlesung',
  exercise: 'Übung',
  lab: 'Praktikum',
  seminar: 'Seminar',
  tutorial: 'Tutorium',
}

export interface Occurrence {
  slotId: ID
  moduleId: ID
  kind: SessionKind
  date: ISODate
  start: string
  end: string
  room: string
  /** Sequence number within the slot (1 = first session) */
  index: number
}

type SemesterDates = Pick<Semester, 'lectureStart' | 'lectureEnd' | 'breaks'>

export function expandSlot(
  slot: ScheduleSlot,
  moduleId: ID,
  semester: SemesterDates,
): Occurrence[] {
  const from =
    slot.firstDate && slot.firstDate > semester.lectureStart
      ? slot.firstDate
      : semester.lectureStart
  const step = slot.everyTwoWeeks ? 14 : 7
  const result: Occurrence[] = []
  let index = 0
  for (
    let date = nextWeekday(from, slot.weekday);
    date <= semester.lectureEnd;
    date = addDays(date, step)
  ) {
    if (isInBreak(semester, date) || slot.skip.includes(date)) continue
    index += 1
    result.push({
      slotId: slot.id,
      moduleId,
      kind: slot.kind,
      date,
      start: slot.start,
      end: slot.end,
      room: slot.room,
      index,
    })
  }
  return result
}

export function moduleOccurrences(module: Module, semester: SemesterDates): Occurrence[] {
  return module.schedule
    .flatMap((slot) => expandSlot(slot, module.id, semester))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
}

/** Folder name from a template, e.g. '{kind} {n} · {date}' → 'Vorlesung 3 · 14.10.' */
export function sessionFolderName(
  template: string,
  occ: Pick<Occurrence, 'kind' | 'index' | 'date'>,
): string {
  return (template || '{kind} {n} · {date}')
    .replaceAll('{kind}', SESSION_LABELS[occ.kind])
    .replaceAll('{n}', String(occ.index))
    .replaceAll('{date}', shortDate(occ.date))
    .trim()
}

export function findSeriesEvents(
  allEvents: CalendarEvent[],
  target: CalendarEvent,
): CalendarEvent[] {
  if (!target.id && !target.externalId) return []
  const baseUid = target.externalId?.includes('#') ? target.externalId.split('#')[0] : null
  const targetTitleNorm = target.title.trim().toLowerCase()
  return allEvents.filter((e) => {
    if (e.id === target.id) return true
    if (baseUid && e.externalId && e.externalId.split('#')[0] === baseUid) return true
    if (
      target.subscriptionId &&
      e.subscriptionId === target.subscriptionId &&
      e.title.trim().toLowerCase() === targetTitleNorm
    ) {
      return true
    }
    if (
      target.externalId?.startsWith('moodle:') &&
      e.externalId?.startsWith('moodle:') &&
      e.title.trim().toLowerCase() === targetTitleNorm
    ) {
      return true
    }
    if (
      !target.subscriptionId &&
      !target.externalId &&
      !e.subscriptionId &&
      !e.externalId &&
      targetTitleNorm.length >= 3 &&
      e.title.trim().toLowerCase() === targetTitleNorm &&
      e.kind === target.kind
    ) {
      return true
    }
    return false
  })
}
