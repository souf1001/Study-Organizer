// Bottom navigation on phones: the main areas, reachable with one thumb.
import type { ReactNode } from 'react'
import { BookOpen, Bot, Calendar, CheckSquare, Home } from 'lucide-react'
import { useWorkspace, type View } from '@/lib/workspace'

interface NavEntry {
  label: string
  icon: ReactNode
  /** Opens this view; without one the entry toggles the module drawer */
  view?: View
}

const ENTRIES: NavEntry[] = [
  { label: 'Heute', icon: <Home />, view: { type: 'home' } },
  { label: 'Module', icon: <BookOpen /> },
  { label: 'Kalender', icon: <Calendar />, view: { type: 'calendar' } },
  { label: 'Aufgaben', icon: <CheckSquare />, view: { type: 'tasks' } },
  { label: 'KI-Chat', icon: <Bot />, view: { type: 'chat' } },
]

/** Views that belong to the module tree in the drawer */
const MODULE_VIEWS = new Set<View['type']>(['module', 'folder', 'item'])

export function MobileNav() {
  const { panes, activeId, open, sidebarOpen, toggleSidebar } = useWorkspace()
  const currentType = panes.find((p) => p.id === activeId)?.view.type

  const isActive = ({ view }: NavEntry) =>
    view
      ? !sidebarOpen && currentType === view.type
      : sidebarOpen || (currentType !== undefined && MODULE_VIEWS.has(currentType))

  const select = ({ view }: NavEntry) => {
    if (!view) return toggleSidebar()
    if (sidebarOpen) toggleSidebar()
    open(view)
  }

  return (
    <nav className="mobile-bottom-nav" aria-label="Navigation">
      {ENTRIES.map((entry) => {
        const active = isActive(entry)
        return (
          <button
            key={entry.label}
            type="button"
            className={`mobile-nav-item ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => select(entry)}
          >
            {entry.icon}
            <span>{entry.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
