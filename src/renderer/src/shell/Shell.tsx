import { useEffect } from 'react'
import { createNote } from '@/lib/actions'
import { getDb } from '@/lib/db'
import { useWorkspace } from '@/lib/workspace'
import { toast } from '@/ui/Toast'
import { CommandPalette, usePalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { Workspace } from './Workspace'

/** Module/folder of the active view, which is where new notes are created. */
function currentContext(): { moduleId: string; folderId: string | null } | null {
  const { panes, activeId } = useWorkspace.getState()
  const view = panes.find((p) => p.id === activeId)?.view
  const db = getDb()
  if (view?.type === 'module') return { moduleId: view.id, folderId: null }
  if (view?.type === 'folder') {
    const folder = db.folders.find((f) => f.id === view.id)
    return folder ? { moduleId: folder.moduleId, folderId: folder.id } : null
  }
  if (view?.type === 'item') {
    const item = db.items.find((i) => i.id === view.id)
    return item ? { moduleId: item.moduleId, folderId: item.folderId } : null
  }
  return null
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const workspace = useWorkspace.getState()
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        usePalette.getState().show()
      } else if (key === '\\') {
        e.preventDefault()
        workspace.toggleSidebar()
      } else if (key === ',') {
        e.preventDefault()
        workspace.open({ type: 'settings' })
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault()
        const context = currentContext()
        if (context) void createNote(context.moduleId, context.folderId)
        else toast('Öffne zuerst ein Modul oder einen Ordner.')
      } else if (key === '[' || key === ']') {
        e.preventDefault()
        if (key === '[') workspace.back(workspace.activeId)
        else workspace.forward(workspace.activeId)
      } else if (/^[1-4]$/.test(key)) {
        const pane = workspace.panes[Number(key) - 1]
        if (pane) {
          e.preventDefault()
          workspace.focus(pane.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function Shell() {
  const sidebarOpen = useWorkspace((s) => s.sidebarOpen)
  useShortcuts()
  return (
    <div className={`shell ${sidebarOpen ? '' : 'sidebar-closed'}`}>
      {sidebarOpen && <Sidebar />}
      <Workspace />
      <CommandPalette />
    </div>
  )
}
