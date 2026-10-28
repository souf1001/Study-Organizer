import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { maskCalendarUrl, normalizeCalendarUrl } from '../src/backend/ics'
import type { CalendarEvent, Subscription } from '../src/shared/types'

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, value: string) => void data.set(name, value),
    remove: async (name: string) => void data.delete(name),
  }
}

function vcal(body: string, prodid = '-//TU Darmstadt//TUCaN//DE'): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:${prodid}\r\nCALSCALE:GREGORIAN\r\n${body}\r\nEND:VCALENDAR\r\n`
}

function vevent(p: {
  uid: string
  summary: string
  start: string
  end?: string
  location?: string
  description?: string
  categories?: string[]
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`]
  lines.push(`SUMMARY:${p.summary}`)
  lines.push(`DTSTART:${p.start}`)
  if (p.end) lines.push(`DTEND:${p.end}`)
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  if (p.categories?.length) lines.push(`CATEGORIES:${p.categories.join(',')}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

/**
 * Mirror the frontend isValidFeedUrl implementation from IntegrationSettings.tsx
 */
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

describe('Challenger M3-2: IntegrationSettings UI, WebCal URL Validation & Subscription Lifecycle', () => {
  let tmpDir: string
  let store: Store
  let secrets: ReturnType<typeof memorySecrets>

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m3-2-'))
    store = await Store.open(tmpDir)
    secrets = memorySecrets()
  })

  afterEach(async () => {
    await store.flush()
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ==========================================================================
  // Suite 1: WebCal URL Validation & Scheme Testing (Adversarial)
  // ==========================================================================
  describe('WebCal URL Validation & Scheme Robustness', () => {
    describe('Frontend isValidFeedUrl()', () => {
      it('rejects forbidden and malicious schemes', () => {
        const forbidden = [
          'ftp://ftp.tu-darmstadt.de/calendar.ics',
          'javascript:alert(1)',
          'javascript:void(0)',
          'file:///C:/Users/student/calendar.ics',
          'file:///etc/passwd',
          'data:text/calendar;base64,QkVHSU46VkNBTEVOREFSCg==',
          'blob:https://campus.tu-darmstadt.de/b45c-1234',
          'mailto:stundenplan@tu-darmstadt.de',
          'ws://stream.tu-darmstadt.de/cal',
          'wss://stream.tu-darmstadt.de/cal',
          'gopher://gopher.example.edu/cal.ics',
          'ldap://ldap.tu-darmstadt.de/cal',
          'ssh://git@github.com:repo.git',
          'about:blank',
          'view-source:https://tu-darmstadt.de',
        ]

        for (const url of forbidden) {
          expect(isValidFeedUrl(url), `Should reject scheme for "${url}"`).toBe(false)
        }
      })

      it('accepts all valid calendar feed schemes (webcal, webcals, http, https)', () => {
        const valid = [
          'webcal://www.tucan.tu-darmstadt.de/timetable.ics',
          'webcals://campus.tu-darmstadt.de/feed.ics',
          'http://lernen.h-da.de/cal.ics',
          'https://moodle.tu-darmstadt.de/calendar/export_execute.php?userid=123&authtoken=abc',
          'WEBCAL://WWW.TUCAN.TU-DARMSTADT.DE/CAL.ICS',
          'WebCals://Campus.Example.De/feed.ics',
          'HTTP://example.com/cal.ics',
          'HTTPS://example.com/cal.ics',
          'https://obs.fbi.h-da.de/obs/index.php?action=getTerminplan&token=xyz123',
        ]

        for (const url of valid) {
          expect(isValidFeedUrl(url), `Should accept valid URL "${url}"`).toBe(true)
        }
      })

      it('handles whitespace, edge cases, and malformed URLs safely without crashing', () => {
        const invalid = [
          '',
          '   ',
          '\t\n\r',
          'webcal://',
          'webcals://',
          'https://',
          'http://',
          'not-a-valid-url',
          'https://:80/path',
          'https://[invalid-ipv6/cal.ics',
          'webcal:/missing-slash.de',
          '://no-scheme.com',
        ]

        for (const url of invalid) {
          expect(isValidFeedUrl(url), `Should reject malformed URL "${url}"`).toBe(false)
        }
      })

      it('handles URLs with leading/trailing whitespace gracefully', () => {
        expect(isValidFeedUrl('   https://moodle.tu-darmstadt.de/cal.ics   ')).toBe(true)
        expect(isValidFeedUrl('  webcal://campus.de/cal.ics\n')).toBe(true)
      })

      it('handles URLs with ports, query parameters, auth tokens, and internationalized domain names', () => {
        expect(isValidFeedUrl('webcal://campus.tu-darmstadt.de:8443/cal.ics')).toBe(true)
        expect(
          isValidFeedUrl('https://moodle.tu-darmstadt.de/export.php?id=1&token=sec!@$%^*()'),
        ).toBe(true)
        expect(isValidFeedUrl('https://münchen-hochschule.de/kalender.ics')).toBe(true)
        expect(isValidFeedUrl('https://127.0.0.1:8080/cal.ics')).toBe(true)
      })
    })

    describe('Backend normalizeCalendarUrl() & maskCalendarUrl()', () => {
      it('backend rejects invalid schemes with specific Error message', () => {
        const forbidden = [
          'ftp://ftp.tu-darmstadt.de/cal.ics',
          'javascript:alert(1)',
          'file:///etc/passwd',
          'data:text/calendar;base64,Q==',
        ]

        for (const url of forbidden) {
          expect(() => normalizeCalendarUrl(url)).toThrow('Nur http(s)- oder webcal-Adressen')
        }
      })

      it('normalizes webcal:// and webcals:// to https://', () => {
        expect(normalizeCalendarUrl('webcal://tucan.tu-darmstadt.de/cal.ics')).toBe(
          'https://tucan.tu-darmstadt.de/cal.ics',
        )
        expect(normalizeCalendarUrl('webcals://tucan.tu-darmstadt.de/cal.ics')).toBe(
          'https://tucan.tu-darmstadt.de/cal.ics',
        )
        expect(normalizeCalendarUrl('http://insecure.h-da.de/cal.ics')).toBe(
          'http://insecure.h-da.de/cal.ics',
        )
        expect(normalizeCalendarUrl('https://secure.h-da.de/cal.ics')).toBe(
          'https://secure.h-da.de/cal.ics',
        )
      })

      it('maskCalendarUrl protects authentication tokens and sensitive parameters', () => {
        const sensitive1 =
          'https://moodle.tu-darmstadt.de/export.php?userid=12345&authtoken=supersecrettoken999'
        const masked1 = maskCalendarUrl(sensitive1)
        expect(masked1).not.toContain('supersecrettoken999')
        expect(masked1).not.toContain('12345')
        expect(masked1).toBe('moodle.tu-darmstadt.de/export.php?…')

        const sensitive2 = 'webcal://obs.fbi.h-da.de/index.php?token=mysecretpassword'
        const masked2 = maskCalendarUrl(sensitive2)
        expect(masked2).not.toContain('mysecretpassword')
        expect(masked2).toBe('obs.fbi.h-da.de/index.php?…')

        const noParams = 'https://tu-darmstadt.de/public/semester.ics'
        const maskedNoParams = maskCalendarUrl(noParams)
        expect(maskedNoParams).toBe('tu-darmstadt.de/public/semester.ics')
      })
    })
  })

  // ==========================================================================
  // Suite 2: Name Validation (Empty / Whitespace / Fallback Handling)
  // ==========================================================================
  describe('Name Validation & Fallbacks', () => {
    it('frontend prevents form submission when feedName is empty or only whitespace', () => {
      const checkForm = (name: string, url: string) => name.trim().length > 0 && isValidFeedUrl(url)

      expect(checkForm('', 'https://campus.de/cal.ics')).toBe(false)
      expect(checkForm('   ', 'https://campus.de/cal.ics')).toBe(false)
      expect(checkForm('\t\n', 'https://campus.de/cal.ics')).toBe(false)
      expect(checkForm('TUCaN Vorlesungsplan', 'https://campus.de/cal.ics')).toBe(true)
    })

    it('backend calendarSubscribe provides robust fallback to hostname if name is empty or whitespace', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(vcal(''))) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub1 = await service.calendarSubscribe('   ', 'https://moodle.tu-darmstadt.de/feed.ics')
      expect(sub1.name).toBe('moodle.tu-darmstadt.de')

      const sub2 = await service.calendarSubscribe('', 'webcal://campus.h-da.de/plan.ics')
      expect(sub2.name).toBe('campus.h-da.de')
    })

    it('preserves valid names with special characters, Umlauts, and trims excess whitespace', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(vcal(''))) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub = await service.calendarSubscribe(
        '  Höhere Mathematik II & Übungen (WS 26/27)  ',
        'https://uni.de/cal.ics',
      )
      expect(sub.name).toBe('Höhere Mathematik II & Übungen (WS 26/27)')
    })
  })

  // ==========================================================================
  // Suite 3: Subscription Lifecycle: Sync Resilience & Error Handling
  // ==========================================================================
  describe('Subscription Lifecycle: Sync Robustness & Non-freezing Guarantees', () => {
    it('calendarSync handles HTTP 404, 500, 503 errors without throwing unhandled rejection', async () => {
      let status = 404
      const mockFetch = vi.fn().mockImplementation(async () => {
        return new Response('Not Found', { status, statusText: 'Not Found' })
      }) as unknown as typeof fetch

      const service = createService(store, secrets, { fetchImpl: mockFetch })
      const sub = await service.calendarSubscribe('Test Feed', 'https://campus.de/cal.ics')

      // Initial subscribe calls sync, which caught the error
      expect(sub.lastError).toContain('HTTP 404')

      // Manual sync call should also return error object without throwing
      status = 503
      const res503 = await service.calendarSync(sub.id)
      expect(res503.count).toBe(0)
      expect(res503.error).toContain('HTTP 503')

      const updatedSub = store.get().subscriptions.find((s) => s.id === sub.id)
      expect(updatedSub?.lastError).toContain('HTTP 503')
    })

    it('calendarSync handles network timeouts and aborts gracefully without unhandled rejections', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error('Network request failed: timeout')) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub = await service.calendarSubscribe(
        'Network Timeout Feed',
        'https://campus.de/cal.ics',
      )
      expect(sub.lastError).toBe('Network request failed: timeout')

      const res = await service.calendarSync(sub.id)
      expect(res.count).toBe(0)
      expect(res.error).toBe('Network request failed: timeout')
    })

    it('calendarSync handles non-calendar / garbage payload safely', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('<!DOCTYPE html><html><body>Error 500 Internal Error</body></html>', {
          status: 200,
        }),
      ) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub = await service.calendarSubscribe('HTML Response Feed', 'https://campus.de/cal.ics')
      expect(sub.lastError).toContain('keinen iCal-Kalender')
    })

    it('calendarSync gracefully drops sync results if subscription was removed while fetch was in-flight', async () => {
      let resolveFetch!: (res: Response) => void
      const pendingFetch = new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
      const mockFetch = vi.fn().mockReturnValue(pendingFetch) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      // Directly put subscription in store & secrets without triggering calendarSubscribe's await calendarSync
      const sub: Subscription = {
        id: 'concurrent-sub',
        name: 'Concurrent Feed',
        kind: 'url',
        url: 'campus.de/cal.ics',
        enabled: true,
        lastSync: null,
        lastError: null,
      }
      store.put('subscriptions', sub)
      await secrets.set(`ics:${sub.id}`, 'https://campus.de/cal.ics')

      // Start sync
      const syncPromise = service.calendarSync(sub.id)

      // Concurrent removal while fetch is in-flight!
      await service.calendarUnsubscribe(sub.id)
      expect(store.get().subscriptions.find((s) => s.id === sub.id)).toBeUndefined()

      // Now resolve the fetch with events
      const icsData = vcal(
        vevent({
          uid: 'late-1',
          summary: 'Late Event',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      resolveFetch(new Response(icsData))

      const result = await syncPromise
      expect(result.count).toBe(0)
      expect(result.error).toBeNull()

      // Crucial: No events should have been written for the removed subscription!
      expect(store.get().events.filter((e) => e.subscriptionId === sub.id)).toHaveLength(0)
    })

    it('deduplicates and merges events across multiple sync cycles without event ballooning', async () => {
      const icsData = vcal(
        vevent({
          uid: 'ev-1',
          summary: 'Mathematik I',
          start: '20261015T080000Z',
          end: '20261015T100000Z',
        }) +
          vevent({
            uid: 'ev-2',
            summary: 'Physik I',
            start: '20261016T080000Z',
            end: '20261016T100000Z',
          }),
      )
      const mockFetch = vi
        .fn()
        .mockImplementation(() => new Response(icsData)) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub = await service.calendarSubscribe('Uni Feed', 'https://campus.de/cal.ics')
      expect(store.get().events.filter((e) => e.subscriptionId === sub.id)).toHaveLength(2)

      // Sync again with identical data
      const res2 = await service.calendarSync(sub.id)
      expect(res2.count).toBe(2)
      // Exactly 2 events must remain (no duplicate event records created)
      expect(store.get().events.filter((e) => e.subscriptionId === sub.id)).toHaveLength(2)
    })
  })

  // ==========================================================================
  // Suite 4: Subscription Lifecycle: Removal & Cascade Integrity
  // ==========================================================================
  describe('Subscription Lifecycle: Removal & Cascading Deletions', () => {
    it('calendarUnsubscribe deletes subscription, secret token, and cascades all associated events', async () => {
      const icsData = vcal(
        vevent({
          uid: 'ev-sub1',
          summary: 'Sub 1 Event',
          start: '20261015T080000Z',
          end: '20261015T100000Z',
        }),
      )
      const mockFetch = vi.fn().mockResolvedValue(new Response(icsData)) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub1 = await service.calendarSubscribe('Sub 1', 'https://campus.de/cal.ics?secret=tok1')
      expect(await secrets.get(`ics:${sub1.id}`)).toBe('https://campus.de/cal.ics?secret=tok1')
      expect(store.get().events.filter((e) => e.subscriptionId === sub1.id)).toHaveLength(1)

      // Add a manual independent event that must NOT be deleted
      const manualEvent: CalendarEvent = {
        id: 'manual-ev',
        title: 'Eigene Lerngruppe',
        start: '20261018T100000Z',
        end: '20261018T120000Z',
        allDay: false,
        kind: 'other',
        moduleId: null,
        location: 'Bib',
        notes: '',
        subscriptionId: null,
        externalId: null,
      }
      store.put('events', manualEvent)

      // Now unsubscribe
      await service.calendarUnsubscribe(sub1.id)

      // 1. Subscription removed from store
      expect(store.get().subscriptions.find((s) => s.id === sub1.id)).toBeUndefined()
      // 2. Secret removed from secrets store
      expect(await secrets.get(`ics:${sub1.id}`)).toBeNull()
      // 3. Events belonging to subscription removed
      expect(store.get().events.filter((e) => e.subscriptionId === sub1.id)).toHaveLength(0)
      // 4. Independent manual events remain intact
      expect(store.get().events.find((e) => e.id === 'manual-ev')).toBeDefined()
    })

    it('removing one subscription leaves other subscriptions and their events untouched', async () => {
      const ics1 = vcal(
        vevent({
          uid: 'ev-1',
          summary: 'Sub 1 Event',
          start: '20261015T080000Z',
          end: '20261015T100000Z',
        }),
      )
      const ics2 = vcal(
        vevent({
          uid: 'ev-2',
          summary: 'Sub 2 Event',
          start: '20261016T080000Z',
          end: '20261016T100000Z',
        }),
      )

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(ics1))
        .mockResolvedValueOnce(new Response(ics2)) as unknown as typeof fetch

      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub1 = await service.calendarSubscribe('Sub 1', 'https://campus.de/cal1.ics')
      const sub2 = await service.calendarSubscribe('Sub 2', 'https://campus.de/cal2.ics')

      expect(store.get().subscriptions).toHaveLength(2)
      expect(store.get().events).toHaveLength(2)

      // Delete sub1
      await service.calendarUnsubscribe(sub1.id)

      // sub2 and its event remain completely intact
      expect(store.get().subscriptions).toHaveLength(1)
      expect(store.get().subscriptions[0].id).toBe(sub2.id)
      expect(store.get().events).toHaveLength(1)
      expect(store.get().events[0].subscriptionId).toBe(sub2.id)
      expect(await secrets.get(`ics:${sub2.id}`)).toBeDefined()
    })

    it('calendarUnsubscribe handles non-existent IDs gracefully without throwing', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(vcal(''))) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      await expect(service.calendarUnsubscribe('non-existent-id')).resolves.not.toThrow()
    })
  })

  // ==========================================================================
  // Suite 5: IntegrationSettings UI Logic & State Flow Simulation
  // ==========================================================================
  describe('IntegrationSettings UI Handlers & State Machine Simulation', () => {
    it('handleSubscribe rejects empty names and invalid URLs before calling API', async () => {
      const apiSubscribe = vi.fn()
      const mockToastError = vi.fn()

      const runSubscribe = async (feedName: string, feedUrl: string) => {
        const name = feedName.trim()
        const url = feedUrl.trim()
        if (!name) {
          mockToastError(new Error('Bitte gib einen Namen für den Kalender ein.'))
          return
        }
        if (!isValidFeedUrl(url)) {
          mockToastError(
            new Error(
              'Ungültige Kalender-URL. Erlaubte Protokolle sind webcal://, https:// oder http://.',
            ),
          )
          return
        }
        await apiSubscribe(name, url)
      }

      // Empty name
      await runSubscribe('  ', 'https://campus.de/cal.ics')
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Namen') }),
      )
      expect(apiSubscribe).not.toHaveBeenCalled()

      mockToastError.mockClear()

      // Invalid URL
      await runSubscribe('Valid Name', 'ftp://campus.de/cal.ics')
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Ungültige Kalender-URL') }),
      )
      expect(apiSubscribe).not.toHaveBeenCalled()
    })

    it('handleSync sets and clears syncingId in finally block even when API throws', async () => {
      const mockApiSync = vi.fn().mockRejectedValue(new Error('Sync failed unexpectedly'))
      const mockToastError = vi.fn()
      let syncingId: string | null = null

      const handleSync = async (subId: string) => {
        syncingId = subId
        try {
          await mockApiSync(subId)
        } catch (err) {
          mockToastError(err)
        } finally {
          syncingId = null
        }
      }

      await handleSync('sub-123')
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Sync failed unexpectedly' }),
      )
      // Must NOT remain stuck in syncing state!
      expect(syncingId).toBeNull()
    })

    it('handleRemove checks confirmation dialog and supports removeSubscription / unsubscribe fallback', async () => {
      const mockConfirm = vi.fn()
      const mockRemove = vi.fn().mockResolvedValue(undefined)
      const mockLoadDb = vi.fn().mockResolvedValue(undefined)
      const mockToast = vi.fn()

      const handleRemove = async (
        sub: Subscription,
        api: {
          removeSubscription?: (id: string) => Promise<void>
          unsubscribe?: (id: string) => Promise<void>
        },
      ) => {
        const ok = await mockConfirm({
          title: `„${sub.name}“ entfernen?`,
          message: 'Alle zugehörigen Termine werden aus dem Kalender gelöscht.',
          confirmLabel: 'Entfernen',
          danger: true,
        })
        if (!ok) return
        const removeFn = api.removeSubscription ?? api.unsubscribe
        if (removeFn) {
          await removeFn(sub.id)
        }
        await mockLoadDb()
        mockToast(`„${sub.name}“ wurde entfernt`)
      }

      const testSub: Subscription = {
        id: 's-1',
        name: 'TUCaN Plan',
        kind: 'file',
        url: 'local.ics',
        enabled: true,
        lastSync: null,
        lastError: null,
      }

      // 1. User cancels confirm
      mockConfirm.mockResolvedValueOnce(false)
      await handleRemove(testSub, { removeSubscription: mockRemove })
      expect(mockRemove).not.toHaveBeenCalled()
      expect(mockLoadDb).not.toHaveBeenCalled()

      // 2. User confirms -> uses removeSubscription
      mockConfirm.mockResolvedValueOnce(true)
      await handleRemove(testSub, { removeSubscription: mockRemove })
      expect(mockRemove).toHaveBeenCalledWith('s-1')
      expect(mockLoadDb).toHaveBeenCalled()
      expect(mockToast).toHaveBeenCalledWith('„TUCaN Plan“ wurde entfernt')

      // 3. User confirms -> fallback to unsubscribe if removeSubscription undefined
      mockRemove.mockClear()
      const mockUnsubscribe = vi.fn().mockResolvedValue(undefined)
      mockConfirm.mockResolvedValueOnce(true)
      await handleRemove(testSub, { unsubscribe: mockUnsubscribe })
      expect(mockUnsubscribe).toHaveBeenCalledWith('s-1')
    })

    it('handleStartTucanWizard manages tucanBusy state and handles cancellation vs error', async () => {
      let tucanBusy = false
      const mockToast = vi.fn()
      const mockToastError = vi.fn()

      const handleWizard = async (
        wizardFn: () => Promise<{ success: boolean; count?: number; error?: string }>,
      ) => {
        tucanBusy = true
        try {
          const res = await wizardFn()
          if (res.success) {
            mockToast(`${res.count} Termine importiert`)
          } else if (res.error && !res.error.toLowerCase().includes('abgebrochen')) {
            mockToastError(new Error(res.error))
          } else if (res.error && res.error.toLowerCase().includes('abgebrochen')) {
            mockToast('TUCaN-Assistent abgebrochen')
          }
        } catch (err) {
          mockToastError(err)
        } finally {
          tucanBusy = false
        }
      }

      // Case 1: Cancellation by user
      await handleWizard(async () => ({
        success: false,
        error: 'Vorgang durch Benutzer abgebrochen.',
      }))
      expect(mockToast).toHaveBeenCalledWith('TUCaN-Assistent abgebrochen')
      expect(mockToastError).not.toHaveBeenCalled()
      expect(tucanBusy).toBe(false)

      mockToast.mockClear()

      // Case 2: Network failure
      await handleWizard(async () => ({
        success: false,
        error: 'Verbindung zu TUCaN fehlgeschlagen (ERR_CONNECTION_REFUSED).',
      }))
      expect(mockToastError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('fehlgeschlagen') }),
      )
      expect(tucanBusy).toBe(false)

      mockToastError.mockClear()
      mockToast.mockClear()

      // Case 3: Success
      await handleWizard(async () => ({ success: true, count: 12 }))
      expect(mockToast).toHaveBeenCalledWith('12 Termine importiert')
      expect(tucanBusy).toBe(false)
    })
  })

  // ==========================================================================
  // Suite 6: IntegrationSettings File Inspection & Wiring Verification
  // ==========================================================================
  describe('Static & Layout Inspection of IntegrationSettings.tsx', () => {
    const settingsPath = path.resolve(
      __dirname,
      '../src/renderer/src/views/settings/IntegrationSettings.tsx',
    )
    const content = readFileSync(settingsPath, 'utf-8')

    it('defines isValidFeedUrl with protocol regex and URL candidate test', () => {
      expect(content).toContain('function isValidFeedUrl(rawUrl: string): boolean')
      expect(content).toContain("candidate = trimmed.replace(/^webcals?:\\/\\//i, 'https://')")
      expect(content).toContain('new URL(candidate)')
    })

    it('binds handleStartTucanWizard to TUCaN-Assistent starten button with spin animation', () => {
      expect(content).toContain('handleStartTucanWizard')
      expect(content).toContain('TUCaN-Assistent starten')
      expect(content).toContain("tucanBusy ? 'spin' : ''")
    })

    it('provides step-by-step guidance for TUCaN, Moodle, HISinOne, OBS, and Stud.IP / ILIAS', () => {
      expect(content).toContain('TU Darmstadt (TUCaN)')
      expect(content).toContain('Moodle')
      expect(content).toContain('my h_da / HISinOne')
      expect(content).toContain('h_da Informatik (OBS)')
      expect(content).toContain('Stud.IP & ILIAS')
    })

    it('renders badges differentiating Datei-Import vs WebCal-Feed', () => {
      expect(content).toContain("s.kind === 'file' ? 'Datei-Import' : 'WebCal-Feed'")
    })

    it('renders error indicator AlertCircle when subscription has lastError', () => {
      expect(content).toContain('s.lastError')
      expect(content).toContain('AlertCircle')
      expect(content).toContain('Synchronisationsfehler:')
    })

    it('exposes remove action with confirm dialog', () => {
      expect(content).toContain('handleRemove')
      expect(content).toContain('confirm({')
      expect(content).toContain('danger: true')
      expect(content).toContain('removeSubscription ?? api.calendar.unsubscribe')
    })
  })

  // ==========================================================================
  // Suite 7: Deep Stress & Multi-Subscription Edge Conditions
  // ==========================================================================
  describe('Deep Stress & Multi-Subscription Edge Conditions', () => {
    it('maskCalendarUrl protects credentials embedded in userinfo (e.g. https://user:pass@host)', () => {
      const urlWithCreds =
        'https://student_user:super_secret_password@tucan.tu-darmstadt.de/cal.ics?authtoken=abc123xyz'
      const masked = maskCalendarUrl(urlWithCreds)

      expect(masked).not.toContain('super_secret_password')
      expect(masked).not.toContain('student_user')
      expect(masked).not.toContain('abc123xyz')
      expect(masked).toBe('tucan.tu-darmstadt.de/cal.ics?…')
    })

    it('calendarSync handles missing secret gracefully when secret was purged from store', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(vcal(''))) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const sub: Subscription = {
        id: 'orphaned-sub',
        name: 'Orphaned Feed',
        kind: 'url',
        url: 'tucan.tu-darmstadt.de/cal.ics',
        enabled: true,
        lastSync: null,
        lastError: null,
      }
      store.put('subscriptions', sub)
      // Secrets store intentionally left empty for this ID

      const res = await service.calendarSync('orphaned-sub')
      expect(res.count).toBe(0)
      expect(res.error).toBe('Adresse fehlt – bitte das Abo neu anlegen.')

      const updatedSub = store.get().subscriptions.find((s) => s.id === 'orphaned-sub')
      expect(updatedSub?.lastError).toBe('Adresse fehlt – bitte das Abo neu anlegen.')
    })

    it('calendarSync rejects file-kind subscriptions cleanly', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(vcal(''))) as unknown as typeof fetch
      const service = createService(store, secrets, { fetchImpl: mockFetch })

      const fileSub: Subscription = {
        id: 'file-sub',
        name: 'Stundenplan.ics',
        kind: 'file',
        url: 'Datei-Import',
        enabled: false,
        lastSync: null,
        lastError: null,
      }
      store.put('subscriptions', fileSub)

      await expect(service.calendarSync('file-sub')).rejects.toThrow('Abo nicht gefunden')
    })

    it('supports rapid sequential creation, sync, and removal of multiple subscriptions', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        const ics = vcal(
          vevent({ uid: `ev-${url}`, summary: `Event for ${url}`, start: '20261015T080000Z' }),
        )
        return new Response(ics)
      }) as unknown as typeof fetch

      const service = createService(store, secrets, { fetchImpl: mockFetch })

      // Create 5 subscriptions
      const subs: Subscription[] = []
      for (let i = 1; i <= 5; i++) {
        const s = await service.calendarSubscribe(`Feed ${i}`, `https://uni.de/feed${i}.ics`)
        subs.push(s)
      }

      expect(store.get().subscriptions).toHaveLength(5)
      expect(store.get().events).toHaveLength(5)

      // Unsubscribe 3 of them
      await service.calendarUnsubscribe(subs[0].id)
      await service.calendarUnsubscribe(subs[2].id)
      await service.calendarUnsubscribe(subs[4].id)

      expect(store.get().subscriptions).toHaveLength(2)
      expect(store.get().events).toHaveLength(2)
      expect(store.get().subscriptions.map((s) => s.id)).toEqual([subs[1].id, subs[3].id])

      // Re-sync remaining subscription
      const res = await service.calendarSync(subs[1].id)
      expect(res.count).toBe(1)
      expect(store.get().events).toHaveLength(2)
    })
  })
})
