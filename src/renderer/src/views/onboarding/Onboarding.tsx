// Ersteinrichtung beim ersten Start – kein Konto, alles bleibt lokal.
import { useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Monitor, Moon, Plus, Sun, Trash2 } from 'lucide-react'
import { AI_PROVIDERS, getProvider } from '@shared/ai-providers'
import { MODULE_COLORS, newId, newModule } from '@shared/defaults'
import { today } from '@shared/dates'
import { suggestedSemester, SEMESTER_MODELS, type SemesterDraft } from '@shared/semester'
import type { Db, InstitutionType, Module, SemesterModelId, Settings, ThemeSetting } from '@shared/types'
import { api } from '@/lib/api'
import { putRecord, updateDb, useDb } from '@/lib/db'
import { Button, IconButton } from '@/ui/Button'
import { Field, Input, Segmented, Select, Switch } from '@/ui/Field'
import { toastError } from '@/ui/Toast'
import { ScheduleEditor } from '../module/ScheduleEditor'
import { SemesterForm } from '../semester/SemesterDialog'
import { PaperPicker } from '../note/PaperPicker'
import './onboarding.css'
import '../module/module.css'
import '../semester/semester.css'

const UNIVERSITIES = [
  'Hochschule Darmstadt (h_da)',
  'Technische Universität Darmstadt',
  'Goethe-Universität Frankfurt',
  'Frankfurt University of Applied Sciences',
  'Hochschule RheinMain',
  'Johannes Gutenberg-Universität Mainz',
  'Hochschule Mainz',
  'Technische Hochschule Mittelhessen',
  'Justus-Liebig-Universität Gießen',
  'Philipps-Universität Marburg',
  'Universität Kassel',
  'Universität Heidelberg',
  'Universität Mannheim',
  'Hochschule Mannheim',
  'Karlsruher Institut für Technologie (KIT)',
  'Universität Stuttgart',
  'Technische Universität München',
  'Ludwig-Maximilians-Universität München',
  'Hochschule München',
  'RWTH Aachen',
  'Universität zu Köln',
  'TH Köln',
  'Universität Hamburg',
  'HAW Hamburg',
  'Humboldt-Universität zu Berlin',
  'Freie Universität Berlin',
  'Technische Universität Berlin',
  'HTW Berlin',
  'Technische Universität Dresden',
  'Universität Leipzig',
  'FernUniversität in Hagen',
]

const DEGREES = ['Bachelor', 'Master', 'Staatsexamen', 'Diplom', 'Ausbildung / Duales Studium', 'Promotion', 'Sonstiges']

function guessInstitution(name: string): { type: InstitutionType; model: SemesterModelId } {
  if (/h_da|hochschule darmstadt/i.test(name)) return { type: 'hochschule', model: 'hda' }
  if (/hochschule|fachhochschule|\bfh\b|\bth\b|\bhaw\b|htw|applied sciences|technische hochschule/i.test(name)) {
    return { type: 'hochschule', model: 'hochschule' }
  }
  return { type: 'uni', model: 'uni' }
}

function Step({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="onb-step">
      <h1 className="onb-title">{title}</h1>
      {subtitle && <p className="onb-subtitle">{subtitle}</p>}
      <div className="onb-content">{children}</div>
    </div>
  )
}

function ModuleDraftRow({ module, onChange, onRemove }: { module: Module; onChange: (m: Module) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="onb-module">
      <div className="onb-module-row">
        <span className={`dot color-${module.color}`} />
        <input className="input" placeholder="Modulname, z. B. Programmieren 1" value={module.name} onChange={(e) => onChange({ ...module, name: e.target.value })} />
        <input className="input onb-code" placeholder="Kürzel" value={module.code} onChange={(e) => onChange({ ...module, code: e.target.value })} />
        <Button size="sm" variant="ghost" icon={open ? <ChevronDown /> : <ChevronRight />} onClick={() => setOpen(!open)}>
          Termine{module.schedule.length ? ` (${module.schedule.length})` : ''}
        </Button>
        <IconButton label="Entfernen" onClick={onRemove}>
          <Trash2 />
        </IconButton>
      </div>
      {open && <ScheduleEditor slots={module.schedule} onChange={(schedule) => onChange({ ...module, schedule })} />}
    </div>
  )
}

export function Onboarding() {
  const db = useDb()
  const [step, setStep] = useState(0)
  const [profile, setProfile] = useState<Db['profile']>(db.profile)
  const [model, setModel] = useState<SemesterModelId>(db.settings.study.semesterModel)
  const [semester, setSemester] = useState<SemesterDraft>(() => suggestedSemester(model, today()))
  const [semesterId] = useState(newId)
  const [modules, setModules] = useState<Module[]>(() => [newModule(semesterId, { color: MODULE_COLORS[0] })])
  const [theme, setTheme] = useState<ThemeSetting>(db.settings.appearance.theme)
  const [editor, setEditor] = useState<Settings['editor']>(db.settings.editor)
  const [ai, setAi] = useState<Settings['ai']>(db.settings.ai)
  const [aiKey, setAiKey] = useState('')
  const [saving, setSaving] = useState(false)

  const setUniversity = (university: string) => {
    const guess = guessInstitution(university)
    setProfile({ ...profile, university, institutionType: guess.type })
    setModel(guess.model)
    setSemester(suggestedSemester(guess.model, today()))
  }

  const applyTheme = (value: ThemeSetting) => {
    setTheme(value)
    updateDb({ settings: { ...db.settings, appearance: { ...db.settings.appearance, theme: value } } })
  }

  const finish = async () => {
    setSaving(true)
    try {
      putRecord('semesters', { ...semester, id: semesterId, createdAt: new Date().toISOString() })
      modules
        .filter((m) => m.name.trim())
        .forEach((m, i) => putRecord('modules', { ...m, name: m.name.trim(), order: i }))
      if (ai.enabled && aiKey.trim()) await api.ai.setKey(ai.provider, aiKey)
      updateDb({
        profile: { ...profile, name: profile.name.trim() },
        activeSemesterId: semesterId,
        settings: {
          ...db.settings,
          appearance: { ...db.settings.appearance, theme },
          editor,
          study: { ...db.settings.study, semesterModel: model },
          ai: { ...ai, enabled: ai.enabled && (Boolean(aiKey.trim()) || Boolean(getProvider(ai.provider).keyOptional)) },
        },
        onboarded: true,
      })
    } catch (error) {
      toastError(error)
      setSaving(false)
    }
  }

  const provider = getProvider(ai.provider)
  const steps: { valid: boolean; node: ReactNode }[] = [
    {
      valid: true,
      node: (
        <div className="onb-welcome">
          <div className="onb-logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="40" height="40">
              <rect x="5" y="4" width="18" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M10 11h8M10 16h8M10 21h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M26 9v18" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="onb-title">Willkommen beim Study Organizer</h1>
          <p className="onb-subtitle">
            Module, Vorlesungen, Notizen, Folien und Termine an einem Ort. Kein Konto nötig – deine Daten bleiben auf deinem
            Rechner. Die Einrichtung dauert etwa zwei Minuten.
          </p>
        </div>
      ),
    },
    {
      valid: profile.name.trim().length > 0,
      node: (
        <Step title="Wie heißt du?" subtitle="Nur für die Begrüßung in der App.">
          <Field label="Vorname">
            <Input autoFocus value={profile.name} placeholder="z. B. Soufian" onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
          </Field>
        </Step>
      ),
    },
    {
      valid: profile.university.trim().length > 0 && profile.program.trim().length > 0,
      node: (
        <Step title="Was und wo studierst du?" subtitle="Daraus leiten wir Semesterzeiten und passende Voreinstellungen ab.">
          <Field label="Hochschule">
            <Input list="universities" value={profile.university} placeholder="Name der Hochschule" onChange={(e) => setUniversity(e.target.value)} />
            <datalist id="universities">
              {UNIVERSITIES.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <div className="form-row">
            <Field label="Art der Hochschule">
              <Select
                value={model}
                options={(Object.keys(SEMESTER_MODELS) as SemesterModelId[]).map((id) => ({ value: id, label: SEMESTER_MODELS[id].label }))}
                onChange={(id) => {
                  setModel(id)
                  setProfile({ ...profile, institutionType: id === 'uni' ? 'uni' : 'hochschule' })
                  setSemester(suggestedSemester(id, today()))
                }}
              />
            </Field>
            <Field label="Abschluss">
              <Select value={profile.degree} options={DEGREES.map((d) => ({ value: d, label: d }))} onChange={(degree) => setProfile({ ...profile, degree })} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Studiengang">
              <Input value={profile.program} placeholder="z. B. Informatik" onChange={(e) => setProfile({ ...profile, program: e.target.value })} />
            </Field>
            <Field label="Fachsemester">
              <Input
                type="number"
                min={1}
                max={20}
                value={profile.studySemester}
                onChange={(e) => setProfile({ ...profile, studySemester: Number(e.target.value) || 1 })}
              />
            </Field>
          </div>
        </Step>
      ),
    },
    {
      valid: Boolean(semester.name && semester.lectureStart && semester.lectureEnd),
      node: (
        <Step title="Dein aktuelles Semester" subtitle="Die Termine sind ein Vorschlag. Beim nächsten Semesterwechsel fragt die App automatisch nach.">
          <SemesterForm draft={semester} onChange={setSemester} model={model} />
        </Step>
      ),
    },
    {
      valid: true,
      node: (
        <Step title="Welche Module belegst du?" subtitle="Termine und Räume kannst du gleich oder später eintragen.">
          <div className="onb-modules">
            {modules.map((m) => (
              <ModuleDraftRow
                key={m.id}
                module={m}
                onChange={(next) => setModules(modules.map((x) => (x.id === m.id ? next : x)))}
                onRemove={() => setModules(modules.filter((x) => x.id !== m.id))}
              />
            ))}
            <div>
              <Button
                icon={<Plus />}
                onClick={() => setModules([...modules, newModule(semesterId, { color: MODULE_COLORS[modules.length % MODULE_COLORS.length], order: modules.length })])}
              >
                Weiteres Modul
              </Button>
            </div>
          </div>
        </Step>
      ),
    },
    {
      valid: true,
      node: (
        <Step title="Aussehen" subtitle="Lässt sich jederzeit in den Einstellungen ändern.">
          <Field label="Farbschema">
            <Segmented
              value={theme}
              onChange={applyTheme}
              options={[
                { value: 'light', label: 'Hell', icon: <Sun /> },
                { value: 'dark', label: 'Dunkel', icon: <Moon /> },
                { value: 'system', label: 'System', icon: <Monitor /> },
              ]}
            />
          </Field>
          <Field label="Standard-Papier für neue Notizen">
            <PaperPicker value={editor.paper} onChange={(paper) => setEditor({ ...editor, paper })} />
          </Field>
        </Step>
      ),
    },
    {
      valid: !ai.enabled || Boolean(aiKey.trim()) || Boolean(provider.keyOptional),
      node: (
        <Step
          title="KI-Funktionen (optional)"
          subtitle="Zusammenfassungen von Vorlesungen und ein Chat mit deinen Unterlagen. Funktioniert mit deinem eigenen API-Key – z. B. kostenlos über Groq, Google Gemini oder Hugging Face."
        >
          <label className="row onb-toggle">
            <Switch checked={ai.enabled} onChange={(enabled) => setAi({ ...ai, enabled })} label="KI aktivieren" />
            <span>KI-Funktionen nutzen</span>
          </label>
          {ai.enabled && (
            <>
              <Field label="Anbieter" hint={provider.note}>
                <Select
                  value={ai.provider}
                  options={AI_PROVIDERS.map((p) => ({ value: p.id, label: p.free ? `${p.name} · kostenlos nutzbar` : p.name }))}
                  onChange={(id) => setAi({ ...ai, provider: id, model: '', baseUrl: '' })}
                />
              </Field>
              <Field
                label={provider.keyOptional ? 'API-Key (optional)' : 'API-Key'}
                hint={
                  provider.keyUrl && (
                    <>
                      Key erstellen:{' '}
                      <a href={provider.keyUrl} onClick={(e) => { e.preventDefault(); void api.openExternal(provider.keyUrl) }}>
                        {new URL(provider.keyUrl).host}
                      </a>{' '}
                      · wird verschlüsselt auf diesem Gerät gespeichert
                    </>
                  )
                }
              >
                <Input type="password" value={aiKey} placeholder="Key einfügen" onChange={(e) => setAiKey(e.target.value)} />
              </Field>
            </>
          )}
        </Step>
      ),
    },
  ]

  const last = step === steps.length - 1
  const current = steps[step]

  return (
    <div className="onboarding">
      <div className="onb-top drag" />
      <div className="onb-body">
        {current.node}
        <div className="onb-actions">
          {step > 0 && (
            <Button variant="ghost" icon={<ArrowLeft />} onClick={() => setStep(step - 1)}>
              Zurück
            </Button>
          )}
          <span className="spacer" />
          <div className="onb-dots" aria-hidden>
            {steps.map((_, i) => (
              <span key={i} className={i === step ? 'on' : ''} />
            ))}
          </div>
          <span className="spacer" />
          <Button
            variant="primary"
            size="lg"
            disabled={!current.valid || saving}
            onClick={() => (last ? void finish() : setStep(step + 1))}
          >
            {step === 0 ? 'Los geht’s' : last ? 'Fertig' : 'Weiter'}
            {!last && <ArrowRight />}
          </Button>
        </div>
      </div>
    </div>
  )
}
