// Alles, was im Kalender erscheint: Stundenplan, eigene/abonnierte Termine, Aufgaben mit Frist.
import { addDays, atTime, isoDateOf, toISODate } from '@shared/dates'
import { SESSION_LABELS, type Occurrence } from '@shared/schedule'
import type { CalendarEvent, Db, EventKind, ISODate, ModuleColor, Task } from '@shared/types'
import { activeSemester, semesterOccurrences } from '@/lib/actions'

export type Entry =
  | { key: string; source: 'session'; title: string; start: Date; end: Date; allDay: false; color: ModuleColor; subtitle: string; occ: Occurrence }
  | { key: string; source: 'event'; title: string; start: Date; end: Date; allDay: boolean; color: ModuleColor; subtitle: string; event: CalendarEvent }
  | { key: string; source: 'task'; title: string; start: Date; end: Date; allDay: true; color: ModuleColor; subtitle: string; task: Task }

export const EVENT_KINDS: Record<EventKind, string> = {
  exam: 'Prüfung',
  deadline: 'Frist / Abgabe',
  lab: 'Praktikum',
  lecture: 'Vorlesung',
  other: 'Termin',
}

const KIND_COLOR: Record<EventKind, ModuleColor> = { exam: 'red', deadline: 'orange', lab: 'green', lecture: 'blue', other: 'gray' }

export function entriesBetween(db: Db, from: ISODate, to: ISODate): Entry[] {
  const moduleColor = (id: string | null): ModuleColor | undefined => db.modules.find((m) => m.id === id)?.color
  const moduleName = (id: string | null) => db.modules.find((m) => m.id === id)?.name ?? ''
  const entries: Entry[] = []

  for (const occ of semesterOccurrences(db, activeSemester(db))) {
    if (occ.date < from || occ.date > to) continue
    entries.push({
      key: `s-${occ.slotId}-${occ.date}`,
      source: 'session',
      title: moduleName(occ.moduleId),
      subtitle: [SESSION_LABELS[occ.kind], occ.room].filter(Boolean).join(' · '),
      start: atTime(occ.date, occ.start),
      end: atTime(occ.date, occ.end),
      allDay: false,
      color: moduleColor(occ.moduleId) ?? 'gray',
      occ,
    })
  }

  for (const event of db.events) {
    const day = isoDateOf(event.start)
    if (day > to || isoDateOf(event.end) < from) continue
    const start = new Date(event.start)
    // Fristen ohne Dauer bekommen 30 Minuten, damit sie sichtbar sind
    const end = new Date(Math.max(new Date(event.end).getTime(), start.getTime() + 30 * 60_000))
    entries.push({
      key: `e-${event.id}`,
      source: 'event',
      title: event.title,
      subtitle: [EVENT_KINDS[event.kind], moduleName(event.moduleId), event.location].filter(Boolean).join(' · '),
      start,
      end,
      allDay: event.allDay || (event.kind === 'deadline' && start.getTime() === new Date(event.end).getTime()),
      color: moduleColor(event.moduleId) ?? KIND_COLOR[event.kind],
      event,
    })
  }

  for (const task of db.tasks) {
    if (!task.due || task.done) continue
    const day = isoDateOf(task.due)
    if (day < from || day > to) continue
    entries.push({
      key: `t-${task.id}`,
      source: 'task',
      title: task.title,
      subtitle: ['Aufgabe', moduleName(task.moduleId)].filter(Boolean).join(' · '),
      start: new Date(task.due),
      end: new Date(task.due),
      allDay: true,
      color: moduleColor(task.moduleId) ?? 'orange',
      task,
    })
  }
  return entries.sort((a, b) => a.start.getTime() - b.start.getTime())
}

export function entriesOn(entries: Entry[], day: ISODate): Entry[] {
  return entries.filter((e) => toISODate(e.start) <= day && toISODate(e.end) >= day)
}

/** Überlappende Termine nebeneinander anordnen: Spalte und Spaltenzahl je Termin */
export function layoutDay(entries: Entry[]): Map<string, { column: number; columns: number }> {
  const result = new Map<string, { column: number; columns: number }>()
  const sorted = [...entries].sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime())
  let cluster: Entry[] = []
  let clusterEnd = 0
  let columnsEnd: number[] = []

  const closeCluster = () => {
    for (const e of cluster) result.get(e.key)!.columns = columnsEnd.length
    cluster = []
    columnsEnd = []
  }

  for (const entry of sorted) {
    if (cluster.length && entry.start.getTime() >= clusterEnd) closeCluster()
    let column = columnsEnd.findIndex((end) => end <= entry.start.getTime())
    if (column === -1) {
      column = columnsEnd.length
      columnsEnd.push(entry.end.getTime())
    } else columnsEnd[column] = entry.end.getTime()
    result.set(entry.key, { column, columns: 1 })
    cluster.push(entry)
    clusterEnd = Math.max(clusterEnd, entry.end.getTime())
  }
  closeCluster()
  return result
}

export function weekDays(start: ISODate, count: number): ISODate[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i))
}
