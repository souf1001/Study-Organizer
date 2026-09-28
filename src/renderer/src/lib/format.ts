// Anzeigeformate auf Deutsch.
import { diffDays, parseISODate, today, toISODate } from '@shared/dates'
import type { ISODate } from '@shared/types'

const dayFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })
const longDayFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' })
const monthFormat = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' })

export const formatDay = (date: ISODate): string => dayFormat.format(parseISODate(date))
export const formatLongDay = (date: ISODate): string => longDayFormat.format(parseISODate(date))
export const formatMonth = (date: ISODate): string => monthFormat.format(parseISODate(date))
export const formatTime = (iso: string): string => timeFormat.format(new Date(iso))

export function formatDateTime(iso: string, allDay = false): string {
  const day = formatDay(toISODate(new Date(iso)))
  return allDay ? day : `${day}, ${formatTime(iso)}`
}

export function relativeDay(date: ISODate): string {
  const days = diffDays(today(), date)
  if (days === 0) return 'heute'
  if (days === 1) return 'morgen'
  if (days === -1) return 'gestern'
  if (days > 1 && days < 14) return `in ${days} Tagen`
  if (days < -1 && days > -14) return `vor ${-days} Tagen`
  return formatDay(date)
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function greeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 5) return 'Gute Nacht'
  if (hour < 11) return 'Guten Morgen'
  if (hour < 18) return 'Hallo'
  return 'Guten Abend'
}

export const isMac = navigator.userAgent.includes('Mac')
/** '⌘' auf dem Mac, sonst 'Strg' */
export const modKey = isMac ? '⌘' : 'Strg'
