// Moving the setup to another device: export on the source (e.g. the desktop PC), import on the
// target (e.g. an Android tablet). Used in the settings and during onboarding.
import { useState } from 'react'
import { FileDown, FileUp } from 'lucide-react'
import {
  SETUP_FILE_EXTENSION,
  openSetupFile,
  summarizeSetupFile,
  type SetupImportResult,
  type SetupScope,
} from '@shared/setup-bundle'
import { api } from '@/lib/api'
import { pickFiles } from '@/lib/actions'
import { getDb, loadDb } from '@/lib/db'
import { Button } from '@/ui/Button'
import { confirm } from '@/ui/Dialogs'
import { Field, Input, Segmented, Switch } from '@/ui/Field'
import { Modal } from '@/ui/Modal'
import { toast, toastError } from '@/ui/Toast'
import { SettingGroup, SettingRow } from './SettingsView'

const SCOPE_OPTIONS: { value: SetupScope; label: string }[] = [
  { value: 'settings', label: 'Einstellungen' },
  { value: 'study', label: '+ Studium' },
  { value: 'everything', label: '+ Notizen & Dateien' },
]

const SCOPE_DESCRIPTIONS: Record<SetupScope, string> = {
  settings:
    'Profil, Einstellungen, Moodle-Verbindung, KI und Kalender-Abos. Daten auf dem Zielgerät bleiben erhalten.',
  study:
    'Zusätzlich Semester, Module, Ordner, Kalender (z. B. aus TUCaN), Aufgaben, Chats und Moodle-Foren. Ersetzt die Daten auf dem Zielgerät.',
  everything:
    'Zusätzlich alle Notizen, Markierungen und Dateien. Die Datei kann groß werden. Ersetzt die Daten auf dem Zielgerät.',
}

function describeImport(result: SetupImportResult): string {
  const parts = [`${result.credentials} Zugangsdaten`]
  if (result.scope !== 'settings')
    parts.push(`${result.modules} Module`, `${result.events} Termine`)
  if (result.scope === 'everything') parts.push(`${result.items} Notizen & Dateien`)
  return `Einrichtung übernommen: ${parts.join(', ')}`
}

function ExportSection() {
  const [scope, setScope] = useState<SetupScope>('settings')
  const [includeCredentials, setIncludeCredentials] = useState(true)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const runExport = async () => {
    if (includeCredentials && !password) {
      const ok = await confirm({
        title: 'Ohne Passwort exportieren?',
        message:
          'Die Datei enthält dann deinen Moodle-Zugang, KI-Keys und Kalender-Adressen im Klartext. Jeder, der die Datei bekommt, kann sie nutzen.',
        confirmLabel: 'Trotzdem exportieren',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const target = await api.setup.export({
        scope,
        includeCredentials,
        password: password || undefined,
      })
      if (target) toast(`Einrichtung gespeichert: ${target}`)
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingGroup title="Auf ein anderes Gerät übertragen">
      <SettingRow label="Umfang" description={SCOPE_DESCRIPTIONS[scope]} stacked>
        <Segmented value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
      </SettingRow>
      <SettingRow
        label="Zugangsdaten mitnehmen"
        description="Moodle-Anmeldung, KI-Keys und private Kalender-Adressen. So musst du dich auf dem Tablet nicht neu anmelden."
      >
        <Switch
          checked={includeCredentials}
          onChange={setIncludeCredentials}
          label="Zugangsdaten mitnehmen"
        />
      </SettingRow>
      <SettingRow
        label="Passwort"
        description="Verschlüsselt die Datei. Du brauchst es beim Import auf dem anderen Gerät."
      >
        <Input
          type="password"
          value={password}
          placeholder="Empfohlen"
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        label="Einrichtungsdatei erstellen"
        description={`Speichert eine ${SETUP_FILE_EXTENSION}-Datei, z. B. auf einen USB-Stick oder in die Cloud.`}
      >
        <Button
          variant="primary"
          icon={<FileDown />}
          disabled={busy}
          onClick={() => void runExport()}
        >
          {busy ? 'Exportiere …' : 'Exportieren'}
        </Button>
      </SettingRow>
    </SettingGroup>
  )
}

/** Asks for the password of an encrypted setup file */
function PasswordDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (password: string) => void
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const submit = () => password && onSubmit(password)
  return (
    <Modal
      title="Passwort der Einrichtungsdatei"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!password} onClick={submit}>
            Importieren
          </Button>
        </>
      }
    >
      <Field label="Passwort">
        <Input
          type="password"
          autoFocus
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </Field>
    </Modal>
  )
}

/**
 * Button that picks a setup file, asks for its password if needed and applies it.
 * `onImported` runs after the data was reloaded.
 */
export function SetupImportButton({
  onImported,
  label = 'Datei wählen',
}: {
  onImported?: () => void
  label?: string
}) {
  const [pendingFile, setPendingFile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = async (content: string, password?: string) => {
    setBusy(true)
    try {
      const result = await api.setup.import(content, password)
      await loadDb()
      toast(describeImport(result))
      onImported?.()
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  /** Files with study data replace everything; ask first unless this device is still empty */
  const confirmAndApply = async (content: string, scope: SetupScope, password?: string) => {
    const { modules, items } = getDb()
    const hasLocalData = modules.length > 0 || items.length > 0
    if (scope !== 'settings' && hasLocalData) {
      const ok = await confirm({
        title: 'Daten auf diesem Gerät ersetzen?',
        message:
          'Die Datei enthält Studiendaten. Alle Module, Termine und Notizen auf diesem Gerät werden durch den Inhalt der Datei ersetzt.',
        confirmLabel: 'Ersetzen',
        danger: true,
      })
      if (!ok) return
    }
    await apply(content, password)
  }

  const choose = async () => {
    const [file] = await pickFiles(`${SETUP_FILE_EXTENSION},application/json,.json`)
    if (!file) return
    try {
      const content = await file.text()
      const summary = summarizeSetupFile(content)
      if (summary.scope) await confirmAndApply(content, summary.scope)
      else setPendingFile(content)
    } catch (error) {
      toastError(error)
    }
  }

  const unlock = async (content: string, password: string) => {
    try {
      // Decrypting here first tells us the scope and catches a wrong password early
      const { scope } = await openSetupFile(content, password)
      setPendingFile(null)
      await confirmAndApply(content, scope, password)
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <>
      <Button icon={<FileUp />} disabled={busy} onClick={() => void choose()}>
        {busy ? 'Importiere …' : label}
      </Button>
      {pendingFile && (
        <PasswordDialog
          onClose={() => setPendingFile(null)}
          onSubmit={(password) => void unlock(pendingFile, password)}
        />
      )}
    </>
  )
}

export function SetupTransferSettings() {
  return (
    <>
      <ExportSection />
      <SettingGroup title="Von einem anderen Gerät übernehmen">
        <SettingRow
          label="Einrichtungsdatei importieren"
          description="Übernimmt Einstellungen, Anbindungen und – je nach Datei – alle Studiendaten von einem anderen Gerät."
        >
          <SetupImportButton />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
