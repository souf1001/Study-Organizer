// Aufgaben & Abgaben: gruppiert nach Fälligkeit, schnell anlegen und abhaken.
import { useState, type KeyboardEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { newTask } from '@shared/defaults'
import { addDays, isoDateOf, startOfWeek, today } from '@shared/dates'
import type { ID, Task, TaskKind } from '@shared/types'
import { activeSemester, semesterModules } from '@/lib/actions'
import { putRecord, removeRecord, useDb } from '@/lib/db'
import { formatDateTime, relativeDay } from '@/lib/format'
import { IconButton } from '@/ui/Button'
import { Select } from '@/ui/Field'
import './tasks.css'

export const TASK_KINDS: Record<TaskKind, string> = {
  assignment: 'Abgabe',
  lab: 'Praktikum',
  study: 'Lernen',
  other: 'Sonstiges',
}

function TaskRow({ task }: { task: Task }) {
  const db = useDb()
  const module = db.modules.find((m) => m.id === task.moduleId)
  const [title, setTitle] = useState(task.title)
  const dueDate = task.due ? isoDateOf(task.due) : null
  const overdue = !task.done && dueDate !== null && dueDate < today()

  return (
    <div className={`task-row ${task.done ? 'done' : ''}`}>
      <input
        type="checkbox"
        className="checkbox round"
        checked={task.done}
        aria-label="Erledigt"
        onChange={(e) => putRecord('tasks', { ...task, done: e.target.checked })}
      />
      <input
        className="input-bare task-title"
        value={title}
        aria-label="Titel"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== task.title && putRecord('tasks', { ...task, title: title.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {task.source === 'moodle' && <span className="badge">Moodle</span>}
      {module && (
        <span className={`badge color-${module.color}`}>
          {module.code || module.name}
        </span>
      )}
      <span className="small faint">{TASK_KINDS[task.kind]}</span>
      <input
        type="datetime-local"
        className={`input-bare task-due small ${overdue ? 'overdue' : ''}`}
        aria-label="Fällig am"
        title={task.due ? `${formatDateTime(task.due)} (${relativeDay(dueDate!)})` : 'Kein Datum'}
        value={task.due ? toLocalInput(task.due) : ''}
        onChange={(e) => putRecord('tasks', { ...task, due: e.target.value ? new Date(e.target.value).toISOString() : null })}
      />
      <IconButton small label="Löschen" onClick={() => void removeRecord('tasks', task.id)}>
        <Trash2 />
      </IconButton>
    </div>
  )
}

/** ISO-Zeitpunkt → Wert für <input type="datetime-local"> in lokaler Zeit */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function QuickAdd({ moduleId, kind }: { moduleId: ID | null; kind: TaskKind }) {
  const db = useDb()
  const modules = semesterModules(db, activeSemester(db)?.id)
  const [title, setTitle] = useState('')
  const [module, setModule] = useState<ID | ''>(moduleId ?? '')
  const [due, setDue] = useState('')
  const add = () => {
    if (!title.trim()) return
    putRecord('tasks', newTask({ title: title.trim(), moduleId: module || null, kind, due: due ? new Date(`${due}T23:59`).toISOString() : null }))
    setTitle('')
    setDue('')
  }
  const onKey = (e: KeyboardEvent) => e.key === 'Enter' && add()
  return (
    <div className="task-add">
      <Plus className="faint" size={16} />
      <input className="input-bare" placeholder="Neue Aufgabe, z. B. Übungsblatt 4 abgeben" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onKey} />
      {moduleId === null && (
        <Select
          value={module}
          aria-label="Modul"
          options={[{ value: '', label: 'Ohne Modul' }, ...modules.map((m) => ({ value: m.id, label: m.name }))]}
          onChange={setModule}
        />
      )}
      <input type="date" className="input task-date" aria-label="Fällig am" value={due} onChange={(e) => setDue(e.target.value)} onKeyDown={onKey} />
    </div>
  )
}

export function TaskList({ tasks, newTask: create, showDone }: { tasks: Task[]; newTask?: { moduleId: ID | null; kind: TaskKind }; showDone?: boolean }) {
  const open = tasks.filter((t) => !t.done).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  const done = tasks.filter((t) => t.done)
  return (
    <div className="task-list">
      {create && <QuickAdd moduleId={create.moduleId} kind={create.kind} />}
      {open.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
      {showDone && done.length > 0 && (
        <details className="task-done">
          <summary className="small muted">Erledigt ({done.length})</summary>
          {done.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </details>
      )}
    </div>
  )
}

export function TasksView() {
  const db = useDb()
  const day = today()
  const weekEnd = addDays(startOfWeek(day), 6)
  const open = db.tasks.filter((t) => !t.done)
  const groups: { title: string; tasks: Task[] }[] = [
    { title: 'Überfällig', tasks: open.filter((t) => t.due && isoDateOf(t.due) < day) },
    { title: 'Heute', tasks: open.filter((t) => t.due && isoDateOf(t.due) === day) },
    { title: 'Diese Woche', tasks: open.filter((t) => t.due && isoDateOf(t.due) > day && isoDateOf(t.due) <= weekEnd) },
    { title: 'Später', tasks: open.filter((t) => t.due && isoDateOf(t.due) > weekEnd) },
    { title: 'Ohne Datum', tasks: open.filter((t) => !t.due) },
  ]
  const done = db.tasks.filter((t) => t.done)

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Aufgaben</h1>
        <p className="page-subtitle">Abgaben, Testate und alles, was du nicht vergessen willst.</p>
        <div className="section">
          <QuickAdd moduleId={null} kind="assignment" />
        </div>
        {groups
          .filter((g) => g.tasks.length > 0)
          .map((g) => (
            <section key={g.title} className="section">
              <div className="section-title">
                {g.title}
                <span className="faint">{g.tasks.length}</span>
              </div>
              <TaskList tasks={g.tasks} />
            </section>
          ))}
        {open.length === 0 && <p className="muted section">Alles erledigt. </p>}
        {done.length > 0 && (
          <section className="section">
            <TaskList tasks={done} showDone />
          </section>
        )}
      </div>
    </div>
  )
}
