// Modulseite: Übersicht, Termine (mit Ordner pro Termin), Praktikum, Dateien, Aufgaben.
import { useState } from 'react'
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Circle,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GraduationCap,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  Upload,
  User,
} from 'lucide-react'
import { isoDateOf, today } from '@shared/dates'
import { moduleOccurrences, SESSION_LABELS, type Occurrence } from '@shared/schedule'
import type { Module, SessionKind } from '@shared/types'
import {
  childFolders,
  createFolder,
  createManualSession,
  createNote,
  deleteModule,
  findSessionFolder,
  openSession,
  pickFiles,
  semesterOf,
  uploadFiles,
  visibleItems,
} from '@/lib/actions'
import { summarizePastSessions } from '@/lib/ai'
import { putRecord, useDb } from '@/lib/db'
import { formatDay, relativeDay } from '@/lib/format'
import { openView, useWorkspace, type ModuleTab } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { showMenu } from '@/ui/Menu'
import { FolderContents } from '../folder/FolderView'
import { TaskList } from '../tasks/TasksView'
import { WEEKDAYS } from './ScheduleEditor'
import { ModuleDialog } from './ModuleDialog'
import './module.css'

const LAB_KINDS: SessionKind[] = ['lab']
const isLab = (kind: SessionKind) => LAB_KINDS.includes(kind)

function SessionList({ module, occurrences, kinds }: { module: Module; occurrences: Occurrence[]; kinds: 'lab' | 'other' }) {
  const db = useDb()
  const day = today()
  // Manuell angelegte Termin-Ordner ohne passenden Stundenplan-Termin
  const extra = db.folders
    .filter((f) => f.moduleId === module.id && f.kind === 'session' && f.sessionKind && (kinds === 'lab') === isLab(f.sessionKind))
    .filter((f) => !occurrences.some((o) => o.date === f.date && o.kind === f.sessionKind))
    .map<Occurrence>((f) => ({ slotId: f.id, moduleId: module.id, kind: f.sessionKind!, date: f.date!, start: '', end: '', room: f.room, index: 0 }))
  const all = [...occurrences, ...extra].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))

  if (all.length === 0) {
    return (
      <Empty
        icon={<CalendarDays />}
        title={kinds === 'lab' ? 'Keine Praktikumstermine' : 'Keine Termine'}
        action={
          <Button icon={<Plus />} onClick={() => void createManualSession(module, kinds === 'lab' ? 'lab' : 'lecture')}>
            Termin hinzufügen
          </Button>
        }
      >
        {kinds === 'lab'
          ? 'Trag im Modul wöchentliche Praktikumstermine ein oder leg einzelne Termine an.'
          : 'Trag im Modul die wöchentlichen Termine ein – dann erscheinen sie hier und im Kalender.'}
      </Empty>
    )
  }

  const nextIndex = all.findIndex((o) => o.date >= day)
  return (
    <div className="list">
      {all.map((occ, i) => {
        const folder = findSessionFolder(db, occ.moduleId, occ.date, occ.kind)
        const count = folder ? db.items.filter((it) => it.folderId === folder.id && !it.attachedTo).length : 0
        const state = occ.date < day ? 'past' : occ.date === day ? 'today' : ''
        return (
          <div key={occ.slotId + occ.date} className={`session-row ${state}`} onClick={(e) => openSession(occ, e)}>
            <span className="num">{occ.index || '–'}</span>
            <span className="tabular">
              {formatDay(occ.date)}
              {i === nextIndex && <span className="badge color-blue next-badge">{relativeDay(occ.date)}</span>}
            </span>
            <span className="small muted tabular hide-narrow">{occ.start ? `${occ.start}–${occ.end}` : ''}</span>
            <span className="small muted truncate">
              {SESSION_LABELS[occ.kind]}
              {occ.room && ` · ${occ.room}`}
            </span>
            <span className="folder-state small">
              {kinds === 'lab' && folder && (
                <IconButton
                  small
                  label={folder.done ? 'Als offen markieren' : 'Als bestanden markieren'}
                  onClick={(e) => {
                    e.stopPropagation()
                    putRecord('folders', { ...folder, done: !folder.done })
                  }}
                >
                  {folder.done ? <CheckCircle2 color="var(--success)" /> : <Circle />}
                </IconButton>
              )}
              {folder ? (
                <span className="row muted">
                  <FolderOpen size={14} /> {count}
                </span>
              ) : (
                <span className="faint">Ordner anlegen</span>
              )}
            </span>
          </div>
        )
      })}
      <div style={{ marginTop: 10 }}>
        <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => void createManualSession(module, kinds === 'lab' ? 'lab' : 'lecture')}>
          Zusätzlicher Termin
        </Button>
      </div>
    </div>
  )
}

function Overview({ module, occurrences }: { module: Module; occurrences: Occurrence[] }) {
  const db = useDb()
  const day = today()
  const next = occurrences.find((o) => o.date >= day)
  const exams = db.events.filter((e) => e.moduleId === module.id && e.kind === 'exam').sort((a, b) => a.start.localeCompare(b.start))
  const openTasks = db.tasks.filter((t) => t.moduleId === module.id && !t.done)

  return (
    <div className="stack" style={{ gap: 28 }}>
      {next && (
        <div className="card next-session clickable" onClick={(e) => openSession(next, e)}>
          <div className="date-tile">
            <div className="day">{next.date.slice(8)}</div>
            <div className="month">{formatDay(next.date).split(' ').at(-1)}</div>
          </div>
          <div>
            <div className="small muted">Nächster Termin · {relativeDay(next.date)}</div>
            <div style={{ fontWeight: 600 }}>
              {SESSION_LABELS[next.kind]} {next.index} · {next.start}–{next.end}
            </div>
            {next.room && (
              <div className="row small muted">
                <MapPin size={13} /> {next.room}
              </div>
            )}
          </div>
          <span className="spacer" />
          <Button icon={<FolderOpen />} onClick={(e) => { e.stopPropagation(); openSession(next, e) }}>
            {findSessionFolder(db, module.id, next.date, next.kind) ? 'Ordner öffnen' : 'Ordner anlegen'}
          </Button>
        </div>
      )}

      <div>
        <div className="section-title">Wöchentliche Termine</div>
        {module.schedule.length === 0 && <p className="small muted">Noch keine Termine eingetragen.</p>}
        <div className="list">
          {module.schedule.map((s) => (
            <div key={s.id} className="list-row slot-summary">
              <span>{SESSION_LABELS[s.kind]}</span>
              <span className="small muted">
                {WEEKDAYS[s.weekday - 1]}, {s.start}–{s.end}
                {s.everyTwoWeeks && ' · alle 2 Wochen'}
              </span>
              <span className="small muted row">
                {s.room && (
                  <>
                    <MapPin size={13} /> {s.room}
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {(exams.length > 0 || openTasks.length > 0) && (
        <div>
          <div className="section-title">Anstehend</div>
          <div className="list">
            {exams.map((e) => (
              <div key={e.id} className="list-row clickable" onClick={(ev) => openView({ type: 'calendar' }, ev)}>
                <GraduationCap size={16} className="faint" />
                <span>{e.title}</span>
                <span className="meta">{formatDay(isoDateOf(e.start))}</span>
              </div>
            ))}
          </div>
          <TaskList tasks={openTasks.slice(0, 5)} />
        </div>
      )}

      {module.info && (
        <div>
          <div className="section-title">Infos</div>
          <p className="info-text selectable">{module.info}</p>
        </div>
      )}
    </div>
  )
}

export function ModuleView({ module, tab, paneId }: { module: Module; tab: ModuleTab; paneId: string }) {
  const db = useDb()
  const [editing, setEditing] = useState(false)
  const semester = semesterOf(db, module)
  const occurrences = semester ? moduleOccurrences(module, semester) : []
  const lectures = occurrences.filter((o) => !isLab(o.kind))
  const labs = occurrences.filter((o) => isLab(o.kind))
  const setTab = (next: ModuleTab) => useWorkspace.getState().replace(paneId, { type: 'module', id: module.id, tab: next })
  const rootItems = visibleItems(db, null, module.id)
  const moduleTasks = db.tasks.filter((t) => t.moduleId === module.id)
  const labTasks = moduleTasks.filter((t) => t.kind === 'lab')

  const tabs: { id: ModuleTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Übersicht' },
    { id: 'sessions', label: 'Termine', count: lectures.length || undefined },
    { id: 'lab', label: 'Praktikum', count: labs.length || undefined },
    { id: 'files', label: 'Dateien' },
    { id: 'tasks', label: 'Aufgaben', count: moduleTasks.filter((t) => !t.done).length || undefined },
  ]

  const moreMenu = (e: React.MouseEvent<HTMLButtonElement>) =>
    showMenu(e.currentTarget, [
      { label: 'Modul bearbeiten', icon: <Pencil />, onClick: () => setEditing(true) },
      ...(db.settings.ai.enabled
        ? [
            { label: 'Bisherige Vorlesungen zusammenfassen', icon: <ScrollText />, onClick: () => void summarizePastSessions(module.id, today()) },
            { label: 'Mit KI über das Modul chatten', icon: <MessageCircle />, onClick: () => openView({ type: 'chat', moduleId: module.id }, { metaKey: true, ctrlKey: false }) },
          ]
        : []),
      { separator: true },
      { label: 'Modul löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteModule(module) },
    ])

  return (
    <div className="page">
      <div className="page-inner">
        <div className="module-header">
          <div className={`module-badge color-${module.color}`}>
            {(module.code || module.name).slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="page-title">{module.name}</h1>
            <div className="module-meta">
              {module.code && (
                <span>
                  <BookOpen /> {module.code}
                </span>
              )}
              {module.lecturer && (
                <span>
                  <User /> {module.lecturer}
                </span>
              )}
              {module.ects !== null && <span>{module.ects} ECTS</span>}
              {semester && <span>{semester.name}</span>}
            </div>
          </div>
          <Button icon={<FilePlus />} onClick={(e) => void createNote(module.id, null, e)}>
            Notiz
          </Button>
          <IconButton label="Mehr" onClick={moreMenu}>
            <MoreHorizontal />
          </IconButton>
        </div>

        <div className="tabs" role="tablist" style={{ marginTop: 28 }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count !== undefined && <span className="count">{t.count}</span>}
            </button>
          ))}
        </div>

        {tab === 'overview' && <Overview module={module} occurrences={occurrences} />}
        {tab === 'sessions' && <SessionList module={module} occurrences={lectures} kinds="other" />}
        {tab === 'lab' && (
          <div className="stack" style={{ gap: 28 }}>
            <SessionList module={module} occurrences={labs} kinds="lab" />
            <div>
              <div className="section-title">Testate & Abgaben im Praktikum</div>
              <TaskList tasks={labTasks} newTask={{ moduleId: module.id, kind: 'lab' }} />
            </div>
          </div>
        )}
        {tab === 'files' && (
          <div>
            <div className="row" style={{ marginBottom: 12 }}>
              <Button size="sm" icon={<Upload />} onClick={() => void pickFiles().then((f) => uploadFiles(module.id, null, f))}>
                Hochladen
              </Button>
              <Button size="sm" icon={<FolderPlus />} onClick={() => void createFolder(module.id, null)}>
                Ordner
              </Button>
            </div>
            <FolderContents moduleId={module.id} folderId={null} folders={childFolders(db, module.id, null)} items={rootItems} />
          </div>
        )}
        {tab === 'tasks' && <TaskList tasks={moduleTasks} newTask={{ moduleId: module.id, kind: 'assignment' }} showDone />}
      </div>
      {editing && semester && <ModuleDialog semester={semester} module={module} onClose={() => setEditing(false)} />}
    </div>
  )
}
