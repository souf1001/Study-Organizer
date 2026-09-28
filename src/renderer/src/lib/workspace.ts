// Arbeitsfläche: bis zu 4 Bereiche (Split-Screen), jeder mit eigener Ansicht und Verlauf.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ID } from '@shared/types'
import { toast } from '@/ui/Toast'

export type ModuleTab = 'overview' | 'sessions' | 'lab' | 'files' | 'tasks'

export type View =
  | { type: 'home' }
  | { type: 'calendar' }
  | { type: 'tasks' }
  | { type: 'chat'; itemIds?: ID[]; folderId?: ID; moduleId?: ID }
  | { type: 'module'; id: ID; tab?: ModuleTab }
  | { type: 'folder'; id: ID }
  | { type: 'item'; id: ID }
  | { type: 'settings'; section?: string }

export interface Pane {
  id: string
  view: View
  back: View[]
  forward: View[]
}

export const MAX_PANES = 4
const HISTORY_LIMIT = 50

interface WorkspaceState {
  panes: Pane[]
  activeId: string
  sidebarOpen: boolean
  open: (view: View, options?: { newPane?: boolean; paneId?: string }) => void
  replace: (paneId: string, view: View) => void
  close: (paneId: string) => void
  focus: (paneId: string) => void
  back: (paneId: string) => void
  forward: (paneId: string) => void
  toggleSidebar: () => void
}

const newPane = (view: View): Pane => ({ id: crypto.randomUUID(), view, back: [], forward: [] })
const sameView = (a: View, b: View): boolean => JSON.stringify(a) === JSON.stringify(b)

const first = newPane({ type: 'home' })

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => {
      const updatePane = (paneId: string, fn: (p: Pane) => Pane) =>
        set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? fn(p) : p)) }))

      return {
        panes: [first],
        activeId: first.id,
        sidebarOpen: true,

        open(view, options = {}) {
          const { panes, activeId } = get()
          if (options.newPane) {
            const existing = panes.find((p) => sameView(p.view, view))
            if (existing) return set({ activeId: existing.id })
            if (panes.length >= MAX_PANES) {
              toast(`Es passen höchstens ${MAX_PANES} Bereiche nebeneinander.`)
            } else {
              const pane = newPane(view)
              return set({ panes: [...panes, pane], activeId: pane.id })
            }
          }
          const target = options.paneId ?? activeId
          updatePane(target, (p) =>
            sameView(p.view, view)
              ? p
              : { ...p, view, back: [...p.back, p.view].slice(-HISTORY_LIMIT), forward: [] },
          )
          set({ activeId: target })
        },

        replace(paneId, view) {
          updatePane(paneId, (p) => ({ ...p, view }))
        },

        close(paneId) {
          const { panes, activeId } = get()
          if (panes.length === 1) {
            const home = newPane({ type: 'home' })
            return set({ panes: [home], activeId: home.id })
          }
          const index = panes.findIndex((p) => p.id === paneId)
          const rest = panes.filter((p) => p.id !== paneId)
          set({ panes: rest, activeId: activeId === paneId ? rest[Math.max(0, index - 1)].id : activeId })
        },

        focus(paneId) {
          if (get().activeId !== paneId) set({ activeId: paneId })
        },

        back(paneId) {
          updatePane(paneId, (p) =>
            p.back.length
              ? { ...p, view: p.back[p.back.length - 1], back: p.back.slice(0, -1), forward: [p.view, ...p.forward] }
              : p,
          )
        },

        forward(paneId) {
          updatePane(paneId, (p) =>
            p.forward.length
              ? { ...p, view: p.forward[0], forward: p.forward.slice(1), back: [...p.back, p.view] }
              : p,
          )
        },

        toggleSidebar() {
          set((s) => ({ sidebarOpen: !s.sidebarOpen }))
        },
      }
    },
    {
      name: 'study-organizer-workspace',
      partialize: (s) => ({ panes: s.panes, activeId: s.activeId, sidebarOpen: s.sidebarOpen }),
    },
  ),
)

/** Ansicht öffnen – mit gedrückter Cmd/Strg-Taste in einem neuen Bereich */
export function openView(view: View, event?: { metaKey: boolean; ctrlKey: boolean }): void {
  useWorkspace.getState().open(view, { newPane: Boolean(event?.metaKey || event?.ctrlKey) })
}

export function openInNewPane(view: View): void {
  useWorkspace.getState().open(view, { newPane: true })
}

/** Datentyp für Drag & Drop von Einträgen in einen Bereich */
export const DRAG_VIEW_TYPE = 'application/x-study-view'
