// Mobile Bottom-Navigation für Smartphones.
// Ermöglicht einhändige Bedienung der 5 Kernbereiche.
import { BookOpen, Bot, Calendar, CheckSquare, Home } from 'lucide-react'
import { useWorkspace } from '@/lib/workspace'

export function MobileNav() {
  const { panes, activeId, open, sidebarOpen, toggleSidebar } = useWorkspace()
  const activePane = panes.find((p) => p.id === activeId)
  const currentViewType = activePane?.view.type

  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile Navigation">
      <button
        type="button"
        className={`mobile-nav-item ${currentViewType === 'home' && !sidebarOpen ? 'active' : ''}`}
        onClick={() => {
          if (sidebarOpen) toggleSidebar()
          open({ type: 'home' })
        }}
      >
        <Home />
        <span>Heute</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${sidebarOpen || currentViewType === 'module' || currentViewType === 'folder' || currentViewType === 'item' ? 'active' : ''}`}
        onClick={() => toggleSidebar()}
      >
        <BookOpen />
        <span>Module</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${currentViewType === 'calendar' && !sidebarOpen ? 'active' : ''}`}
        onClick={() => {
          if (sidebarOpen) toggleSidebar()
          open({ type: 'calendar' })
        }}
      >
        <Calendar />
        <span>Kalender</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${currentViewType === 'tasks' && !sidebarOpen ? 'active' : ''}`}
        onClick={() => {
          if (sidebarOpen) toggleSidebar()
          open({ type: 'tasks' })
        }}
      >
        <CheckSquare />
        <span>Aufgaben</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${currentViewType === 'chat' && !sidebarOpen ? 'active' : ''}`}
        onClick={() => {
          if (sidebarOpen) toggleSidebar()
          open({ type: 'chat' })
        }}
      >
        <Bot />
        <span>KI-Chat</span>
      </button>
    </nav>
  )
}
