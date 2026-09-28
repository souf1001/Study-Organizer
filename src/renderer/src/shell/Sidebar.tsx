import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  CalendarDays,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  FilePlus,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  Home,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Settings,
  SplitSquareHorizontal,
  Trash2,
  Upload,
} from 'lucide-react'
import type { Folder, Item, Module } from '@shared/types'
import { isoDateOf, today } from '@shared/dates'
import {
  activeSemester,
  childFolders,
  createFolder,
  createNote,
  deleteFolder,
  deleteItem,
  deleteModule,
  pickFiles,
  renameFolder,
  renameItem,
  semesterModules,
  uploadFiles,
  visibleItems,
} from '@/lib/actions'
import { updateDb, useDb } from '@/lib/db'
import { modKey } from '@/lib/format'
import { DRAG_VIEW_TYPE, openInNewPane, openView, useWorkspace, type View } from '@/lib/workspace'
import { IconButton } from '@/ui/Button'
import { showMenu } from '@/ui/Menu'
import { FileIcon } from '@/views/file/FileIcon'
import { ModuleDialog } from '@/views/module/ModuleDialog'
import { SemesterDialog } from '@/views/semester/SemesterDialog'
import { usePalette } from './CommandPalette'

// Aufgeklappte Einträge merken
const useExpanded = create<{ ids: string[]; toggle: (id: string) => void; open: (id: string) => void }>()(
  persist(
    (set) => ({
      ids: [],
      toggle: (id) => set((s) => ({ ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] })),
      open: (id) => set((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] })),
    }),
    { name: 'study-organizer-sidebar' },
  ),
)

function useActiveView(): View | undefined {
  return useWorkspace((s) => s.panes.find((p) => p.id === s.activeId)?.view)
}

function isActive(current: View | undefined, view: View): boolean {
  if (!current || current.type !== view.type) return false
  return !('id' in view) || ('id' in current && current.id === view.id)
}

function dragStart(view: View) {
  return (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_VIEW_TYPE, JSON.stringify(view))
    e.dataTransfer.effectAllowed = 'copyMove'
  }
}

function NavItem({ icon, label, view, trailing }: { icon: ReactNode; label: string; view: View; trailing?: ReactNode }) {
  const active = isActive(useActiveView(), view)
  return (
    <button
      type="button"
      className={`nav-item ${active ? 'active' : ''}`}
      onClick={(e) => openView(view, e)}
      draggable
      onDragStart={dragStart(view)}
    >
      {icon}
      <span>{label}</span>
      {trailing}
    </button>
  )
}

function ItemRow({ item, depth }: { item: Item; depth: number }) {
  const view: View = { type: 'item', id: item.id }
  const active = isActive(useActiveView(), view)
  const menu = (e: MouseEvent) => {
    e.preventDefault()
    showMenu(e, [
      { label: 'In neuem Bereich öffnen', icon: <SplitSquareHorizontal />, onClick: () => openInNewPane(view) },
      { label: 'Umbenennen', icon: <Pencil />, onClick: () => void renameItem(item) },
      { separator: true },
      { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteItem(item) },
    ])
  }
  return (
    <div
      className={`tree-row ${active ? 'active' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 + 18 }}
      onClick={(e) => openView(view, e)}
      onContextMenu={menu}
      draggable
      onDragStart={dragStart(view)}
    >
      {item.kind === 'note' ? <FileText className="row-icon" /> : <FileIcon type={item.fileType} className="row-icon" />}
      <span className="label">{item.title}</span>
    </div>
  )
}

function FolderRow({ folder, depth }: { folder: Folder; depth: number }) {
  const db = useDb()
  const expanded = useExpanded((s) => s.ids.includes(folder.id))
  const { toggle, open } = useExpanded.getState()
  const view: View = { type: 'folder', id: folder.id }
  const active = isActive(useActiveView(), view)
  const folders = expanded ? childFolders(db, folder.moduleId, folder.id) : []
  const items = expanded ? visibleItems(db, folder.id, folder.moduleId) : []

  const menu = (e: MouseEvent) => {
    e.preventDefault()
    showMenu(e, [
      { label: 'Neue Notiz', icon: <FilePlus />, onClick: () => void createNote(folder.moduleId, folder.id).then(() => open(folder.id)) },
      { label: 'Dateien hinzufügen', icon: <Upload />, onClick: () => void pickFiles().then((f) => uploadFiles(folder.moduleId, folder.id, f)) },
      { label: 'Unterordner', icon: <FolderPlus />, onClick: () => void createFolder(folder.moduleId, folder.id).then(() => open(folder.id)) },
      { separator: true },
      { label: 'In neuem Bereich öffnen', icon: <SplitSquareHorizontal />, onClick: () => openInNewPane(view) },
      { label: 'Umbenennen', icon: <Pencil />, onClick: () => void renameFolder(folder) },
      { separator: true },
      { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteFolder(folder) },
    ])
  }

  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => openView(view, e)}
        onContextMenu={menu}
        draggable
        onDragStart={dragStart(view)}
      >
        <button
          type="button"
          className="chevron"
          aria-label={expanded ? 'Zuklappen' : 'Aufklappen'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation()
            toggle(folder.id)
          }}
        >
          <ChevronRight />
        </button>
        <FolderIcon className="row-icon" />
        <span className="label">{folder.name}</span>
      </div>
      {folders.map((f) => (
        <FolderRow key={f.id} folder={f} depth={depth + 1} />
      ))}
      {items.map((i) => (
        <ItemRow key={i.id} item={i} depth={depth + 1} />
      ))}
      {expanded && folders.length === 0 && items.length === 0 && (
        <div className="tree-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 + 18 }}>
          Leer
        </div>
      )}
    </>
  )
}

function ModuleRow({ module, onEdit }: { module: Module; onEdit: () => void }) {
  const db = useDb()
  const expanded = useExpanded((s) => s.ids.includes(module.id))
  const { toggle, open } = useExpanded.getState()
  const view: View = { type: 'module', id: module.id }
  const active = isActive(useActiveView(), view)
  const folders = expanded ? childFolders(db, module.id, null) : []
  const items = expanded ? visibleItems(db, null, module.id) : []

  const menu = (e: MouseEvent) => {
    e.preventDefault()
    showMenu(e, [
      { label: 'Neue Notiz', icon: <FilePlus />, onClick: () => void createNote(module.id, null).then(() => open(module.id)) },
      { label: 'Neuer Ordner', icon: <FolderPlus />, onClick: () => void createFolder(module.id, null).then(() => open(module.id)) },
      { separator: true },
      { label: 'In neuem Bereich öffnen', icon: <SplitSquareHorizontal />, onClick: () => openInNewPane(view) },
      { label: 'Modul bearbeiten', icon: <Pencil />, onClick: onEdit },
      { separator: true },
      { label: 'Modul löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteModule(module) },
    ])
  }

  return (
    <>
      <div
        className={`tree-row module-row ${active ? 'active' : ''}`}
        style={{ paddingLeft: 4 }}
        onClick={(e) => openView(view, e)}
        onContextMenu={menu}
        draggable
        onDragStart={dragStart(view)}
      >
        <button
          type="button"
          className="chevron"
          aria-label={expanded ? 'Zuklappen' : 'Aufklappen'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation()
            toggle(module.id)
          }}
        >
          <ChevronRight />
        </button>
        <span className={`dot color-${module.color}`} />
        <span className="label">{module.name || 'Unbenanntes Modul'}</span>
        <span className="row-actions">
          <IconButton
            small
            label="Neue Notiz"
            onClick={(e) => {
              e.stopPropagation()
              void createNote(module.id, null).then(() => open(module.id))
            }}
          >
            <Plus />
          </IconButton>
        </span>
      </div>
      {folders.map((f) => (
        <FolderRow key={f.id} folder={f} depth={1} />
      ))}
      {items.map((i) => (
        <ItemRow key={i.id} item={i} depth={1} />
      ))}
      {expanded && folders.length === 0 && items.length === 0 && (
        <div className="tree-empty" style={{ paddingLeft: 40 }}>
          Noch leer
        </div>
      )}
    </>
  )
}

export function Sidebar() {
  const db = useDb()
  const semester = activeSemester(db)
  const modules = semesterModules(db, semester?.id)
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar)
  const openPalette = usePalette((s) => s.show)
  const [moduleDialog, setModuleDialog] = useState<{ module?: Module } | null>(null)
  const [semesterDialog, setSemesterDialog] = useState(false)

  const openTasks = db.tasks.filter((t) => !t.done && t.due && isoDateOf(t.due) <= today()).length
  const initials = (db.profile.name || 'S').trim().slice(0, 1).toUpperCase()

  const semesterMenu = (e: MouseEvent<HTMLButtonElement>) =>
    showMenu(e.currentTarget, [
      { heading: 'Semester' },
      ...[...db.semesters]
        .sort((a, b) => b.start.localeCompare(a.start))
        .map((s) => ({
          label: s.name,
          icon: s.id === semester?.id ? <Check /> : <span style={{ width: 15 }} />,
          onClick: () => updateDb({ activeSemesterId: s.id }),
        })),
      { separator: true },
      { label: 'Neues Semester beginnen…', icon: <Plus />, onClick: () => setSemesterDialog(true) },
      { label: 'Semester verwalten', icon: <Settings />, onClick: () => openView({ type: 'settings', section: 'study' }) },
    ])

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <button type="button" className="semester-switch" onClick={semesterMenu}>
          <span className="avatar">{initials}</span>
          <span className="truncate">{semester?.name ?? 'Kein Semester'}</span>
          <ChevronDown />
        </button>
        <span className="spacer" />
        <IconButton label={`Seitenleiste ausblenden (${modKey} \\)`} onClick={toggleSidebar}>
          <ChevronsLeft />
        </IconButton>
      </div>

      <div className="sidebar-scroll">
        <nav className="sidebar-nav">
          <button type="button" className="nav-item" onClick={openPalette}>
            <Search />
            <span>Suchen</span>
            <span className="kbd">{modKey} K</span>
          </button>
          <NavItem icon={<Home />} label="Heute" view={{ type: 'home' }} />
          <NavItem icon={<CalendarDays />} label="Kalender" view={{ type: 'calendar' }} />
          <NavItem
            icon={<CheckSquare />}
            label="Aufgaben"
            view={{ type: 'tasks' }}
            trailing={openTasks > 0 ? <span className="count">{openTasks}</span> : null}
          />
          {db.settings.ai.enabled && <NavItem icon={<MessageCircle />} label="KI-Chat" view={{ type: 'chat' }} />}
        </nav>

        <div className="sidebar-heading">
          <span>MODULE</span>
          <IconButton small label="Modul hinzufügen" onClick={() => setModuleDialog({})}>
            <Plus />
          </IconButton>
        </div>
        {modules.map((m) => (
          <ModuleRow key={m.id} module={m} onEdit={() => setModuleDialog({ module: m })} />
        ))}
        {modules.length === 0 && (
          <button type="button" className="nav-item" onClick={() => setModuleDialog({})}>
            <Plus />
            <span>Modul hinzufügen</span>
          </button>
        )}
      </div>

      <div className="sidebar-bottom">
        <NavItem icon={<Settings />} label="Einstellungen" view={{ type: 'settings' }} />
      </div>

      {moduleDialog && semester && (
        <ModuleDialog semester={semester} module={moduleDialog.module} onClose={() => setModuleDialog(null)} />
      )}
      {semesterDialog && <SemesterDialog onClose={() => setSemesterDialog(false)} />}
    </aside>
  )
}
