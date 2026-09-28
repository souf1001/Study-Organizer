// Ordner (z. B. „Vorlesung 3 · 14.10.“): Notizen, Folien, Videos, Fotos – per Drag & Drop befüllbar.
import { useState, type DragEvent, type MouseEvent } from 'react'
import {
  CheckCircle2,
  Circle,
  Columns2,
  ExternalLink,
  FilePlus,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ScrollText,
  SplitSquareHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { SESSION_LABELS } from '@shared/schedule'
import type { Folder, ID, Item } from '@shared/types'
import { isoDateOf } from '@shared/dates'
import { api, openFileLabel } from '@/lib/api'
import {
  childFolders,
  createFolder,
  createNote,
  deleteFolder,
  deleteItem,
  pickFiles,
  renameFolder,
  renameItem,
  uploadFiles,
  visibleItems,
} from '@/lib/actions'
import { summarizeFolder, summarizeItems } from '@/lib/ai'
import { putRecord, removeRecord, useDb } from '@/lib/db'
import { formatLongDay, formatSize, relativeDay } from '@/lib/format'
import { DRAG_VIEW_TYPE, MAX_PANES, openInNewPane, openView, useWorkspace, type View } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { confirm } from '@/ui/Dialogs'
import { Empty } from '@/ui/Empty'
import { showMenu } from '@/ui/Menu'
import { toastError } from '@/ui/Toast'
import { FILE_TYPE_LABELS, FileIcon } from '../file/FileIcon'
import './folder.css'

function ItemThumb({ item }: { item: Item }) {
  if (item.fileType === 'image') return <img className="item-thumb" src={api.fileUrl(item)} alt="" loading="lazy" />
  return item.kind === 'note' ? <FileText className="item-icon" /> : <FileIcon type={item.fileType} className="item-icon" />
}

/** Mehrere Einträge nebeneinander öffnen (höchstens 4 Bereiche) */
function openSideBySide(ids: ID[]): void {
  const ws = useWorkspace.getState()
  const views: View[] = ids.slice(0, MAX_PANES).map((id) => ({ type: 'item', id }))
  ws.open(views[0], { paneId: ws.activeId })
  for (const view of views.slice(1)) ws.open(view, { newPane: true })
}

export function FolderContents({ moduleId, folderId, folders, items }: { moduleId: ID; folderId: ID | null; folders: Folder[]; items: Item[] }) {
  const db = useDb()
  const [selected, setSelected] = useState<Set<ID>>(new Set())
  const [dropping, setDropping] = useState(false)
  const toggle = (id: ID) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const selectedItems = items.filter((i) => selected.has(i.id))

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    setDropping(false)
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    e.stopPropagation()
    void uploadFiles(moduleId, folderId, [...e.dataTransfer.files])
  }

  const itemMenu = (e: MouseEvent, item: Item) => {
    e.preventDefault()
    showMenu(e, [
      { label: 'In neuem Bereich öffnen', icon: <SplitSquareHorizontal />, onClick: () => openInNewPane({ type: 'item', id: item.id }) },
      ...(item.kind === 'file' ? [{ label: openFileLabel, icon: <ExternalLink />, onClick: () => void api.openFile(item).catch(toastError) }] : []),
      ...(db.settings.ai.enabled ? [{ label: 'Mit KI zusammenfassen', icon: <ScrollText />, onClick: () => void summarizeItems([item]) }] : []),
      { label: 'Umbenennen', icon: <Pencil />, onClick: () => void renameItem(item) },
      { separator: true },
      { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteItem(item) },
    ])
  }

  const deleteSelected = async () => {
    const ok = await confirm({ title: `${selectedItems.length} Einträge löschen?`, confirmLabel: 'Löschen', danger: true })
    if (!ok) return
    for (const item of selectedItems) await removeRecord('items', item.id)
    setSelected(new Set())
  }

  return (
    <div
      className={`folder-contents ${dropping ? 'dropping' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={onDrop}
    >
      {selected.size > 0 && (
        <div className="selection-bar">
          <span className="small">{selected.size} ausgewählt</span>
          <span className="spacer" />
          <Button size="sm" icon={<Columns2 />} onClick={() => openSideBySide([...selected])} disabled={selected.size > MAX_PANES}>
            Nebeneinander öffnen
          </Button>
          {db.settings.ai.enabled && (
            <>
              <Button size="sm" icon={<ScrollText />} onClick={() => void summarizeItems(selectedItems)}>
                Zusammenfassen
              </Button>
              <Button size="sm" icon={<MessageCircle />} onClick={() => openInNewPane({ type: 'chat', itemIds: [...selected] })}>
                Fragen
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => void deleteSelected()}>
            Löschen
          </Button>
          <IconButton small label="Auswahl aufheben" onClick={() => setSelected(new Set())}>
            <X />
          </IconButton>
        </div>
      )}

      {folders.length === 0 && items.length === 0 ? (
        <Empty
          icon={<Upload />}
          title="Noch leer"
          action={
            <div className="row">
              <Button icon={<FilePlus />} onClick={(e) => void createNote(moduleId, folderId, e)}>
                Neue Notiz
              </Button>
              <Button icon={<Upload />} onClick={() => void pickFiles().then((f) => uploadFiles(moduleId, folderId, f))}>
                Dateien hochladen
              </Button>
            </div>
          }
        >
          Folien, Übungsblätter, Videos und Fotos einfach hierher ziehen.
        </Empty>
      ) : (
        <div className="list">
          {folders.map((f) => {
            const count = db.items.filter((i) => i.folderId === f.id && !i.attachedTo).length
            const view: View = { type: 'folder', id: f.id }
            return (
              <div
                key={f.id}
                className="list-row item-row clickable"
                onClick={(e) => openView(view, e)}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_VIEW_TYPE, JSON.stringify(view))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  showMenu(e, [
                    { label: 'In neuem Bereich öffnen', icon: <SplitSquareHorizontal />, onClick: () => openInNewPane(view) },
                    { label: 'Umbenennen', icon: <Pencil />, onClick: () => void renameFolder(f) },
                    { separator: true },
                    { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteFolder(f) },
                  ])
                }}
              >
                <span className="check-spacer" />
                <FolderIcon className="item-icon" />
                <span className="truncate">{f.name}</span>
                <span className="meta">{count} Einträge</span>
              </div>
            )
          })}
          {items.map((item) => {
            const view: View = { type: 'item', id: item.id }
            return (
              <div
                key={item.id}
                className={`list-row item-row clickable ${selected.has(item.id) ? 'selected' : ''}`}
                onClick={(e) => (e.shiftKey ? toggle(item.id) : openView(view, e))}
                onContextMenu={(e) => itemMenu(e, item)}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_VIEW_TYPE, JSON.stringify(view))}
              >
                <input
                  type="checkbox"
                  className="checkbox"
                  aria-label="Auswählen"
                  checked={selected.has(item.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(item.id)}
                />
                <ItemThumb item={item} />
                <span className="truncate">{item.title}</span>
                {item.source === 'ai' && <span className="badge">KI</span>}
                {item.source === 'moodle' && <span className="badge">Moodle</span>}
                <span className="meta">
                  {item.kind === 'note' ? 'Notiz' : FILE_TYPE_LABELS[item.fileType ?? 'other']}
                  {item.size ? ` · ${formatSize(item.size)}` : ''} · {relativeDay(isoDateOf(item.updatedAt))}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {dropping && <div className="drop-hint">Loslassen zum Hinzufügen</div>}
    </div>
  )
}

export function FolderView({ folder }: { folder: Folder }) {
  const db = useDb()
  const folders = childFolders(db, folder.moduleId, folder.id)
  const items = visibleItems(db, folder.id, folder.moduleId)
  const module = db.modules.find((m) => m.id === folder.moduleId)
  const [room, setRoom] = useState(folder.room)
  const isSession = folder.kind === 'session' && folder.sessionKind

  const more = (e: MouseEvent<HTMLButtonElement>) =>
    showMenu(e.currentTarget, [
      { label: 'Unterordner anlegen', icon: <FolderPlus />, onClick: () => void createFolder(folder.moduleId, folder.id) },
      { label: 'Umbenennen', icon: <Pencil />, onClick: () => void renameFolder(folder) },
      { separator: true },
      { label: 'Ordner löschen', icon: <Trash2 />, danger: true, onClick: () => void deleteFolder(folder) },
    ])

  return (
    <div className="page">
      <div className="page-inner">
        <div className="folder-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="page-title">{folder.name}</h1>
            <div className="module-meta">
              {module && (
                <span>
                  <span className={`dot color-${module.color}`} /> {module.name}
                </span>
              )}
              {isSession && <span>{SESSION_LABELS[folder.sessionKind!]}</span>}
              {folder.date && <span>{formatLongDay(folder.date)}</span>}
              {isSession && (
                <span>
                  <MapPin />
                  <input
                    className="input-bare room-input"
                    value={room}
                    placeholder="Raum"
                    aria-label="Raum"
                    onChange={(e) => setRoom(e.target.value)}
                    onBlur={() => room !== folder.room && putRecord('folders', { ...folder, room })}
                  />
                </span>
              )}
              {folder.sessionKind === 'lab' && (
                <button type="button" className="lab-state" onClick={() => putRecord('folders', { ...folder, done: !folder.done })}>
                  {folder.done ? <CheckCircle2 color="var(--success)" /> : <Circle />}
                  {folder.done ? 'Bestanden' : 'Offen'}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="folder-actions">
          <Button icon={<FilePlus />} onClick={(e) => void createNote(folder.moduleId, folder.id, e)}>
            Neue Notiz
          </Button>
          <Button icon={<Upload />} onClick={() => void pickFiles().then((f) => uploadFiles(folder.moduleId, folder.id, f))}>
            Hochladen
          </Button>
          {db.settings.ai.enabled && (
            <>
              <Button icon={<ScrollText />} onClick={() => void summarizeFolder(folder)} disabled={items.length === 0}>
                Zusammenfassen
              </Button>
              <Button icon={<MessageCircle />} onClick={() => openInNewPane({ type: 'chat', folderId: folder.id })}>
                Fragen
              </Button>
            </>
          )}
          <span className="spacer" />
          <IconButton label="Mehr" onClick={more}>
            <MoreHorizontal />
          </IconButton>
        </div>

        <FolderContents moduleId={folder.moduleId} folderId={folder.id} folders={folders} items={items} />
      </div>
    </div>
  )
}
