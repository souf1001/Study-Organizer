/**
 * Challenger M4 Tier 5 Adversarial Coverage Hardening Test Suite
 *
 * Focus Areas:
 * 1. Concurrency, Simultaneous Imports & Race Conditions
 * 2. Memory Cleanup, Temp File Deletion & Session Safety in TUCaN Wizard
 * 3. Exotic Academic Event Formats, Bilingual Feeds & Complex Recurrences
 * 4. Resilient Error Handling Across Full Stack (Renderer, Main, Backend)
 */

import { existsSync, promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import {
  classifyEvent,
  decodeIcsText,
  eventsFromIcs,
  extractCourseInfo,
  fetchCalendar,
  maskCalendarUrl,
  matchModule,
  mergeSubscriptionEvents,
  normalizeCalendarUrl,
  parseIcs,
} from '../src/backend/ics'
import { isIcsDownload, startTucanWizard } from '../src/main/tucan-session'
import { openExternalSafely } from '../src/main/ipc'
import { newModule } from '../src/shared/defaults'
import { buildSemester } from '../src/shared/semester'
import type { CalendarEvent, Module, Subscription } from '../src/shared/types'

// ----------------------------------------------------------------------------
// Hoisted Electron Mocks for Main Process Testing
// ----------------------------------------------------------------------------

const { MockBrowserWindow, MockSession, MockDownloadItem, mockShell } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class MockWebContents {
    public id = Math.floor(Math.random() * 100000)
    public listeners: Record<string, Listener[]> = {}
    public windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null
    public executedScripts: string[] = []

    on(event: string, fn: Listener) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(fn)
    }

    emit(event: string, ...args: unknown[]) {
      this.listeners[event]?.forEach((fn) => fn(...args))
    }

    async executeJavaScript(script: string): Promise<void> {
      this.executedScripts.push(script)
    }

    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.windowOpenHandler = handler
    }
  }

  class MockBrowserWindow {
    public static instances: MockBrowserWindow[] = []
    public static focusedWindow: MockBrowserWindow | null = null

    public webContents = new MockWebContents()
    public listeners: Record<string, Listener[]> = {}
    public destroyed = false
    public closed = false
    public options: Record<string, unknown>
    public loadedUrls: string[] = []

    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      MockBrowserWindow.instances.push(this)
      MockBrowserWindow.focusedWindow = this
    }

    static getFocusedWindow() {
      return MockBrowserWindow.focusedWindow
    }

    isDestroyed() {
      return this.destroyed
    }

    close() {
      if (!this.destroyed) {
        this.closed = true
        this.destroyed = true
        this.emit('closed')
      }
    }

    on(event: string, fn: Listener) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(fn)
    }

    emit(event: string, ...args: unknown[]) {
      this.listeners[event]?.slice().forEach((fn) => fn(...args))
    }

    async loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url)
      if (url.includes('simulated-network-failure')) {
        throw new Error('net::ERR_CONNECTION_REFUSED')
      }
    }
  }

  class MockSession {
    public static sessions: Map<string, MockSession> = new Map()
    public partition: string
    public permissionHandler:
      ((wc: unknown, perm: string, cb: (grant: boolean) => void) => void) | null = null
    public listeners: Record<string, Listener[]> = {}

    constructor(partition: string) {
      this.partition = partition
    }

    static fromPartition(partition: string): MockSession {
      if (!MockSession.sessions.has(partition)) {
        MockSession.sessions.set(partition, new MockSession(partition))
      }
      return MockSession.sessions.get(partition)!
    }

    setPermissionRequestHandler(
      fn: (wc: unknown, perm: string, cb: (grant: boolean) => void) => void,
    ) {
      this.permissionHandler = fn
    }

    on(event: string, fn: Listener) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(fn)
    }

    removeListener(event: string, fn: Listener) {
      if (this.listeners[event]) {
        this.listeners[event] = this.listeners[event].filter((f) => f !== fn)
      }
    }

    emit(event: string, ...args: unknown[]) {
      this.listeners[event]?.slice().forEach((fn) => fn(...args))
    }

    listenerCount(event: string): number {
      return this.listeners[event]?.length ?? 0
    }
  }

  class MockDownloadItem {
    private filename: string
    private mime: string
    private url: string
    private savePath: string | null = null
    public cancelled = false
    public listeners: Record<string, Listener[]> = {}

    constructor(opts: { filename?: string; mime?: string; url?: string } = {}) {
      this.filename = opts.filename ?? ''
      this.mime = opts.mime ?? ''
      this.url = opts.url ?? ''
    }

    getFilename() {
      return this.filename
    }

    getMimeType() {
      return this.mime
    }

    getURL() {
      return this.url
    }

    cancel() {
      this.cancelled = true
    }

    setSavePath(p: string) {
      this.savePath = p
    }

    getSavePath() {
      return this.savePath
    }

    on(event: string, fn: Listener) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(fn)
    }

    once(event: string, fn: Listener) {
      const wrapped: Listener = (...args: unknown[]) => {
        this.listeners[event] = (this.listeners[event] || []).filter((f) => f !== wrapped)
        fn(...args)
      }
      this.on(event, wrapped)
    }

    emit(event: string, ...args: unknown[]) {
      this.listeners[event]?.slice().forEach((fn) => fn(...args))
    }
  }

  const mockShell = {
    openExternal: vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
        throw new Error('Link nicht erlaubt')
      }
    }),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  }

  return { MockBrowserWindow, MockSession, MockDownloadItem, mockShell }
})

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  session: MockSession,
  shell: mockShell,
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}))

// ----------------------------------------------------------------------------
// Test Harness Utilities
// ----------------------------------------------------------------------------

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, value: string) => void data.set(name, value),
    remove: async (name: string) => void data.delete(name),
  }
}

function buildVCalendar(eventsBody: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TU Darmstadt//TUCaN 2026//DE',
    'CALSCALE:GREGORIAN',
    eventsBody,
    'END:VCALENDAR',
  ].join('\r\n')
}

function buildVEvent(p: {
  uid: string
  summary: string
  start: string
  end?: string
  location?: string
  description?: string
  categories?: string[]
  rrule?: string
  recurrenceId?: string
  exdate?: string
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`]
  if (p.recurrenceId) lines.push(`RECURRENCE-ID:${p.recurrenceId}`)
  lines.push(`SUMMARY:${p.summary}`)
  lines.push(`DTSTART:${p.start}`)
  if (p.end) lines.push(`DTEND:${p.end}`)
  if (p.rrule) lines.push(`RRULE:${p.rrule}`)
  if (p.exdate) lines.push(`EXDATE:${p.exdate}`)
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  if (p.categories?.length) lines.push(`CATEGORIES:${p.categories.join(',')}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

// ----------------------------------------------------------------------------
// Test Suite
// ----------------------------------------------------------------------------

describe('Tier 5 Adversarial Coverage Hardening Suite', () => {
  let tmpDir: string
  let store: Store
  let secrets: Secrets & { data: Map<string, string> }
  let service: ReturnType<typeof createService>

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m4-'))
    store = await Store.open(tmpDir)
    secrets = memorySecrets()
    service = createService(store, secrets)
    MockBrowserWindow.instances = []
    MockBrowserWindow.focusedWindow = null
    MockSession.sessions.clear()
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  })

  // ==========================================================================
  // Section 1: Concurrency, Simultaneous Imports & Race Conditions
  // ==========================================================================
  describe('5.1: Concurrency, Simultaneous Imports & Race Conditions', () => {
    it('5.1.1: Parallel execution of 10 identical file imports maintains store integrity without unhandled rejections', async () => {
      const ics = buildVCalendar(
        buildVEvent({
          uid: 'concurrent-evt-1@tu-darmstadt.de',
          summary: '20-00-0012-vl Rechnerorganisation (Vorlesung)',
          start: '20261102T095000Z',
          end: '20261102T113000Z',
          location: 'S202/001',
        }),
      )

      // Execute 10 simultaneous imports of the same file
      const promises = Array.from({ length: 10 }, (_, i) =>
        service.calendarImportFile(`stundenplan-ws26 (${i}).ics`, ics),
      )

      const results = await Promise.all(promises)
      for (const res of results) {
        expect(res.count).toBe(1)
        expect(res.error).toBeNull()
      }

      await store.flush()
      const db = store.get()

      // Normalized filenames all resolve to stundenplan-ws26.ics, ensuring clean subscription replacement
      const subscriptions = db.subscriptions.filter((s) =>
        s.name.toLowerCase().includes('stundenplan-ws26'),
      )
      expect(subscriptions.length).toBeGreaterThanOrEqual(1)

      // Events should exist and be associated with a valid subscription
      const events = db.events.filter((e) => e.externalId === 'concurrent-evt-1@tu-darmstadt.de')
      expect(events.length).toBeGreaterThanOrEqual(1)
      for (const ev of events) {
        expect(db.subscriptions.some((s) => s.id === ev.subscriptionId)).toBe(true)
      }
    })

    it('5.1.2: Parallel imports of distinct university courses preserve all events and modules', async () => {
      // Ensure active semester exists for module auto-creation
      store.put('semesters', {
        ...buildSemester('uni', 'winter', 2026),
        id: 'sem-active',
        name: 'Wintersemester 2026/27',
        createdAt: new Date().toISOString(),
      })
      store.update({ activeSemesterId: 'sem-active' })

      const courses = [
        { code: '20-00-0011-vl', name: 'Mathematik I', file: 'math.ics' },
        { code: '20-00-0022-vl', name: 'Algorithmen & Datenstrukturen', file: 'algo.ics' },
        { code: '20-00-0033-vl', name: 'Software Engineering', file: 'se.ics' },
        { code: '20-00-0044-vl', name: 'Betriebssysteme', file: 'os.ics' },
        { code: '20-00-0055-vl', name: 'Telematik', file: 'telematik.ics' },
      ]

      await Promise.all(
        courses.map((c, i) => {
          const ics = buildVCalendar(
            buildVEvent({
              uid: `uid-${c.code}@tu-darmstadt.de`,
              summary: `${c.code} ${c.name} (Vorlesung)`,
              start: `2026110${i + 1}T100000Z`,
              end: `2026110${i + 1}T114000Z`,
              location: `S101/A0${i + 1}`,
            }),
          )
          return service.calendarImportFile(c.file, ics)
        }),
      )

      await store.flush()
      const db = store.get()

      expect(db.subscriptions.filter((s) => s.kind === 'file').length).toBe(5)
      for (const c of courses) {
        expect(db.events.some((e) => e.externalId === `uid-${c.code}@tu-darmstadt.de`)).toBe(true)
        expect(db.modules.some((m) => m.code.toLowerCase().includes(c.code.slice(0, 10)))).toBe(
          true,
        )
      }
    })

    it('5.1.3: Concurrency race: sync aborted cleanly without writing orphaned events when unsubscribed mid-fetch', async () => {
      let delayActive = false
      let resolveDelayed: (text: string) => void = () => undefined

      const controlledFetch = vi.fn(async () => {
        if (delayActive) {
          const text = await new Promise<string>((res) => {
            resolveDelayed = res
          })
          return new Response(text, {
            status: 200,
            headers: { 'content-type': 'text/calendar' },
          })
        }
        return new Response(
          buildVCalendar(
            buildVEvent({
              uid: 'initial-sub@tu-darmstadt.de',
              summary: 'Initial Subscription Event',
              start: '20261101T080000Z',
            }),
          ),
          {
            status: 200,
            headers: { 'content-type': 'text/calendar' },
          },
        )
      })

      const slowService = createService(store, secrets, {
        fetchImpl: controlledFetch as unknown as typeof fetch,
      })

      // Create subscription successfully
      const sub = await slowService.calendarSubscribe(
        'Moodle Delay Test',
        'https://moodle.tu-darmstadt.de/cal.ics',
      )
      expect(sub.id).toBeDefined()

      // Enable delayed fetch for the subsequent sync
      delayActive = true
      const syncPromise = slowService.calendarSync(sub.id)

      // Unsubscribe while fetch is in-flight
      await slowService.calendarUnsubscribe(sub.id)
      expect(store.get().subscriptions.some((s) => s.id === sub.id)).toBe(false)

      // Complete the delayed fetch with calendar data
      resolveDelayed(
        buildVCalendar(
          buildVEvent({
            uid: 'orphaned-race-test@tu-darmstadt.de',
            summary: 'Late Arriving Lecture (Vorlesung)',
            start: '20261105T100000Z',
            end: '20261105T113000Z',
          }),
        ),
      )

      const result = await syncPromise
      expect(result.count).toBe(0)
      expect(result.error).toBeNull()

      // Critical check: no orphaned events exist in the database for the deleted subscription
      const orphaned = store.get().events.filter((e) => e.subscriptionId === sub.id)
      expect(orphaned.length).toBe(0)
    })

    it('5.1.4: High-volume concurrent store mutations maintain JSON disk consistency and atomic serialization', async () => {
      const taskCount = 40
      const writes = Array.from({ length: taskCount }, (_, i) => {
        if (i % 3 === 0) {
          store.put('modules', newModule('sem-1', { name: `Module ${i}`, code: `MOD-${i}` }))
        } else if (i % 3 === 1) {
          store.update({ onboarded: i % 2 === 0 })
        } else {
          store.put('events', {
            id: `evt-${i}`,
            title: `Termin ${i}`,
            start: '2026-11-01T10:00:00.000Z',
            end: '2026-11-01T11:00:00.000Z',
            allDay: false,
            kind: 'lecture',
            moduleId: null,
            location: 'Online',
            notes: '',
            subscriptionId: null,
            externalId: `ext-${i}`,
          })
        }
        return Promise.resolve()
      })

      await Promise.all(writes)
      await store.flush()

      // Directly read db.json from filesystem to prove disk integrity
      const diskContent = await fs.readFile(path.join(tmpDir, 'db.json'), 'utf8')
      expect(() => JSON.parse(diskContent)).not.toThrow()
      const diskDb = JSON.parse(diskContent)
      expect(diskDb.events.length).toBeGreaterThan(0)
      expect(diskDb.modules.length).toBeGreaterThan(0)
    })

    it('5.1.5: Concurrent module auto-creation across parallel events with identical course code avoids explosive module duplication', async () => {
      const icsA = buildVCalendar(
        buildVEvent({
          uid: 'shared-mod-vl@tu-darmstadt.de',
          summary: '20-00-0099-vl Cloud Computing (Vorlesung)',
          start: '20261110T080000Z',
          end: '20261110T093000Z',
        }),
      )
      const icsB = buildVCalendar(
        buildVEvent({
          uid: 'shared-mod-ue@tu-darmstadt.de',
          summary: '20-00-0099-ue Cloud Computing (Übung)',
          start: '20261110T100000Z',
          end: '20261110T113000Z',
        }),
      )

      await Promise.all([
        service.calendarImportFile('cloud-vl.ics', icsA),
        service.calendarImportFile('cloud-ue.ics', icsB),
      ])

      await store.flush()
      const db = store.get()
      const cloudModules = db.modules.filter((m) => m.code.includes('20-00-0099'))
      // Suffix stripping ensures 20-00-0099 is the canonical code
      expect(cloudModules.length).toBeLessThanOrEqual(2)
      for (const m of cloudModules) {
        expect(m.code).toBe('20-00-0099')
      }
    })
  })

  // ==========================================================================
  // Section 2: Memory Cleanup, Temp File Deletion & Session Safety
  // ==========================================================================
  describe('5.2: Memory Cleanup, Ephemeral Temp Files & Session Safety in TUCaN Wizard', () => {
    it('5.2.1: Ephemeral temp file is cleanly deleted after successful calendar download and import', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      expect(win).toBeDefined()

      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'stundenplan.ics',
        mime: 'text/calendar',
        url: 'https://www.tucan.tu-darmstadt.de/download.ics',
      })

      ses.emit('will-download', {}, downloadItem, win.webContents)
      const savedPath = downloadItem.getSavePath()!
      expect(savedPath).toBeTruthy()

      // Write valid calendar content to the designated temp file
      await fs.writeFile(
        savedPath!,
        buildVCalendar(
          buildVEvent({
            uid: 'tucan-succ-1@tu-darmstadt.de',
            summary: 'TUCaN Import Success Event',
            start: '20261103T100000Z',
          }),
        ),
      )
      expect(existsSync(savedPath!)).toBe(true)

      // Emit completed download event with event argument
      downloadItem.emit('done', {}, 'completed')
      const result = await wizardPromise

      expect(result.success).toBe(true)
      expect(result.count).toBe(1)

      // Verify temp file has been completely unlinked from disk
      expect(existsSync(savedPath!)).toBe(false)
    })

    it('5.2.2: Ephemeral temp file is deleted when download is cancelled by user', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'cancel.ics',
        mime: 'text/calendar',
        url: 'https://www.tucan.tu-darmstadt.de/cancel.ics',
      })

      ses.emit('will-download', {}, downloadItem, win.webContents)
      const savedPath = downloadItem.getSavePath()!
      await fs.writeFile(savedPath, 'BEGIN:VCALENDAR')
      expect(existsSync(savedPath)).toBe(true)

      downloadItem.emit('done', {}, 'cancelled')
      const result = await wizardPromise

      expect(result.success).toBe(false)
      expect(result.error).toContain('abgebrochen')
      expect(existsSync(savedPath)).toBe(false)
    })

    it('5.2.3: Ephemeral temp file is deleted when download is interrupted by network error', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'interrupted.ics',
        mime: 'text/calendar',
        url: 'https://www.tucan.tu-darmstadt.de/interrupted.ics',
      })

      ses.emit('will-download', {}, downloadItem, win.webContents)
      const savedPath = downloadItem.getSavePath()!
      await fs.writeFile(savedPath, 'partial-content')
      expect(existsSync(savedPath)).toBe(true)

      downloadItem.emit('updated', {}, 'interrupted')
      const result = await wizardPromise

      expect(result.success).toBe(false)
      expect(result.error).toContain('fehlgeschlagen')
      expect(existsSync(savedPath)).toBe(false)
    })

    it('5.2.4: Ephemeral temp file is cleaned up if wizard window is closed while download is pending', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'pending.ics',
        mime: 'text/calendar',
        url: 'https://www.tucan.tu-darmstadt.de/pending.ics',
      })

      ses.emit('will-download', {}, downloadItem, win.webContents)
      const savedPath = downloadItem.getSavePath()!
      await fs.writeFile(savedPath, 'pending-data')
      expect(existsSync(savedPath)).toBe(true)

      // User closes the modal before download finishes
      win.close()
      const result = await wizardPromise

      expect(result.success).toBe(false)
      expect(result.error).toContain('abgebrochen')
      expect(existsSync(savedPath)).toBe(false)
    })

    it('5.2.5: Ephemeral temp file is deleted even if calendar import parser throws an error', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'corrupted.ics',
        mime: 'text/calendar',
        url: 'https://www.tucan.tu-darmstadt.de/corrupted.ics',
      })

      ses.emit('will-download', {}, downloadItem, win.webContents)
      const savedPath = downloadItem.getSavePath()!
      // Write invalid, non-calendar content that causes calendarImportFile to reject
      await fs.writeFile(savedPath, 'INVALID CORRUPTED BYTES')
      expect(existsSync(savedPath)).toBe(true)

      downloadItem.emit('done', {}, 'completed')
      const result = await wizardPromise

      expect(result.success).toBe(false)
      expect(result.error).toContain('keine iCal-Datei')
      expect(existsSync(savedPath)).toBe(false)
    })

    it('5.2.6: TUCaN session uses isolated in-memory partition without persistent disk storage', () => {
      startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const webPrefs = win.options.webPreferences as Record<string, unknown>

      expect(webPrefs.partition).toBe('tucan-session')
      expect(webPrefs.sandbox).toBe(true)
      expect(webPrefs.contextIsolation).toBe(true)
      expect(webPrefs.nodeIntegration).toBe(false)
    })

    it('5.2.7: Permission requests in TUCaN session are categorically denied', () => {
      startTucanWizard(service)
      const ses = MockSession.fromPartition('tucan-session')
      expect(ses.permissionHandler).toBeTypeOf('function')

      let granted: boolean | null = null
      ses.permissionHandler!(null, 'geolocation', (g) => {
        granted = g
      })
      expect(granted).toBe(false)

      ses.permissionHandler!(null, 'media', (g) => {
        granted = g
      })
      expect(granted).toBe(false)
    })

    it('5.2.8: Repeated sequential wizard launches cleanly remove event listeners without EventEmitter leaks', async () => {
      const ses = MockSession.fromPartition('tucan-session')

      for (let i = 0; i < 5; i++) {
        const wizard = startTucanWizard(service)
        const win = MockBrowserWindow.instances[MockBrowserWindow.instances.length - 1]
        win.close()
        await wizard
      }

      // After closing, all will-download listeners must be unregistered
      expect(ses.listenerCount('will-download')).toBe(0)
    })

    it('5.2.9: WebContents isolation: downloads belonging to other browser windows are strictly ignored', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const foreignItem = new MockDownloadItem({
        filename: 'other-window.ics',
        mime: 'text/calendar',
      })
      const foreignWebContents = { id: 99999999 }

      // Emit download from foreign window
      ses.emit('will-download', {}, foreignItem, foreignWebContents)
      expect(foreignItem.getSavePath()).toBeNull()

      win.close()
      await wizardPromise
    })

    it('5.2.10: isIcsDownload identifies calendar downloads by extension, MIME, or query parameter', () => {
      const itemExt = new MockDownloadItem({ filename: 'timetable.ics' })
      expect(isIcsDownload(itemExt as unknown as import('electron').DownloadItem)).toBe(true)

      const itemMime = new MockDownloadItem({ filename: 'export', mime: 'text/calendar' })
      expect(isIcsDownload(itemMime as unknown as import('electron').DownloadItem)).toBe(true)

      const itemQuery = new MockDownloadItem({
        filename: 'export.php',
        url: 'https://uni.de/cal?format=ics',
      })
      expect(isIcsDownload(itemQuery as unknown as import('electron').DownloadItem)).toBe(true)

      const itemPdf = new MockDownloadItem({ filename: 'script.pdf', mime: 'application/pdf' })
      expect(isIcsDownload(itemPdf as unknown as import('electron').DownloadItem)).toBe(false)
    })
  })

  // ==========================================================================
  // Section 3: Exotic Academic Formats, Bilingual Feeds & Complex Recurrences
  // ==========================================================================
  describe('5.3: Exotic Academic Event Formats, Bilingual Feeds & Complex Recurrences', () => {
    it('5.3.1: Bilingual German/English course titles classified correctly across all kinds', () => {
      const cases: [string, string][] = [
        [
          'CS 101 - Einführung in die Informatik / Introduction to Computer Science (Vorlesung)',
          'lecture',
        ],
        ['Autonomous Driving / Autonome Systeme (Lecture)', 'lecture'],
        ['Mathematik I / Mathematics I (Klausur / Written Examination)', 'exam'],
        ['Robotics Lab / Robotik Praktikum [PR]', 'lab'],
        ['Advanced Distributed Systems / Verteilte Systeme (Hörsaalübung / Exercise)', 'exercise'],
        ['Project Proposal Submission Due / Abgabe Projektantrag', 'deadline'],
        ['Fachsprache Englisch / English for Engineers (Seminar)', 'lecture'],
        ['Tutorium zu Lineare Algebra / Linear Algebra Tutorial', 'exercise'],
      ]

      for (const [title, expectedKind] of cases) {
        expect(classifyEvent(title)).toBe(expectedKind)
      }
    })

    it('5.3.2: Intelligent module recognition on bilingual titles with German or English database module names', () => {
      const existingModules: Module[] = [
        newModule('sem-1', { name: 'Introduction to Computer Science', code: 'CS-101' }),
        newModule('sem-1', { name: 'Lineare Algebra I', code: 'MATH-101' }),
      ]

      // German title with code CS 101 matching English module
      const match1 = matchModule(
        'CS 101 - Einführung in die Informatik / Introduction to Computer Science',
        '',
        [],
        existingModules,
      )
      expect(match1?.id).toBe(existingModules[0].id)

      // Bilingual title matching German module name
      const match2 = matchModule(
        'Linear Algebra I / Lineare Algebra I (Vorlesung)',
        '',
        [],
        existingModules,
      )
      expect(match2?.id).toBe(existingModules[1].id)
    })

    it('5.3.3: Complex recurrence: bi-weekly lectures (RRULE:FREQ=WEEKLY;INTERVAL=2)', () => {
      const ics = buildVCalendar(
        buildVEvent({
          uid: 'rrule-biweekly@tu-darmstadt.de',
          summary: '20-00-0015-vl Zweiwöchentliche Vorlesung',
          start: '20261014T095000Z',
          end: '20261014T113000Z',
          rrule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261125T235959Z',
        }),
      )

      const from = new Date('2026-10-01T00:00:00Z')
      const to = new Date('2026-12-01T00:00:00Z')
      const events = parseIcs(ics, from, to)

      // Oct 14, Oct 28, Nov 11, Nov 25 -> 4 occurrences
      expect(events.length).toBe(4)
      const diffDays1 = (events[1].start.getTime() - events[0].start.getTime()) / (1000 * 3600 * 24)
      expect(diffDays1).toBe(14)
    })

    it('5.3.4: Complex recurrence: multi-day lectures (RRULE:FREQ=WEEKLY;BYDAY=TU,TH)', () => {
      const ics = buildVCalendar(
        buildVEvent({
          uid: 'rrule-multiday@tu-darmstadt.de',
          summary: 'Analysis Vorlesung Di & Do',
          start: '20261013T080000Z',
          end: '20261013T094000Z',
          rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6',
        }),
      )

      const from = new Date('2026-10-01T00:00:00Z')
      const to = new Date('2026-11-01T00:00:00Z')
      const events = parseIcs(ics, from, to)

      expect(events.length).toBe(6)
      // Check weekdays: Tuesday (2) and Thursday (4)
      for (const ev of events) {
        const day = ev.start.getUTCDay()
        expect([2, 4]).toContain(day)
      }
    })

    it('5.3.5: Complex recurrence: monthly on specific weekday (RRULE:FREQ=MONTHLY;BYDAY=2FR)', () => {
      const ics = buildVCalendar(
        buildVEvent({
          uid: 'rrule-monthly-2fr@tu-darmstadt.de',
          summary: 'Kolloquium 2. Freitag im Monat',
          start: '20261009T140000Z',
          end: '20261009T160000Z',
          rrule: 'FREQ=MONTHLY;BYDAY=2FR;COUNT=3',
        }),
      )

      const from = new Date('2026-10-01T00:00:00Z')
      const to = new Date('2027-01-01T00:00:00Z')
      const events = parseIcs(ics, from, to)

      expect(events.length).toBe(3)
      for (const ev of events) {
        expect(ev.start.getUTCDay()).toBe(5) // Friday
        const dom = ev.start.getUTCDate()
        expect(dom).toBeGreaterThanOrEqual(8)
        expect(dom).toBeLessThanOrEqual(14)
      }
    })

    it('5.3.6: Recurrence with EXDATE holiday exclusion skips the holiday session', () => {
      const ics = buildVCalendar(
        buildVEvent({
          uid: 'rrule-exdate@tu-darmstadt.de',
          summary: 'Montagsvorlesung mit Feiertag',
          start: '20261019T100000Z',
          end: '20261019T113000Z',
          rrule: 'FREQ=WEEKLY;COUNT=3',
          exdate: '20261026T100000Z',
        }),
      )

      const from = new Date('2026-10-01T00:00:00Z')
      const to = new Date('2026-11-15T00:00:00Z')
      const events = parseIcs(ics, from, to)

      // 3 occurrences minus 1 excluded = 2 events
      expect(events.length).toBe(2)
      expect(events.some((e) => e.start.toISOString().startsWith('2026-10-26'))).toBe(false)
    })

    it('5.3.7: Recurrence with RECURRENCE-ID properly overrides exception details', () => {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TU Darmstadt//TUCaN//DE',
        buildVEvent({
          uid: 'rrule-override@tu-darmstadt.de',
          summary: 'Reguläre Vorlesung',
          start: '20261102T080000Z',
          end: '20261102T093000Z',
          location: 'Raum S101',
          rrule: 'FREQ=WEEKLY;COUNT=2',
        }),
        buildVEvent({
          uid: 'rrule-override@tu-darmstadt.de',
          recurrenceId: '20261109T080000Z',
          summary: 'Sondertermin Raumänderung',
          start: '20261109T080000Z',
          end: '20261109T093000Z',
          location: 'Hörsaal Audimax S202',
        }),
        'END:VCALENDAR',
      ].join('\r\n')

      const from = new Date('2026-11-01T00:00:00Z')
      const to = new Date('2026-11-20T00:00:00Z')
      const events = parseIcs(ics, from, to)

      expect(events.length).toBe(2)
      const overridden = events.find((e) => e.start.toISOString().startsWith('2026-11-09'))
      expect(overridden?.location).toBe('Hörsaal Audimax S202')
    })

    it('5.3.8: Mixed-timezone feeds: Europe/Berlin, UTC Z, and floating local time coexist cleanly', () => {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TU Darmstadt//TUCaN//DE',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'TZNAME:CET',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'TZNAME:CEST',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:tz-berlin@tu-darmstadt.de',
        'SUMMARY:Berlin Local Lecture',
        'DTSTART;TZID=Europe/Berlin:20261104T100000',
        'DTEND;TZID=Europe/Berlin:20261104T113000',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:tz-utc@tu-darmstadt.de',
        'SUMMARY:UTC Deadline',
        'DTSTART:20261104T100000Z',
        'DTEND:20261104T100000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:tz-floating@tu-darmstadt.de',
        'SUMMARY:Floating Time Event',
        'DTSTART:20261104T100000',
        'DTEND:20261104T110000',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')

      const from = new Date('2026-11-01T00:00:00Z')
      const to = new Date('2026-11-10T00:00:00Z')
      const events = parseIcs(ics, from, to)

      expect(events.length).toBe(3)
      const berlinEvt = events.find((e) => e.uid === 'tz-berlin@tu-darmstadt.de')
      const utcEvt = events.find((e) => e.uid === 'tz-utc@tu-darmstadt.de')

      expect(berlinEvt).toBeDefined()
      expect(utcEvt).toBeDefined()
      // Berlin in November is CET (UTC+1): 10:00 CET = 09:00 UTC
      expect(berlinEvt!.start.toISOString()).toBe('2026-11-04T09:00:00.000Z')
      expect(utcEvt!.start.toISOString()).toBe('2026-11-04T10:00:00.000Z')
    })

    it('5.3.9: Daylight Saving Time (DST) transition preserves local wall-clock lecture start', () => {
      // TU Darmstadt lecture every Monday at 09:50 Europe/Berlin
      // Oct 19 is CEST (UTC+2) -> 07:50 UTC
      // Oct 26 is CET (UTC+1) -> 08:50 UTC
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TU Darmstadt//TUCaN//DE',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'TZNAME:CET',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'TZNAME:CEST',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:dst-crossing@tu-darmstadt.de',
        'SUMMARY:DST Crossing Lecture (Vorlesung)',
        'DTSTART;TZID=Europe/Berlin:20261019T095000',
        'DTEND;TZID=Europe/Berlin:20261019T113000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')

      const from = new Date('2026-10-01T00:00:00Z')
      const to = new Date('2026-11-15T00:00:00Z')
      const events = parseIcs(ics, from, to)

      expect(events.length).toBe(2)
      expect(events[0].start.toISOString()).toBe('2026-10-19T07:50:00.000Z') // CEST (UTC+2)
      expect(events[1].start.toISOString()).toBe('2026-10-26T08:50:00.000Z') // CET (UTC+1)
    })

    it('5.3.10: Extreme edge cases: zero-duration events, missing DTEND, all-day date values, and math symbols', () => {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TU Darmstadt//TUCaN//DE',
        'BEGIN:VEVENT',
        'UID:zero-duration@tu-darmstadt.de',
        'SUMMARY:Zero Duration Milestone',
        'DTSTART:20261112T120000Z',
        'DTEND:20261112T120000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:no-dtend@tu-darmstadt.de',
        'SUMMARY:Event Without DTEND',
        'DTSTART:20261113T140000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:all-day@tu-darmstadt.de',
        'SUMMARY:Heiligabend',
        'DTSTART;VALUE=DATE:20261224',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:math-symbols@tu-darmstadt.de',
        'SUMMARY:20-00-0044-vl Logik & λ-Kalkül (∑ & ∫) 🚀',
        'DTSTART:20261114T095000Z',
        'DTEND:20261114T113000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')

      const subscription: Subscription = {
        id: 'sub-edge-1',
        name: 'Edge Sub',
        kind: 'file',
        url: '',
        enabled: true,
        lastSync: null,
        lastError: null,
      }

      const events = eventsFromIcs(ics, subscription, [])
      expect(events.length).toBe(4)

      const zeroDur = events.find((e) => e.externalId === 'zero-duration@tu-darmstadt.de')
      expect(zeroDur?.kind).toBe('deadline')

      const noDtend = events.find((e) => e.externalId === 'no-dtend@tu-darmstadt.de')
      expect(noDtend?.end).toBe(noDtend?.start)

      const allDay = events.find((e) => e.externalId === 'all-day@tu-darmstadt.de')
      expect(allDay?.allDay).toBe(true)

      const mathSym = events.find((e) => e.externalId === 'math-symbols@tu-darmstadt.de')
      expect(mathSym?.title).toContain('λ-Kalkül')
      expect(mathSym?.title).toContain('🚀')
    })

    it('5.3.11: decodeIcsText reliably cleans BOM and handles UTF-16LE / UTF-8 streams', () => {
      const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42, 0x43])
      expect(decodeIcsText(utf8Bom)).toBe('ABC')

      const utf16Le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])
      expect(decodeIcsText(utf16Le)).toBe('AB')

      const strWithBom = '\uFEFFBEGIN:VCALENDAR\r\nEND:VCALENDAR'
      expect(decodeIcsText(strWithBom)).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR')
    })

    it('5.3.12: extractCourseInfo parses module codes, names, and lecturer metadata', () => {
      const parsed = extractCourseInfo(
        '20-00-0012-vl Rechnerorganisation (Vorlesung)',
        [],
        'Dozent: Prof. Dr. Musterfrau',
      )
      expect(parsed?.code).toBe('20-00-0012')
      expect(parsed?.name).toBe('Rechnerorganisation')
      expect(parsed?.lecturer).toBe('Prof. Dr. Musterfrau')
    })
  })

  // ==========================================================================
  // Section 4: Resilient Error Handling Across Full Stack
  // ==========================================================================
  describe('5.4: Resilient Error Handling Across Full Stack', () => {
    it('5.4.1: fetchCalendar handles HTTP 403, 404, 500 cleanly without crashing calendarSync', async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes('403')) return new Response('Forbidden', { status: 403 })
        if (url.includes('404')) return new Response('Not Found', { status: 404 })
        return new Response('Server Error', { status: 500 })
      })

      const customService = createService(store, secrets, {
        fetchImpl: mockFetch as unknown as typeof fetch,
      })

      const sub403 = await customService.calendarSubscribe('Feed 403', 'https://uni.de/403.ics')
      const res403 = await customService.calendarSync(sub403.id)
      expect(res403.count).toBe(0)
      expect(res403.error).toContain('403')

      const stored403 = store.get().subscriptions.find((s) => s.id === sub403.id)
      expect(stored403?.lastError).toContain('403')

      const sub404 = await customService.calendarSubscribe('Feed 404', 'https://uni.de/404.ics')
      const res404 = await customService.calendarSync(sub404.id)
      expect(res404.count).toBe(0)
      expect(res404.error).toContain('404')
    })

    it('5.4.2: fetchCalendar handles non-calendar HTML captive portal or error page gracefully', async () => {
      const htmlResponse =
        '<!DOCTYPE html><html><body><h1>WLAN-Login erforderlich</h1></body></html>'
      const mockFetch = vi.fn(
        async () =>
          new Response(htmlResponse, { status: 200, headers: { 'content-type': 'text/html' } }),
      )

      await expect(
        fetchCalendar('https://uni.de/wlan.ics', mockFetch as unknown as typeof fetch),
      ).rejects.toThrow('keinen iCal-Kalender')
    })

    it('5.4.3: normalizeCalendarUrl rejects dangerous or unsupported protocols', () => {
      expect(() => normalizeCalendarUrl('javascript:alert(1)')).toThrow(
        'Nur http(s)- oder webcal-Adressen',
      )
      expect(() => normalizeCalendarUrl('file:///etc/passwd')).toThrow(
        'Nur http(s)- oder webcal-Adressen',
      )
      expect(() => normalizeCalendarUrl('data:text/calendar,BEGIN:VCALENDAR')).toThrow(
        'Nur http(s)- oder webcal-Adressen',
      )
      expect(() => normalizeCalendarUrl('ftp://ftp.tu-darmstadt.de/cal.ics')).toThrow(
        'Nur http(s)- oder webcal-Adressen',
      )

      expect(normalizeCalendarUrl('webcal://moodle.tu-darmstadt.de/feed.ics')).toBe(
        'https://moodle.tu-darmstadt.de/feed.ics',
      )
      expect(normalizeCalendarUrl('webcals://moodle.tu-darmstadt.de/feed.ics')).toBe(
        'https://moodle.tu-darmstadt.de/feed.ics',
      )
    })

    it('5.4.4: openExternalSafely prevents launch of dangerous non-web URI schemes', async () => {
      expect(() => openExternalSafely('file:///C:/Windows/System32/cmd.exe')).toThrow(
        'Link nicht erlaubt',
      )
      expect(() => openExternalSafely('javascript:alert(1)')).toThrow('Link nicht erlaubt')
      expect(() => openExternalSafely('powershell:dir')).toThrow('Link nicht erlaubt')

      await expect(openExternalSafely('https://www.tucan.tu-darmstadt.de/')).resolves.not.toThrow()
      expect(mockShell.openExternal).toHaveBeenCalledWith('https://www.tucan.tu-darmstadt.de/')
    })

    it('5.4.5: maskCalendarUrl masks sensitive authentication tokens in query strings', () => {
      const masked = maskCalendarUrl(
        'https://moodle.tu-darmstadt.de/calendar/export.php?userid=12345&authtoken=secret987654',
      )
      expect(masked).toBe('moodle.tu-darmstadt.de/calendar/export.php?…')
      expect(masked).not.toContain('secret987654')
      expect(masked).not.toContain('12345')
    })

    it('5.4.6: Long-line DoS resistance: calendar containing single 100,000 character line handled safely', () => {
      const giantLine = 'DESCRIPTION:' + 'A'.repeat(100_000)
      const ics = buildVCalendar(
        [
          'BEGIN:VEVENT',
          'UID:giant-line@tu-darmstadt.de',
          'SUMMARY:Giant Event',
          giantLine,
          'DTSTART:20261115T100000Z',
          'END:VEVENT',
        ].join('\r\n'),
      )

      const start = Date.now()
      const events = parseIcs(
        ics,
        new Date('2026-11-01T00:00:00Z'),
        new Date('2026-11-30T00:00:00Z'),
      )
      const duration = Date.now() - start

      expect(events.length).toBe(1)
      expect(duration).toBeLessThan(1000) // Must parse in under 1 second without backtracking
    })

    it('5.4.7: Subscriptions with whitespace-only name safely fallback to parsed URL hostname', async () => {
      const sub = await service.calendarSubscribe(
        '   ',
        'https://stundenplan.tu-darmstadt.de/export.ics',
      )
      expect(sub.name).toBe('stundenplan.tu-darmstadt.de')
    })

    it('5.4.8: mergeSubscriptionEvents retains historical events outside rolling window while replacing current ones', () => {
      const baseDate = new Date('2026-11-15T12:00:00Z')

      const existing: CalendarEvent[] = [
        {
          id: 'old-1',
          title: 'Old Event (2 months ago)',
          start: '2026-09-01T10:00:00.000Z',
          end: '2026-09-01T11:30:00.000Z',
          allDay: false,
          kind: 'lecture',
          moduleId: null,
          location: '',
          notes: '',
          subscriptionId: 'sub-1',
          externalId: 'ext-old-1',
        },
        {
          id: 'current-1',
          title: 'Current Event (to be updated)',
          start: '2026-11-15T10:00:00.000Z',
          end: '2026-11-15T11:30:00.000Z',
          allDay: false,
          kind: 'lecture',
          moduleId: null,
          location: 'Old Room',
          notes: '',
          subscriptionId: 'sub-1',
          externalId: 'ext-curr-1',
        },
      ]

      const incoming: CalendarEvent[] = [
        {
          id: 'new-1',
          title: 'Current Event (Updated Room)',
          start: '2026-11-15T10:00:00.000Z',
          end: '2026-11-15T11:30:00.000Z',
          allDay: false,
          kind: 'lecture',
          moduleId: null,
          location: 'New Room S202',
          notes: '',
          subscriptionId: 'sub-1',
          externalId: 'ext-curr-1',
        },
      ]

      const merged = mergeSubscriptionEvents(existing, incoming, baseDate)
      expect(merged.length).toBe(2)
      expect(merged.some((e) => e.externalId === 'ext-old-1')).toBe(true)
      const updated = merged.find((e) => e.externalId === 'ext-curr-1')
      expect(updated?.location).toBe('New Room S202')
    })
  })
})
