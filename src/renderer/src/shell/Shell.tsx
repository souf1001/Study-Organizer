import { useEffect } from 'react'
import { createNote } from '@/lib/actions'
import { getDb } from '@/lib/db'
import { useWorkspace } from '@/lib/workspace'
import { toast } from '@/ui/Toast'
import { CommandPalette, usePalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { Workspace } from './Workspace'

/** Modul/Ordner der aktiven Ansicht – dort landen neue Notizen */
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
      const ws = useWorkspace.getState()
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        usePalette.getState().show()
      } else if (key === '\\') {
        e.preventDefault()
        ws.toggleSidebar()
      } else if (key === ',') {
        e.preventDefault()
        ws.open({ type: 'settings' })
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault()
        const context = currentContext()
        if (context) void createNote(context.moduleId, context.folderId)
        else toast('Öffne zuerst ein Modul oder einen Ordner.')
      } else if (key === '[' || key === ']') {
        e.preventDefault()
        if (key === '[') ws.back(ws.activeId)
        else ws.forward(ws.activeId)
      } else if (/^[1-4]$/.test(key)) {
        const pane = ws.panes[Number(key) - 1]
        if (pane) {
          e.preventDefault()
          ws.focus(pane.id)
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
