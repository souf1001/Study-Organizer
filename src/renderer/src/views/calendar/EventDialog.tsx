// Termin anlegen/bearbeiten (Prüfung, Frist, Praktikum …) und Details zu Kalendereinträgen.
import { useState } from 'react'
import { Ban, CheckSquare, FolderOpen, MapPin, Trash2 } from 'lucide-react'
import { newEvent } from '@shared/defaults'
import { toISODate } from '@shared/dates'
import { SESSION_LABELS } from '@shared/schedule'
import type { CalendarEvent, EventKind } from '@shared/types'
import { activeSemester, findSessionFolder, openSession, semesterModules } from '@/lib/actions'
import { putRecord, removeRecord, useDb } from '@/lib/db'
import { formatLongDay, formatTime } from '@/lib/format'
import { openView } from '@/lib/workspace'
import { Button } from '@/ui/Button'
import { Field, Input, Select, Switch, Textarea } from '@/ui/Field'
import { Modal } from '@/ui/Modal'
import { EVENT_KINDS, type Entry } from './entries'

const pad = (n: number) => String(n).padStart(2, '0')
const timeOf = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const combine = (date: string, time: string) => new Date(`${date}T${time || '00:00'}`).toISOString()

export function EventDialog({ event, onClose }: { event?: CalendarEvent | Partial<CalendarEvent>; onClose: () => void }) {
  const db = useDb()
  const existing = event && 'id' in event && db.events.some((e) => e.id === event.id)
  const [draft, setDraft] = useState<CalendarEvent>(() => newEvent(event))
  const [date, setDate] = useState(toISODate(new Date(draft.start)))
  const [start, setStart] = useState(timeOf(draft.start))
  const [end, setEnd] = useState(timeOf(draft.end))
  const readOnly = Boolean(draft.subscriptionId || draft.externalId?.startsWith('moodle:'))
  const modules = semesterModules(db, activeSemester(db)?.id)
  const set = (values: Partial<CalendarEvent>) => setDraft((d) => ({ ...d, ...values }))

  const save = () => {
    if (!draft.title.trim()) return
    const startIso = draft.allDay ? combine(date, '00:00') : combine(date, start)
    const endIso = draft.allDay ? combine(date, '23:59') : combine(date, end < start ? start : end)
    putRecord('events', { ...draft, title: draft.title.trim(), start: startIso, end: endIso })
    onClose()
  }

  return (
    <Modal
      title={existing ? (readOnly ? 'Termin' : 'Termin bearbeiten') : 'Neuer Termin'}
      onClose={onClose}
      footer={
        <>
          {existing && !readOnly && (
            <Button variant="ghost" icon={<Trash2 />} onClick={() => void removeRecord('events', draft.id).then(onClose)}>
              Löschen
            </Button>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>{readOnly ? 'Schließen' : 'Abbrechen'}</Button>
          {!readOnly && (
            <Button variant="primary" onClick={save} disabled={!draft.title.trim()}>
              Speichern
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {readOnly && <p className="small muted">Dieser Termin wird automatisch abgeglichen (Kalender-Abo bzw. Moodle) und kann hier nicht geändert werden.</p>}
        <Field label="Titel">
          <Input autoFocus value={draft.title} disabled={readOnly} placeholder="z. B. Klausur Analysis 1" onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <div className="form-row">
          <Field label="Art">
            <Select
              value={draft.kind}
              disabled={readOnly}
              options={(Object.keys(EVENT_KINDS) as EventKind[]).map((k) => ({ value: k, label: EVENT_KINDS[k] }))}
              onChange={(kind) => set({ kind })}
            />
          </Field>
          <Field label="Modul">
            <Select
              value={draft.moduleId ?? ''}
              disabled={readOnly}
              options={[{ value: '', label: 'Kein Modul' }, ...modules.map((m) => ({ value: m.id, label: m.name }))]}
              onChange={(id) => set({ moduleId: id || null })}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Datum">
            <input className="input" type="date" value={date} disabled={readOnly} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {!draft.allDay && (
            <>
              <Field label="Von">
                <input className="input" type="time" value={start} disabled={readOnly} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="Bis">
                <input className="input" type="time" value={end} disabled={readOnly} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <label className="row small">
          <Switch checked={draft.allDay} onChange={(allDay) => !readOnly && set({ allDay })} label="Ganztägig" />
          Ganztägig
        </label>
        <Field label="Ort / Raum">
          <Input value={draft.location} disabled={readOnly} placeholder="z. B. D14/0.04" onChange={(e) => set({ location: e.target.value })} />
        </Field>
        <Field label="Notizen">
          <Textarea value={draft.notes} disabled={readOnly} rows={3} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

/** Details zu einem Stundenplan-Termin oder einer Aufgabe */
export function EntryDialog({ entry, onClose }: { entry: Exclude<Entry, { source: 'event' }>; onClose: () => void }) {
  const db = useDb()
  if (entry.source === 'task') {
    return (
      <Modal
        title={entry.title}
        onClose={onClose}
        footer={
          <>
            <Button onClick={() => { onClose(); openView({ type: 'tasks' }) }}>Zu den Aufgaben</Button>
            <Button variant="primary" icon={<CheckSquare />} onClick={() => { putRecord('tasks', { ...entry.task, done: true }); onClose() }}>
              Erledigt
            </Button>
          </>
        }
      >
        <p className="muted">
          {entry.subtitle} · fällig {formatLongDay(toISODate(entry.start))}, {formatTime(entry.start.toISOString())}
        </p>
      </Modal>
    )
  }

  const { occ } = entry
  const module = db.modules.find((m) => m.id === occ.moduleId)
  const folder = findSessionFolder(db, occ.moduleId, occ.date, occ.kind)
  const cancelOccurrence = () => {
    if (!module) return
    putRecord('modules', {
      ...module,
      schedule: module.schedule.map((s) => (s.id === occ.slotId ? { ...s, skip: [...s.skip, occ.date] } : s)),
    })
    onClose()
  }

  return (
    <Modal
      title={
        <span className="row">
          <span className={`dot color-${entry.color}`} />
          {entry.title}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" icon={<Ban />} onClick={cancelOccurrence}>
            Fällt aus
          </Button>
          <span className="spacer" />
          <Button onClick={() => { onClose(); if (module) openView({ type: 'module', id: module.id, tab: 'sessions' }) }}>Modul</Button>
          <Button variant="primary" icon={<FolderOpen />} onClick={() => { onClose(); openSession(occ) }}>
            {folder ? 'Ordner öffnen' : 'Ordner anlegen'}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 6 }}>
        <div>
          {SESSION_LABELS[occ.kind]} {occ.index} · {formatLongDay(occ.date)}, {occ.start}–{occ.end}
        </div>
        {occ.room && (
          <div className="row muted">
            <MapPin size={15} /> {occ.room}
          </div>
        )}
      </div>
    </Modal>
  )
}
