import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { api } from '@/lib/api'
import { loadDb, useDbStore } from '@/lib/db'
import { DialogHost } from '@/ui/Dialogs'
import { MenuHost } from '@/ui/Menu'
import { ToastHost } from '@/ui/Toast'
import { Shell } from '@/shell/Shell'
import { Onboarding } from '@/views/onboarding/Onboarding'
import { AiTaskHost } from '@/views/chat/AiTaskHost'

function useSystemDark(): boolean {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(query.matches)
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])
  return dark
}

/** Überträgt die Darstellungs-Einstellungen auf das Dokument */
function useAppearance(appearance: Settings['appearance'] | undefined): void {
  const systemDark = useSystemDark()
  useEffect(() => {
    if (!appearance) return
    const root = document.documentElement
    const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && systemDark)
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.accent = appearance.accent
    root.dataset.compact = String(appearance.compact)
    root.dataset.reduceMotion = String(appearance.reduceMotion)
    document.getElementById('root')!.style.zoom = String(appearance.zoom)
  }, [appearance, systemDark])
}

export function App() {
  const db = useDbStore((s) => s.db)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadDb().catch((e: Error) => setError(e.message))
    return api.onChange(() => void loadDb())
  }, [])

  useAppearance(db?.settings.appearance)

  if (error) return <div className="empty">Daten konnten nicht geladen werden: {error}</div>
  if (!db) return <div className="boot" />
  return (
    <>
      {db.onboarded ? <Shell /> : <Onboarding />}
      <MenuHost />
      <AiTaskHost />
      <DialogHost />
      <ToastHost />
    </>
  )
}
