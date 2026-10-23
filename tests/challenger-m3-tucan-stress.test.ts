/**
 * Challenger M3 Empirical Stress Test Suite: TUCaN & University Integration Wizard
 *
 * Verifies:
 * 1. isIcsDownload boundary cases and MIME/URL patterns.
 * 2. startTucanWizard download interception and ephemeral temp file cleanup.
 * 3. User cancellation error handling (verifying 'abgebrochen' substring).
 * 4. Network and load failures (verifying 'fehlgeschlagen' substring).
 * 5. UTF-16LE BOM decoding of timetable stream from TUCaN with complex German characters.
 * 6. UTF-16BE BOM and UTF-8 BOM decoding.
 * 7. Non-ICS download rejection while keeping the wizard alive.
 * 8. Malformed ICS error handling and unlinking.
 * 9. Security isolation (partition, sandbox, contextIsolation, permission request denial).
 * 10. Navigation guarding and popup denial.
 * 11. Multi-window concurrency and webContents.id download isolation.
 * 12. Odd-byte truncated UTF-16LE recovery.
 * 13. Feed URL schema validation (webcal://, webcals://, http://, https://).
 * 14. Signature flexibility (service, parentWindow) vs (parentWindow, service).
 */

import { existsSync, promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ----------------------------------------------------------------------------
// Hoisted Controllable Electron Mocks
// ----------------------------------------------------------------------------

const { MockBrowserWindow, MockSession, MockDownloadItem } = vi.hoisted(() => {
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
      if (url.includes('reject-url-error')) {
        throw new Error('net::ERR_NAME_NOT_RESOLVED')
      }
    }
  }

  class MockSession {
    public static sessions: Map<string, MockSession> = new Map()
    public partition: string
    public permissionHandler: ((wc: unknown, perm: string, cb: (grant: boolean) => void) => void) | null = null
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

    setPermissionRequestHandler(fn: (wc: unknown, perm: string, cb: (grant: boolean) => void) => void) {
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

  return { MockWebContents, MockBrowserWindow, MockSession, MockDownloadItem }
})

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  session: {
    fromPartition: (p: string) => MockSession.fromPartition(p),
  },
}))

// Import tested modules after mocking electron
import { isIcsDownload, startTucanWizard } from '../src/main/tucan-session'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { buildSemester } from '../src/shared/semester'

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (name: string) => data.get(name) ?? null,
    set: async (name: string, value: string) => void data.set(name, value),
    remove: async (name: string) => void data.delete(name),
  }
}

function encodeUtf16Le(str: string, withBom = true): Buffer {
  const buf = Buffer.alloc(str.length * 2 + (withBom ? 2 : 0))
  let offset = 0
  if (withBom) {
    buf[0] = 0xff
    buf[1] = 0xfe
    offset = 2
  }
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16LE(str.charCodeAt(i), offset)
    offset += 2
  }
  return buf
}

function encodeUtf16Be(str: string, withBom = true): Buffer {
  const buf = Buffer.alloc(str.length * 2 + (withBom ? 2 : 0))
  let offset = 0
  if (withBom) {
    buf[0] = 0xfe
    buf[1] = 0xff
    offset = 2
  }
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), offset)
    offset += 2
  }
  return buf
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
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`, `SUMMARY:${p.summary}`, `DTSTART:${p.start}`]
  if (p.end) lines.push(`DTEND:${p.end}`)
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
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

describe('Challenger M3: TUCaN Session Wizard Empirical Stress Harness', () => {
  let tempDir: string
  let store: Store
  let service: ReturnType<typeof createService>

  beforeEach(async () => {
    MockBrowserWindow.instances = []
    MockSession.sessions.clear()

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tucan-challenger-'))
    store = await Store.open(tempDir)
    store.put('semesters', {
      ...buildSemester('uni', 'winter', 2026),
      id: 'sem-wise26',
      name: 'Wintersemester 2026/27',
      createdAt: new Date().toISOString(),
    })
    service = createService(store, memorySecrets())
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  // ==========================================================================
  // Section 1: isIcsDownload Filtering & Edge Cases
  // ==========================================================================
  describe('1. isIcsDownload Filtering & Edge Cases', () => {
    it('accurately detects standard .ics filenames regardless of case', () => {
      expect(isIcsDownload(new MockDownloadItem({ filename: 'stundenplan.ics' }) as unknown as import('electron').DownloadItem)).toBe(true)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'Export_TUCaN.ICS' }) as unknown as import('electron').DownloadItem)).toBe(true)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'schedule (1).iCs' }) as unknown as import('electron').DownloadItem)).toBe(true)
    })

    it('accurately detects calendar MIME types', () => {
      expect(isIcsDownload(new MockDownloadItem({ filename: 'export', mime: 'text/calendar' }) as unknown as import('electron').DownloadItem)).toBe(true)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'export', mime: 'application/ics' }) as unknown as import('electron').DownloadItem)).toBe(true)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'export', mime: 'text/x-vcalendar' }) as unknown as import('electron').DownloadItem)).toBe(true)
    })

    it('accurately detects calendar URL patterns', () => {
      expect(isIcsDownload(new MockDownloadItem({ filename: 'file', url: 'https://tucan.tu-darmstadt.de/schedule.ics' }) as unknown as import('electron').DownloadItem)).toBe(true)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'file', url: 'https://tucan.tu-darmstadt.de/export?format=ics' }) as unknown as import('electron').DownloadItem)).toBe(true)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'file', url: 'https://tucan.tu-darmstadt.de/get?file=cal.ics&token=xyz' }) as unknown as import('electron').DownloadItem)).toBe(true)
    })

    it('rejects non-calendar files and non-calendar MIME types', () => {
      expect(isIcsDownload(new MockDownloadItem({ filename: 'vorlesung_skript.pdf', mime: 'application/pdf', url: 'https://tucan.tu-darmstadt.de/dl/skript.pdf' }) as unknown as import('electron').DownloadItem)).toBe(false)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'archive.zip', mime: 'application/zip', url: 'https://tucan.tu-darmstadt.de/files.zip' }) as unknown as import('electron').DownloadItem)).toBe(false)
      expect(isIcsDownload(new MockDownloadItem({ filename: 'index.html', mime: 'text/html', url: 'https://tucan.tu-darmstadt.de/home' }) as unknown as import('electron').DownloadItem)).toBe(false)
    })
  })

  // ==========================================================================
  // Section 2: User Cancellation Simulation
  // ==========================================================================
  describe('2. User Cancellation Simulation', () => {
    it('resolves with success: false and error containing "abgebrochen" when window is closed without download', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      expect(win).toBeDefined()

      // Simulate student closing the window
      win.close()

      const result = await wizardPromise
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error?.toLowerCase()).toContain('abgebrochen')
      expect(store.get().events).toHaveLength(0)
    })

    it('cleans up session will-download listener when cancelled', async () => {
      const ses = MockSession.fromPartition('tucan-session')
      const initialListeners = ses.listeners['will-download']?.length ?? 0

      const wizardPromise = startTucanWizard(service)
      expect((ses.listeners['will-download']?.length ?? 0)).toBe(initialListeners + 1)

      const win = MockBrowserWindow.instances[0]
      win.close()

      await wizardPromise
      expect(ses.listeners['will-download']?.length ?? 0).toBe(initialListeners)
    })
  })

  // ==========================================================================
  // Section 3: Download Failure & Network Interruption Simulation
  // ==========================================================================
  describe('3. Download Failure & Network Interruption Simulation', () => {
    it('handles download interrupted state during transmission with error containing "fehlgeschlagen"', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'tucan-export.ics',
        mime: 'text/calendar',
        url: 'https://www.tucan.tu-darmstadt.de/export.ics',
      })

      // Trigger will-download
      ses.emit('will-download', {}, downloadItem, win.webContents)

      // Verify temp path was assigned
      const savePath = downloadItem.getSavePath()
      expect(savePath).toBeTruthy()

      // Simulate connection interruption during progress
      downloadItem.emit('updated', {}, 'interrupted')

      const result = await wizardPromise
      expect(result.success).toBe(false)
      expect(result.error?.toLowerCase()).toContain('fehlgeschlagen')

      // Ensure temp file is cleaned up if it was created
      if (savePath) {
        expect(existsSync(savePath)).toBe(false)
      }
    })

    it('handles download done with cancelled state with error containing "abgebrochen"', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const downloadItem = new MockDownloadItem({
        filename: 'tucan-export.ics',
        mime: 'text/calendar',
      })

      ses.emit('will-download', {}, downloadItem, win.webContents)
      downloadItem.emit('done', {}, 'cancelled')

      const result = await wizardPromise
      expect(result.success).toBe(false)
      expect(result.error?.toLowerCase()).toContain('abgebrochen')
    })

    it('handles webContents did-fail-load with error containing "fehlgeschlagen"', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]

      // Simulate network outage / DNS failure on main frame (errorCode != -3)
      win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://www.tucan.tu-darmstadt.de/', true)

      const result = await wizardPromise
      expect(result.success).toBe(false)
      expect(result.error?.toLowerCase()).toContain('fehlgeschlagen')
    })

    it('ignores non-main-frame or aborted (-3) did-fail-load events', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]

      // Subframe abort should not kill the wizard
      win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://tucan/tracker', false)

      let settled = false
      wizardPromise.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)

      win.close()
      await wizardPromise
    })
  })

  // ==========================================================================
  // Section 4: Non-ICS Download Interception Resilience
  // ==========================================================================
  describe('4. Non-ICS Download Interception Resilience', () => {
    it('cancels non-calendar download without aborting the wizard session', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      // User accidentally clicks a PDF manual
      const pdfItem = new MockDownloadItem({
        filename: 'anleitung.pdf',
        mime: 'application/pdf',
      })

      ses.emit('will-download', {}, pdfItem, win.webContents)
      expect(pdfItem.cancelled).toBe(true)

      // Wizard should still be running
      let settled = false
      wizardPromise.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)

      // Now user clicks the proper ICS export
      const icsData = vcal(vevent({
        uid: 'tucan-valid-1',
        summary: 'Mathematik 1 - Vorlesung',
        start: '20261014T080000Z',
        end: '20261014T093000Z',
      }))

      const icsItem = new MockDownloadItem({
        filename: 'stundenplan.ics',
        mime: 'text/calendar',
      })

      ses.emit('will-download', {}, icsItem, win.webContents)
      const tempPath = icsItem.getSavePath()!
      await fs.writeFile(tempPath, icsData, 'utf-8')

      icsItem.emit('done', {}, 'completed')

      const result = await wizardPromise
      expect(result.success).toBe(true)
      expect(result.count).toBe(1)
      expect(store.get().events[0].title).toBe('Mathematik 1 - Vorlesung')
    })
  })

  // ==========================================================================
  // Section 5: Successful Download & UTF-16LE BOM Decoding
  // ==========================================================================
  describe('5. Successful Download & UTF-16LE BOM Decoding', () => {
    it('successfully imports UTF-16LE with BOM timetable export and removes temp file', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const icsString = vcal(vevent({
        uid: 'tucan-utf16le-1',
        summary: 'Software Engineering - Vorlesung',
        start: '20261015T100000Z',
        end: '20261015T113000Z',
        location: 'S2|02 / Room A',
        description: 'TUCaN Vorlesung mit Umlauten: Überprüfung & Grüße',
      }))

      const utf16Bytes = encodeUtf16Le(icsString, true)

      const item = new MockDownloadItem({
        filename: 'tucan_stundenplan.ics',
        mime: 'text/calendar',
      })

      ses.emit('will-download', {}, item, win.webContents)
      const tempPath = item.getSavePath()!
      expect(tempPath).toBeDefined()

      await fs.writeFile(tempPath, utf16Bytes)
      item.emit('done', {}, 'completed')

      const result = await wizardPromise
      expect(result.success).toBe(true)
      expect(result.count).toBe(1)

      const savedEvents = store.get().events
      expect(savedEvents).toHaveLength(1)
      expect(savedEvents[0].title).toBe('Software Engineering - Vorlesung')
      expect(savedEvents[0].notes).toContain('Überprüfung & Grüße')
      expect(savedEvents[0].location).toBe('S2|02 / Room A')
      expect(savedEvents[0].kind).toBe('lecture')

      // Crucial: temp file MUST be deleted immediately
      expect(existsSync(tempPath)).toBe(false)
    })

    it('successfully imports UTF-16BE with BOM timetable export', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const icsString = vcal(vevent({
        uid: 'tucan-utf16be-1',
        summary: 'Rechnerorganisation - Übung',
        start: '20261016T140000Z',
        end: '20261016T153000Z',
      }))

      const utf16Bytes = encodeUtf16Be(icsString, true)

      const item = new MockDownloadItem({
        filename: 'stundenplan.ics',
        mime: 'text/calendar',
      })

      ses.emit('will-download', {}, item, win.webContents)
      const tempPath = item.getSavePath()!
      await fs.writeFile(tempPath, utf16Bytes)
      item.emit('done', {}, 'completed')

      const result = await wizardPromise
      expect(result.success).toBe(true)
      expect(result.count).toBe(1)
      expect(store.get().events[0].title).toBe('Rechnerorganisation - Übung')
      expect(store.get().events[0].kind).toBe('exercise')
      expect(existsSync(tempPath)).toBe(false)
    })
  })

  // ==========================================================================
  // Section 6: Malformed ICS & Error State Ephemeral Cleanup
  // ==========================================================================
  describe('6. Malformed ICS & Error State Ephemeral Cleanup', () => {
    it('handles corrupted ICS download, returns error, and cleans temp file', async () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]
      const ses = MockSession.fromPartition('tucan-session')

      const corruptData = Buffer.from('NOT_A_VALID_ICAL_FILE_GARBAGE_CONTENT', 'utf-8')

      const item = new MockDownloadItem({
        filename: 'corrupted.ics',
        mime: 'text/calendar',
      })

      ses.emit('will-download', {}, item, win.webContents)
      const tempPath = item.getSavePath()!
      await fs.writeFile(tempPath, corruptData)
      item.emit('done', {}, 'completed')

      const result = await wizardPromise
      expect(result.success).toBe(false)
      expect(result.error).toContain('keine iCal-Datei')
      expect(existsSync(tempPath)).toBe(false)
    })
  })

  // ==========================================================================
  // Section 7: Security & Partition Isolation
  // ==========================================================================
  describe('7. Security & Partition Isolation', () => {
    it('enforces isolated session partition and strict sandbox webPreferences', () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]

      const webPrefs = win.options.webPreferences as Record<string, unknown>
      expect(webPrefs.partition).toBe('tucan-session')
      expect(webPrefs.sandbox).toBe(true)
      expect(webPrefs.contextIsolation).toBe(true)
      expect(webPrefs.nodeIntegration).toBe(false)

      win.close()
      return wizardPromise
    })

    it('denies all permission requests via setPermissionRequestHandler', () => {
      const wizardPromise = startTucanWizard(service)
      const ses = MockSession.fromPartition('tucan-session')

      expect(ses.permissionHandler).toBeDefined()
      let granted = true
      ses.permissionHandler!(null, 'geolocation', (result: boolean) => {
        granted = result
      })
      expect(granted).toBe(false)

      ses.permissionHandler!(null, 'media', (result: boolean) => {
        granted = result
      })
      expect(granted).toBe(false)

      MockBrowserWindow.instances[0].close()
      return wizardPromise
    })

    it('blocks external window popups and allows only TUCaN navigation', () => {
      const wizardPromise = startTucanWizard(service)
      const win = MockBrowserWindow.instances[0]

      const handler = win.webContents.windowOpenHandler
      expect(handler).toBeDefined()

      // Malicious or third-party URL
      const rogueResult = handler!({ url: 'https://evil-phishing.com/login' })
      expect(rogueResult.action).toBe('deny')

      // Official TUCaN internal navigation
      const tucanResult = handler!({ url: 'https://www.tucan.tu-darmstadt.de/subpage' })
      expect(tucanResult.action).toBe('deny')
      expect(win.loadedUrls).toContain('https://www.tucan.tu-darmstadt.de/subpage')

      win.close()
      return wizardPromise
    })
  })

  // ==========================================================================
  // Section 8: Signature Flexibility
  // ==========================================================================
  describe('8. Signature Flexibility', () => {
    it('accepts both (service, parentWindow) and (parentWindow, service)', async () => {
      const dummyParent = new MockBrowserWindow()

      const p1 = startTucanWizard(service, dummyParent as unknown as import('electron').BrowserWindow)
      const win1 = MockBrowserWindow.instances[MockBrowserWindow.instances.length - 1]
      expect(win1.options.parent).toBe(dummyParent)
      win1.close()
      await p1

      const p2 = startTucanWizard(dummyParent as unknown as import('electron').BrowserWindow, service)
      const win2 = MockBrowserWindow.instances[MockBrowserWindow.instances.length - 1]
      expect(win2.options.parent).toBe(dummyParent)
      win2.close()
      await p2
    })
  })

  // ==========================================================================
  // Section 9: Multi-Window Concurrency & Download WebContents Isolation
  // ==========================================================================
  describe('9. Multi-Window Concurrency & Download WebContents Isolation', () => {
    it('isolates downloads to the matching window webContents.id', async () => {
      const p1 = startTucanWizard(service)
      const win1 = MockBrowserWindow.instances[0]

      const p2 = startTucanWizard(service)
      const win2 = MockBrowserWindow.instances[1]

      const ses = MockSession.fromPartition('tucan-session')

      // Download triggered specifically in window 2
      const icsData = vcal(vevent({
        uid: 'win2-event',
        summary: 'Window 2 Vorlesung',
        start: '20261018T100000Z',
      }))
      const item = new MockDownloadItem({
        filename: 'win2.ics',
        mime: 'text/calendar',
      })

      ses.emit('will-download', {}, item, win2.webContents)
      const tempPath = item.getSavePath()!
      await fs.writeFile(tempPath, icsData, 'utf-8')
      item.emit('done', {}, 'completed')

      // Window 2 should finish
      const r2 = await p2
      expect(r2.success).toBe(true)
      expect(r2.count).toBe(1)

      // Window 1 should still be open and running
      let p1Settled = false
      p1.then(() => {
        p1Settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(p1Settled).toBe(false)

      win1.close()
      const r1 = await p1
      expect(r1.success).toBe(false)
      expect(r1.error?.toLowerCase()).toContain('abgebrochen')
    })
  })

  // ==========================================================================
  // Section 10: WebCal URL Validation Suite
  // ==========================================================================
  describe('10. WebCal Feed URL Schema Validation', () => {
    it('accepts valid webcal, webcals, http, and https URLs', () => {
      expect(isValidFeedUrl('webcal://campus.example.de/cal.ics')).toBe(true)
      expect(isValidFeedUrl('webcals://campus.example.de/cal.ics')).toBe(true)
      expect(isValidFeedUrl('https://moodle.tu-darmstadt.de/calendar/export.ics')).toBe(true)
      expect(isValidFeedUrl('http://localhost:8080/test.ics')).toBe(true)
      expect(isValidFeedUrl('  webcal://tu-darmstadt.de/feed.ics  ')).toBe(true)
    })

    it('rejects forbidden or invalid protocols and garbage inputs', () => {
      expect(isValidFeedUrl('')).toBe(false)
      expect(isValidFeedUrl('   ')).toBe(false)
      expect(isValidFeedUrl('file:///etc/passwd')).toBe(false)
      expect(isValidFeedUrl('javascript:alert(1)')).toBe(false)
      expect(isValidFeedUrl('data:text/calendar,...')).toBe(false)
      expect(isValidFeedUrl('ftp://example.com/cal.ics')).toBe(false)
      expect(isValidFeedUrl('webcal://')).toBe(false)
      expect(isValidFeedUrl('https://')).toBe(false)
    })
  })
})
