// Overview tab of the module page: next session, weekly schedule, upcoming exams/tasks, AI chats.
import { FolderOpen, GraduationCap, MapPin, MessageCircle, MessageSquare } from 'lucide-react'
import { isoDateOf, today } from '@shared/dates'
import { SESSION_LABELS } from '@shared/schedule'
import type { Module } from '@shared/types'
import { findSessionFolder, openSession } from '@/lib/actions'
import { useDb } from '@/lib/db'
import { formatDateTime, formatDay, relativeDay } from '@/lib/format'
import { openView } from '@/lib/workspace'
import { Button } from '@/ui/Button'
import { TaskList } from '../tasks/TasksView'
import type { SessionOccurrence } from '@shared/module-sessions'
import { WEEKDAYS } from './ScheduleEditor'

export function ModuleOverview({
  module,
  occurrences,
}: {
  module: Module
  occurrences: SessionOccurrence[]
}) {
  const db = useDb()
  const day = today()
  const next = occurrences.find((o) => o.date >= day)
  const exams = db.events
    .filter((e) => e.moduleId === module.id && e.kind === 'exam')
    .sort((a, b) => a.start.localeCompare(b.start))
  const openTasks = db.tasks.filter((t) => t.moduleId === module.id && !t.done)
  const chats = (db.chats ?? []).filter((c) => c.moduleId === module.id)

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
              {next.title && next.title !== module.name
                ? next.title
                : `${SESSION_LABELS[next.kind]} ${next.index}`}
              {next.start ? ` · ${next.start}${next.end ? `–${next.end}` : ''}` : ''}
            </div>
            {next.room && (
              <div className="row small muted">
                <MapPin size={13} /> {next.room}
              </div>
            )}
          </div>
          <span className="spacer" />
          <Button
            icon={<FolderOpen />}
            onClick={(e) => {
              e.stopPropagation()
              openSession(next, e)
            }}
          >
            {findSessionFolder(db, module.id, next.date, next.kind)
              ? 'Ordner öffnen'
              : 'Ordner anlegen'}
          </Button>
        </div>
      )}

      <div>
        <div className="section-title">
          {module.schedule.length > 0
            ? 'Wöchentliche Termine'
            : `Nächste Termine (${occurrences.length} gesamt)`}
        </div>
        {module.schedule.length === 0 && occurrences.length === 0 && (
          <p className="small muted">Noch keine Termine eingetragen oder importiert.</p>
        )}
        {module.schedule.length > 0 ? (
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
        ) : occurrences.length > 0 ? (
          <div className="list">
            {occurrences
              .filter((o) => o.date >= day)
              .slice(0, 4)
              .map((occ) => (
                <div
                  key={occ.slotId + occ.date}
                  className="list-row clickable"
                  onClick={(e) => openSession(occ, e)}
                >
                  <span className="tabular small muted" style={{ minWidth: 80 }}>
                    {formatDay(occ.date)}
                  </span>
                  <span className="small muted tabular hide-narrow">
                    {occ.start ? `${occ.start}–${occ.end}` : ''}
                  </span>
                  <span className="truncate">
                    {occ.title && occ.title !== module.name ? occ.title : SESSION_LABELS[occ.kind]}
                  </span>
                  {occ.room && (
                    <span className="small muted row">
                      <MapPin size={13} /> {occ.room}
                    </span>
                  )}
                </div>
              ))}
          </div>
        ) : null}
      </div>

      {(exams.length > 0 || openTasks.length > 0) && (
        <div>
          <div className="section-title">Anstehend</div>
          <div className="list">
            {exams.map((e) => (
              <div
                key={e.id}
                className="list-row clickable"
                onClick={(ev) => openView({ type: 'calendar' }, ev)}
              >
                <GraduationCap size={16} className="faint" />
                <span>{e.title}</span>
                <span className="meta">{formatDay(isoDateOf(e.start))}</span>
              </div>
            ))}
          </div>
          <TaskList tasks={openTasks.slice(0, 5)} />
        </div>
      )}

      {db.settings.ai.enabled && (
        <div>
          <div className="section-title">KI-Chats {chats.length ? `(${chats.length})` : ''}</div>
          {chats.length > 0 ? (
            <div className="list">
              {[...chats]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 3)
                .map((c) => (
                  <div
                    key={c.id}
                    className="list-row clickable"
                    onClick={(ev) =>
                      openView({ type: 'chat', chatId: c.id, moduleId: module.id }, ev)
                    }
                  >
                    <MessageSquare size={16} className="faint" />
                    <span className="truncate">{c.title}</span>
                    <span className="meta">{formatDateTime(c.updatedAt)}</span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="ghost"
                icon={<MessageCircle />}
                onClick={(ev) => openView({ type: 'chat', moduleId: module.id }, ev)}
              >
                Chat zu diesem Modul starten
              </Button>
            </div>
          )}
          {chats.length > 3 && (
            <div className="row" style={{ marginTop: 8 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openView({ type: 'module', id: module.id, tab: 'chats' })}
              >
                Alle {chats.length} Chats anzeigen …
              </Button>
            </div>
          )}
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
