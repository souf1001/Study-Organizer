import { beforeEach, describe, expect, it } from 'vitest'
import { isIcsDownload } from '../src/main/tucan-session'
import {
  normalizeCalendarUrl,
  maskCalendarUrl,
  mergeSubscriptionEvents,
} from '../src/backend/ics'
import type { CalendarEvent } from '../src/shared/types'
import { createService } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DownloadItem } from 'electron'

function mockDownloadItem(options: {
  filename?: string
  mime?: string
  url?: string
}): DownloadItem {
  return {
    getFilename: () => options.filename ?? '',
    getMimeType: () => options.mime ?? '',
    getURL: () => options.url ?? '',
  } as unknown as DownloadItem
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

describe('Challenger M3 Adversarial & Edge Case Suite', () => {
  describe('1. Scheme Normalization & Validation', () => {
    it('normalizes webcal:// to https://', () => {
      expect(normalizeCalendarUrl('webcal://tu-darmstadt.de/cal.ics')).toBe(
        'https://tu-darmstadt.de/cal.ics',
      )
    })

    it('normalizes webcals:// to https://', () => {
      expect(normalizeCalendarUrl('webcals://tu-darmstadt.de/cal.ics')).toBe(
        'https://tu-darmstadt.de/cal.ics',
      )
    })

    it('normalizes case-insensitive WEBCAL:// and WEBCALS://', () => {
      expect(normalizeCalendarUrl('WEBCAL://tu-darmstadt.de/cal.ics')).toBe(
        'https://tu-darmstadt.de/cal.ics',
      )
      expect(normalizeCalendarUrl('WebCal://tu-darmstadt.de/cal.ics')).toBe(
        'https://tu-darmstadt.de/cal.ics',
      )
      expect(normalizeCalendarUrl('WebCals://tu-darmstadt.de/cal.ics')).toBe(
        'https://tu-darmstadt.de/cal.ics',
      )
    })

    it('preserves existing https:// and http:// schemes', () => {
      expect(normalizeCalendarUrl('https://example.com/cal.ics')).toBe('https://example.com/cal.ics')
      expect(normalizeCalendarUrl('http://insecure.example.com/feed')).toBe(
        'http://insecure.example.com/feed',
      )
    })

    it('trims leading and trailing whitespace', () => {
      expect(normalizeCalendarUrl('  webcal://tu-darmstadt.de/cal.ics  \n')).toBe(
        'https://tu-darmstadt.de/cal.ics',
      )
    })

    it('rejects disallowed schemes', () => {
      const dangerousSchemes = [
        'file:///etc/passwd',
        'file:///C:/Windows/win.ini',
        'javascript:alert(1)',
        'data:text/calendar,BEGIN:VCALENDAR...',
        'ftp://example.com/cal.ics',
        'smb://server/share/cal.ics',
      ]
      for (const url of dangerousSchemes) {
        expect(() => normalizeCalendarUrl(url)).toThrow('Nur http(s)- oder webcal-Adressen')
      }
    })

    it('isValidFeedUrl replicates UI validation accurately', () => {
      expect(isValidFeedUrl('webcal://tu-darmstadt.de/cal.ics')).toBe(true)
      expect(isValidFeedUrl('webcals://tu-darmstadt.de/cal.ics')).toBe(true)
      expect(isValidFeedUrl('https://tu-darmstadt.de/cal.ics')).toBe(true)
      expect(isValidFeedUrl('http://tu-darmstadt.de/cal.ics')).toBe(true)

      // Invalid schemes
      expect(isValidFeedUrl('file:///etc/passwd')).toBe(false)
      expect(isValidFeedUrl('javascript:alert(1)')).toBe(false)
      expect(isValidFeedUrl('ftp://example.com/feed.ics')).toBe(false)
      expect(isValidFeedUrl('chrome://settings')).toBe(false)

      // Malformed URLs
      expect(isValidFeedUrl('')).toBe(false)
      expect(isValidFeedUrl('   ')).toBe(false)
      expect(isValidFeedUrl('webcal://')).toBe(false)
      expect(isValidFeedUrl('https://')).toBe(false)
      expect(isValidFeedUrl('not a url')).toBe(false)
      expect(isValidFeedUrl('http:// invalid domain.com')).toBe(false)
    })
  })

  describe('2. URL Masking', () => {
    it('masks secret query parameters in calendar URLs', () => {
      const url = 'https://moodle.tu-darmstadt.de/calendar/export.php?userid=123&authtoken=secrettoken999'
      const masked = maskCalendarUrl(url)
      expect(masked).toContain('moodle.tu-darmstadt.de')
      expect(masked).toContain('/calendar/export.php?…')
      expect(masked).not.toContain('secrettoken999')
      expect(masked).not.toContain('userid=123')
    })

    it('displays path without query suffix when no search params exist', () => {
      const url = 'https://moodle.tu-darmstadt.de/calendar/export.ics'
      const masked = maskCalendarUrl(url)
      expect(masked).toBe('moodle.tu-darmstadt.de/calendar/export.ics')
    })
  })

  describe('3. isIcsDownload Filter in TUCaN Wizard', () => {
    it('accepts standard .ics extension', () => {
      const item = mockDownloadItem({
        filename: 'stundenplan.ics',
        mime: 'application/octet-stream',
        url: 'https://tucan.tu-darmstadt.de/export',
      })
      expect(isIcsDownload(item)).toBe(true)
    })

    it('accepts uppercase .ICS extension', () => {
      const item = mockDownloadItem({
        filename: 'TIMETABLE.ICS',
        mime: 'application/octet-stream',
        url: 'https://tucan.tu-darmstadt.de/export',
      })
      expect(isIcsDownload(item)).toBe(true)
    })

    it('accepts text/calendar MIME type regardless of filename', () => {
      const item = mockDownloadItem({
        filename: 'export',
        mime: 'text/calendar',
        url: 'https://tucan.tu-darmstadt.de/export',
      })
      expect(isIcsDownload(item)).toBe(true)
    })

    it('accepts application/ics MIME type', () => {
      const item = mockDownloadItem({
        filename: 'export',
        mime: 'application/ics',
        url: 'https://tucan.tu-darmstadt.de/export',
      })
      expect(isIcsDownload(item)).toBe(true)
    })

    it('accepts URL ending in .ics or containing format=ics', () => {
      const item1 = mockDownloadItem({
        filename: 'download',
        mime: 'application/octet-stream',
        url: 'https://tucan.tu-darmstadt.de/export.ics',
      })
      expect(isIcsDownload(item1)).toBe(true)

      const item2 = mockDownloadItem({
        filename: 'download',
        mime: 'application/octet-stream',
        url: 'https://tucan.tu-darmstadt.de/scripts/mgrqispi.dll?APPNAME=CampusNet&format=ics',
      })
      expect(isIcsDownload(item2)).toBe(true)
    })

    it('rejects non-calendar file downloads (PDF, HTML, images, executables)', () => {
      const nonCalendarItems = [
        { filename: 'syllabus.pdf', mime: 'application/pdf', url: 'https://tucan.tu-darmstadt.de/syllabus.pdf' },
        { filename: 'login.html', mime: 'text/html', url: 'https://tucan.tu-darmstadt.de/login' },
        { filename: 'logo.png', mime: 'image/png', url: 'https://tucan.tu-darmstadt.de/logo.png' },
        { filename: 'setup.exe', mime: 'application/x-msdownload', url: 'https://tucan.tu-darmstadt.de/setup.exe' },
        { filename: 'grades.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'https://tucan.tu-darmstadt.de/grades.xlsx' },
        { filename: 'notes.txt', mime: 'text/plain', url: 'https://tucan.tu-darmstadt.de/notes.txt' },
      ]

      for (const item of nonCalendarItems) {
        expect(isIcsDownload(mockDownloadItem(item))).toBe(false)
      }
    })

    it('rejects files where filename merely has ics as substring inside another extension', () => {
      const item = mockDownloadItem({
        filename: 'physics_notes.pdf',
        mime: 'application/pdf',
        url: 'https://tucan.tu-darmstadt.de/notes.pdf',
      })
      expect(isIcsDownload(item)).toBe(false)
    })
  })

  describe('4. Subscription Removal & Event Cleanup', () => {
    let dir: string
    let store: Store

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m3-'))
      store = await Store.open(dir)
    })

    it('calendarUnsubscribe removes subscription and cascades removal of all associated events', async () => {
      const secrets = {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      }
      const service = createService(store, secrets)

      // Add subscription and events
      const subId = 'sub-test-123'
      const otherSubId = 'sub-test-456'

      store.put('subscriptions', {
        id: subId,
        name: 'TUCaN Timetable',
        kind: 'file',
        url: 'tucan.ics',
        enabled: true,
        lastSync: null,
        lastError: null,
      })
      store.put('subscriptions', {
        id: otherSubId,
        name: 'Moodle',
        kind: 'url',
        url: 'https://moodle.de/cal.ics',
        enabled: true,
        lastSync: null,
        lastError: null,
      })

      store.put('events', {
        id: 'ev-1',
        subscriptionId: subId,
        externalId: 'ext-1',
        title: 'TUCaN Event 1',
        start: '2026-10-12T08:00:00Z',
        end: '2026-10-12T09:30:00Z',
        allDay: false,
        moduleId: null,
        location: '',
        notes: '',
        kind: 'lecture',
      })
      store.put('events', {
        id: 'ev-2',
        subscriptionId: subId,
        externalId: 'ext-2',
        title: 'TUCaN Event 2',
        start: '2026-10-13T10:00:00Z',
        end: '2026-10-13T11:30:00Z',
        allDay: false,
        moduleId: null,
        location: '',
        notes: '',
        kind: 'exercise',
      })
      store.put('events', {
        id: 'ev-3',
        subscriptionId: otherSubId,
        externalId: 'ext-3',
        title: 'Moodle Event',
        start: '2026-10-14T10:00:00Z',
        end: '2026-10-14T11:30:00Z',
        allDay: false,
        moduleId: null,
        location: '',
        notes: '',
        kind: 'deadline',
      })
      store.put('events', {
        id: 'ev-4',
        subscriptionId: null,
        externalId: null,
        title: 'Manual Event',
        start: '2026-10-15T10:00:00Z',
        end: '2026-10-15T11:30:00Z',
        allDay: false,
        moduleId: null,
        location: '',
        notes: '',
        kind: 'other',
      })

      expect(store.get().subscriptions).toHaveLength(2)
      expect(store.get().events).toHaveLength(4)

      // Unsubscribe subId
      await service.calendarUnsubscribe(subId)

      const dbAfter = store.get()
      expect(dbAfter.subscriptions.find((s) => s.id === subId)).toBeUndefined()
      expect(dbAfter.subscriptions.find((s) => s.id === otherSubId)).toBeDefined()

      // TUCaN events should be gone, Moodle and manual events must remain
      expect(dbAfter.events.find((e) => e.subscriptionId === subId)).toBeUndefined()
      expect(dbAfter.events.find((e) => e.subscriptionId === otherSubId)).toBeDefined()
      expect(dbAfter.events.find((e) => e.id === 'ev-4')).toBeDefined()
      expect(dbAfter.events).toHaveLength(2)

      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    })
  })

  describe('5. mergeSubscriptionEvents Deduplication', () => {
    it('replaces existing event when same externalId arrives in incoming feed', () => {
      const now = new Date('2026-10-23T12:00:00Z')
      const existing: CalendarEvent[] = [
        {
          id: 'old-1',
          subscriptionId: 'sub-1',
          externalId: 'uid-lecture-1',
          title: 'Alte Vorlesung',
          start: '2026-10-20T08:00:00Z', // older than 3 days cutoff
          end: '2026-10-20T09:30:00Z',
          allDay: false,
          moduleId: null,
          location: '',
          notes: '',
          kind: 'lecture',
        },
      ]

      const incoming: CalendarEvent[] = [
        {
          id: 'new-1',
          subscriptionId: 'sub-1',
          externalId: 'uid-lecture-1',
          title: 'Aktualisierte Vorlesung',
          start: '2026-10-20T08:00:00Z',
          end: '2026-10-20T09:30:00Z',
          allDay: false,
          moduleId: null,
          location: '',
          notes: '',
          kind: 'lecture',
        },
      ]

      const merged = mergeSubscriptionEvents(existing, incoming, now)
      expect(merged).toHaveLength(1)
      expect(merged[0].title).toBe('Aktualisierte Vorlesung')
      expect(merged[0].id).toBe('new-1')
    })

    it('preserves older historical events not in incoming window if externalId not duplicated', () => {
      const now = new Date('2026-10-23T12:00:00Z')
      const existing: CalendarEvent[] = [
        {
          id: 'hist-1',
          subscriptionId: 'sub-1',
          externalId: 'uid-past-exam',
          title: 'Alte Klausur',
          start: '2026-09-15T08:00:00Z', // well before cutoff
          end: '2026-09-15T10:00:00Z',
          allDay: false,
          moduleId: null,
          location: '',
          notes: '',
          kind: 'exam',
        },
      ]

      const incoming: CalendarEvent[] = [
        {
          id: 'curr-1',
          subscriptionId: 'sub-1',
          externalId: 'uid-current-lecture',
          title: 'Aktuelle Vorlesung',
          start: '2026-10-24T08:00:00Z',
          end: '2026-10-24T09:30:00Z',
          allDay: false,
          moduleId: null,
          location: '',
          notes: '',
          kind: 'lecture',
        },
      ]

      const merged = mergeSubscriptionEvents(existing, incoming, now)
      expect(merged).toHaveLength(2)
      expect(merged.map((e) => e.externalId)).toContain('uid-past-exam')
      expect(merged.map((e) => e.externalId)).toContain('uid-current-lecture')
    })
  })
})
