// Kalender: Woche, Monat oder Liste – Vorlesungen mit Raum, Prüfungen, Fristen, Praktika.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, Rows3 } from 'lucide-react'
import { addDays, diffDays, parseISODate, startOfWeek, today, toISODate } from '@shared/dates'
import type { CalendarEvent, CalendarViewId, ISODate } from '@shared/types'
import { useDb } from '@/lib/db'
import { formatDay, formatLongDay, formatMonth, formatTime } from '@/lib/format'
import { Button, IconButton } from '@/ui/Button'
import { Segmented } from '@/ui/Field'
import { entriesBetween, entriesOn, layoutDay, weekDays, type Entry } from './entries'
import { EntryDialog, EventDialog } from './EventDialog'
import './calendar.css'

const HOUR_HEIGHT = 48
const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

function Chip({ entry, onClick }: { entry: Entry; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`cal-chip color-${entry.color} ${entry.source} ${entry.source === 'event' ? `kind-${entry.event.kind}` : ''}`}
      onClick={onClick}
      title={`${entry.title} · ${entry.subtitle}`}
    >
      {!entry.allDay && <span className="tabular">{formatTime(entry.start.toISOString())}</span>}
      <span className="truncate">{entry.title}</span>
    </button>
  )
}

function WeekGrid({ days, entries, onSelect, onCreate }: { days: ISODate[]; entries: Entry[]; onSelect: (e: Entry) => void; onCreate: (date: ISODate, hour: number) => void }) {
  const { startHour, endHour } = useDb().settings.calendar
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(new Date())
  const day = today()

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const top = (date: Date) => ((date.getHours() - startHour) * 60 + date.getMinutes()) * (HOUR_HEIGHT / 60)
  const columns = { '--days': days.length } as CSSProperties

  return (
    <div className="week">
      <div className="week-head" style={columns}>
        <span />
        {days.map((d) => (
          <div key={d} className={`week-day ${d === day ? 'today' : ''}`}>
            <span className="small muted">{WEEKDAY_LABELS[(parseISODate(d).getDay() + 6) % 7]}</span>
            <span className="week-date">{parseISODate(d).getDate()}</span>
          </div>
        ))}
      </div>
      <div className="week-allday" style={columns}>
        <span className="small faint">Ganztags</span>
        {days.map((d) => (
          <div key={d} className="allday-cell">
            {entriesOn(entries, d)
              .filter((e) => e.allDay)
              .map((e) => (
                <Chip key={e.key} entry={e} onClick={() => onSelect(e)} />
              ))}
          </div>
        ))}
      </div>
      <div className="week-scroll" ref={scrollRef}>
        <div className="week-body" style={{ ...columns, height: hours.length * HOUR_HEIGHT }}>
          <div className="hour-labels">
            {hours.map((h) => (
              <span key={h} style={{ top: (h - startHour) * HOUR_HEIGHT }}>
                {String(h).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {days.map((d) => {
            const timed = entriesOn(entries, d).filter((e) => !e.allDay)
            const layout = layoutDay(timed)
            return (
              <div
                key={d}
                className={`day-column ${d === day ? 'today' : ''}`}
                onDoubleClick={(e) => {
                  const offset = e.clientY - e.currentTarget.getBoundingClientRect().top
                  onCreate(d, startHour + Math.floor(offset / HOUR_HEIGHT))
                }}
              >
                {hours.map((h) => (
                  <span key={h} className="hour-line" style={{ top: (h - startHour) * HOUR_HEIGHT }} />
                ))}
                {timed.map((e) => {
                  const { column, columns: count } = layout.get(e.key)!
                  const y = Math.max(0, top(e.start))
                  const height = Math.max(22, top(e.end) - y)
                  return (
                    <button
                      key={e.key}
                      type="button"
                      className={`cal-event color-${e.color} ${e.source} ${e.source === 'event' ? `kind-${e.event.kind}` : ''}`}
                      style={{ top: y, height, left: `calc(${(column / count) * 100}% + 2px)`, width: `calc(${100 / count}% - 4px)` }}
                      onClick={() => onSelect(e)}
                      onDoubleClick={(ev) => ev.stopPropagation()}
                    >
                      <span className="cal-event-title truncate">{e.title}</span>
                      <span className="cal-event-sub truncate">
                        {formatTime(e.start.toISOString())} · {e.subtitle}
                      </span>
                    </button>
                  )
                })}
                {d === day && now.getHours() >= startHour && now.getHours() < endHour && <span className="now-line" style={{ top: top(now) }} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MonthGrid({ month, entries, onSelect, onDay }: { month: ISODate; entries: Entry[]; onSelect: (e: Entry) => void; onDay: (d: ISODate) => void }) {
  const first = startOfWeek(month)
  const days = weekDays(first, 42)
  const currentMonth = month.slice(0, 7)
  const day = today()
  return (
    <div className="month">
      <div className="month-head">
        {WEEKDAY_LABELS.map((l) => (
          <span key={l} className="small muted">{l}</span>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const list = entriesOn(entries, d)
          return (
            <div key={d} className={`month-cell ${d.slice(0, 7) !== currentMonth ? 'other' : ''} ${d === day ? 'today' : ''}`} onDoubleClick={() => onDay(d)}>
              <span className="month-date">{parseISODate(d).getDate()}</span>
              {list.slice(0, 3).map((e) => (
                <Chip key={e.key} entry={e} onClick={() => onSelect(e)} />
              ))}
              {list.length > 3 && <span className="small faint">+{list.length - 3} weitere</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Agenda({ from, entries, onSelect }: { from: ISODate; entries: Entry[]; onSelect: (e: Entry) => void }) {
  const days = weekDays(from, 60).filter((d) => entriesOn(entries, d).length > 0)
  if (days.length === 0) return <p className="muted agenda-empty">In den nächsten 60 Tagen stehen keine Termine an.</p>
  return (
    <div className="agenda">
      {days.map((d) => (
        <section key={d}>
          <div className="section-title">{formatLongDay(d)}</div>
          <div className="list">
            {entriesOn(entries, d).map((e) => (
              <div key={e.key} className="list-row clickable" onClick={() => onSelect(e)}>
                <span className="home-time tabular small muted" style={{ width: 90 }}>
                  {e.allDay ? 'ganztägig' : `${formatTime(e.start.toISOString())}–${formatTime(e.end.toISOString())}`}
                </span>
                <span className={`dot color-${e.color}`} />
                <span className="truncate">
                  {e.title}
                  <span className="faint"> · {e.subtitle}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function CalendarView() {
  const db = useDb()
  const { showWeekends, defaultView } = db.settings.calendar
  const [view, setView] = useState<CalendarViewId>(defaultView)
  const [anchor, setAnchor] = useState(today())
  const [selected, setSelected] = useState<Entry | null>(null)
  const [creating, setCreating] = useState<Partial<CalendarEvent> | null>(null)

  const weekStart = startOfWeek(anchor)
  const days = weekDays(weekStart, showWeekends ? 7 : 5)
  const monthStart = `${anchor.slice(0, 7)}-01`
  const range: [ISODate, ISODate] =
    view === 'week' ? [weekStart, addDays(weekStart, 6)] : view === 'month' ? [startOfWeek(monthStart), addDays(startOfWeek(monthStart), 41)] : [today(), addDays(today(), 60)]
  const entries = entriesBetween(db, range[0], range[1])

  const step = (direction: 1 | -1) => {
    if (view === 'month') {
      const d = parseISODate(monthStart)
      d.setMonth(d.getMonth() + direction)
      setAnchor(toISODate(d))
    } else setAnchor(addDays(anchor, 7 * direction))
  }

  const title =
    view === 'month'
      ? formatMonth(monthStart)
      : view === 'week'
        ? `KW ${isoWeek(weekStart)} · ${formatDay(weekStart)} – ${formatDay(days.at(-1)!)}`
        : 'Die nächsten 60 Tage'

  const create = (date: ISODate, hour = 10) => {
    const start = new Date(`${date}T${String(hour).padStart(2, '0')}:00`)
    setCreating({ start: start.toISOString(), end: new Date(start.getTime() + 90 * 60_000).toISOString(), kind: 'other' })
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <Button size="sm" onClick={() => setAnchor(today())}>Heute</Button>
        {view !== 'agenda' && (
          <>
            <IconButton label="Zurück" onClick={() => step(-1)}><ChevronLeft /></IconButton>
            <IconButton label="Weiter" onClick={() => step(1)}><ChevronRight /></IconButton>
          </>
        )}
        <h2 className="cal-title">{title}</h2>
        <span className="spacer" />
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'week', label: 'Woche', icon: <Rows3 /> },
            { value: 'month', label: 'Monat', icon: <CalendarDays /> },
            { value: 'agenda', label: 'Liste', icon: <List /> },
          ]}
        />
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => create(anchor)}>
          Termin
        </Button>
      </div>

      {view === 'week' && <WeekGrid days={days} entries={entries} onSelect={setSelected} onCreate={create} />}
      {view === 'month' && <MonthGrid month={monthStart} entries={entries} onSelect={setSelected} onDay={(d) => create(d)} />}
      {view === 'agenda' && (
        <div className="page">
          <div className="page-inner">
            <Agenda from={today()} entries={entries} onSelect={setSelected} />
          </div>
        </div>
      )}

      {selected?.source === 'event' && <EventDialog event={selected.event} onClose={() => setSelected(null)} />}
      {selected && selected.source !== 'event' && <EntryDialog entry={selected} onClose={() => setSelected(null)} />}
      {creating && <EventDialog event={creating} onClose={() => setCreating(null)} />}
    </div>
  )
}

/** Kalenderwoche nach ISO 8601 */
function isoWeek(monday: ISODate): number {
  const thursday = addDays(monday, 3)
  const yearStart = `${thursday.slice(0, 4)}-01-01`
  return Math.floor(diffDays(yearStart, thursday) / 7) + 1
}
