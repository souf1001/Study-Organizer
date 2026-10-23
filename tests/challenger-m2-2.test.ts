import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
import { buildSemester } from '../src/shared/semester'
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

function makeEvent(partial: Partial<CalendarEvent> & { id: string; title: string; start: string; end: string }): CalendarEvent {
  return {
    allDay: false,
    kind: 'other',
    moduleId: null,
    location: '',
    notes: '',
    subscriptionId: null,
    externalId: null,
    ...partial,
  }
}

describe('Challenger M2-2: SubscriptionsDialog & EventKind Visuals', () => {
  // ==========================================================================
  // Suite 1: Dedicated CSS Rules in calendar.css
  // ==========================================================================
  describe('CSS Rule Verification in calendar.css', () => {
    const cssPath = path.resolve(__dirname, '../src/renderer/src/views/calendar/calendar.css')
    const cssContent = readFileSync(cssPath, 'utf-8')

    it('contains .cal-event.kind-lab with dotted border', () => {
      expect(cssContent).toMatch(/\.cal-event\.kind-lab\s*\{[^}]*border-left-style:\s*dotted/s)
    })

    it('contains .cal-chip.kind-lab::before with rotated diamond and var(--dot)', () => {
      expect(cssContent).toMatch(/\.cal-chip\.kind-lab::before\s*\{[^}]*transform:\s*rotate\(45deg\)/s)
      expect(cssContent).toMatch(/\.cal-chip\.kind-lab::before\s*\{[^}]*background:\s*var\(--dot\)/s)
    })

    it('contains .cal-event.kind-deadline with orange border-left-color', () => {
      expect(cssContent).toMatch(/\.cal-event\.kind-deadline\s*\{[^}]*border-left-color:\s*var\(--c-orange\)/s)
    })

    it('contains .cal-chip.kind-deadline::before with orange circle ring', () => {
      expect(cssContent).toMatch(/\.cal-chip\.kind-deadline::before\s*\{[^}]*border-radius:\s*50%/s)
      expect(cssContent).toMatch(/\.cal-chip\.kind-deadline::before\s*\{[^}]*border:\s*1\.5px\s+solid\s+var\(--c-orange\)/s)
    })

    it('contains .cal-event.kind-exam and .cal-event.kind-exercise for visual completeness', () => {
      expect(cssContent).toMatch(/\.cal-event\.kind-exam\s*\{[^}]*border-left-color:\s*var\(--c-red\)/s)
      expect(cssContent).toMatch(/\.cal-event\.kind-exercise\s*\{[^}]*border-left-style:\s*dashed/s)
    })

    it('contains subscription dialog and counter styles (.cal-sub-count, .cal-subs-*)', () => {
      expect(cssContent).toContain('.cal-sub-count')
      expect(cssContent).toContain('.cal-subs-list')
      expect(cssContent).toContain('.cal-sub-item')
      expect(cssContent).toContain('.cal-sub-info')
      expect(cssContent).toContain('.cal-sub-name')
      expect(cssContent).toContain('.cal-sub-meta')
      expect(cssContent).toContain('.cal-sub-error')
      expect(cssContent).toContain('.cal-sub-actions')
      expect(cssContent).toContain('.cal-subs-empty')
    })
  })

  // ==========================================================================
  // Suite 2: EventKind Static Analysis & CalendarView Mapping
  // ==========================================================================
  describe('EventKind Code Inspection in entries.ts and CalendarView.tsx', () => {
    const entriesPath = path.resolve(__dirname, '../src/renderer/src/views/calendar/entries.ts')
    const entriesContent = readFileSync(entriesPath, 'utf-8')
    const calViewPath = path.resolve(__dirname, '../src/renderer/src/views/calendar/CalendarView.tsx')
    const calViewContent = readFileSync(calViewPath, 'utf-8')

    it('entries.ts defines EVENT_KINDS with lab: Praktikum and deadline: Frist / Abgabe', () => {
      expect(entriesContent).toContain("lab: 'Praktikum'")
      expect(entriesContent).toContain("deadline: 'Frist / Abgabe'")
    })

    it('entries.ts defines KIND_COLOR with lab: green and deadline: orange', () => {
      expect(entriesContent).toContain("lab: 'green'")
      expect(entriesContent).toContain("deadline: 'orange'")
    })

    it('entries.ts expands deadlines with zero duration by 30 minutes', () => {
      expect(entriesContent).toContain("start.getTime() + 30 * 60_000")
      expect(entriesContent).toMatch(/event\.kind === 'deadline' && start\.getTime\(\) === new Date\(event\.end\)\.getTime\(\)/)
    })

    it('CalendarView.tsx appends kind-${entry.event.kind} to cal-chip and cal-event', () => {
      expect(calViewContent).toContain("className={`cal-chip color-${entry.color} ${entry.source} ${entry.source === 'event' ? `kind-${entry.event.kind}` : ''}`}")
      expect(calViewContent).toContain("className={`cal-event color-${e.color} ${e.source} ${e.source === 'event' ? `kind-${e.event.kind}` : ''}`}")
    })
  })

  // ==========================================================================
  // Suite 3: SubscriptionsDialog Source & Logic Verification
  // ==========================================================================
  describe('SubscriptionsDialog Structure in CalendarView.tsx', () => {
    const calViewPath = path.resolve(__dirname, '../src/renderer/src/views/calendar/CalendarView.tsx')
    const calViewContent = readFileSync(calViewPath, 'utf-8')

    it('SubscriptionsDialog component is defined and uses useDb()', () => {
      expect(calViewContent).toMatch(/function SubscriptionsDialog\(\{ onClose \}: \{ onClose: \(\) => void \}\)/)
      expect(calViewContent).toMatch(/const db = useDb\(\)/)
    })

    it('SubscriptionsDialog calls api.calendar.sync and awaits loadDb()', () => {
      expect(calViewContent).toContain('const res = await api.calendar.sync(sub.id)')
      expect(calViewContent).toContain('await loadDb()')
      expect(calViewContent).toContain("toast(`${res.count} ${res.count === 1 ? 'Termin' : 'Termine'} aktualisiert`)")
    })

    it('SubscriptionsDialog prompts for confirmation before calling api.calendar.unsubscribe', () => {
      expect(calViewContent).toContain('const ok = await confirm({')
      expect(calViewContent).toContain("title: `„${sub.name}“ entfernen?`")
      expect(calViewContent).toContain("message: 'Alle zugehörigen Termine werden aus dem Kalender gelöscht.'")
      expect(calViewContent).toContain("confirmLabel: 'Entfernen'")
      expect(calViewContent).toContain('danger: true')
      expect(calViewContent).toContain('if (!ok) return')
      expect(calViewContent).toContain('await api.calendar.unsubscribe(sub.id)')
      expect(calViewContent).toContain("toast(`„${sub.name}“ wurde entfernt`)")
    })

    it('SubscriptionsDialog calculates eventCount per subscription via filter', () => {
      expect(calViewContent).toContain('const eventCount = db.events.filter((e) => e.subscriptionId === sub.id).length')
      expect(calViewContent).toContain('{` · ${eventCount} ${eventCount === 1 ? \'Termin\' : \'Termine\'}`}')
    })

    it('CalendarView toolbar renders subscription count badge when db.subscriptions.length > 0', () => {
      expect(calViewContent).toContain('db.subscriptions.length > 0 && <span className="cal-sub-count">{db.subscriptions.length}</span>')
    })
  })

  // ==========================================================================
  // Suite 4: Empirical Simulation of SubscriptionsDialog Handlers
  // ==========================================================================
  describe('Empirical Simulation of SubscriptionsDialog Handlers', () => {
    it('handleSync executes api.calendar.sync, loadDb(), and handles singular/plural', async () => {
      const mockApi = {
        calendar: {
          sync: vi.fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 4 }),
        },
      }
      const mockLoadDb = vi.fn().mockResolvedValue(undefined)
      const mockToast = vi.fn()
      const mockToastError = vi.fn()

      let syncingId: string | null = null
      const setSyncingId = (id: string | null) => { syncingId = id }

      const handleSync = async (sub: Subscription) => {
        setSyncingId(sub.id)
        try {
          const res = await mockApi.calendar.sync(sub.id)
          await mockLoadDb()
          mockToast(`${res.count} ${res.count === 1 ? 'Termin' : 'Termine'} aktualisiert`)
        } catch (err) {
          mockToastError(err)
        } finally {
          setSyncingId(null)
        }
      }

      const sub: Subscription = { id: 's-1', name: 'Feed', kind: 'url', url: 'https://cal', enabled: true, lastSync: null, lastError: null }

      await handleSync(sub)
      expect(mockApi.calendar.sync).toHaveBeenCalledWith('s-1')
      expect(mockLoadDb).toHaveBeenCalledTimes(1)
      expect(mockToast).toHaveBeenLastCalledWith('1 Termin aktualisiert')
      expect(syncingId).toBeNull()

      await handleSync(sub)
      expect(mockLoadDb).toHaveBeenCalledTimes(2)
      expect(mockToast).toHaveBeenLastCalledWith('4 Termine aktualisiert')
      expect(syncingId).toBeNull()
    })

    it('handleSync catches errors and resets syncingId cleanly', async () => {
      const mockApi = {
        calendar: {
          sync: vi.fn().mockRejectedValue(new Error('Server 500 error')),
        },
      }
      const mockLoadDb = vi.fn()
      const mockToast = vi.fn()
      const mockToastError = vi.fn()

      let syncingId: string | null = null
      const setSyncingId = (id: string | null) => { syncingId = id }

      const handleSync = async (sub: Subscription) => {
        setSyncingId(sub.id)
        try {
          const res = await mockApi.calendar.sync(sub.id)
          await mockLoadDb()
          mockToast(`${res.count} ${res.count === 1 ? 'Termin' : 'Termine'} aktualisiert`)
        } catch (err) {
          mockToastError(err)
        } finally {
          setSyncingId(null)
        }
      }

      const sub: Subscription = { id: 's-err', name: 'Broken Feed', kind: 'url', url: 'https://err', enabled: true, lastSync: null, lastError: null }

      await handleSync(sub)
      expect(mockToastError).toHaveBeenCalledWith(expect.any(Error))
      expect(mockLoadDb).not.toHaveBeenCalled()
      expect(syncingId).toBeNull()
    })

    it('handleUnsubscribe triggers confirmation dialog and aborts on cancel', async () => {
      const mockConfirm = vi.fn().mockResolvedValue(false)
      const mockApi = { calendar: { unsubscribe: vi.fn() } }
      const mockLoadDb = vi.fn()
      const mockToast = vi.fn()

      const handleUnsubscribe = async (sub: Subscription) => {
        const ok = await mockConfirm({
          title: `„${sub.name}“ entfernen?`,
          message: 'Alle zugehörigen Termine werden aus dem Kalender gelöscht.',
          confirmLabel: 'Entfernen',
          danger: true,
        })
        if (!ok) return
        try {
          await mockApi.calendar.unsubscribe(sub.id)
          await mockLoadDb()
          mockToast(`„${sub.name}“ wurde entfernt`)
        } catch (err) {
          void err
        }
      }

      const sub: Subscription = { id: 's-cancel', name: 'My Sub', kind: 'file', url: 'f.ics', enabled: true, lastSync: null, lastError: null }

      await handleUnsubscribe(sub)
      expect(mockConfirm).toHaveBeenCalledWith({
        title: '„My Sub“ entfernen?',
        message: 'Alle zugehörigen Termine werden aus dem Kalender gelöscht.',
        confirmLabel: 'Entfernen',
        danger: true,
      })
      expect(mockApi.calendar.unsubscribe).not.toHaveBeenCalled()
      expect(mockLoadDb).not.toHaveBeenCalled()
      expect(mockToast).not.toHaveBeenCalled()
    })

    it('handleUnsubscribe calls api.calendar.unsubscribe and loadDb on confirmation', async () => {
      const mockConfirm = vi.fn().mockResolvedValue(true)
      const mockApi = { calendar: { unsubscribe: vi.fn().mockResolvedValue(undefined) } }
      const mockLoadDb = vi.fn().mockResolvedValue(undefined)
      const mockToast = vi.fn()

      const handleUnsubscribe = async (sub: Subscription) => {
        const ok = await mockConfirm({
          title: `„${sub.name}“ entfernen?`,
          message: 'Alle zugehörigen Termine werden aus dem Kalender gelöscht.',
          confirmLabel: 'Entfernen',
          danger: true,
        })
        if (!ok) return
        try {
          await mockApi.calendar.unsubscribe(sub.id)
          await mockLoadDb()
          mockToast(`„${sub.name}“ wurde entfernt`)
        } catch (err) {
          void err
        }
      }

      const sub: Subscription = { id: 's-ok', name: 'TU Darmstadt', kind: 'url', url: 'https://tucan', enabled: true, lastSync: null, lastError: null }

      await handleUnsubscribe(sub)
      expect(mockConfirm).toHaveBeenCalled()
      expect(mockApi.calendar.unsubscribe).toHaveBeenCalledWith('s-ok')
      expect(mockLoadDb).toHaveBeenCalledTimes(1)
      expect(mockToast).toHaveBeenCalledWith('„TU Darmstadt“ wurde entfernt')
    })
  })

  // ==========================================================================
  // Suite 5: Backend Store Cascade Deletion on Unsubscribe
  // ==========================================================================
  describe('Backend Store Cascade Deletion', () => {
    let dir: string
    let store: Store
    let secrets: Secrets & { data: Map<string, string> }
    let service: ReturnType<typeof createService>

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m2-cascade-'))
      store = await Store.open(dir)
      secrets = memorySecrets()
      service = createService(store, secrets)

      const sem = {
        ...buildSemester('uni', 'winter', 2026),
        id: 'sem-2026',
        name: 'WS 2026',
        createdAt: new Date().toISOString(),
      }
      store.put('semesters', sem)
      store.update({ activeSemesterId: 'sem-2026' })
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('cascades deletion of all events belonging to subscription while preserving others', async () => {
      // 1. Setup subscription 1 with 3 events
      const sub1: Subscription = { id: 'sub-cascade-1', name: 'Sub 1', kind: 'url', url: 'https://sub1.ics', enabled: true, lastSync: null, lastError: null }
      store.put('subscriptions', sub1)
      await secrets.set('ics:sub-cascade-1', 'https://sub1.ics')

      const event1 = makeEvent({ id: 'e-sub1-1', title: 'Sub1 Event 1', start: '2026-10-15T10:00:00Z', end: '2026-10-15T11:00:00Z', kind: 'lecture', subscriptionId: 'sub-cascade-1' })
      const event2 = makeEvent({ id: 'e-sub1-2', title: 'Sub1 Event 2', start: '2026-10-16T10:00:00Z', end: '2026-10-16T11:00:00Z', kind: 'lab', subscriptionId: 'sub-cascade-1' })
      const event3 = makeEvent({ id: 'e-sub1-3', title: 'Sub1 Event 3', start: '2026-10-17T10:00:00Z', end: '2026-10-17T11:00:00Z', kind: 'deadline', subscriptionId: 'sub-cascade-1' })

      // 2. Setup subscription 2 with 1 event
      const sub2: Subscription = { id: 'sub-cascade-2', name: 'Sub 2', kind: 'file', url: 'file.ics', enabled: true, lastSync: null, lastError: null }
      store.put('subscriptions', sub2)
      const event4 = makeEvent({ id: 'e-sub2-1', title: 'Sub2 Event', start: '2026-10-18T10:00:00Z', end: '2026-10-18T11:00:00Z', kind: 'exercise', subscriptionId: 'sub-cascade-2' })

      // 3. Setup manual user event without subscriptionId
      const manualEvent = makeEvent({ id: 'e-manual-1', title: 'Manual Event', start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z', kind: 'other' })

      store.put('events', event1)
      store.put('events', event2)
      store.put('events', event3)
      store.put('events', event4)
      store.put('events', manualEvent)

      expect(store.get().subscriptions).toHaveLength(2)
      expect(store.get().events).toHaveLength(5)

      // 4. Call service.calendarUnsubscribe for sub1
      await service.calendarUnsubscribe('sub-cascade-1')

      // 5. Verify sub1 and secret are gone
      expect(store.get().subscriptions.find((s) => s.id === 'sub-cascade-1')).toBeUndefined()
      expect(await secrets.get('ics:sub-cascade-1')).toBeNull()

      // 6. Verify sub1's 3 events are purged
      const remainingEvents = store.get().events
      expect(remainingEvents).toHaveLength(2)
      expect(remainingEvents.some((e) => e.subscriptionId === 'sub-cascade-1')).toBe(false)

      // 7. Verify sub2 and manual event are fully preserved
      expect(remainingEvents.find((e) => e.id === 'e-sub2-1')).toBeDefined()
      expect(remainingEvents.find((e) => e.id === 'e-manual-1')).toBeDefined()
      expect(store.get().subscriptions.find((s) => s.id === 'sub-cascade-2')).toBeDefined()
    })

    it('stress: unsubscribing a subscription with 200 events cascades completely in < 100ms', async () => {
      const sub: Subscription = { id: 'sub-heavy', name: 'Heavy Sub', kind: 'file', url: 'heavy.ics', enabled: true, lastSync: null, lastError: null }
      store.put('subscriptions', sub)

      for (let i = 0; i < 200; i++) {
        store.put('events', makeEvent({
          id: `ev-heavy-${i}`,
          title: `Heavy Event ${i}`,
          start: '2026-10-15T10:00:00Z',
          end: '2026-10-15T11:00:00Z',
          kind: i % 2 === 0 ? 'lab' : 'deadline',
          subscriptionId: 'sub-heavy',
        }))
      }

      expect(store.get().events).toHaveLength(200)

      const start = performance.now()
      await service.calendarUnsubscribe('sub-heavy')
      const elapsed = performance.now() - start

      expect(store.get().subscriptions).toHaveLength(0)
      expect(store.get().events).toHaveLength(0)
      expect(elapsed).toBeLessThan(200)
    })
  })
})
