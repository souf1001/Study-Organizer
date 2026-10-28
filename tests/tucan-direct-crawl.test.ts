import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/backend/store'
import { createService } from '../src/backend/service'

// Hoisted Electron mock
const { MockBrowserWindow, MockSession, MockDownloadItem } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class MockWebContents {
    public id = Math.floor(Math.random() * 100000)
    public listeners: Record<string, Listener[]> = {}
    public executedScripts: string[] = []

    on(event: string, fn: Listener) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(fn)
    }

    emit(event: string, ...args: unknown[]) {
      this.listeners[event]?.slice().forEach((fn) => fn(...args))
    }

    async executeJavaScript(script: string): Promise<void> {
      this.executedScripts.push(script)
    }

    setWindowOpenHandler() {}
  }

  class MockBrowserWindow {
    public static instances: MockBrowserWindow[] = []
    public webContents = new MockWebContents()
    public listeners: Record<string, Listener[]> = {}
    public destroyed = false
    public closed = false

    constructor(_opts: Record<string, unknown> = {}) {
      MockBrowserWindow.instances.push(this)
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

    async loadURL(): Promise<void> {}
  }

  class MockSession {
    public static sessions: Map<string, MockSession> = new Map()
    public listeners: Record<string, Listener[]> = {}

    static fromPartition(partition: string): MockSession {
      if (!MockSession.sessions.has(partition)) {
        MockSession.sessions.set(partition, new MockSession())
      }
      return MockSession.sessions.get(partition)!
    }

    setPermissionRequestHandler() {}

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
    public listeners: Record<string, Listener[]> = {}
    public savePath = ''
    constructor(
      public filename = 'tucan-stundenplan.ics',
      public mime = 'text/calendar',
      public url = 'https://www.tucan.tu-darmstadt.de/export.ics',
    ) {}
    getFilename() {
      return this.filename
    }
    getMimeType() {
      return this.mime
    }
    getURL() {
      return this.url
    }
    setSavePath(p: string) {
      this.savePath = p
    }
    on(event: string, fn: Listener) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(fn)
    }
    once(event: string, fn: Listener) {
      this.on(event, (...args: unknown[]) => {
        fn(...args)
      })
    }
    emit(event: string, ...args: unknown[]) {
      this.listeners[event]?.slice().forEach((fn) => fn(...args))
    }
    cancel() {}
  }

  return { MockBrowserWindow, MockSession, MockDownloadItem }
})

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  session: MockSession,
}))

import { startTucanWizard } from '../src/main/tucan-session'

describe('TUCaN In-Page Background Fetch & Completion Button', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tucan-crawl-test-'))
    MockBrowserWindow.instances = []
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('imports multi-month calendar from STUDY_ORGANIZER_DIRECT_ICS without abruptly closing the window', async () => {
    const store = await Store.open(tmpDir)
    const secrets = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    }
    const service = createService(store, secrets)

    const wizardPromise = startTucanWizard(service)
    const win = MockBrowserWindow.instances[0]
    expect(win).toBeDefined()

    // Trigger dom-ready to inject banner
    win.webContents.emit('dom-ready')
    expect(win.webContents.executedScripts.length).toBeGreaterThan(0)
    const bannerScript = win.webContents.executedScripts[0]
    expect(bannerScript).toContain('study-organizer-tucan-banner')
    expect(bannerScript).toContain('fetchIcsOption')
    expect(bannerScript).toContain('STUDY_ORGANIZER_DIRECT_ICS:')

    // Prepare multi-month ICS data payload
    const octIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:tucan-oct-1',
      'SUMMARY:20-00-0015-iv Functional Programming',
      'DTSTART:20261020T100000Z',
      'DTEND:20261020T114000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const novIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:tucan-nov-1',
      'SUMMARY:20-00-0012-vl Software Engineering',
      'DTSTART:20261105T080000Z',
      'DTEND:20261105T094000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    // Simulate in-page crawler completion message
    win.webContents.emit(
      'console-message',
      {},
      0,
      'STUDY_ORGANIZER_DIRECT_ICS:' + JSON.stringify([octIcs, novIcs]),
    )

    // Wait for the async console-message handler to process and import
    await new Promise((r) => setTimeout(r, 50))

    // Verify window is STILL OPEN and NOT closed abruptly!
    expect(win.isDestroyed()).toBe(false)
    expect(win.closed).toBe(false)

    // Verify the completion UI script was executed to show success and completion button
    const completionScript = win.webContents.executedScripts.find((s) =>
      s.includes('Termine importiert'),
    )
    expect(completionScript).toBeDefined()
    expect(completionScript).toContain('2 Termine importiert')
    expect(completionScript).toContain('Alle 2 Abschnitte erfolgreich eingelesen')

    // Now the student clicks "✓ Fertigstellen / Schließen" which triggers win.close()
    win.close()

    // Wizard promise should now cleanly resolve with success and count
    const result = await wizardPromise
    expect(result.success).toBe(true)
    expect(result.count).toBe(2)

    // Check store in database
    const db = store.get()
    expect(db.events.length).toBe(2)
  })

  it('notifies user on empty ICS list and keeps wizard open for retry', async () => {
    const store = await Store.open(tmpDir)
    const secrets = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    }
    const service = createService(store, secrets)

    const wizardPromise = startTucanWizard(service)
    const win = MockBrowserWindow.instances[0]

    // Empty list returned from crawl
    win.webContents.emit('console-message', {}, 0, 'STUDY_ORGANIZER_DIRECT_ICS:[]')
    await new Promise((r) => setTimeout(r, 20))

    // Window remains open
    expect(win.isDestroyed()).toBe(false)
    const retryScripts = win.webContents.executedScripts.filter((s) =>
      s.includes('Erneut versuchen'),
    )
    expect(retryScripts.length).toBeGreaterThan(0)

    // Closing without any import resolves with cancellation error
    win.close()
    const result = await wizardPromise
    expect(result.success).toBe(false)
    expect(result.error).toContain('abgebrochen')
  })

  it('handles structured crawl payload with month counting and German banner text', async () => {
    const store = await Store.open(tmpDir)
    const secrets = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    }
    const service = createService(store, secrets)

    const wizardPromise = startTucanWizard(service)
    const win = MockBrowserWindow.instances[0]

    const octIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:tucan-oct-struct',
      'SUMMARY:20-00-0015-iv Functional Programming',
      'DTSTART:20261020T100000Z',
      'DTEND:20261020T114000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    win.webContents.emit(
      'console-message',
      {},
      0,
      'STUDY_ORGANIZER_DIRECT_ICS:' +
        JSON.stringify({
          icsList: [octIcs],
          total: 6,
          isMonth: true,
          unit: 'Monate',
        }),
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(win.isDestroyed()).toBe(false)

    const completionScript = win.webContents.executedScripts.find((s) =>
      s.includes('Termine importiert'),
    )
    expect(completionScript).toBeDefined()
    expect(completionScript).toContain('Alle 6 Monate erfolgreich eingelesen')
    expect(completionScript).toContain('1 Termine importiert')
    expect(completionScript).toContain('✓ Fertigstellen / Schließen')

    win.close()
    const res = await wizardPromise
    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
  })

  it('intercepts standalone calendar file download and resolves cleanly with imported event count', async () => {
    const store = await Store.open(tmpDir)
    const secrets = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    }
    const service = createService(store, secrets)

    const wizardPromise = startTucanWizard(service)
    const win = MockBrowserWindow.instances[0]
    const ses = MockSession.fromPartition('tucan-session')

    const testIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:tucan-dl-1',
      'SUMMARY:20-00-0012-vl Software Engineering',
      'DTSTART:20261105T080000Z',
      'DTEND:20261105T094000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const downloadItem = new MockDownloadItem('stundenplan.ics')
    ses.emit('will-download', {}, downloadItem, win.webContents)

    // Verify savePath was set to a temporary file
    expect(downloadItem.savePath).toBeTruthy()
    // Write fake downloaded file to savePath
    await fs.writeFile(downloadItem.savePath, testIcs)

    // Emit download completion with event object and state string
    downloadItem.emit('done', {}, 'completed')

    const res = await wizardPromise
    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
  })
})
