// Bottom navigation on phones: the five main areas, reachable with one thumb.
import type { ReactNode } from 'react'
import { BookOpen, Bot, Calendar, CheckSquare, Home } from 'lucide-react'
import { useWorkspace, type View } from '@/lib/workspace'

const DESTINATIONS: { view: View; label: string; icon: ReactNode }[] = [
  { view: { type: 'home' }, label: 'Heute', icon: <Home /> },
  { view: { type: 'calendar' }, label: 'Kalender', icon: <Calendar /> },
  { view: { type: 'tasks' }, label: 'Aufgaben', icon: <CheckSquare /> },
  { view: { type: 'chat' }, label: 'KI-Chat', icon: <Bot /> },
]

/** Views that belong to the module tree, which lives in the sidebar drawer */
const MODULE_VIEWS = new Set<View['type']>(['module', 'folder', 'item'])

export function MobileNav() {
  const { panes, activeId, open, sidebarOpen, toggleSidebar } = useWorkspace()
  const currentType = panes.find((p) => p.id === activeId)?.view.type

  const navigate = (view: View) => {
    if (sidebarOpen) toggleSidebar()
    open(view)
  }

  const item = (
    key: string,
    label: string,
    icon: ReactNode,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className={`mobile-nav-item ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  const [home, ...rest] = DESTINATIONS
  const destination = (d: (typeof DESTINATIONS)[number]) =>
    item(d.view.type, d.label, d.icon, currentType === d.view.type && !sidebarOpen, () =>
      navigate(d.view),
    )

  return (
    <nav className="mobile-bottom-nav" aria-label="Navigation">
      {destination(home)}
      {item(
        'modules',
        'Module',
        <BookOpen />,
        sidebarOpen || (currentType !== undefined && MODULE_VIEWS.has(currentType)),
        toggleSidebar,
      )}
      {rest.map(destination)}
    </nav>
  )
}
