// Kleine Datums-Helfer. Alle Funktionen arbeiten mit lokaler Zeit.
import type { ISODate } from './types'

const pad = (n: number): string => String(n).padStart(2, '0')

export function toISODate(date: Date): ISODate {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseISODate(value: ISODate): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function today(): ISODate {
  return toISODate(new Date())
}

export function addDays(value: ISODate, days: number): ISODate {
  const date = parseISODate(value)
  date.setDate(date.getDate() + days)
  return toISODate(date)
}

/** Differenz in ganzen Tagen (b - a) */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime()
  return Math.round(ms / 86_400_000)
}

/** 1 = Montag … 7 = Sonntag */
export function weekday(value: ISODate): number {
  const day = parseISODate(value).getDay()
  return day === 0 ? 7 : day
}

export function startOfWeek(value: ISODate): ISODate {
  return addDays(value, 1 - weekday(value))
}

/** Erster Tag mit dem gewünschten Wochentag ab (einschließlich) `value` */
export function nextWeekday(value: ISODate, wanted: number): ISODate {
  return addDays(value, (wanted - weekday(value) + 7) % 7)
}

export function isWithin(value: ISODate, start: ISODate, end: ISODate): boolean {
  return value >= start && value <= end
}

/** Verbindet Datum und Uhrzeit ('HH:MM') zu einem Date-Objekt */
export function atTime(value: ISODate, time: string): Date {
  const date = parseISODate(value)
  const [h, m] = time.split(':').map(Number)
  date.setHours(h || 0, m || 0, 0, 0)
  return date
}

export function isoDateOf(isoDateTime: string): ISODate {
  return toISODate(new Date(isoDateTime))
}

/** '14.10.' bzw. mit Jahr '14.10.2026' */
export function shortDate(value: ISODate, withYear = false): string {
  const [y, m, d] = value.split('-')
  return withYear ? `${d}.${m}.${y}` : `${d}.${m}.`
}
