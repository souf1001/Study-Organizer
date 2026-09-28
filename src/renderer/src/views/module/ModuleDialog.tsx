// Modul anlegen oder bearbeiten.
import { useState } from 'react'
import { Check } from 'lucide-react'
import { MODULE_COLORS, newModule } from '@shared/defaults'
import type { Module, ModuleColor, Semester } from '@shared/types'
import { getDb, putRecord } from '@/lib/db'
import { openView } from '@/lib/workspace'
import { Button } from '@/ui/Button'
import { Field, Input, Textarea } from '@/ui/Field'
import { Modal } from '@/ui/Modal'
import { ScheduleEditor } from './ScheduleEditor'
import './module.css'

export function ColorPicker({ value, onChange }: { value: ModuleColor; onChange: (c: ModuleColor) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="Farbe">
      {MODULE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={c}
          className={`swatch color-${c}`}
          onClick={() => onChange(c)}
        >
          {c === value && <Check />}
        </button>
      ))}
    </div>
  )
}

function nextColor(semesterId: string): ModuleColor {
  const used = getDb().modules.filter((m) => m.semesterId === semesterId).length
  return MODULE_COLORS[used % MODULE_COLORS.length]
}

export function ModuleDialog({ semester, module, onClose }: { semester: Semester; module?: Module; onClose: () => void }) {
  const [draft, setDraft] = useState<Module>(() => module ?? newModule(semester.id, { color: nextColor(semester.id) }))
  const set = (values: Partial<Module>) => setDraft((d) => ({ ...d, ...values }))

  const save = () => {
    if (!draft.name.trim()) return
    putRecord('modules', { ...draft, name: draft.name.trim() })
    onClose()
    if (!module) openView({ type: 'module', id: draft.id })
  }

  return (
    <Modal
      wide
      title={module ? 'Modul bearbeiten' : `Neues Modul · ${semester.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={save} disabled={!draft.name.trim()}>
            {module ? 'Speichern' : 'Modul anlegen'}
          </Button>
        </>
      }
    >
      <div className="module-form">
        <div className="form-grid">
          <Field label="Name">
            <Input autoFocus value={draft.name} placeholder="z. B. Analysis 1" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Kürzel">
            <Input value={draft.code} placeholder="z. B. ANA1" onChange={(e) => set({ code: e.target.value })} />
          </Field>
          <Field label="Dozent/in">
            <Input value={draft.lecturer} placeholder="Prof. Dr. …" onChange={(e) => set({ lecturer: e.target.value })} />
          </Field>
          <Field label="ECTS">
            <Input
              type="number"
              min={0}
              max={60}
              value={draft.ects ?? ''}
              onChange={(e) => set({ ects: e.target.value ? Number(e.target.value) : null })}
            />
          </Field>
        </div>
        <Field label="Farbe">
          <ColorPicker value={draft.color} onChange={(color) => set({ color })} />
        </Field>
        <div className="field">
          <span className="field-label">Wöchentliche Termine</span>
          <span className="field-hint">
            Daraus entstehen automatisch Kalendereinträge und auf Knopfdruck ein Ordner pro Termin.
          </span>
          <ScheduleEditor slots={draft.schedule} onChange={(schedule) => set({ schedule })} />
        </div>
        <Field label="Infos" hint="Sprechstunde, Moodle-Kurs, Prüfungsform …">
          <Textarea value={draft.info} rows={3} onChange={(e) => set({ info: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
