// Everything the app knows about a module as plain text for the AI: timetable with rooms,
// upcoming and past sessions, exams and deadlines, tasks, labs, Moodle announcements and the
// folder structure. Lets the chat answer questions like "Where is my next lecture?".
import { addDays, isoDateOf, parseISODate, shortDate, toISODate } from './dates'
import { SESSION_LABELS } from './schedule'
import type { CalendarEvent, Db, EventKind, ID, Module } from './types'
import { mappedCourseIds, moduleDiscussions, moduleSessions } from './module-sessions'

const WEEKDAYS = [
  '',
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
]
const EVENT_LABELS: Record<EventKind, string> = {
  exam: 'Prüfung',
  deadline: 'Frist',
  lab: 'Praktikum',
  lecture: 'Vorlesung',
  exercise: 'Übung',
  other: 'Termin',
}
const UPCOMING_SESSIONS = 8
const PAST_SESSIONS = 3
const MAX_TREE_LINES = 150

const pad = (n: number) => String(n).padStart(2, '0')
const time = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dayLabel = (date: string) =>
  `${WEEKDAYS[parseISODate(date).getDay() || 7]}, ${shortDate(date, true)}`

/** Plain text from Moodle HTML, shortened */
function plain(html: string, max = 300): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)} …` : text
}

function eventLine(event: CalendarEvent): string {
  const date = isoDateOf(event.start)
  const when = event.allDay
    ? dayLabel(date)
    : `${dayLabel(date)}, ${time(event.start)}–${time(event.end)}`
  return [
    `- ${EVENT_LABELS[event.kind]}: ${event.title} – ${when}`,
    event.location ? ` – Ort: ${event.location}` : '',
    event.notes ? ` – Notiz: ${plain(event.notes, 200)}` : '',
  ].join('')
}

function folderTree(db: Db, moduleId: ID): string[] {
  const lines: string[] = []
  const visit = (parentId: ID | null, depth: number) => {
    const indent = '  '.repeat(depth)
    const folders = db.folders
      .filter((f) => f.moduleId === moduleId && f.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    for (const folder of folders) {
      const details = [
        folder.date ? shortDate(folder.date, true) : '',
        folder.room ? `Raum ${folder.room}` : '',
        folder.sessionKind === 'lab' ? (folder.done ? 'bestanden' : 'offen') : '',
      ].filter(Boolean)
      lines.push(`${indent}- 📁 ${folder.name}${details.length ? ` (${details.join(', ')})` : ''}`)
      visit(folder.id, depth + 1)
    }
    const items = db.items.filter(
      (i) => i.moduleId === moduleId && i.folderId === parentId && !i.attachedTo,
    )
    for (const item of items) {
      const kind = item.kind === 'note' ? 'Notiz' : (item.fileType ?? 'Datei').toUpperCase()
      lines.push(`${indent}- ${item.title} [${kind}]`)
    }
  }
  visit(null, 0)
  return lines.length > MAX_TREE_LINES
    ? [...lines.slice(0, MAX_TREE_LINES), `- … und ${lines.length - MAX_TREE_LINES} weitere`]
    : lines
}

export function moduleFacts(db: Db, module: Module, now = new Date()): string {
  const todayIso = toISODate(now)
  const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const semester = db.semesters.find((s) => s.id === module.semesterId)
  const out: string[] = [`## Modul „${module.name}“${module.code ? ` (${module.code})` : ''}`]

  const facts = [
    module.lecturer && `Dozent/in: ${module.lecturer}`,
    module.ects !== null && `ECTS: ${module.ects}`,
    semester &&
      `Semester: ${semester.name} (Vorlesungszeit ${shortDate(semester.lectureStart, true)} – ${shortDate(semester.lectureEnd, true)}${
        semester.breaks.length
          ? `; vorlesungsfrei: ${semester.breaks.map((b) => `${b.label} ${shortDate(b.start)}–${shortDate(b.end, true)}`).join(', ')}`
          : ''
      })`,
  ].filter(Boolean)
  out.push(...facts.map((f) => `- ${f}`))
  if (module.info.trim()) out.push(`- Infos: ${plain(module.info, 1000)}`)

  if (module.schedule.length > 0) {
    out.push('', '### Wöchentlicher Stundenplan')
    for (const slot of module.schedule) {
      out.push(
        [
          `- ${SESSION_LABELS[slot.kind]}: ${WEEKDAYS[slot.weekday]} ${slot.start}–${slot.end}`,
          slot.room ? `, Raum ${slot.room}` : ', Raum nicht angegeben',
          slot.everyTwoWeeks ? ', alle zwei Wochen' : '',
          slot.firstDate ? `, ab ${shortDate(slot.firstDate, true)}` : '',
          slot.skip.length
            ? `, fällt aus am ${slot.skip.map((d) => shortDate(d, true)).join(', ')}`
            : '',
        ].join(''),
      )
    }
  }

  const sessions = moduleSessions(db, module, semester)
  const isPast = (s: { date: string; end: string }) =>
    s.date < todayIso || (s.date === todayIso && Boolean(s.end) && s.end <= nowTime)
  const past = sessions.filter(isPast)
  const upcoming = sessions.filter((s) => !isPast(s))
  const sessionLine = (s: (typeof sessions)[number]) => {
    const folder = db.folders.find(
      (f) => f.moduleId === module.id && f.date === s.date && f.sessionKind === s.kind,
    )
    const room = folder?.room || s.room
    return [
      `- ${dayLabel(s.date)}${s.start ? ` ${s.start}–${s.end}` : ''}: ${s.title || SESSION_LABELS[s.kind]} ${s.index}`,
      room ? `, Raum ${room}` : '',
    ].join('')
  }
  if (upcoming.length > 0) {
    out.push('', `### Nächste Termine (${upcoming.length} noch ausstehend)`)
    out.push(...upcoming.slice(0, UPCOMING_SESSIONS).map(sessionLine))
  }
  if (past.length > 0) {
    out.push('', `### Letzte Termine (${past.length} bisher)`)
    out.push(...past.slice(-PAST_SESSIONS).map(sessionLine))
  }

  const special = db.events
    .filter((e) => e.moduleId === module.id && !['lecture', 'exercise', 'lab'].includes(e.kind))
    .sort((a, b) => a.start.localeCompare(b.start))
  const comingSpecial = special.filter((e) => isoDateOf(e.end || e.start) >= todayIso)
  if (comingSpecial.length > 0) {
    out.push('', '### Prüfungen, Fristen und weitere Termine')
    out.push(...comingSpecial.slice(0, 15).map(eventLine))
  }

  const tasks = db.tasks.filter((t) => t.moduleId === module.id)
  const open = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  if (tasks.length > 0) {
    out.push('', `### Aufgaben (${open.length} offen, ${tasks.length - open.length} erledigt)`)
    for (const task of open.slice(0, 15)) {
      const due = task.due
        ? ` – fällig ${dayLabel(isoDateOf(task.due))}, ${time(task.due)}${isoDateOf(task.due) < todayIso ? ' (überfällig)' : ''}`
        : ''
      out.push(`- ${task.title}${due}${task.notes ? ` – ${plain(task.notes, 200)}` : ''}`)
    }
  }

  const announcements = moduleDiscussions(
    db.moodleDiscussions,
    module.id,
    mappedCourseIds(db.settings.moodle.courseMap, module.id),
  )
    .sort((a, b) => b.timeModified.localeCompare(a.timeModified))
    .slice(0, 5)
  if (announcements.length > 0) {
    out.push('', '### Neueste Ankündigungen und Forenbeiträge (Moodle)')
    for (const d of announcements) {
      out.push(
        `- ${shortDate(isoDateOf(d.timeCreated), true)} – ${d.forumName}: „${d.subject}“ von ${d.userFullName}: ${plain(d.message)}`,
      )
    }
  }

  const tree = folderTree(db, module.id)
  if (tree.length > 0) out.push('', '### Ordner und Dateien', ...tree)

  return out.join('\n')
}

/** Short overview of all modules of the active semester and the next two weeks */
export function studyOverview(db: Db, now = new Date()): string {
  const todayIso = toISODate(now)
  const semesterId = db.activeSemesterId ?? db.semesters[0]?.id
  const modules = db.modules.filter((m) => m.semesterId === semesterId)
  const out: string[] = ['## Module dieses Semesters']
  for (const module of modules) {
    const slots = module.schedule
      .map(
        (s) =>
          `${SESSION_LABELS[s.kind]} ${WEEKDAYS[s.weekday].slice(0, 2)} ${s.start}${s.room ? ` (${s.room})` : ''}`,
      )
      .join('; ')
    out.push(
      `- ${module.name}${module.code ? ` (${module.code})` : ''}${slots ? `: ${slots}` : ''}`,
    )
  }
  const until = addDays(todayIso, 14)
  const coming = db.events
    .filter((e) => isoDateOf(e.start) >= todayIso && isoDateOf(e.start) <= until)
    .filter((e) => !['lecture', 'exercise', 'lab'].includes(e.kind))
    .sort((a, b) => a.start.localeCompare(b.start))
  if (coming.length > 0) {
    out.push('', '## Prüfungen und Fristen in den nächsten zwei Wochen')
    for (const event of coming.slice(0, 20)) {
      const module = db.modules.find((m) => m.id === event.moduleId)
      out.push(`${eventLine(event)}${module ? ` (${module.name})` : ''}`)
    }
  }
  const openTasks = db.tasks.filter((t) => !t.done && t.due && isoDateOf(t.due) <= until)
  if (openTasks.length > 0) {
    out.push('', '## Offene Aufgaben mit Frist in den nächsten zwei Wochen')
    for (const task of openTasks.sort((a, b) => a.due!.localeCompare(b.due!)).slice(0, 20)) {
      const module = db.modules.find((m) => m.id === task.moduleId)
      out.push(
        `- ${task.title} – fällig ${dayLabel(isoDateOf(task.due!))}${module ? ` (${module.name})` : ''}`,
      )
    }
  }
  return out.join('\n')
}

/** Header with the current date, so the AI can answer "today", "tomorrow", "next week" */
export function nowFacts(now = new Date()): string {
  return `Heute ist ${dayLabel(toISODate(now))}, es ist ${pad(now.getHours())}:${pad(now.getMinutes())} Uhr.`
}
