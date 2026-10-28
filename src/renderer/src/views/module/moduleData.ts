// Derived data for the module page: merged session list and linked Moodle discussions.
import { isoDateOf } from '@shared/dates'
import { moduleOccurrences, type Occurrence } from '@shared/schedule'
import type {
  CalendarEvent,
  Db,
  ID,
  Module,
  MoodleDiscussion,
  Semester,
  SessionKind,
} from '@shared/types'

/** A session of the module, optionally backed by a calendar event */
export type SessionOccurrence = Occurrence & { event?: CalendarEvent; title?: string }

const LAB_KINDS: SessionKind[] = ['lab']
export const isLab = (kind: SessionKind) => LAB_KINDS.includes(kind)

const pad = (n: number) => String(n).padStart(2, '0')
const timeOf = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const sessionKey = (occ: Occurrence) => `${occ.date}#${occ.start}#${occ.kind}`

/**
 * All sessions of a module: the weekly timetable merged with calendar events assigned to the
 * module (e.g. imported from TUCaN or a calendar subscription). Entries with the same date,
 * start time and kind are merged. Lectures and labs are numbered separately by date.
 */
export function moduleSessions(
  db: Db,
  module: Module,
  semester: Semester | undefined,
): SessionOccurrence[] {
  const scheduleOccurrences = semester ? moduleOccurrences(module, semester) : []

  const eventOccurrences = db.events
    .filter((e) => e.moduleId === module.id && e.kind !== 'exam' && e.kind !== 'deadline')
    .map<SessionOccurrence>((e) => ({
      slotId: e.id,
      moduleId: module.id,
      kind: e.kind === 'lab' ? 'lab' : e.kind === 'exercise' ? 'exercise' : 'lecture',
      date: isoDateOf(e.start),
      start: e.allDay ? '' : timeOf(e.start),
      end: e.allDay ? '' : timeOf(e.end),
      room: e.location || '',
      index: 0,
      title: e.title,
      event: e,
    }))

  const merged = new Map<string, SessionOccurrence>()
  for (const occ of scheduleOccurrences) merged.set(sessionKey(occ), occ)
  for (const eventOcc of eventOccurrences) {
    const key = sessionKey(eventOcc)
    const existing = merged.get(key)
    merged.set(
      key,
      existing
        ? {
            ...existing,
            event: eventOcc.event,
            title: eventOcc.title || existing.title,
            room: existing.room || eventOcc.room,
          }
        : eventOcc,
    )
  }

  const sessions = Array.from(merged.values()).sort((a, b) =>
    (a.date + a.start).localeCompare(b.date + b.start),
  )

  let lectureCount = 0
  let labCount = 0
  for (const occ of sessions) {
    occ.index = isLab(occ.kind) ? ++labCount : ++lectureCount
  }
  return sessions
}

/** Moodle course IDs (as strings) that are mapped to the module */
export function mappedCourseIds(courseMap: Record<string, ID>, moduleId: ID): string[] {
  return Object.entries(courseMap)
    .filter(([, mappedModuleId]) => mappedModuleId === moduleId)
    .map(([courseId]) => courseId)
}

/** Discussions assigned to the module directly or through one of its mapped courses */
export function moduleDiscussions(
  discussions: MoodleDiscussion[],
  moduleId: ID,
  courseIds: string[],
): MoodleDiscussion[] {
  return discussions.filter(
    (d) =>
      d.moduleId === moduleId || (d.courseId && courseIds.some((id) => id === String(d.courseId))),
  )
}
