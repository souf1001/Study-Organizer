// Moodle-Anbindung und Kalender-Abos (Moodle, my h_da/HISinOne, Stud.IP, ILIAS, OBS …).
import { useEffect, useState } from 'react'
import { FileUp, Link2, LogIn, RefreshCw, Trash2, Unplug } from 'lucide-react'
import { newModule } from '@shared/defaults'
import type { MoodleCourse, MoodleSiteInfo } from '@shared/types'
import { api } from '@/lib/api'
import { activeSemester, pickFiles, semesterModules } from '@/lib/actions'
import { loadDb, putRecord, updateSettings, useDb } from '@/lib/db'
import { formatDateTime } from '@/lib/format'
import { Button, IconButton } from '@/ui/Button'
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

function SubscriptionsSection() {
  const db = useDb()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setBusy(true)
    try {
      const sub = await api.calendar.subscribe(name, url)
      await loadDb()
      setName('')
      setUrl('')
      if (sub.lastError) toastError(new Error(sub.lastError))
      else toast(`„${sub.name}“ abonniert`)
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  const importFile = async () => {
    const [file] = await pickFiles('.ics,text/calendar')
    if (!file) return
    try {
      const result = await api.calendar.importFile(file.name, await file.text())
      await loadDb()
      toast(`${result.count} Termine aus „${file.name}“ importiert`)
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <>
      <SettingGroup title="Kalender-Abos (iCal)">
        {db.subscriptions.map((s) => (
          <SettingRow
            key={s.id}
            label={s.name}
            description={
              <>
                <span className="mono-path">{s.url}</span>
                <br />
                {s.lastError ? (
                  <span className="status-error">{s.lastError}</span>
                ) : s.lastSync ? (
                  <span className="status-ok">
                    {s.kind === 'file' ? 'Importiert' : 'Abgeglichen'} {formatDateTime(s.lastSync)} · {db.events.filter((e) => e.subscriptionId === s.id).length} Termine
                  </span>
                ) : null}
              </>
            }
          >
            <div className="row">
              {s.kind === 'url' && (
                <IconButton label="Jetzt abgleichen" onClick={() => void api.calendar.sync(s.id).then(loadDb)}>
                  <RefreshCw />
                </IconButton>
              )}
              <IconButton label="Entfernen" onClick={() => void api.calendar.unsubscribe(s.id).then(loadDb)}>
                <Trash2 />
              </IconButton>
            </div>
          </SettingRow>
        ))}
        <SettingRow label="Kalender abonnieren" description="Die Adresse wird verschlüsselt gespeichert, da sie wie ein Passwort funktioniert." stacked>
          <div className="inline-form">
            <div className="row">
              <Input value={name} placeholder="Name, z. B. Moodle" onChange={(e) => setName(e.target.value)} />
              <Input value={url} placeholder="https://… oder webcal://…" onChange={(e) => setUrl(e.target.value)} />
              <Button icon={<Link2 />} disabled={!url.trim() || busy} onClick={() => void add()}>
                Abonnieren
              </Button>
            </div>
          </div>
        </SettingRow>
        <SettingRow label="iCal-Datei importieren" description="Für Systeme ohne Abo, z. B. den Stundenplan aus my h_da (HISinOne) oder TUCaN. Erneuter Import derselben Datei ersetzt die Termine.">
          <Button icon={<FileUp />} onClick={() => void importFile()}>
            Datei wählen
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="So findest du die Kalender-Adresse">
        <div className="setting-row guide">
          <div>
            <strong>Moodle</strong> (z. B. lernen.h-da.de)
            <ol>
              <li>Kalender öffnen → unten „Import und Export“ bzw. „Kalender exportieren“.</li>
              <li>„Alle Termine“ und als Zeitraum „Eigener Bereich“ (sonst „Vergangene und nachfolgende 60 Tage“) wählen.</li>
              <li>„Kalender-URL abfragen“ → URL kopieren und oben einfügen.</li>
            </ol>
            Tipp: Mit der Moodle-Anbindung oben kommen Abgaben zusätzlich als abhakbare Aufgaben.
          </div>
        </div>
        <div className="setting-row guide">
          <div>
            <strong>my h_da / HISinOne</strong>: Studienservice → Stundenplan → „Daten für Kalender (ics) exportieren“ → Datei oben importieren. HISinOne bietet nur einen Export zum
            Zeitpunkt des Herunterladens – nach Änderungen neu importieren.
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
            <strong>Stud.IP</strong>: Planer → Terminkalender → „Kalender teilen“ → „Adresse generieren“. <strong>ILIAS</strong>: Kalender → „Abonnieren“ → „iCal-URL“.{' '}
            <strong>TUCaN</strong>: Stundenplan → Export (pro Monat) → Datei importieren.
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
      <SubscriptionsSection />
    </>
  )
}
