import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { api, isWeb } from '@/lib/api'
import { account } from '@/lib/web-api'
import { AuthScreen } from '@/views/auth/AuthScreen'
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

type Session = { state: 'checking' } | { state: 'anonymous'; allowRegistration: boolean } | { state: 'ready' }

export function App() {
  const db = useDbStore((s) => s.db)
  const [error, setError] = useState<string | null>(null)
  // Desktop: keine Anmeldung. Web: erst prüfen, ob eine Sitzung besteht.
  const [session, setSession] = useState<Session>(isWeb ? { state: 'checking' } : { state: 'ready' })

  useEffect(() => {
    if (!isWeb) return
    const check = () =>
      account
        .status()
        .then(({ user, allowRegistration }) => {
          if (user) return setSession({ state: 'ready' })
          useDbStore.setState({ db: null })
          setSession({ state: 'anonymous', allowRegistration })
        })
        .catch((e: Error) => setError(e.message))
    void check()
    // Sitzung abgelaufen oder beendet: zurück zur Anmeldung
    const onLoggedOut = () => void check()
    window.addEventListener('study:logged-out', onLoggedOut)
    return () => window.removeEventListener('study:logged-out', onLoggedOut)
  }, [])

  useEffect(() => {
    if (session.state !== 'ready') return
    loadDb().catch((e: Error) => setError(e.message))
    return api.onChange(() => void loadDb())
  }, [session.state])

  useAppearance(db?.settings.appearance)

  if (error) return <div className="empty">Daten konnten nicht geladen werden: {error}</div>
  if (session.state === 'anonymous') {
    return <AuthScreen allowRegistration={session.allowRegistration} onDone={() => setSession({ state: 'ready' })} />
  }
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
