// Web-Version: Anmelden oder Konto erstellen.
import { useState, type FormEvent } from 'react'
import { account, type WebUser } from '@/lib/web-api'
import { Button } from '@/ui/Button'
import { Field, Input, Segmented } from '@/ui/Field'
import '../onboarding/onboarding.css'
import './auth.css'

export function AuthScreen({ allowRegistration, onDone }: { allowRegistration: boolean; onDone: (user: WebUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { user } = mode === 'login' ? await account.login(email, password) : await account.register(email, password, name)
      onDone(user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onboarding">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <div className="onb-logo" aria-hidden>
          <svg viewBox="0 0 32 32" width="40" height="40">
            <rect x="5" y="4" width="18" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M10 11h8M10 16h8M10 21h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M26 9v18" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </div>
        <h1 className="onb-title">Study Organizer</h1>
        <p className="onb-subtitle">{mode === 'login' ? 'Melde dich mit deinem Konto an.' : 'Erstelle ein kostenloses Konto.'}</p>

        {allowRegistration && (
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m)
              setError(null)
            }}
            options={[
              { value: 'login', label: 'Anmelden' },
              { value: 'register', label: 'Registrieren' },
            ]}
          />
        )}

        <div className="auth-fields">
          {mode === 'register' && (
            <Field label="Vorname">
              <Input value={name} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label="E-Mail">
            <Input type="email" value={email} autoComplete="email" required autoFocus onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Passwort" hint={mode === 'register' ? 'Mindestens 10 Zeichen.' : undefined}>
            <Input
              type="password"
              value={password}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 10 : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>

        {error && <p className="auth-error small">{error}</p>}

        <Button type="submit" variant="primary" size="lg" disabled={busy || !email || !password}>
          {mode === 'login' ? 'Anmelden' : 'Konto erstellen'}
        </Button>
      </form>
    </div>
  )
}
