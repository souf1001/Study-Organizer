// Startseite „Heute“: Termine des Tages, anstehende Fristen und zuletzt Bearbeitetes.
import { useState } from 'react'
import { CalendarClock, FileText, FolderOpen, MapPin } from 'lucide-react'
import { addDays, diffDays, isoDateOf, today } from '@shared/dates'
import { SESSION_LABELS, type Occurrence } from '@shared/schedule'
import { findSemesterAt, lectureWeek, semesterForDate } from '@shared/semester'
import { activeSemester, findSessionFolder, openSession, semesterOccurrences } from '@/lib/actions'
import { useDb } from '@/lib/db'
import { formatDateTime, formatDay, formatLongDay, greeting, relativeDay } from '@/lib/format'
import { openView } from '@/lib/workspace'
import { Button } from '@/ui/Button'
import { FileIcon } from '../file/FileIcon'
import { SemesterDialog } from '../semester/SemesterDialog'
import './home.css'

function readDismissed(): string | null {
  try {
    return localStorage.getItem('semester-banner-dismissed')
  } catch {
    return null
  }
}

function SessionRow({ occ, showDay }: { occ: Occurrence; showDay?: boolean }) {
  const db = useDb()
  const module = db.modules.find((m) => m.id === occ.moduleId)
  const folder = findSessionFolder(db, occ.moduleId, occ.date, occ.kind)
  const count = folder ? db.items.filter((i) => i.folderId === folder.id && !i.attachedTo).length : 0
  if (!module) return null
  return (
    <div className="list-row clickable" onClick={(e) => openSession(occ, e)}>
      <span className="home-time tabular">{showDay ? formatDay(occ.date) : occ.start}</span>
      <span className={`dot color-${module.color}`} />
      <span className="truncate">
        {module.name}
        <span className="faint"> · {SESSION_LABELS[occ.kind]}{showDay ? ` · ${occ.start}` : ''}</span>
      </span>
      <span className="meta row">
        {occ.room && (
          <span className="row home-room">
            <MapPin size={13} />
            {occ.room}
          </span>
        )}
        <FolderOpen size={14} />
        {folder ? `${count}` : 'Ordner anlegen'}
      </span>
    </div>
  )
}

export function HomeView() {
  const db = useDb()
  const [semesterDialog, setSemesterDialog] = useState(false)
  const [dismissed, setDismissed] = useState(readDismissed)
  const day = today()
  const semester = activeSemester(db)
  const week = semester ? lectureWeek(semester, day) : null

  // Neues Semester vorschlagen, wenn heute in keinem angelegten Semester liegt
  const expected = semesterForDate(db.settings.study.semesterModel, day)
  const showBanner = db.settings.study.askForNewSemester && !findSemesterAt(db.semesters, day) && dismissed !== expected.name

  const occurrences = semesterOccurrences(db, semester)
  const todays = occurrences.filter((o) => o.date === day)
  const upcoming = occurrences.filter((o) => o.date > day).slice(0, 5)

  const horizon = addDays(day, 14)
  const deadlines = [
    ...db.tasks
      .filter((t) => !t.done && t.due && isoDateOf(t.due) <= horizon)
      .map((t) => ({ id: t.id, title: t.title, when: t.due!, allDay: false, moduleId: t.moduleId, kind: 'Aufgabe', view: { type: 'tasks' } as const })),
    ...db.events
      .filter((e) => (e.kind === 'exam' || e.kind === 'deadline') && isoDateOf(e.start) >= day && isoDateOf(e.start) <= addDays(day, 45))
      .map((e) => ({ id: e.id, title: e.title, when: e.start, allDay: e.allDay, moduleId: e.moduleId, kind: e.kind === 'exam' ? 'Prüfung' : 'Frist', view: { type: 'calendar' } as const })),
  ].sort((a, b) => a.when.localeCompare(b.when))

  const recent = db.items
    .filter((i) => !i.attachedTo)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6)

  let status = semester?.name ?? ''
  if (semester && week) status += ` · Vorlesungswoche ${week.week} von ${week.total}`
  else if (semester && day < semester.lectureStart) status += ` · Vorlesungsbeginn ${relativeDay(semester.lectureStart)}`
  else if (semester && day > semester.lectureEnd && day <= semester.end) status += ' · vorlesungsfreie Zeit'

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">
          {greeting()}
          {db.profile.name ? `, ${db.profile.name}` : ''}
        </h1>
        <p className="page-subtitle">
          {formatLongDay(day)}
          {status && ` · ${status}`}
        </p>

        {showBanner && (
          <div className="card banner">
            <CalendarClock />
            <div>
              <div className="banner-title">Das {expected.name} hat begonnen</div>
              <div className="small muted">Leg das neue Semester an und übernimm Module, die weiterlaufen.</div>
            </div>
            <span className="spacer" />
            <Button
              variant="ghost"
              onClick={() => {
                setDismissed(expected.name)
                try {
                  localStorage.setItem('semester-banner-dismissed', expected.name)
                } catch {
                  // egal
                }
              }}
            >
              Später
            </Button>
            <Button variant="primary" onClick={() => setSemesterDialog(true)}>
              Semester anlegen
            </Button>
          </div>
        )}

        <div className="home-grid">
          <section className="section">
            <div className="section-title">Heute</div>
            {todays.length === 0 && <p className="muted small home-empty">Heute stehen keine Veranstaltungen im Stundenplan.</p>}
            <div className="list">
              {todays.map((o) => (
                <SessionRow key={o.slotId + o.date} occ={o} />
              ))}
            </div>
            {upcoming.length > 0 && (
              <>
                <div className="section-title home-subtitle">Als Nächstes</div>
                <div className="list">
                  {upcoming.map((o) => (
                    <SessionRow key={o.slotId + o.date} occ={o} showDay />
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="section">
            <div className="section-title">Fristen & Prüfungen</div>
            {deadlines.length === 0 && <p className="muted small home-empty">In den nächsten zwei Wochen ist nichts fällig.</p>}
            <div className="list">
              {deadlines.map((d) => {
                const module = db.modules.find((m) => m.id === d.moduleId)
                const days = diffDays(day, isoDateOf(d.when))
                return (
                  <div key={d.id} className="list-row clickable" onClick={(e) => openView(d.view, e)}>
                    <span className={`badge ${days < 0 ? 'color-red' : days <= 2 ? 'color-orange' : ''}`}>{relativeDay(isoDateOf(d.when))}</span>
                    <span className="truncate">
                      {d.title}
                      <span className="faint"> · {d.kind}{module ? ` · ${module.name}` : ''}</span>
                    </span>
                    <span className="meta">{formatDateTime(d.when, d.allDay)}</span>
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        <section className="section">
          <div className="section-title">Zuletzt bearbeitet</div>
          {recent.length === 0 && <p className="muted small home-empty">Noch keine Notizen oder Dateien. Öffne ein Modul in der Seitenleiste, um loszulegen.</p>}
          <div className="recent-grid">
            {recent.map((item) => {
              const module = db.modules.find((m) => m.id === item.moduleId)
              return (
                <button key={item.id} type="button" className="recent-card" onClick={(e) => openView({ type: 'item', id: item.id }, e)}>
                  {item.kind === 'note' ? <FileText /> : <FileIcon type={item.fileType} />}
                  <span className="recent-title truncate">{item.title}</span>
                  <span className="recent-meta truncate">
                    {module && <span className={`dot color-${module.color}`} />}
                    {module?.name} · {relativeDay(isoDateOf(item.updatedAt))}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      </div>
      {semesterDialog && <SemesterDialog onClose={() => setSemesterDialog(false)} />}
    </div>
  )
}
