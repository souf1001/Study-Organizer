// Web-Version: Konto, Speicherplatz, Passwort, Abmelden, Konto löschen.
import { useEffect, useState } from 'react'
import { LogOut, Trash2 } from 'lucide-react'
import { account } from '@/lib/web-api'
import { formatSize } from '@/lib/format'
import { Button } from '@/ui/Button'
import { prompt } from '@/ui/Dialogs'
import { Input } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'
import { SettingGroup, SettingRow } from './SettingsView'

export function AccountSettings() {
  const [usage, setUsage] = useState<{ used: number; quota: number; email: string } | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')

  useEffect(() => {
    account.usage().then(setUsage).catch(toastError)
  }, [])

  const percent = usage ? Math.min(100, Math.round((usage.used / usage.quota) * 100)) : 0

  const changePassword = async () => {
    try {
      await account.changePassword(current, next)
      setCurrent('')
      setNext('')
      toast('Passwort geändert. Andere Geräte wurden abgemeldet.')
    } catch (error) {
      toastError(error)
    }
  }

  const logout = async () => {
    await account.logout().catch(() => undefined)
    window.location.reload()
  }

  const deleteAccount = async () => {
    const password = await prompt({ title: 'Konto endgültig löschen?', label: 'Passwort zur Bestätigung', placeholder: 'Passwort', confirmLabel: 'Konto löschen' })
    if (!password) return
    try {
      await account.deleteAccount(password)
      window.location.reload()
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <>
      <SettingGroup title="Konto">
        <SettingRow label="E-Mail">
          <span className="muted">{usage?.email ?? '…'}</span>
        </SettingRow>
        <SettingRow
          label="Speicherplatz"
          description={usage ? `${formatSize(usage.used) || '0 B'} von ${formatSize(usage.quota)} belegt` : 'Wird berechnet …'}
          stacked
        >
          <div className={`progress ${percent > 90 ? 'progress-full' : ''}`}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </SettingRow>
        <SettingRow label="Abmelden">
          <Button icon={<LogOut />} onClick={() => void logout()}>
            Abmelden
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Passwort ändern">
        <SettingRow label="Neues Passwort" description="Mindestens 10 Zeichen. Danach werden alle anderen Geräte abgemeldet." stacked>
          <div className="inline-form">
            <div className="row">
              <Input type="password" value={current} placeholder="Aktuelles Passwort" autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
              <Input type="password" value={next} placeholder="Neues Passwort" autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
              <Button disabled={!current || next.length < 10} onClick={() => void changePassword()}>
                Ändern
              </Button>
            </div>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Gefahrenzone">
        <SettingRow label="Konto löschen" description="Löscht dein Konto und alle Daten auf dem Server unwiderruflich. Lade vorher einen Export herunter.">
          <Button variant="danger" icon={<Trash2 />} onClick={() => void deleteAccount()}>
            Konto löschen
          </Button>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
