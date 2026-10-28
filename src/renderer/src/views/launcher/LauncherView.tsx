import { useState } from 'react'
import {
  BookOpen,
  CalendarDays,
  CheckSquare,
  Home,
  MessageCircle,
  Plus,
  Search,
  Settings as SettingsIcon,
  User,
} from 'lucide-react'
import type { Module } from '@shared/types'
import { activeSemester, semesterModules } from '@/lib/actions'
import { useDb } from '@/lib/db'
import { modKey } from '@/lib/format'
import { useWorkspace, type View } from '@/lib/workspace'
import { usePalette } from '@/shell/CommandPalette'
import { Button } from '@/ui/Button'
import { ModuleDialog } from '@/views/module/ModuleDialog'
import './launcher.css'

export function LauncherView({ paneId }: { paneId: string }) {
  const db = useDb()
  const { replace } = useWorkspace.getState()
  const openPalette = usePalette((s) => s.show)
  const [moduleDialog, setModuleDialog] = useState(false)

  const semester = activeSemester(db)
  const modules = semesterModules(db, semester?.id)

  // Replace the launcher in place instead of pushing it onto the pane history.
  const navigate = (view: View) => replace(paneId, view)

  const quickLinks: {
    label: string
    icon: React.ReactNode
    view?: View
    action?: () => void
    kbd?: string
  }[] = [
    {
      label: 'Suchen',
      icon: <Search />,
      action: openPalette,
      kbd: `${modKey} K`,
    },
    {
      label: 'Heute',
      icon: <Home />,
      view: { type: 'home' },
    },
    {
      label: 'Kalender',
      icon: <CalendarDays />,
      view: { type: 'calendar' },
    },
    {
      label: 'Aufgaben',
      icon: <CheckSquare />,
      view: { type: 'tasks' },
    },
    ...(db.settings.ai.enabled
      ? [
          {
            label: 'KI-Chat',
            icon: <MessageCircle />,
            view: { type: 'chat' as const },
          },
        ]
      : []),
    {
      label: 'Einstellungen',
      icon: <SettingsIcon />,
      view: { type: 'settings' },
    },
  ]

  return (
    <div className="page launcher-page">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <div className="launcher-header">
          <h1 className="page-title">Neuer Bereich</h1>
          <p className="page-desc">Wähle eine Ansicht oder ein Modul, um hier weiterzuarbeiten.</p>
        </div>

        <div className="launcher-section">
          <h2 className="section-title">Hauptfunktionen</h2>
          <div className="launcher-grid">
            {quickLinks.map((link, idx) => (
              <button
                key={idx}
                type="button"
                className="launcher-tile"
                onClick={() => {
                  if (link.action) link.action()
                  else if (link.view) navigate(link.view)
                }}
              >
                <div className="launcher-tile-icon">{link.icon}</div>
                <span className="launcher-tile-title">{link.label}</span>
                {link.kbd && <span className="kbd small">{link.kbd}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="launcher-section" style={{ marginTop: 28 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              Module {semester ? `(${semester.name})` : ''}
            </h2>
            <Button size="sm" icon={<Plus />} onClick={() => setModuleDialog(true)}>
              Modul anlegen
            </Button>
          </div>

          <div className="launcher-modules-grid">
            {modules.map((m: Module) => (
              <button
                key={m.id}
                type="button"
                className="launcher-module-card"
                onClick={() => navigate({ type: 'module', id: m.id })}
              >
                <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                  <div
                    className={`module-badge color-${m.color}`}
                    style={{ width: 34, height: 34, fontSize: 13 }}
                  >
                    {(m.code || m.name).slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div className="launcher-module-name">{m.name}</div>
                    <div className="launcher-module-meta">
                      {m.code && (
                        <span>
                          <BookOpen size={11} /> {m.code}
                        </span>
                      )}
                      {m.lecturer && (
                        <span>
                          <User size={11} /> {m.lecturer}
                        </span>
                      )}
                      {m.ects !== null && <span>{m.ects} ECTS</span>}
                    </div>
                  </div>
                </div>
              </button>
            ))}

            {modules.length === 0 && (
              <div className="small muted" style={{ gridColumn: '1 / -1', padding: '16px 0' }}>
                Noch keine Module für dieses Semester angelegt.
              </div>
            )}
          </div>
        </div>

        {moduleDialog && semester && (
          <ModuleDialog semester={semester} onClose={() => setModuleDialog(false)} />
        )}
      </div>
    </div>
  )
}
