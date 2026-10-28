// Module page: overview, sessions (with one folder per session), lab, files, tasks, forum and AI chats.
import { useState } from 'react'
import {
  BookOpen,
  FilePlus,
  FolderOpen,
  FolderPlus,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ScrollText,
  Trash2,
  Upload,
  User,
} from 'lucide-react'
import { today } from '@shared/dates'
import type { CalendarEvent, Module } from '@shared/types'
import {
  childFolders,
  createFolder,
  createNote,
  deleteModule,
  pickFiles,
  semesterOf,
  uploadFiles,
  visibleItems,
} from '@/lib/actions'
import { summarizePastSessions } from '@/lib/ai'
import { api } from '@/lib/api'
import { useDb } from '@/lib/db'
import { openView, useWorkspace, type ModuleTab } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { showMenu } from '@/ui/Menu'
import { toastError } from '@/ui/Toast'
import { FolderContents } from '../folder/FolderView'
import { TaskList } from '../tasks/TasksView'
import { EventDialog } from '../calendar/EventDialog'
import { ModuleAnnouncements } from './ModuleAnnouncements'
import { ModuleChats } from './ModuleChats'
import { ModuleDialog } from './ModuleDialog'
import { ModuleOverview } from './ModuleOverview'
import { isLab, mappedCourseIds, moduleDiscussions, moduleSessions } from '@shared/module-sessions'
import { SessionList } from './SessionList'
import './module.css'

export function ModuleView({
  module,
  tab,
  paneId,
}: {
  module: Module
  tab: ModuleTab
  paneId: string
}) {
  const db = useDb()
  const [editing, setEditing] = useState(false)
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null)
  const semester = semesterOf(db, module)

  const occurrences = moduleSessions(db, module, semester)

  const lectures = occurrences.filter((o) => !isLab(o.kind))
  const labs = occurrences.filter((o) => isLab(o.kind))
  const setTab = (next: ModuleTab) =>
    useWorkspace.getState().replace(paneId, { type: 'module', id: module.id, tab: next })
  const rootItems = visibleItems(db, null, module.id)
  const moduleTasks = db.tasks.filter((t) => t.moduleId === module.id)
  const labTasks = moduleTasks.filter((t) => t.kind === 'lab')
  const discussionCount = moduleDiscussions(
    db.moodleDiscussions,
    module.id,
    mappedCourseIds(db.settings.moodle?.courseMap ?? {}, module.id),
  ).length
  const moduleChats = (db.chats ?? []).filter((c) => c.moduleId === module.id)

  const tabs: { id: ModuleTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Übersicht' },
    { id: 'sessions', label: 'Termine', count: lectures.length || undefined },
    { id: 'lab', label: 'Praktikum', count: labs.length || undefined },
    { id: 'files', label: 'Dateien' },
    {
      id: 'tasks',
      label: 'Aufgaben',
      count: moduleTasks.filter((t) => !t.done).length || undefined,
    },
    { id: 'announcements', label: 'Ankündigungen & Forum', count: discussionCount || undefined },
    ...(db.settings.ai.enabled
      ? [{ id: 'chats' as ModuleTab, label: 'KI-Chat', count: moduleChats.length || undefined }]
      : []),
  ]

  const moreMenu = (e: React.MouseEvent<HTMLButtonElement>) =>
    showMenu(e.currentTarget, [
      { label: 'Modul bearbeiten', icon: <Pencil />, onClick: () => setEditing(true) },
      ...(api.revealDocuments
        ? [
            {
              label: 'Im Dateiordner öffnen',
              icon: <FolderOpen />,
              onClick: () => void api.revealDocuments?.({ moduleId: module.id }).catch(toastError),
            },
          ]
        : []),
      ...(db.settings.ai.enabled
        ? [
            {
              label: 'Bisherige Vorlesungen zusammenfassen',
              icon: <ScrollText />,
              onClick: () => void summarizePastSessions(module.id, today()),
            },
            {
              label: 'Mit KI über das Modul chatten',
              icon: <MessageCircle />,
              onClick: () =>
                openView({ type: 'chat', moduleId: module.id }, { metaKey: true, ctrlKey: false }),
            },
          ]
        : []),
      { separator: true },
      {
        label: 'Modul löschen',
        icon: <Trash2 />,
        danger: true,
        onClick: () => void deleteModule(module),
      },
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
            <button
              key={t.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count !== undefined && <span className="count">{t.count}</span>}
            </button>
          ))}
        </div>

        {tab === 'overview' && <ModuleOverview module={module} occurrences={occurrences} />}
        {tab === 'sessions' && (
          <SessionList
            module={module}
            occurrences={lectures}
            kinds="other"
            onEditEvent={setEditingEvent}
          />
        )}
        {tab === 'lab' && (
          <div className="stack" style={{ gap: 28 }}>
            <SessionList
              module={module}
              occurrences={labs}
              kinds="lab"
              onEditEvent={setEditingEvent}
            />
            <div>
              <div className="section-title">Testate & Abgaben im Praktikum</div>
              <TaskList tasks={labTasks} newTask={{ moduleId: module.id, kind: 'lab' }} />
            </div>
          </div>
        )}
        {tab === 'files' && (
          <div>
            <div className="row" style={{ marginBottom: 12 }}>
              <Button
                size="sm"
                icon={<Upload />}
                onClick={() => void pickFiles().then((f) => uploadFiles(module.id, null, f))}
              >
                Hochladen
              </Button>
              <Button
                size="sm"
                icon={<FolderPlus />}
                onClick={() => void createFolder(module.id, null)}
              >
                Ordner
              </Button>
            </div>
            <FolderContents
              moduleId={module.id}
              folderId={null}
              folders={childFolders(db, module.id, null)}
              items={rootItems}
            />
          </div>
        )}
        {tab === 'tasks' && (
          <TaskList
            tasks={moduleTasks}
            newTask={{ moduleId: module.id, kind: 'assignment' }}
            showDone
          />
        )}
        {tab === 'announcements' && <ModuleAnnouncements module={module} />}
        {tab === 'chats' && <ModuleChats module={module} />}
      </div>
      {editing && semester && (
        <ModuleDialog semester={semester} module={module} onClose={() => setEditing(false)} />
      )}
      {editingEvent && <EventDialog event={editingEvent} onClose={() => setEditingEvent(null)} />}
    </div>
  )
}
