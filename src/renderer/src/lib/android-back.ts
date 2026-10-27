import { useWorkspace } from './workspace'
import { detectDevice } from './device'

declare global {
  interface Window {
    __onAndroidBack?: () => boolean
    __menuClose?: () => void
    __dialogClose?: () => void
  }
}

export function setupAndroidBackButton(): () => void {
  const handleBack = (): boolean => {
    // 1. Schließe offenes Kontext- oder Dropdown-Menü, falls vorhanden
    if (typeof window !== 'undefined' && typeof window.__menuClose === 'function') {
      window.__menuClose()
      return true
    }

    // 2. Schließe Dialog/Modal, falls offen
    if (typeof window !== 'undefined' && typeof window.__dialogClose === 'function') {
      window.__dialogClose()
      return true
    }

    // 3. Schließe die mobile Seitenleiste (Drawer), falls auf Phone geöffnet
    const ws = useWorkspace.getState()
    const { isPhone } = detectDevice()
    if (isPhone && ws.sidebarOpen) {
      ws.toggleSidebar()
      return true
    }

    // 4. Navigiere im aktiven Bereich zurück, falls Verlauf existiert
    const activePane = ws.panes.find((p) => p.id === ws.activeId)
    if (activePane && activePane.back.length > 0) {
      ws.back(ws.activeId)
      return true
    }

    // 5. Nichts zum Schließen oder Zurücknavigieren vorhanden -> Android-System übernimmt (App minimieren/beenden)
    return false
  }

  if (typeof window !== 'undefined') {
    window.__onAndroidBack = handleBack
    window.addEventListener('androidbackbutton', (e) => {
      if (handleBack()) {
        e.preventDefault()
      }
    })
  }

  return () => {
    if (typeof window !== 'undefined') {
      delete window.__onAndroidBack
    }
  }
}
