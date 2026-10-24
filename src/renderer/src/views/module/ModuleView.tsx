// Modulseite: Übersicht, Termine (mit Ordner pro Termin), Praktikum, Dateien, Aufgaben.
import { useMemo, useState } from 'react'
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
  Search,
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
  const [errorLoadingPosts, setErrorLoadingPosts] = useState<string | null>(null)
  const [showReplyBox, setShowReplyBox] = useState(false)
  const [replyTargetPostId, setReplyTargetPostId] = useState<number | null>(null)
  const [replyTargetAuthor, setReplyTargetAuthor] = useState<string | null>(null)
  const [replySubject, setReplySubject] = useState(`Re: ${discussion.subject}`)
  const [replyMessage, setReplyMessage] = useState('')
  const [sendingReply, setSendingReply] = useState(false)

  const fetchPosts = async () => {
    setLoadingPosts(true)
    setErrorLoadingPosts(null)
    try {
      const fetched = await api.moodle.posts(discussion.discussionId)
      setPosts(fetched)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorLoadingPosts(msg)
      toastError(err)
    } finally {
      setLoadingPosts(false)
    }
  }

  const toggleReplies = async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (!posts && !loadingPosts) {
      await fetchPosts()
    }
  }

  const rootPost = useMemo(() => {
    if (!posts || posts.length === 0) return null
    return posts.find((p) => p.parentId === 0 || p.id === discussion.firstPostId) ?? posts[0]
  }, [posts, discussion.firstPostId])

  const rawBody = discussion.message || rootPost?.message || ''
  const sanitizedBody = useMemo(() => DOMPurify.sanitize(rawBody), [rawBody])

  const replies = useMemo(() => {
    if (!posts) return []
    const rootId = rootPost?.id ?? discussion.firstPostId
    return posts.filter((p) => p.id !== rootId && p.parentId !== 0)
  }, [posts, rootPost, discussion.firstPostId])

  const canReplyToDiscussion = !discussion.isAnnouncement && (!rootPost || rootPost.canReply !== false)

  const handleOpenDiscussionReply = () => {
    const targetId =
      rootPost?.id ??
      (discussion.firstPostId && discussion.firstPostId !== discussion.discussionId ? discussion.firstPostId : null) ??
      discussion.discussionId
    setReplyTargetPostId(targetId)
    setReplyTargetAuthor(discussion.userFullName)
    setReplySubject(discussion.subject.startsWith('Re:') ? discussion.subject : `Re: ${discussion.subject}`)
    setShowReplyBox((v) => !v)
  }

  const handleOpenPostReply = (post: MoodlePost) => {
    setReplyTargetPostId(post.id)
    setReplyTargetAuthor(post.userFullName)
    setReplySubject(post.subject.startsWith('Re:') ? post.subject : `Re: ${post.subject}`)
    setShowReplyBox(true)
  }

  const handleSendReply = async () => {
    if (!replyMessage.trim()) return
    setSendingReply(true)
    try {
      const targetId = replyTargetPostId ?? rootPost?.id ?? discussion.firstPostId ?? discussion.discussionId
      await api.moodle.reply(
        targetId,
        replySubject.trim() || `Re: ${discussion.subject}`,
        replyMessage.trim(),
      )
      toast('Antwort erfolgreich gesendet!')
      setReplyMessage('')
      setShowReplyBox(false)
      setReplyTargetPostId(null)
      setReplyTargetAuthor(null)
      await fetchPosts()
      await loadDb()
      setExpanded(true)
    } catch (err) {
      toastError(err)
    } finally {
      setSendingReply(false)
    }
  }

  const authorInitials = (discussion.userFullName || 'M')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className={`discussion-card ${discussion.pinned ? 'pinned' : ''}`}>
      <div className="discussion-header">
        <div className="discussion-user-meta">
          <div className="forum-avatar" title={discussion.userFullName}>
            {discussion.userPictureUrl ? (
              <img src={discussion.userPictureUrl} alt={discussion.userFullName} />
            ) : (
              <span>{authorInitials}</span>
            )}
          </div>
          <div className="forum-user-info">
            <span className="forum-author-name">{discussion.userFullName}</span>
            <span className="forum-date-meta">{formatDateTime(discussion.timeCreated)}</span>
          </div>
        </div>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {discussion.pinned && (
            <span className="badge color-orange row" style={{ gap: 4 }}>
              <Pin size={11} /> Angepinnt
            </span>
          )}
          {discussion.isAnnouncement ? (
            <span className="badge color-red">📢 Ankündigung</span>
          ) : (
            <span className="badge color-blue">Forum: {discussion.forumName}</span>
          )}
        </div>
      </div>

      <h3 className="discussion-title">{discussion.subject}</h3>

      {sanitizedBody ? (
        <div className="discussion-body" dangerouslySetInnerHTML={{ __html: sanitizedBody }} />
      ) : (
        <div className="discussion-body muted small" style={{ fontStyle: 'italic' }}>
          Keine Textvorschau verfügbar. Klicke auf Antworten zum Laden.
        </div>
      )}

      <div className="discussion-actions">
        <div className="discussion-actions-left">
          <Button
            size="sm"
            variant={expanded ? 'default' : 'ghost'}
            icon={<MessageSquare size={14} />}
            onClick={() => void toggleReplies()}
          >
            {discussion.numReplies} {discussion.numReplies === 1 ? 'Antwort' : 'Antworten'}
          </Button>
          {discussion.isAnnouncement && (
            <span className="forum-announcement-hint muted small">📢 Nur Lesen</span>
          )}
        </div>

        {canReplyToDiscussion && (
          <Button
            size="sm"
            variant="default"
            icon={<CornerDownRight size={14} />}
            onClick={handleOpenDiscussionReply}
          >
            Antworten
          </Button>
        )}
      </div>

      {showReplyBox && (
        <div className="discussion-reply-box">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="small muted font-semibold">
              {replyTargetAuthor ? `Antwort an ${replyTargetAuthor}` : 'Antwort verfassen'}
            </span>
          </div>
          <Input
            value={replySubject}
            placeholder="Betreff"
            onChange={(e) => setReplySubject(e.target.value)}
          />
          <Textarea
            value={replyMessage}
            placeholder="Deine Antwort verfassen…"
            rows={4}
            onChange={(e) => setReplyMessage(e.target.value)}
          />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            <Button size="sm" variant="ghost" onClick={() => setShowReplyBox(false)}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Send size={13} />}
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
          {loadingPosts && (
            <div className="forum-state-box muted small row" style={{ gap: 8 }}>
              <span className="spinner" /> Antworten werden geladen…
            </div>
          )}

          {errorLoadingPosts && (
            <div className="forum-state-box forum-error row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Fehler beim Laden: {errorLoadingPosts}</span>
              <Button size="sm" onClick={() => void fetchPosts()}>
                Erneut versuchen
              </Button>
            </div>
          )}

          {!loadingPosts && !errorLoadingPosts && replies.length === 0 && (
            <div className="forum-empty-replies">
              {discussion.isAnnouncement
                ? 'In Ankündigungen gibt es keine weiteren Antworten.'
                : 'Noch keine Antworten in diesem Strang. Sei der Erste, der antwortet!'}
            </div>
          )}

          {!loadingPosts &&
            replies.map((post) => {
              const replyInitials = (post.userFullName || 'M')
                .split(' ')
                .filter(Boolean)
                .map((n) => n[0])
                .slice(0, 2)
                .join('')
                .toUpperCase()
              const canReplyToPost = !discussion.isAnnouncement && post.canReply !== false
              return (
                <div key={post.id} className="post-reply">
                  <div className="post-header">
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <div className="forum-avatar" style={{ width: 26, height: 26, fontSize: 10 }}>
                        {post.userPictureUrl ? (
                          <img src={post.userPictureUrl} alt={post.userFullName} />
                        ) : (
                          <span>{replyInitials}</span>
                        )}
                      </div>
                      <span className="post-author">{post.userFullName}</span>
                      <span className="forum-date-meta">· {formatDateTime(post.timeCreated)}</span>
                    </div>
                    {canReplyToPost && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<CornerDownRight size={13} />}
                        onClick={() => handleOpenPostReply(post)}
                      >
                        Antworten
                      </Button>
                    )}
                  </div>
                  <div
                    className="post-body"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.message || '') }}
                  />
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}

function ModuleAnnouncements({ module }: { module: Module }) {
  const db = useDb()
  const [syncing, setSyncing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [forumFilter, setForumFilter] = useState<'all' | 'announcements' | number>('all')
  const discussions = db.moodleDiscussions.filter((d) => d.moduleId === module.id)

  const forums = useMemo(() => {
    const map = new Map<number, { id: number; name: string; count: number }>()
    for (const d of discussions) {
      if (d.forumId && d.forumName && !d.isAnnouncement) {
        const existing = map.get(d.forumId)
        if (existing) {
          existing.count++
        } else {
          map.set(d.forumId, { id: d.forumId, name: d.forumName, count: 1 })
        }
      }
    }
    return Array.from(map.values())
  }, [discussions])

  const announcementsCount = useMemo(
    () => discussions.filter((d) => d.isAnnouncement).length,
    [discussions],
  )

  const filteredDiscussions = useMemo(() => {
    let result = discussions
    if (forumFilter === 'announcements') {
      result = result.filter((d) => d.isAnnouncement)
    } else if (typeof forumFilter === 'number') {
      result = result.filter((d) => d.forumId === forumFilter)
    }

    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (d) =>
          d.subject.toLowerCase().includes(q) ||
          d.message.toLowerCase().includes(q) ||
          d.userFullName.toLowerCase().includes(q) ||
          d.forumName.toLowerCase().includes(q),
      )
    }
    return result
  }, [discussions, forumFilter, searchQuery])

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

      {discussions.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="forum-search-row">
            <Search size={16} className="muted" />
            <Input
              value={searchQuery}
              placeholder="Beitrag, Thema oder Autor suchen…"
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="forum-filters-bar">
            <Button
              size="sm"
              variant={forumFilter === 'all' ? 'primary' : 'ghost'}
              onClick={() => setForumFilter('all')}
            >
              Alle ({discussions.length})
            </Button>
            {announcementsCount > 0 && (
              <Button
                size="sm"
                variant={forumFilter === 'announcements' ? 'primary' : 'ghost'}
                onClick={() => setForumFilter('announcements')}
              >
                📢 Ankündigungen ({announcementsCount})
              </Button>
            )}
            {forums.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={forumFilter === f.id ? 'primary' : 'ghost'}
                onClick={() => setForumFilter(f.id)}
              >
                💬 {f.name} ({f.count})
              </Button>
            ))}
          </div>
        </div>
      )}

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
      ) : filteredDiscussions.length === 0 ? (
        <Empty icon={<MessageSquare />} title="Keine Beiträge gefunden">
          {searchQuery
            ? `Keine Suchergebnisse für „${searchQuery}“.`
            : 'In diesem Filter wurden keine Forenbeiträge gefunden.'}
        </Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {filteredDiscussions.map((d) => (
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
