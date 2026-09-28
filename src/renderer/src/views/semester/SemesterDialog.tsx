// Neues Semester beginnen oder ein bestehendes bearbeiten.
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { newId, newModule, newSlot } from '@shared/defaults'
import { today } from '@shared/dates'
import { buildSemester, nextSemesterDraft, suggestedSemester, SEMESTER_MODELS, type SemesterDraft } from '@shared/semester'
import type { Semester, SemesterKind, SemesterModelId } from '@shared/types'
import { semesterModules } from '@/lib/actions'
import { putRecord, updateDb, useDb } from '@/lib/db'
import { openView } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Field, Input, Select } from '@/ui/Field'
import { Modal } from '@/ui/Modal'
import { toast } from '@/ui/Toast'
import './semester.css'

/** Vorschlag für das nächste Semester anhand des Modells und der vorhandenen Semester */
export function suggestSemester(semesters: Semester[], model: SemesterModelId): SemesterDraft {
  const current = suggestedSemester(model, today())
  if (!semesters.some((s) => s.name === current.name)) return current
  const latest = [...semesters].sort((a, b) => b.start.localeCompare(a.start))[0]
  return nextSemesterDraft(model, latest)
}

export function SemesterForm({
  draft,
  onChange,
  model: modelProp,
}: {
  draft: SemesterDraft
  onChange: (d: SemesterDraft) => void
  model?: SemesterModelId
}) {
  const db = useDb()
  const model = modelProp ?? db.settings.study.semesterModel
  const set = (values: Partial<SemesterDraft>) => onChange({ ...draft, ...values })
  const rebuild = (kind: SemesterKind, year: number) => onChange(buildSemester(model, kind, year))
  const date = (key: 'start' | 'end' | 'lectureStart' | 'lectureEnd', label: string) => (
    <Field label={label}>
      <input className="input" type="date" value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  )

  return (
    <div className="semester-form">
      <div className="form-row">
        <Field label="Semester">
          <Select
            value={draft.kind}
            options={[
              { value: 'winter', label: 'Wintersemester' },
              { value: 'summer', label: 'Sommersemester' },
            ]}
            onChange={(kind) => rebuild(kind, draft.year)}
          />
        </Field>
        <Field label="Jahr">
          <Input type="number" value={draft.year} onChange={(e) => rebuild(draft.kind, Number(e.target.value) || draft.year)} />
        </Field>
        <Field label="Name">
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        {date('start', 'Semesterbeginn')}
        {date('end', 'Semesterende')}
      </div>
      <div className="form-row">
        {date('lectureStart', 'Erster Vorlesungstag')}
        {date('lectureEnd', 'Letzter Vorlesungstag')}
      </div>
      <div className="field">
        <span className="field-label">Vorlesungsfreie Zeiten</span>
        {draft.breaks.map((b, i) => (
          <div key={i} className="break-row">
            <Input
              value={b.label}
              aria-label="Bezeichnung"
              onChange={(e) => set({ breaks: draft.breaks.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
            />
            <input
              className="input"
              type="date"
              value={b.start}
              aria-label="Von"
              onChange={(e) => set({ breaks: draft.breaks.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })}
            />
            <input
              className="input"
              type="date"
              value={b.end}
              aria-label="Bis"
              onChange={(e) => set({ breaks: draft.breaks.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })}
            />
            <IconButton label="Entfernen" onClick={() => set({ breaks: draft.breaks.filter((_, j) => j !== i) })}>
              <Trash2 />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus />}
            onClick={() => set({ breaks: [...draft.breaks, { label: 'Frei', start: draft.lectureStart, end: draft.lectureStart }] })}
          >
            Zeitraum hinzufügen
          </Button>
        </div>
      </div>
      <p className="field-hint">Vorschlag nach dem Modell „{SEMESTER_MODELS[model].label}“ – bitte mit den Terminen deiner Hochschule abgleichen.</p>
    </div>
  )
}

export function SemesterDialog({ semester, onClose }: { semester?: Semester; onClose: () => void }) {
  const db = useDb()
  const [draft, setDraft] = useState<SemesterDraft>(() => semester ?? suggestSemester(db.semesters, db.settings.study.semesterModel))
  const previous = semester ? undefined : [...db.semesters].sort((a, b) => b.start.localeCompare(a.start))[0]
  const previousModules = previous ? semesterModules(db, previous.id) : []
  const [carry, setCarry] = useState<string[]>([])

  const save = () => {
    if (draft.lectureStart > draft.lectureEnd || draft.start > draft.end) {
      return toast('Das Ende darf nicht vor dem Beginn liegen.', { error: true })
    }
    const record: Semester = { ...(semester ?? { id: newId(), createdAt: new Date().toISOString() }), ...draft }
    putRecord('semesters', record)
    if (!semester) {
      for (const m of previousModules.filter((m) => carry.includes(m.id))) {
        putRecord('modules', newModule(record.id, {
          name: m.name,
          code: m.code,
          lecturer: m.lecturer,
          color: m.color,
          ects: m.ects,
          info: m.info,
          schedule: m.schedule.map((s) => newSlot({ ...s, id: newId(), firstDate: null, skip: [] })),
        }))
      }
      updateDb({ activeSemesterId: record.id })
      openView({ type: 'home' })
      toast(`${record.name} angelegt`)
    }
    onClose()
  }

  return (
    <Modal
      wide
      title={semester ? `${semester.name} bearbeiten` : 'Neues Semester beginnen'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={save}>
            {semester ? 'Speichern' : 'Semester anlegen'}
          </Button>
        </>
      }
    >
      <SemesterForm draft={draft} onChange={setDraft} />
      {previousModules.length > 0 && (
        <div className="field carry">
          <span className="field-label">Module aus {previous!.name} übernehmen</span>
          <span className="field-hint">Praktisch für Module, die über zwei Semester laufen oder wiederholt werden.</span>
          <div className="carry-list">
            {previousModules.map((m) => (
              <label key={m.id} className="row small">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={carry.includes(m.id)}
                  onChange={(e) => setCarry((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))}
                />
                <span className={`dot color-${m.color}`} />
                {m.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}
