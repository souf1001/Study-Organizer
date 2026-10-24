// Modulseite: Übersicht, Termine (mit Ordner pro Termin), Praktikum, Dateien, Aufgaben.
import { useState } from 'react'
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Circle,
  CornerDownRight,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GraduationCap,
  MapPin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  Trash2,
  Upload,
  User,
} from 'lucide-react'
import DOMPurify from 'dompurify'
import { isoDateOf, today } from '@shared/dates'
import { moduleOccurrences, SESSION_LABELS, type Occurrence } from '@shared/schedule'
import type { Module, MoodleDiscussion, MoodlePost, SessionKind } from '@shared/types'
import { api } from '@/lib/api'
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
import { loadDb, putRecord, useDb } from '@/lib/db'
import { formatDateTime, formatDay, relativeDay } from '@/lib/format'
import { openView, useWorkspace, type ModuleTab } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { Input, Textarea } from '@/ui/Field'
import { showMenu } from '@/ui/Menu'
import { toast, toastError } from '@/ui/Toast'
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

function DiscussionCard({ discussion }: { discussion: MoodleDiscussion }) {
  const [expanded, setExpanded] = useState(false)
  const [posts, setPosts] = useState<MoodlePost[] | null>(null)
  const [loadingPosts, setLoadingPosts] = useState(false)
  const [showReplyBox, setShowReplyBox] = useState(false)
  const [replySubject, setReplySubject] = useState(`Re: ${discussion.subject}`)
  const [replyMessage, setReplyMessage] = useState('')
  const [sendingReply, setSendingReply] = useState(false)

  const toggleReplies = async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (!posts) {
      setLoadingPosts(true)
      try {
        const fetched = await api.moodle.posts(discussion.discussionId)
        setPosts(fetched)
      } catch (err) {
        toastError(err)
      } finally {
        setLoadingPosts(false)
      }
    }
  }

  const handleSendReply = async () => {
    if (!replyMessage.trim()) return
    setSendingReply(true)
    try {
      await api.moodle.reply(
        discussion.discussionId,
        replySubject.trim() || `Re: ${discussion.subject}`,
        replyMessage.trim(),
      )
      toast('Antwort erfolgreich gesendet!')
      setReplyMessage('')
      setShowReplyBox(false)
      // Reload posts
      const updated = await api.moodle.posts(discussion.discussionId)
      setPosts(updated)
      setExpanded(true)
    } catch (err) {
      toastError(err)
    } finally {
      setSendingReply(false)
    }
  }

  const sanitizedBody = DOMPurify.sanitize(discussion.message || '')

  return (
    <div className={`discussion-card ${discussion.pinned ? 'pinned' : ''}`}>
      <div className="discussion-header">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {discussion.pinned && (
            <span className="badge color-orange row" style={{ gap: 4 }}>
              <Pin size={12} /> Angepinnt
            </span>
          )}
          {discussion.isAnnouncement ? (
            <span className="badge color-red">📢 Ankündigung</span>
          ) : (
            <span className="badge color-blue">Forum: {discussion.forumName}</span>
          )}
          <span className="row muted small">
            <User size={13} /> {discussion.userFullName}
          </span>
          <span className="meta small">· {formatDateTime(discussion.timeCreated)}</span>
        </div>
      </div>

      <h3 className="discussion-title">{discussion.subject}</h3>

      <div
        className="discussion-body"
        dangerouslySetInnerHTML={{ __html: sanitizedBody }}
      />

      <div className="discussion-actions">
        <Button
          size="sm"
          variant="ghost"
          icon={<MessageSquare />}
          onClick={() => void toggleReplies()}
        >
          {discussion.numReplies} {discussion.numReplies === 1 ? 'Antwort' : 'Antworten'}
        </Button>
        <Button
          size="sm"
          variant="default"
          icon={<CornerDownRight />}
          onClick={() => setShowReplyBox((v) => !v)}
        >
          Antworten
        </Button>
      </div>

      {showReplyBox && (
        <div className="discussion-reply-box">
          <Input
            value={replySubject}
            placeholder="Betreff"
            onChange={(e) => setReplySubject(e.target.value)}
          />
          <Textarea
            value={replyMessage}
            placeholder="Deine Antwort verfassen…"
            rows={3}
            onChange={(e) => setReplyMessage(e.target.value)}
          />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setShowReplyBox(false)}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Send />}
              disabled={!replyMessage.trim() || sendingReply}
              onClick={() => void handleSendReply()}
            >
              {sendingReply ? 'Sendet…' : 'Abschicken'}
            </Button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="discussion-thread">
          {loadingPosts && <div className="small muted">Lade Antworten…</div>}
          {posts && posts.length <= 1 && (
            <div className="small muted">Keine weiteren Antworten in diesem Strang.</div>
          )}
          {posts &&
            posts
              .filter((p) => p.id !== discussion.id && p.parentId !== 0)
              .map((post) => (
                <div key={post.id} className="post-reply">
                  <div className="post-header">
                    <span className="post-author">{post.userFullName}</span>
                    <span className="meta small">{formatDateTime(post.timeCreated)}</span>
                  </div>
                  <div
                    className="post-body"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.message || '') }}
                  />
                </div>
              ))}
        </div>
      )}
    </div>
  )
}

function ModuleAnnouncements({ module }: { module: Module }) {
  const db = useDb()
  const [syncing, setSyncing] = useState(false)
  const discussions = db.moodleDiscussions.filter((d) => d.moduleId === module.id)

  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await api.moodle.sync()
      await loadDb()
      if (res.errors.length > 0) {
        toastError(new Error(res.errors.join(' · ')))
      } else {
        toast('Foren und Termine erfolgreich aktualisiert')
      }
    } catch (err) {
      toastError(err)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="section-title" style={{ margin: 0 }}>
          Moodle Foren & Ankündigungen ({discussions.length})
        </div>
        <Button
          size="sm"
          icon={<RefreshCw className={syncing ? 'spin' : ''} />}
          disabled={syncing}
          onClick={() => void handleSync()}
        >
          {syncing ? 'Gleiche ab…' : 'Jetzt abgleichen'}
        </Button>
      </div>

      {discussions.length === 0 ? (
        <Empty
          icon={<MessageSquare />}
          title="Keine Forenbeiträge"
          action={
            <Button icon={<RefreshCw />} disabled={syncing} onClick={() => void handleSync()}>
              Mit Moodle abgleichen
            </Button>
          }
        >
          Für dieses Modul sind aktuell keine Ankündigungen oder Forenbeiträge synchronisiert.
        </Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {discussions.map((d) => (
            <DiscussionCard key={d.id} discussion={d} />
          ))}
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
  const moduleDiscussions = db.moodleDiscussions.filter((d) => d.moduleId === module.id)

  const tabs: { id: ModuleTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Übersicht' },
    { id: 'sessions', label: 'Termine', count: lectures.length || undefined },
    { id: 'lab', label: 'Praktikum', count: labs.length || undefined },
    { id: 'files', label: 'Dateien' },
    { id: 'tasks', label: 'Aufgaben', count: moduleTasks.filter((t) => !t.done).length || undefined },
    { id: 'announcements', label: 'Ankündigungen & Forum', count: moduleDiscussions.length || undefined },
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
        {tab === 'announcements' && <ModuleAnnouncements module={module} />}
      </div>
      {editing && semester && <ModuleDialog semester={semester} module={module} onClose={() => setEditing(false)} />}
    </div>
  )
}
