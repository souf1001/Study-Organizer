// Up to 4 resizable panes (1–3: columns, 4: a 2×2 grid).
import { Fragment, lazy, Suspense, useState, type DragEvent, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ArrowLeft, ArrowRight, ChevronsRight, Columns2, X } from 'lucide-react'
import type { Db, Folder } from '@shared/types'
import { folderPath } from '@/lib/actions'
import { useDb } from '@/lib/db'
import { modKey } from '@/lib/format'
import { useDevice } from '@/lib/device'
import { DRAG_VIEW_TYPE, MAX_PANES, useWorkspace, type Pane, type View } from '@/lib/workspace'
import { IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { ErrorBoundary } from '@/ui/ErrorBoundary'
import { HomeView } from '@/views/home/HomeView'
import { ModuleView } from '@/views/module/ModuleView'
import { FolderView } from '@/views/folder/FolderView'
import { TasksView } from '@/views/tasks/TasksView'
import { CalendarView } from '@/views/calendar/CalendarView'
import { SettingsView } from '@/views/settings/SettingsView'
import { LauncherView } from '@/views/launcher/LauncherView'

const ItemView = lazy(() => import('@/views/item/ItemView'))
const ChatView = lazy(() => import('@/views/chat/ChatView'))

interface Crumb {
  label: string
  view: View
  dot?: string
}

function crumbsFor(db: Db, view: View): Crumb[] {
  const moduleCrumb = (id: string): Crumb[] => {
    const module = db.modules.find((m) => m.id === id)
    return module
      ? [{ label: module.name, view: { type: 'module', id: module.id }, dot: module.color }]
      : []
  }
  const folderCrumbs = (folder: Folder): Crumb[] =>
    folderPath(db, folder).map((f) => ({ label: f.name, view: { type: 'folder', id: f.id } }))
  switch (view.type) {
    case 'home':
      return [{ label: 'Heute', view }]
    case 'calendar':
      return [{ label: 'Kalender', view }]
    case 'tasks':
      return [{ label: 'Aufgaben', view }]
    case 'chat': {
      const chat = view.chatId ? (db.chats ?? []).find((c) => c.id === view.chatId) : null
      const moduleId = view.moduleId ?? chat?.moduleId
      const label = chat ? `KI-Chat: ${chat.title}` : 'KI-Chat'
      return [...(moduleId ? moduleCrumb(moduleId) : []), { label, view }]
    }
    case 'settings':
      return [{ label: 'Einstellungen', view }]
    case 'launcher':
      return [{ label: 'Neuer Bereich', view }]
    case 'module':
      return moduleCrumb(view.id)
    case 'folder': {
      const folder = db.folders.find((f) => f.id === view.id)
      if (!folder) return []
      return [...moduleCrumb(folder.moduleId), ...folderCrumbs(folder)]
    }
    case 'item': {
      const item = db.items.find((i) => i.id === view.id)
      if (!item) return []
      const folder = db.folders.find((f) => f.id === item.folderId)
      return [
        ...moduleCrumb(item.moduleId),
        ...(folder ? folderCrumbs(folder) : []),
        { label: item.title, view },
      ]
    }
  }
}

function ViewContent({ view, paneId }: { view: View; paneId: string }) {
  const db = useDb()
  const missing = (
    <Empty title="Nicht gefunden">Dieser Eintrag wurde gelöscht oder verschoben.</Empty>
  )
  switch (view.type) {
    case 'home':
      return <HomeView />
    case 'calendar':
      return <CalendarView />
    case 'tasks':
      return <TasksView />
    case 'settings':
      return <SettingsView section={view.section} paneId={paneId} />
    case 'chat':
      return <ChatView view={view} paneId={paneId} />
    case 'launcher':
      return <LauncherView paneId={paneId} />
    case 'module': {
      const module = db.modules.find((m) => m.id === view.id)
      return module ? (
        <ModuleView key={module.id} module={module} tab={view.tab ?? 'overview'} paneId={paneId} />
      ) : (
        missing
      )
    }
    case 'folder': {
      const folder = db.folders.find((f) => f.id === view.id)
      return folder ? <FolderView key={folder.id} folder={folder} /> : missing
    }
    case 'item': {
      const item = db.items.find((i) => i.id === view.id)
      return item ? <ItemView key={item.id} item={item} /> : missing
    }
  }
}

function PaneHeader({ pane, count }: { pane: Pane; count: number }) {
  const db = useDb()
  const { back, forward, close, open, sidebarOpen, toggleSidebar } = useWorkspace()
  const isFirst = useWorkspace((s) => s.panes[0]?.id === pane.id)
  // Phones show a single pane, so there is nothing to split or close
  const canSplit = !useDevice((s) => s.isPhone)
  const crumbs = crumbsFor(db, pane.view)

  return (
    <header className="pane-header drag">
      {!sidebarOpen && isFirst && (
        <IconButton label={`Seitenleiste einblenden (${modKey} \\)`} onClick={toggleSidebar}>
          <ChevronsRight />
        </IconButton>
      )}
      <IconButton label="Zurück" disabled={!pane.back.length} onClick={() => back(pane.id)}>
        <ArrowLeft />
      </IconButton>
      <IconButton label="Vorwärts" disabled={!pane.forward.length} onClick={() => forward(pane.id)}>
        <ArrowRight />
      </IconButton>
      <nav className="breadcrumb">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            <button type="button" onClick={() => open(c.view, { paneId: pane.id })}>
              {c.dot && <span className={`dot color-${c.dot}`} />}
              <span>{c.label}</span>
            </button>
          </Fragment>
        ))}
      </nav>
      {canSplit && (
        <IconButton
          label="Neuen Bereich daneben öffnen"
          disabled={count >= MAX_PANES}
          onClick={() => open({ type: 'launcher' }, { newPane: true })}
        >
          <Columns2 />
        </IconButton>
      )}
      {canSplit && count > 1 && (
        <IconButton label="Bereich schließen" onClick={() => close(pane.id)}>
          <X />
        </IconButton>
      )}
    </header>
  )
}

function PaneView({ pane, count }: { pane: Pane; count: number }) {
  const active = useWorkspace((s) => s.activeId === pane.id)
  const { focus, open } = useWorkspace.getState()
  const [dropping, setDropping] = useState(false)

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_VIEW_TYPE)) return
    e.preventDefault()
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    const data = e.dataTransfer.getData(DRAG_VIEW_TYPE)
    setDropping(false)
    if (!data) return
    e.preventDefault()
    open(JSON.parse(data) as View, { paneId: pane.id })
  }

  return (
    <section
      className={`pane ${count > 1 ? 'multi' : ''} ${active ? 'active' : ''} ${dropping ? 'drop-target' : ''}`}
      onMouseDownCapture={() => focus(pane.id)}
      onFocusCapture={() => focus(pane.id)}
      onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={onDrop}
    >
      <PaneHeader pane={pane} count={count} />
      <div className="pane-body">
        <ErrorBoundary resetKey={JSON.stringify(pane.view)}>
          <Suspense fallback={null}>
            <ViewContent view={pane.view} paneId={pane.id} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </section>
  )
}

/** Grab area around the dividers between panes, in pixels (a finger needs more room) */
const RESIZE_TARGET = { coarse: 32, fine: 10 }

function Row({ panes, count }: { panes: Pane[]; count: number }): ReactNode {
  return (
    <Group orientation="horizontal" className="pane-group" resizeTargetMinimumSize={RESIZE_TARGET}>
      {panes.map((pane, i) => (
        <Fragment key={pane.id}>
          {i > 0 && <Separator className="pane-separator" />}
          <Panel id={pane.id} minSize={260}>
            <PaneView pane={pane} count={count} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  )
}

/** Phones show only the active pane; the other panes stay open in the background */
function PhoneWorkspace() {
  const pane = useWorkspace((s) => s.panes.find((p) => p.id === s.activeId) ?? s.panes[0])
  return (
    <main className="workspace mobile-workspace">
      <PaneView pane={pane} count={1} />
    </main>
  )
}

export function Workspace() {
  const panes = useWorkspace((s) => s.panes)
  const count = panes.length
  const isPhone = useDevice((s) => s.isPhone)
  if (isPhone) return <PhoneWorkspace />

  return (
    <main className="workspace">
      {count < 4 ? (
        <Row panes={panes} count={count} />
      ) : (
        <Group
          orientation="vertical"
          className="pane-group"
          resizeTargetMinimumSize={RESIZE_TARGET}
        >
          <Panel id="top" minSize={200}>
            <Row panes={panes.slice(0, 2)} count={count} />
          </Panel>
          <Separator className="pane-separator" />
          <Panel id="bottom" minSize={200}>
            <Row panes={panes.slice(2)} count={count} />
          </Panel>
        </Group>
      )}
    </main>
  )
}
