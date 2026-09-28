// Einstellungen, gegliedert wie in macOS/Linear: Bereiche links, Optionen rechts.
import { useEffect, useState, type ReactNode } from 'react'
import { Check, FolderOpen, HardDriveDownload, Monitor, Moon, Pencil, Sun, Trash2 } from 'lucide-react'
import { SEMESTER_MODELS } from '@shared/semester'
import { sessionFolderName } from '@shared/schedule'
import { today } from '@shared/dates'
import type { AccentId, CalendarViewId, FontId, Semester, SemesterModelId } from '@shared/types'
import { api } from '@/lib/api'
import { activeSemester } from '@/lib/actions'
import { removeRecord, updateDb, updateSettings, useDb } from '@/lib/db'
import { formatDay, modKey } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { confirm } from '@/ui/Dialogs'
import { Input, Segmented, Select, Switch } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'
import { FONTS, PEN_COLORS, PEN_SIZES } from '../note/paper'
import { PaperColorPicker, PaperPicker } from '../note/PaperPicker'
import { SemesterDialog } from '../semester/SemesterDialog'
import { AiSettings } from './AiSettings'
import { IntegrationSettings } from './IntegrationSettings'
import './settings.css'

export function SettingRow({ label, description, children, stacked }: { label: string; description?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={`setting-row ${stacked ? 'stacked' : ''}`}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {description && <div className="setting-description">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setting-group">
      <h2 className="setting-group-title">{title}</h2>
      <div className="setting-card">{children}</div>
    </section>
  )
}

const ACCENTS: { id: AccentId; label: string; color: string }[] = [
  { id: 'indigo', label: 'Indigo', color: '#5b5bd6' },
  { id: 'blue', label: 'Blau', color: '#2f76d2' },
  { id: 'green', label: 'Grün', color: '#3f8a5f' },
  { id: 'orange', label: 'Orange', color: '#d9730d' },
  { id: 'pink', label: 'Rosa', color: '#c14c8a' },
  { id: 'graphite', label: 'Graphit', color: '#37352f' },
]

function ProfileSection() {
  const db = useDb()
  const p = db.profile
  const set = (values: Partial<typeof p>) => updateDb({ profile: { ...p, ...values } })
  return (
    <SettingGroup title="Über dich">
      <SettingRow label="Name">
        <Input value={p.name} onChange={(e) => set({ name: e.target.value })} />
      </SettingRow>
      <SettingRow label="Hochschule">
        <Input value={p.university} onChange={(e) => set({ university: e.target.value })} />
      </SettingRow>
      <SettingRow label="Studiengang">
        <Input value={p.program} onChange={(e) => set({ program: e.target.value })} />
      </SettingRow>
      <SettingRow label="Abschluss">
        <Input value={p.degree} onChange={(e) => set({ degree: e.target.value })} />
      </SettingRow>
      <SettingRow label="Fachsemester">
        <Input type="number" min={1} max={20} value={p.studySemester} onChange={(e) => set({ studySemester: Number(e.target.value) || 1 })} />
      </SettingRow>
    </SettingGroup>
  )
}

function StudySection() {
  const db = useDb()
  const study = db.settings.study
  const current = activeSemester(db)
  const [editing, setEditing] = useState<Semester | 'new' | null>(null)
  const semesters = [...db.semesters].sort((a, b) => b.start.localeCompare(a.start))

  const remove = async (s: Semester) => {
    const count = db.modules.filter((m) => m.semesterId === s.id).length
    const ok = await confirm({
      title: `${s.name} löschen?`,
      message: count ? `Alle ${count} Module dieses Semesters mit Notizen und Dateien werden gelöscht.` : undefined,
      confirmLabel: 'Löschen',
      danger: true,
    })
    if (ok) await removeRecord('semesters', s.id)
  }

  return (
    <>
      <SettingGroup title="Semester">
        {semesters.map((s) => (
          <div key={s.id} className="setting-row">
            <div className="setting-text">
              <div className="setting-label row">
                {s.name}
                {s.id === current?.id && <span className="badge color-blue">aktiv</span>}
              </div>
              <div className="setting-description">
                Vorlesungen {formatDay(s.lectureStart)} – {formatDay(s.lectureEnd)} · {db.modules.filter((m) => m.semesterId === s.id).length} Module
              </div>
            </div>
            <div className="setting-control row">
              {s.id !== current?.id && (
                <Button size="sm" icon={<Check />} onClick={() => updateDb({ activeSemesterId: s.id })}>
                  Aktivieren
                </Button>
              )}
              <IconButton label="Bearbeiten" onClick={() => setEditing(s)}><Pencil /></IconButton>
              <IconButton label="Löschen" onClick={() => void remove(s)}><Trash2 /></IconButton>
            </div>
          </div>
        ))}
        <div className="setting-row">
          <Button onClick={() => setEditing('new')}>Neues Semester beginnen</Button>
        </div>
      </SettingGroup>
      <SettingGroup title="Semesterzeiten">
        <SettingRow label="Modell" description={SEMESTER_MODELS[study.semesterModel].description}>
          <Select
            value={study.semesterModel}
            options={(Object.keys(SEMESTER_MODELS) as SemesterModelId[]).map((id) => ({ value: id, label: SEMESTER_MODELS[id].label }))}
            onChange={(semesterModel) => updateSettings('study', { semesterModel })}
          />
        </SettingRow>
        <SettingRow label="Bei neuem Semester nachfragen" description="Auf der Startseite erscheint ein Hinweis, sobald ein neues Semester beginnt.">
          <Switch checked={study.askForNewSemester} onChange={(askForNewSemester) => updateSettings('study', { askForNewSemester })} label="Nachfragen" />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Ordner pro Termin">
        <SettingRow
          label="Name neuer Termin-Ordner"
          description={
            <>
              Platzhalter: {'{kind}'} Art, {'{n}'} Nummer, {'{date}'} Datum. Vorschau: „
              {sessionFolderName(study.sessionFolderName, { kind: 'lecture', index: 3, date: today() })}“
            </>
          }
        >
          <Input value={study.sessionFolderName} onChange={(e) => updateSettings('study', { sessionFolderName: e.target.value })} />
        </SettingRow>
      </SettingGroup>
      {editing && <SemesterDialog semester={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function AppearanceSection() {
  const a = useDb().settings.appearance
  return (
    <SettingGroup title="Darstellung">
      <SettingRow label="Farbschema">
        <Segmented
          value={a.theme}
          onChange={(theme) => updateSettings('appearance', { theme })}
          options={[
            { value: 'light', label: 'Hell', icon: <Sun /> },
            { value: 'dark', label: 'Dunkel', icon: <Moon /> },
            { value: 'system', label: 'System', icon: <Monitor /> },
          ]}
        />
      </SettingRow>
      <SettingRow label="Akzentfarbe">
        <div className="accent-picker">
          {ACCENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="accent-swatch"
              aria-label={c.label}
              title={c.label}
              aria-pressed={a.accent === c.id}
              style={{ background: c.color }}
              onClick={() => updateSettings('appearance', { accent: c.id })}
            />
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Größe der Oberfläche">
        <Select
          value={a.zoom}
          options={[0.9, 1, 1.1, 1.2].map((z) => ({ value: z, label: `${Math.round(z * 100)} %` }))}
          onChange={(zoom) => updateSettings('appearance', { zoom })}
        />
      </SettingRow>
      <SettingRow label="Kompakte Darstellung" description="Engere Zeilen in Listen und Seitenleiste.">
        <Switch checked={a.compact} onChange={(compact) => updateSettings('appearance', { compact })} label="Kompakt" />
      </SettingRow>
      <SettingRow label="Animationen reduzieren">
        <Switch checked={a.reduceMotion} onChange={(reduceMotion) => updateSettings('appearance', { reduceMotion })} label="Animationen reduzieren" />
      </SettingRow>
    </SettingGroup>
  )
}

function EditorSection() {
  const e = useDb().settings.editor
  return (
    <>
      <SettingGroup title="Neue Notizen">
        <SettingRow label="Papier" stacked>
          <PaperPicker value={e.paper} onChange={(paper) => updateSettings('editor', { paper })} />
        </SettingRow>
        <SettingRow label="Papierfarbe">
          <PaperColorPicker value={e.paperColor} onChange={(paperColor) => updateSettings('editor', { paperColor })} />
        </SettingRow>
        <SettingRow label="Schrift">
          <Select value={e.font} options={FONTS.map((f) => ({ value: f.id, label: f.label }))} onChange={(font: FontId) => updateSettings('editor', { font })} />
        </SettingRow>
        <SettingRow label="Schriftgröße">
          <Select value={e.fontSize} options={[14, 15, 16, 17, 18, 20].map((s) => ({ value: s, label: `${s} px` }))} onChange={(fontSize) => updateSettings('editor', { fontSize })} />
        </SettingRow>
        <SettingRow label="Breite Seiten" description="Mehr Platz für Tabellen und Zeichnungen.">
          <Switch checked={e.wide} onChange={(wide) => updateSettings('editor', { wide })} label="Breite Seiten" />
        </SettingRow>
        <SettingRow label="Rechtschreibprüfung">
          <Switch checked={e.spellcheck} onChange={(spellcheck) => updateSettings('editor', { spellcheck })} label="Rechtschreibprüfung" />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Stift & Tablet">
        <SettingRow label="Nur Stift zeichnet" description="Mit dem Finger wird gescrollt, gezeichnet wird nur mit dem Stift (Handballen-Erkennung).">
          <Switch checked={e.penOnly} onChange={(penOnly) => updateSettings('editor', { penOnly })} label="Nur Stift zeichnet" />
        </SettingRow>
        <SettingRow label="Standard-Stiftfarbe">
          <div className="accent-picker">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="accent-swatch"
                aria-label={c}
                aria-pressed={e.penColor === c}
                style={{ background: c === 'ink' ? 'var(--text)' : c }}
                onClick={() => updateSettings('editor', { penColor: c })}
              />
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Standard-Stärke">
          <Segmented
            value={String(e.penSize)}
            onChange={(v) => updateSettings('editor', { penSize: Number(v) })}
            options={PEN_SIZES.map((s, i) => ({ value: String(s), label: ['Fein', 'Mittel', 'Dick'][i] }))}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

function CalendarSection() {
  const c = useDb().settings.calendar
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }))
  return (
    <SettingGroup title="Kalender">
      <SettingRow label="Standardansicht">
        <Select
          value={c.defaultView}
          options={[
            { value: 'week', label: 'Woche' },
            { value: 'month', label: 'Monat' },
            { value: 'agenda', label: 'Liste' },
          ]}
          onChange={(defaultView: CalendarViewId) => updateSettings('calendar', { defaultView })}
        />
      </SettingRow>
      <SettingRow label="Sichtbare Stunden">
        <div className="row">
          <Select value={c.startHour} options={hours.slice(0, 12)} onChange={(startHour) => updateSettings('calendar', { startHour })} />
          <span className="muted">bis</span>
          <Select value={c.endHour} options={hours.slice(13).concat({ value: 24, label: '24:00' })} onChange={(endHour) => updateSettings('calendar', { endHour })} />
        </div>
      </SettingRow>
      <SettingRow label="Wochenende anzeigen">
        <Switch checked={c.showWeekends} onChange={(showWeekends) => updateSettings('calendar', { showWeekends })} label="Wochenende anzeigen" />
      </SettingRow>
      <SettingRow label="Automatisch abgleichen" description="Kalender-Abos und Moodle werden beim Start und danach regelmäßig aktualisiert.">
        <Select
          value={c.syncIntervalHours}
          options={[
            { value: 1, label: 'Stündlich' },
            { value: 3, label: 'Alle 3 Stunden' },
            { value: 6, label: 'Alle 6 Stunden' },
            { value: 24, label: 'Täglich' },
            { value: 0, label: 'Nur beim Start' },
          ]}
          onChange={(syncIntervalHours) => updateSettings('calendar', { syncIntervalHours })}
        />
      </SettingRow>
    </SettingGroup>
  )
}

function DataSection() {
  const [dir, setDir] = useState('')
  useEffect(() => {
    void api.dataDir().then(setDir)
  }, [])
  const reset = async () => {
    const ok = await confirm({
      title: 'Alle Daten löschen?',
      message: 'Semester, Module, Notizen, Dateien und Einstellungen werden unwiderruflich gelöscht. Erstelle vorher ein Backup.',
      confirmLabel: 'Alles löschen',
      danger: true,
    })
    if (!ok) return
    await api.resetAll()
    localStorage.clear()
    window.location.reload()
  }
  return (
    <>
      <SettingGroup title="Speicherort">
        <SettingRow label="Daten liegen hier" description={<span className="selectable mono-path">{dir}</span>}>
          {api.platform === 'desktop' && (
            <Button icon={<FolderOpen />} onClick={() => void api.revealDataDir()}>
              Öffnen
            </Button>
          )}
        </SettingRow>
        <SettingRow label="Backup" description="Kopiert alle Daten (ohne API-Keys) in einen Ordner deiner Wahl, z. B. auf einen USB-Stick oder in die Cloud.">
          <Button
            icon={<HardDriveDownload />}
            onClick={() =>
              void api
                .backup()
                .then((path) => path && toast(`Backup gespeichert: ${path}`))
                .catch(toastError)
            }
          >
            Backup erstellen
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Gefahrenzone">
        <SettingRow label="Alles zurücksetzen" description="Löscht alle Daten und startet die Einrichtung neu.">
          <Button variant="danger" icon={<Trash2 />} onClick={() => void reset()}>
            Alles löschen
          </Button>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

const SHORTCUTS: [string, string][] = [
  [`${modKey} K`, 'Suchen & Befehle'],
  [`${modKey} N`, 'Neue Notiz im aktuellen Modul/Ordner'],
  [`${modKey} Klick`, 'In neuem Bereich öffnen (Split-Screen)'],
  [`${modKey} 1–4`, 'Bereich wechseln'],
  [`${modKey} [ / ]`, 'Zurück / Vorwärts'],
  [`${modKey} \\`, 'Seitenleiste ein/aus'],
  [`${modKey} ,`, 'Einstellungen'],
  ['/', 'Befehle im Editor (Überschrift, Liste, Formel …)'],
  ['Leertaste, J, L, < >', 'Video: Pause, ±10 s, Geschwindigkeit'],
]

function AboutSection() {
  return (
    <>
      <SettingGroup title="Study Organizer">
        <SettingRow label="Version" description="Deine Daten bleiben lokal auf diesem Gerät. Kein Konto, kein Tracking.">
          <span className="muted tabular">{__APP_VERSION__}</span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Tastenkürzel">
        {SHORTCUTS.map(([keys, label]) => (
          <SettingRow key={keys} label={label}>
            <span className="kbd">{keys}</span>
          </SettingRow>
        ))}
      </SettingGroup>
    </>
  )
}

const SECTIONS = [
  { id: 'profile', label: 'Profil', render: () => <ProfileSection /> },
  { id: 'study', label: 'Studium & Semester', render: () => <StudySection /> },
  { id: 'appearance', label: 'Darstellung', render: () => <AppearanceSection /> },
  { id: 'editor', label: 'Notizen & Stift', render: () => <EditorSection /> },
  { id: 'calendar', label: 'Kalender', render: () => <CalendarSection /> },
  { id: 'integrations', label: 'Moodle & Kalender-Abos', render: () => <IntegrationSettings /> },
  { id: 'ai', label: 'KI', render: () => <AiSettings /> },
  { id: 'data', label: 'Daten & Backup', render: () => <DataSection /> },
  { id: 'about', label: 'Über & Tastenkürzel', render: () => <AboutSection /> },
]

export function SettingsView({ section, paneId }: { section?: string; paneId: string }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-title">Einstellungen</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`nav-item ${s.id === current.id ? 'active' : ''}`}
            onClick={() => useWorkspace.getState().replace(paneId, { type: 'settings', section: s.id })}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          <h1 className="page-title settings-title">{current.label}</h1>
          {current.render()}
        </div>
      </div>
    </div>
  )
}
