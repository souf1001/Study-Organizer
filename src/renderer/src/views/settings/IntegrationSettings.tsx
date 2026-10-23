// Moodle-Anbindung und Kalender-Abos (Moodle, my h_da/HISinOne, Stud.IP, ILIAS, OBS …).
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CalendarSync,
  FileUp,
  Link2,
  LogIn,
  RefreshCw,
  Trash2,
  Unplug,
} from 'lucide-react'
import { newModule } from '@shared/defaults'
import type { MoodleCourse, MoodleSiteInfo, Subscription } from '@shared/types'
import { api } from '@/lib/api'
import { activeSemester, pickFiles, semesterModules } from '@/lib/actions'
import { loadDb, putRecord, updateSettings, useDb } from '@/lib/db'
import { formatDateTime } from '@/lib/format'
import { Button, IconButton } from '@/ui/Button'
import { confirm } from '@/ui/Dialogs'
import { Input, Select, Switch } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'
import { SettingGroup, SettingRow } from './SettingsView'

function MoodleConnect({ onCourses }: { onCourses: (c: MoodleCourse[]) => void }) {
  const [url, setUrl] = useState('')
  const [info, setInfo] = useState<MoodleSiteInfo | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (task: () => Promise<MoodleCourse[]>) => {
    setBusy(true)
    try {
      onCourses(await task())
      await loadDb()
      toast('Moodle verbunden')
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  const check = async () => {
    setBusy(true)
    try {
      setInfo(await api.moodle.siteInfo(url))
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  if (!info) {
    return (
      <SettingRow label="Moodle-Adresse" description="Z. B. lernen.h-da.de (Hochschule Darmstadt) oder moodle.tu-darmstadt.de">
        <div className="row">
          <Input value={url} placeholder="moodle.meine-hochschule.de" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void check()} />
          <Button onClick={() => void check()} disabled={!url.trim() || busy}>
            Weiter
          </Button>
        </div>
      </SettingRow>
    )
  }

  return (
    <>
      <SettingRow label={info.siteName} description={info.url}>
        <Button variant="ghost" onClick={() => setInfo(null)}>Ändern</Button>
      </SettingRow>
      {info.ssoRequired && api.moodle.connectSso ? (
        <SettingRow label="Mit Hochschul-Login anmelden" description="Es öffnet sich das Anmeldefenster deiner Hochschule. Dein Passwort wird nicht gespeichert.">
          <Button variant="primary" icon={<LogIn />} disabled={busy} onClick={() => void run(() => api.moodle.connectSso!(info.url))}>
            Anmelden
          </Button>
        </SettingRow>
      ) : (
        <SettingRow label="Anmelden" description="Das Passwort wird nur einmal an Moodle geschickt und nicht gespeichert – gespeichert wird nur ein Zugangs-Token." stacked>
          <div className="inline-form">
            <div className="row">
              <Input value={username} placeholder="Benutzername" autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
              <Input value={password} placeholder="Passwort" type="password" autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
              <Button variant="primary" disabled={!username || !password || busy} onClick={() => void run(() => api.moodle.connect({ url: info.url, username, password }))}>
                Anmelden
              </Button>
            </div>
          </div>
        </SettingRow>
      )}
      <SettingRow label="Oder: Sicherheitsschlüssel" description="Falls deine Hochschule ihn freigibt: Moodle → Einstellungen → Sicherheitsschlüssel → „Moodle mobile web service“.">
        <div className="row">
          <Input value={token} placeholder="Schlüssel einfügen" type="password" onChange={(e) => setToken(e.target.value)} />
          <Button disabled={!token || busy} onClick={() => void run(() => api.moodle.connect({ url: info.url, token }))}>
            Verbinden
          </Button>
        </div>
      </SettingRow>
    </>
  )
}

function MoodleSection() {
  const db = useDb()
  const moodle = db.settings.moodle
  const connected = Boolean(moodle.url && moodle.userId !== null)
  const [courses, setCourses] = useState<MoodleCourse[]>([])
  const [syncing, setSyncing] = useState(false)
  const semester = activeSemester(db)
  const modules = semesterModules(db, semester?.id)

  useEffect(() => {
    if (connected) api.moodle.courses().then(setCourses).catch(toastError)
  }, [connected])

  const map = (courseId: number, moduleId: string) => {
    const courseMap = { ...moodle.courseMap }
    if (moduleId === '') delete courseMap[courseId]
    else if (moduleId === 'new' && semester) {
      const course = courses.find((c) => c.id === courseId)!
      const module = newModule(semester.id, { name: course.fullname, code: course.shortname })
      putRecord('modules', module)
      courseMap[courseId] = module.id
    } else courseMap[courseId] = moduleId
    updateSettings('moodle', { courseMap })
  }

  const sync = async () => {
    setSyncing(true)
    try {
      const result = await api.moodle.sync()
      await loadDb()
      if (result.errors.length) toastError(new Error(result.errors.join(' · ')))
      else toast(`Moodle: ${result.tasks} Abgaben, ${result.events} Termine, ${result.files} neue Dateien`)
    } catch (error) {
      toastError(error)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <SettingGroup title="Moodle">
      {!connected ? (
        <MoodleConnect onCourses={setCourses} />
      ) : (
        <>
          <SettingRow label={`Verbunden mit ${moodle.siteName}`} description={moodle.lastSync ? `Zuletzt abgeglichen: ${formatDateTime(moodle.lastSync)}` : 'Noch nicht abgeglichen'}>
            <div className="row">
              <Button icon={<RefreshCw />} disabled={syncing} onClick={() => void sync()}>
                {syncing ? 'Gleiche ab …' : 'Jetzt abgleichen'}
              </Button>
              <IconButton label="Verbindung trennen" onClick={() => void api.moodle.disconnect().then(loadDb)}>
                <Unplug />
              </IconButton>
            </div>
          </SettingRow>
          <SettingRow label="Kursdateien herunterladen" description="Folien und Dateien aus Moodle-Kursen landen im Modul unter „Moodle“.">
            <Switch checked={moodle.syncFiles} onChange={(syncFiles) => updateSettings('moodle', { syncFiles })} label="Kursdateien herunterladen" />
          </SettingRow>
          <SettingRow label="Kurse zuordnen" description="Abgaben, Termine und Dateien eines Kurses landen im gewählten Modul." stacked>
            <div className="inline-form">
              {courses.length === 0 && <span className="small muted">Kurse werden geladen …</span>}
              {courses.map((c) => (
                <div key={c.id} className="row">
                  <span className="truncate" style={{ flex: 1 }} title={c.fullname}>
                    {c.fullname}
                  </span>
                  <Select
                    value={moodle.courseMap[c.id] ?? ''}
                    options={[
                      { value: '', label: 'Nicht übernehmen' },
                      ...modules.map((m) => ({ value: m.id, label: m.name })),
                      { value: 'new', label: '+ Als neues Modul anlegen' },
                    ]}
                    onChange={(v) => map(c.id, v)}
                  />
                </div>
              ))}
            </div>
          </SettingRow>
        </>
      )}
    </SettingGroup>
  )
}

function isValidFeedUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  if (!/^(webcals?|https?):\/\//i.test(trimmed)) return false
  try {
    const candidate = trimmed.replace(/^webcals?:\/\//i, 'https://')
    new URL(candidate)
    return true
  } catch {
    return false
  }
}

function TucanCalendarSection() {
  const db = useDb()
  const [feedName, setFeedName] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [subBusy, setSubBusy] = useState(false)
  const [tucanBusy, setTucanBusy] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const isFormValid = feedName.trim().length > 0 && isValidFeedUrl(feedUrl)

  const handleStartTucanWizard = async () => {
    setTucanBusy(true)
    try {
      if (!api.tucan?.startWizard) {
        throw new Error('TUCaN-Assistent ist in dieser Version noch nicht verfügbar.')
      }
      const res = await api.tucan.startWizard()
      await loadDb()
      if (res.success) {
        toast(
          res.count !== undefined
            ? `${res.count} ${res.count === 1 ? 'Termin' : 'Termine'} aus TUCaN importiert`
            : 'TUCaN-Stundenplan erfolgreich importiert',
        )
      } else if (res.error && !res.error.toLowerCase().includes('abgebrochen')) {
        toastError(new Error(res.error))
      } else if (res.error && res.error.toLowerCase().includes('abgebrochen')) {
        toast('TUCaN-Assistent abgebrochen')
      }
    } catch (err) {
      toastError(err)
    } finally {
      setTucanBusy(false)
    }
  }

  const handleSubscribe = async () => {
    const name = feedName.trim()
    const url = feedUrl.trim()
    if (!name) {
      toastError(new Error('Bitte gib einen Namen für den Kalender ein.'))
      return
    }
    if (!isValidFeedUrl(url)) {
      toastError(new Error('Ungültige Kalender-URL. Erlaubte Protokolle sind webcal://, https:// oder http://.'))
      return
    }

    setSubBusy(true)
    try {
      const sub = await api.calendar.subscribe(name, url)
      await loadDb()
      setFeedName('')
      setFeedUrl('')
      if (sub.lastError) {
        toastError(new Error(`Abo angelegt, aber Synchronisation fehlgeschlagen: ${sub.lastError}`))
      } else {
        toast(`„${sub.name}“ erfolgreich abonniert`)
      }
    } catch (err) {
      toastError(err)
    } finally {
      setSubBusy(false)
    }
  }

  const handleSync = async (sub: Subscription) => {
    setSyncingId(sub.id)
    try {
      const res = await api.calendar.sync(sub.id)
      await loadDb()
      toast(`${res.count} ${res.count === 1 ? 'Termin' : 'Termine'} aktualisiert`)
    } catch (err) {
      toastError(err)
    } finally {
      setSyncingId(null)
    }
  }

  const handleRemove = async (sub: Subscription) => {
    const ok = await confirm({
      title: `„${sub.name}“ entfernen?`,
      message: 'Alle zugehörigen Termine werden aus dem Kalender gelöscht.',
      confirmLabel: 'Entfernen',
      danger: true,
    })
    if (!ok) return
    try {
      const removeFn = api.calendar.removeSubscription ?? api.calendar.unsubscribe
      if (removeFn) {
        await removeFn(sub.id)
      }
      await loadDb()
      toast(`„${sub.name}“ wurde entfernt`)
    } catch (err) {
      toastError(err)
    }
  }

  const handleImportFile = async () => {
    const [file] = await pickFiles('.ics,text/calendar')
    if (!file) return
    try {
      const result = await api.calendar.importFile(file.name, await file.text())
      await loadDb()
      toast(`${result.count} ${result.count === 1 ? 'Termin' : 'Termine'} aus „${file.name}“ importiert`)
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <>
      <SettingGroup title="TU Darmstadt (TUCaN) & Hochschul-Kalender">
        <SettingRow
          label="TUCaN Stundenplan-Assistent"
          description="Öffnet ein geführtes Browser-Fenster für TUCaN (TU Darmstadt). Melde dich an und exportiere deinen Stundenplan – der Organizer fängt den Download automatisch ab und übernimmt alle Termine."
        >
          <Button
            variant="primary"
            icon={<CalendarSync className={tucanBusy ? 'spin' : ''} />}
            disabled={tucanBusy}
            onClick={() => void handleStartTucanWizard()}
          >
            {tucanBusy ? 'Assistent läuft …' : 'TUCaN-Assistent starten'}
          </Button>
        </SettingRow>

        <SettingRow
          label="Kalender abonnieren (WebCal / iCal)"
          description="Abonniere dynamische Kalender-Feeds deiner Hochschule oder Lernplattform. Die Adresse wird verschlüsselt gespeichert."
          stacked
        >
          <div className="inline-form">
            <div className="row">
              <Input
                value={feedName}
                placeholder="Name des Stundenplans/Kurses"
                onChange={(e) => setFeedName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && isFormValid && !subBusy && void handleSubscribe()}
              />
              <Input
                value={feedUrl}
                placeholder="WebCal- / iCal-URL, z.B. webcal://... oder https://..."
                onChange={(e) => setFeedUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && isFormValid && !subBusy && void handleSubscribe()}
              />
              <Button
                icon={<Link2 />}
                disabled={!isFormValid || subBusy}
                onClick={() => void handleSubscribe()}
              >
                {subBusy ? 'Abonniere …' : 'Abonnieren'}
              </Button>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label="iCal-Datei manuell importieren"
          description="Für Systeme ohne Abo, z. B. den Stundenplan aus my h_da (HISinOne) oder manuelle TUCaN-Exporte. Erneuter Import derselben Datei aktualisiert die Termine ohne Duplikate."
        >
          <Button icon={<FileUp />} onClick={() => void handleImportFile()}>
            Datei wählen
          </Button>
        </SettingRow>

        {db.subscriptions.map((s) => {
          const eventCount = db.events.filter((e) => e.subscriptionId === s.id).length
          return (
            <SettingRow
              key={s.id}
              label={s.name}
              description={
                <>
                  <div className="row" style={{ gap: 6, alignItems: 'center', marginBottom: 2 }}>
                    <span className="badge" style={{ fontSize: '11px' }}>
                      {s.kind === 'file' ? 'Datei-Import' : 'WebCal-Feed'}
                    </span>
                    <span className="mono-path">{s.kind === 'file' ? (s.url || 'Lokale ICS-Datei') : s.url}</span>
                  </div>
                  {s.lastError ? (
                    <div className="status-error" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                      <AlertCircle size={13} />
                      <span>Synchronisationsfehler: {s.lastError}</span>
                    </div>
                  ) : s.lastSync ? (
                    <span className="status-ok">
                      {s.kind === 'file' ? 'Importiert' : 'Abgeglichen'} {formatDateTime(s.lastSync)} ·{' '}
                      {eventCount} {eventCount === 1 ? 'Termin' : 'Termine'}
                    </span>
                  ) : (
                    <span className="small muted">Noch nicht abgeglichen</span>
                  )}
                </>
              }
            >
              <div className="row">
                {s.kind === 'url' && (
                  <IconButton
                    label="Jetzt synchronisieren"
                    disabled={syncingId === s.id}
                    onClick={() => void handleSync(s)}
                  >
                    <RefreshCw className={syncingId === s.id ? 'spin' : ''} />
                  </IconButton>
                )}
                <IconButton label="Entfernen" onClick={() => void handleRemove(s)}>
                  <Trash2 />
                </IconButton>
              </div>
            </SettingRow>
          )
        })}
      </SettingGroup>

      <SettingGroup title="So findest du deine Kalender-Adresse & Exporte">
        <div className="setting-row guide">
          <div>
            <strong>TU Darmstadt (TUCaN)</strong>
            <ol>
              <li>Klicke oben auf <strong>„TUCaN-Assistent starten“</strong>.</li>
              <li>Melde dich mit deiner TU-ID im Anmeldefenster an.</li>
              <li>Navigiere zu <strong>Veranstaltungen → Stundenplan</strong> und klicke auf <strong>„Exportieren“</strong>.</li>
              <li>Der Study Organizer übernimmt deinen Stundenplan automatisch und schließt das Fenster.</li>
            </ol>
            Alternativ kannst du die exportierte <code>.ics</code>-Datei direkt über „Datei wählen“ importieren oder per Drag & Drop in den Kalender ziehen.
          </div>
        </div>
        <div className="setting-row guide">
          <div>
            <strong>Moodle</strong> (z. B. moodle.tu-darmstadt.de oder lernen.h-da.de)
            <ol>
              <li>Kalender öffnen → unten „Import und Export“ bzw. „Kalender exportieren“.</li>
              <li>„Alle Termine“ und als Zeitraum „Eigener Bereich“ oder „Vergangene und nachfolgende 60 Tage“ wählen.</li>
              <li>„Kalender-URL abfragen“ → URL kopieren und oben bei „Kalender abonnieren“ einfügen.</li>
            </ol>
            Tipp: Mit der Moodle-Anbindung oben kommen Abgaben zusätzlich als abhakbare Aufgaben.
          </div>
        </div>
        <div className="setting-row guide">
          <div>
            <strong>my h_da / HISinOne</strong>: Studienservice → Stundenplan → „Daten für Kalender (ics) exportieren“ → Datei oben importieren. HISinOne bietet nur einen Export zum Zeitpunkt des Herunterladens – nach Änderungen neu importieren.
          </div>
        </div>
        <div className="setting-row guide">
          <div>
            <strong>h_da Informatik (OBS)</strong>: Im Online-Belegsystem den persönlichen Terminplan als Internetkalender abonnieren – die Adresse beginnt mit{' '}
            <code>https://obs.fbi.h-da.de/obs/index.php?action=getTerminplan</code>.
          </div>
        </div>
        <div className="setting-row guide">
          <div>
            <strong>Stud.IP & ILIAS</strong>: Planer → Terminkalender → „Kalender teilen“ bzw. ILIAS Kalender → „Abonnieren“ → WebCal-URL kopieren und oben abonnieren.
          </div>
        </div>
      </SettingGroup>
    </>
  )
}

export function IntegrationSettings() {
  return (
    <>
      <MoodleSection />
      <TucanCalendarSection />
    </>
  )
}
