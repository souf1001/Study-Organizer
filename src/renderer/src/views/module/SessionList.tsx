// List of lecture or lab sessions of a module, each with its own folder.
import { CalendarDays, CheckCircle2, Circle, FolderOpen, Pencil, Plus } from 'lucide-react'
import { today } from '@shared/dates'
import { SESSION_LABELS } from '@shared/schedule'
import type { CalendarEvent, Module } from '@shared/types'
import { createManualSession, findSessionFolder, openSession } from '@/lib/actions'
import { putRecord, useDb } from '@/lib/db'
import { formatDay, relativeDay } from '@/lib/format'
import { openView } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { showMenu } from '@/ui/Menu'
import { isLab, type SessionOccurrence } from '@shared/module-sessions'

export function SessionList({
  module,
  occurrences,
  kinds,
  onEditEvent,
}: {
  module: Module
  occurrences: SessionOccurrence[]
  kinds: 'lab' | 'other'
  onEditEvent?: (event: CalendarEvent) => void
}) {
  const db = useDb()
  const day = today()
  const newSessionKind = kinds === 'lab' ? 'lab' : 'lecture'
  // Manually created session folders without a matching scheduled session
  const extra = db.folders
    .filter(
      (f) =>
        f.moduleId === module.id &&
        f.kind === 'session' &&
        f.sessionKind &&
        (kinds === 'lab') === isLab(f.sessionKind),
    )
    .filter((f) => !occurrences.some((o) => o.date === f.date && o.kind === f.sessionKind))
    .map<SessionOccurrence>((f) => ({
      slotId: f.id,
      moduleId: module.id,
      kind: f.sessionKind!,
      date: f.date!,
      start: '',
      end: '',
      room: f.room,
      index: 0,
    }))
  const all = [...occurrences, ...extra].sort((a, b) =>
    (a.date + a.start).localeCompare(b.date + b.start),
  )

  if (all.length === 0) {
    return (
      <Empty
        icon={<CalendarDays />}
        title={kinds === 'lab' ? 'Keine Praktikumstermine' : 'Keine Termine'}
        action={
          <div className="row" style={{ gap: 8 }}>
            <Button
              icon={<Plus />}
              onClick={() => void createManualSession(module, newSessionKind)}
            >
              Termin hinzufügen
            </Button>
            <Button variant="ghost" onClick={(ev) => openView({ type: 'calendar' }, ev)}>
              Zum Kalender
            </Button>
          </div>
        }
      >
        Trag im Modul Termine ein oder importiere deinen Stundenplan aus TUCaN – dann erscheinen sie
        hier und im Kalender.
      </Empty>
    )
  }

  const nextIndex = all.findIndex((o) => o.date >= day)
  return (
    <div className="list">
      {all.map((occ, i) => {
        const folder = findSessionFolder(db, occ.moduleId, occ.date, occ.kind)
        const count = folder
          ? db.items.filter((it) => it.folderId === folder.id && !it.attachedTo).length
          : 0
        const state = occ.date < day ? 'past' : occ.date === day ? 'today' : ''
        return (
          <div
            key={occ.slotId + occ.date}
            className={`session-row ${state}`}
            onClick={(e) => openSession(occ, e)}
            onContextMenu={(e) => {
              if (occ.event && onEditEvent) {
                e.preventDefault()
                showMenu(e, [
                  {
                    label: 'Termin bearbeiten / Modulzuweisung',
                    icon: <Pencil size={14} />,
                    onClick: () => onEditEvent(occ.event!),
                  },
                  {
                    label: folder ? 'Ordner öffnen' : 'Ordner anlegen',
                    icon: <FolderOpen size={14} />,
                    onClick: () => openSession(occ),
                  },
                ])
              }
            }}
          >
            <span className="num">{occ.index || '–'}</span>
            <span className="tabular">
              {formatDay(occ.date)}
              {i === nextIndex && (
                <span className="badge color-blue next-badge">{relativeDay(occ.date)}</span>
              )}
            </span>
            <span className="small muted tabular hide-narrow">
              {occ.start ? `${occ.start}–${occ.end}` : ''}
            </span>
            <span className="small muted truncate">
              {occ.title && occ.title !== module.name ? occ.title : SESSION_LABELS[occ.kind]}
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
              {occ.event && onEditEvent && (
                <IconButton
                  small
                  label="Termin bearbeiten / Modulzuweisung"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditEvent(occ.event!)
                  }}
                >
                  <Pencil size={13} />
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
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus />}
          onClick={() => void createManualSession(module, newSessionKind)}
        >
          Zusätzlicher Termin
        </Button>
      </div>
    </div>
  )
}
