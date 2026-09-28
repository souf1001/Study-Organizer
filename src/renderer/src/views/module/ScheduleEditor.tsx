// Wöchentliche Termine eines Moduls bearbeiten (Vorlesung, Übung, Praktikum …).
import { Plus, Trash2 } from 'lucide-react'
import { newSlot } from '@shared/defaults'
import { SESSION_LABELS } from '@shared/schedule'
import type { ScheduleSlot, SessionKind } from '@shared/types'
import { Button, IconButton } from '@/ui/Button'
import { Select } from '@/ui/Field'

export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

const kindOptions = (Object.keys(SESSION_LABELS) as SessionKind[]).map((k) => ({ value: k, label: SESSION_LABELS[k] }))
const weekdayOptions = WEEKDAYS.map((label, i) => ({ value: i + 1, label }))

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = (h * 60 + m + minutes) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function ScheduleEditor({ slots, onChange }: { slots: ScheduleSlot[]; onChange: (slots: ScheduleSlot[]) => void }) {
  const update = (id: string, values: Partial<ScheduleSlot>) =>
    onChange(slots.map((s) => (s.id === id ? { ...s, ...values } : s)))

  return (
    <div className="schedule-editor">
      {slots.map((slot) => (
        <div key={slot.id} className="slot-row">
          <Select value={slot.kind} options={kindOptions} onChange={(kind) => update(slot.id, { kind })} aria-label="Art" />
          <Select value={slot.weekday} options={weekdayOptions} onChange={(weekday) => update(slot.id, { weekday })} aria-label="Wochentag" />
          <input
            className="input"
            type="time"
            value={slot.start}
            aria-label="Beginn"
            onChange={(e) => update(slot.id, { start: e.target.value, end: addMinutes(e.target.value, 90) })}
          />
          <input className="input" type="time" value={slot.end} aria-label="Ende" onChange={(e) => update(slot.id, { end: e.target.value })} />
          <input
            className="input"
            placeholder="Raum, z. B. D14/0.04"
            value={slot.room}
            aria-label="Raum"
            onChange={(e) => update(slot.id, { room: e.target.value })}
          />
          <IconButton label="Termin entfernen" onClick={() => onChange(slots.filter((s) => s.id !== slot.id))}>
            <Trash2 />
          </IconButton>
          <label className="slot-options small muted">
            <input
              type="checkbox"
              className="checkbox"
              checked={slot.everyTwoWeeks}
              onChange={(e) => update(slot.id, { everyTwoWeeks: e.target.checked })}
            />
            alle 2 Wochen
          </label>
          <label className="slot-options small muted">
            ab
            <input
              className="input input-date"
              type="date"
              value={slot.firstDate ?? ''}
              aria-label="Erster Termin"
              onChange={(e) => update(slot.id, { firstDate: e.target.value || null })}
            />
          </label>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus />}
        onClick={() => {
          const previous = slots.at(-1)
          onChange([...slots, newSlot(previous ? { kind: previous.kind === 'lecture' ? 'exercise' : 'lecture', room: previous.room } : {})])
        }}
      >
        Termin hinzufügen
      </Button>
    </div>
  )
}
