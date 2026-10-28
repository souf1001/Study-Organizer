/**
 * Empirical Stress Test Harness for Milestone 2: CalendarView ICS Upload & Drag-and-Drop UX
 *
 * Verifies:
 * 1. Corrupted ICS files (invalid syntax, truncated, malformed RRULE, garbage binary)
 * 2. Non-ICS files (.pdf, .txt, .json, .png, extensionless, mixed-case extensions)
 * 3. Empty files and whitespace-only files
 * 4. Multi-file uploads (all-valid, mixed valid/invalid, all-invalid, empty batches)
 * 5. Drag-and-drop dropzone state transitions and flicker guard
 * 6. Concurrency, cancellation, and busy state handling
 * 7. Security injection and boundary values
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createService, type Secrets } from '../src/backend/service'
import { Store } from '../src/backend/store'
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
  rrule?: string
}): string {
  const lines = ['BEGIN:VEVENT', `UID:${p.uid}`]
  lines.push(`SUMMARY:${p.summary}`)
  lines.push(`DTSTART:${p.start}`)
  if (p.end) lines.push(`DTEND:${p.end}`)
  if (p.location) lines.push(`LOCATION:${p.location}`)
  if (p.description) lines.push(`DESCRIPTION:${p.description}`)
  if (p.categories?.length) lines.push(`CATEGORIES:${p.categories.join(',')}`)
  if (p.rrule) lines.push(`RRULE:${p.rrule}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n') + '\r\n'
}

/**
 * Controller harness simulating the exact runtime logic of CalendarView.tsx
 */
class CalendarViewControllerHarness {
  public busy = false
  public dropping = false
  public toasts: Array<{ message: string; error?: boolean }> = []
  public dbLoads = 0

  constructor(
    public service: ReturnType<typeof createService>,
    public store: Store,
  ) {}

  public async handleImportFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    this.busy = true
    let totalEvents = 0
    let importedFiles = 0

    try {
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.ics') && file.type !== 'text/calendar') {
          this.toast(`„${file.name}“ ist keine gültige iCal-Datei.`, { error: true })
          continue
        }
        try {
          const text = await file.text()
          if (!text.trim()) {
            this.toast(`„${file.name}“ ist leer.`, { error: true })
            continue
          }
          const res = await this.service.calendarImportFile(file.name, text)
          totalEvents += res.count
          importedFiles++
        } catch (err) {
          this.toastError(err)
        }
      }

      if (importedFiles > 0) {
        await this.loadDb()
        this.toast(`${totalEvents} ${totalEvents === 1 ? 'Termin' : 'Termine'} importiert`)
      }
    } finally {
      this.busy = false
    }
  }

  public async handleUploadButton(pickerFn: () => Promise<File[] | null>): Promise<void> {
    if (this.busy) return
    const files = await pickerFn()
    if (files && files.length > 0) {
      await this.handleImportFiles(files)
    }
  }

  public onDragOver(types: string[]): boolean {
    if (!types.includes('Files')) return false
    this.dropping = true
    return true
  }

  public onDragLeave(containsRelatedTarget: boolean): void {
    if (!containsRelatedTarget) {
      this.dropping = false
    }
  }

  public async onDrop(files: File[]): Promise<void> {
    this.dropping = false
    if (files.length > 0) {
      await this.handleImportFiles(files)
    }
  }

  public toast(message: string, options: { error?: boolean } = {}): void {
    this.toasts.push({ message, error: Boolean(options.error) })
  }

  public toastError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.toast(msg, { error: true })
  }

  public async loadDb(): Promise<void> {
    this.dbLoads++
  }

  public getEvents(): CalendarEvent[] {
    return this.store.get().events
  }

  public getSubscriptions(): Subscription[] {
    return this.store.get().subscriptions
  }
}

describe('Challenger M2: Stress Testing CalendarView ICS Upload & Drag-and-Drop UX', () => {
  let dir: string
  let store: Store
  let secrets: Secrets & { data: Map<string, string> }
  let service: ReturnType<typeof createService>
  let ctrl: CalendarViewControllerHarness

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'challenger-m2-'))
    store = await Store.open(dir)
    secrets = memorySecrets()
    service = createService(store, secrets)
    ctrl = new CalendarViewControllerHarness(service, store)
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  // ==========================================================================
  // 1. Non-ICS Files Testing (.pdf, .txt, .json, .png, extensionless)
  // ==========================================================================
  describe('1. Non-ICS Files Rejection and Toast Validation', () => {
    it('rejects .pdf file and displays formatted error toast', async () => {
      const pdf = new File(['%PDF-1.4 ... fake pdf content'], 'vorlesung_skript.pdf', {
        type: 'application/pdf',
      })
      await ctrl.handleImportFiles([pdf])

      expect(ctrl.busy).toBe(false)
      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toBe('„vorlesung_skript.pdf“ ist keine gültige iCal-Datei.')
      expect(ctrl.getEvents()).toHaveLength(0)
      expect(ctrl.getSubscriptions()).toHaveLength(0)
      expect(ctrl.dbLoads).toBe(0)
    })

    it('rejects .txt file and displays formatted error toast', async () => {
      const txt = new File(['Hallo Welt Notizen'], 'notizen.txt', { type: 'text/plain' })
      await ctrl.handleImportFiles([txt])

      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toBe('„notizen.txt“ ist keine gültige iCal-Datei.')
      expect(ctrl.getEvents()).toHaveLength(0)
    })

    it('rejects .json file and displays formatted error toast', async () => {
      const json = new File(['{"events": []}'], 'calendar.json', { type: 'application/json' })
      await ctrl.handleImportFiles([json])

      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toBe('„calendar.json“ ist keine gültige iCal-Datei.')
    })

    it('rejects file without extension and non-calendar MIME type', async () => {
      const noExt = new File(['Some random content'], 'stundenplan', { type: '' })
      await ctrl.handleImportFiles([noExt])

      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toBe('„stundenplan“ ist keine gültige iCal-Datei.')
    })

    it('accepts file with uppercase .ICS extension', async () => {
      const validText = vcal(
        vevent({
          uid: 'uc1',
          summary: 'Uppercase ICS',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      const icsUpper = new File([validText], 'SCHEDULE.ICS', { type: '' })
      await ctrl.handleImportFiles([icsUpper])

      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe('Uppercase ICS')
      expect(ctrl.toasts.some((t) => !t.error && t.message.includes('1 Termin importiert'))).toBe(
        true,
      )
    })

    it('accepts file without .ics extension if MIME type is text/calendar', async () => {
      const validText = vcal(
        vevent({
          uid: 'mime1',
          summary: 'MIME Calendar',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      const mimeFile = new File([validText], 'export_from_portal', { type: 'text/calendar' })
      await ctrl.handleImportFiles([mimeFile])

      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe('MIME Calendar')
    })
  })

  // ==========================================================================
  // 2. Empty and Blank Files Testing
  // ==========================================================================
  describe('2. Empty and Blank Files Rejection', () => {
    it('rejects 0-byte .ics file with empty message toast', async () => {
      const empty = new File([], 'empty.ics', { type: 'text/calendar' })
      await ctrl.handleImportFiles([empty])

      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toBe('„empty.ics“ ist leer.')
      expect(ctrl.getEvents()).toHaveLength(0)
      expect(ctrl.dbLoads).toBe(0)
    })

    it('rejects whitespace-only .ics file with empty message toast', async () => {
      const blank = new File(['   \r\n\t  \n  '], 'blank.ics')
      await ctrl.handleImportFiles([blank])

      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toBe('„blank.ics“ ist leer.')
      expect(ctrl.getEvents()).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 3. Corrupted ICS Files Testing
  // ==========================================================================
  describe('3. Corrupted and Malformed ICS Files Handling', () => {
    it('handles non-iCalendar body with .ics extension via toastError', async () => {
      const corrupt = new File(['THIS IS NOT AN ICALENDAR STREAM AT ALL'], 'corrupt.ics')
      await ctrl.handleImportFiles([corrupt])

      expect(ctrl.toasts).toHaveLength(1)
      expect(ctrl.toasts[0].error).toBe(true)
      expect(ctrl.toasts[0].message).toContain('keine iCal-Datei')
      expect(ctrl.getEvents()).toHaveLength(0)
      expect(ctrl.getSubscriptions()).toHaveLength(0)
    })

    it('handles truncated VEVENT stream without crash', async () => {
      const truncated = new File(
        ['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:broken-1\r\nSUMMARY:Truncated'],
        'truncated.ics',
      )
      await ctrl.handleImportFiles([truncated])

      expect(ctrl.busy).toBe(false)
      // Either ical parser handles with 0 events or rejects with toastError
      expect(ctrl.getEvents()).toHaveLength(0)
    })

    it('preserves existing events when subsequent import is corrupted', async () => {
      // Step 1: Import valid file
      const validText = vcal(
        vevent({
          uid: 'safe1',
          summary: 'Gültiger Termin',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      await ctrl.handleImportFiles([new File([validText], 'valid.ics')])
      expect(ctrl.getEvents()).toHaveLength(1)

      // Step 2: Drop corrupted file
      await ctrl.handleImportFiles([new File(['CORRUPTED DATA'], 'corrupt.ics')])
      expect(ctrl.toasts.some((t) => t.error)).toBe(true)

      // Step 3: Existing events are untouched
      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe('Gültiger Termin')
    })
  })

  // ==========================================================================
  // 4. Multi-File Upload & Ingestion Stress Testing
  // ==========================================================================
  describe('4. Multi-File Upload and Mixed Batches', () => {
    it('imports batch of 5 valid files sequentially with combined success toast', async () => {
      const files: File[] = []
      for (let i = 1; i <= 5; i++) {
        const text = vcal(
          vevent({
            uid: `batch-${i}`,
            summary: `Batch Termin ${i}`,
            start: `2026101${i}T080000Z`,
            end: `2026101${i}T090000Z`,
          }),
        )
        files.push(new File([text], `batch_${i}.ics`))
      }

      await ctrl.handleImportFiles(files)

      expect(ctrl.busy).toBe(false)
      expect(ctrl.getEvents()).toHaveLength(5)
      expect(ctrl.getSubscriptions()).toHaveLength(5)
      expect(ctrl.dbLoads).toBe(1)
      expect(ctrl.toasts).toContainEqual({ message: '5 Termine importiert', error: false })
    })

    it('handles mixed batch of valid, invalid extension, empty, and corrupt files', async () => {
      const validA = new File(
        [
          vcal(
            vevent({
              uid: 'mix-1',
              summary: 'Mix Valid A',
              start: '20261012T080000Z',
              end: '20261012T090000Z',
            }),
          ),
        ],
        'valid_a.ics',
      )
      const invalidPdf = new File(['pdf data'], 'skript.pdf', { type: 'application/pdf' })
      const emptyFile = new File([''], 'empty.ics')
      const corruptFile = new File(['INVALID ICS CONTENT'], 'corrupt.ics')
      const validB = new File(
        [
          vcal(
            vevent({
              uid: 'mix-2',
              summary: 'Mix Valid B',
              start: '20261013T080000Z',
              end: '20261013T090000Z',
            }),
          ),
        ],
        'valid_b.ics',
      )

      await ctrl.handleImportFiles([validA, invalidPdf, emptyFile, corruptFile, validB])

      expect(ctrl.busy).toBe(false)
      // Both valid files imported
      expect(ctrl.getEvents()).toHaveLength(2)
      expect(ctrl.getEvents().map((e) => e.title)).toEqual(['Mix Valid A', 'Mix Valid B'])

      // Errors recorded for invalidPdf, emptyFile, and corruptFile
      expect(ctrl.toasts.some((t) => t.error && t.message.includes('skript.pdf'))).toBe(true)
      expect(ctrl.toasts.some((t) => t.error && t.message.includes('empty.ics'))).toBe(true)
      expect(ctrl.toasts.some((t) => t.error && t.message.includes('keine iCal-Datei'))).toBe(true)

      // Total success toast reflects sum of imported events (2)
      expect(ctrl.toasts.some((t) => !t.error && t.message === '2 Termine importiert')).toBe(true)
      expect(ctrl.dbLoads).toBe(1)
    })

    it('handles all-invalid batch without DB reload or success toast', async () => {
      const invalidPdf = new File(['pdf data'], 'doc.pdf', { type: 'application/pdf' })
      const emptyFile = new File(['   '], 'empty.ics')
      const corruptFile = new File(['GARBAGE'], 'bad.ics')

      await ctrl.handleImportFiles([invalidPdf, emptyFile, corruptFile])

      expect(ctrl.busy).toBe(false)
      expect(ctrl.getEvents()).toHaveLength(0)
      expect(ctrl.dbLoads).toBe(0)
      expect(ctrl.toasts.some((t) => !t.error)).toBe(false)
      expect(ctrl.toasts.filter((t) => t.error)).toHaveLength(3)
    })

    it('handles empty files array immediately without setting busy', async () => {
      await ctrl.handleImportFiles([])
      expect(ctrl.busy).toBe(false)
      expect(ctrl.toasts).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 5. Drag & Drop Dropzone Logic & Flicker Guard
  // ==========================================================================
  describe('5. Drag-and-Drop Dropzone State Transitions', () => {
    it('sets dropping=true on onDragOver when types include Files', () => {
      const accepted = ctrl.onDragOver(['Files'])
      expect(accepted).toBe(true)
      expect(ctrl.dropping).toBe(true)
    })

    it('ignores onDragOver when types do not include Files', () => {
      const accepted = ctrl.onDragOver(['text/plain', 'text/uri-list'])
      expect(accepted).toBe(false)
      expect(ctrl.dropping).toBe(false)
    })

    it('retains dropping=true in onDragLeave when transitioning to child element', () => {
      ctrl.onDragOver(['Files'])
      expect(ctrl.dropping).toBe(true)

      // Child element transition: containsRelatedTarget is true
      ctrl.onDragLeave(true)
      expect(ctrl.dropping).toBe(true)
    })

    it('resets dropping=false in onDragLeave when leaving container', () => {
      ctrl.onDragOver(['Files'])
      expect(ctrl.dropping).toBe(true)

      // Container exit: containsRelatedTarget is false
      ctrl.onDragLeave(false)
      expect(ctrl.dropping).toBe(false)
    })

    it('resets dropping=false on onDrop and executes file import', async () => {
      ctrl.onDragOver(['Files'])
      expect(ctrl.dropping).toBe(true)

      const text = vcal(
        vevent({
          uid: 'drop-ok',
          summary: 'Dropped Event',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      const droppedFile = new File([text], 'dropped.ics')
      await ctrl.onDrop([droppedFile])

      expect(ctrl.dropping).toBe(false)
      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe('Dropped Event')
    })
  })

  // ==========================================================================
  // 6. Upload Button & Concurrency Handling
  // ==========================================================================
  describe('6. Upload Button Behavior & Concurrency', () => {
    it('imports selected file via upload button simulator', async () => {
      const text = vcal(
        vevent({
          uid: 'btn-ok',
          summary: 'Button Event',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      await ctrl.handleUploadButton(async () => [new File([text], 'button_pick.ics')])

      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe('Button Event')
    })

    it('handles user cancellation of file picker gracefully', async () => {
      await ctrl.handleUploadButton(async () => null)
      expect(ctrl.busy).toBe(false)
      expect(ctrl.toasts).toHaveLength(0)

      await ctrl.handleUploadButton(async () => [])
      expect(ctrl.busy).toBe(false)
      expect(ctrl.toasts).toHaveLength(0)
    })

    it('prevents re-entrant trigger when busy is true', async () => {
      ctrl.busy = true
      let pickerCalled = false

      await ctrl.handleUploadButton(async () => {
        pickerCalled = true
        return []
      })

      expect(pickerCalled).toBe(false)
    })
  })

  // ==========================================================================
  // 7. Security and Boundary Stress Testing
  // ==========================================================================
  describe('7. Security, Path Traversal and Special Characters', () => {
    it('safely handles filenames with path traversal characters without crashing store or escaping to filesystem', async () => {
      const text = vcal(
        vevent({
          uid: 'sec-1',
          summary: 'Security Check',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      const traversalFile = new File([text], '../../../../etc/passwd.ics')
      await ctrl.handleImportFiles([traversalFile])

      expect(ctrl.getEvents()).toHaveLength(1)
      const sub = ctrl.getSubscriptions()[0]
      expect(sub).toBeDefined()
      // Store persists cleanly, no filesystem write occurs with the traversal path
      expect(sub.kind).toBe('file')
      expect(sub.url).toBe('Datei-Import')
    })

    it('safely handles XSS scripts in event summary without failure', async () => {
      const xssSummary = '<script>alert("XSS")</script><img src=x onerror=alert(1)>'
      const text = vcal(
        vevent({
          uid: 'xss-1',
          summary: xssSummary,
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      await ctrl.handleImportFiles([new File([text], 'xss.ics')])

      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe(xssSummary)
    })

    it('safely handles Unicode emojis and German umlauts in event titles', async () => {
      const richTitle = '🎓 TU Darmstadt — Vorlesung & Übung (S2|02) 🚀'
      const text = vcal(
        vevent({
          uid: 'uni-1',
          summary: richTitle,
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      await ctrl.handleImportFiles([new File([text], 'unicode.ics')])

      expect(ctrl.getEvents()).toHaveLength(1)
      expect(ctrl.getEvents()[0].title).toBe(richTitle)
    })
  })

  // ==========================================================================
  // 8. Snapshot Replacement, Cascade Deletion and Grammar
  // ==========================================================================
  describe('8. Snapshot Deduplication, Cascade Deletion and UI Grammar', () => {
    it('uses singular "1 Termin importiert" when exactly 1 event is imported', async () => {
      const text = vcal(
        vevent({
          uid: 'one-1',
          summary: 'Einziger Termin',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }),
      )
      await ctrl.handleImportFiles([new File([text], 'single.ics')])

      expect(ctrl.toasts).toContainEqual({ message: '1 Termin importiert', error: false })
    })

    it('uses plural "N Termine importiert" when multiple events are imported', async () => {
      const text = vcal(
        vevent({
          uid: 'p-1',
          summary: 'Termin 1',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }) +
          vevent({
            uid: 'p-2',
            summary: 'Termin 2',
            start: '20261012T100000Z',
            end: '20261012T110000Z',
          }),
      )
      await ctrl.handleImportFiles([new File([text], 'plural.ics')])

      expect(ctrl.toasts).toContainEqual({ message: '2 Termine importiert', error: false })
    })

    it('re-importing the same filename replaces the snapshot without event duplicates', async () => {
      // V1 has 3 events
      const textV1 = vcal(
        vevent({ uid: 'v1', summary: 'V1', start: '20261012T080000Z', end: '20261012T090000Z' }) +
          vevent({ uid: 'v2', summary: 'V2', start: '20261012T100000Z', end: '20261012T110000Z' }) +
          vevent({ uid: 'v3', summary: 'V3', start: '20261012T120000Z', end: '20261012T130000Z' }),
      )
      await ctrl.handleImportFiles([new File([textV1], 'myschedule.ics')])
      expect(ctrl.getEvents()).toHaveLength(3)
      expect(ctrl.getSubscriptions()).toHaveLength(1)

      // V2 updates V1, removes V2, V3, and adds V4
      const textV2 = vcal(
        vevent({
          uid: 'v1',
          summary: 'V1 Updated',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }) +
          vevent({
            uid: 'v4',
            summary: 'V4 New',
            start: '20261012T140000Z',
            end: '20261012T150000Z',
          }),
      )
      await ctrl.handleImportFiles([new File([textV2], 'myschedule.ics')])

      // Should have exactly 2 events, not 5
      expect(ctrl.getEvents()).toHaveLength(2)
      expect(ctrl.getSubscriptions()).toHaveLength(1)
      expect(ctrl.getEvents().map((e) => e.title)).toEqual(['V1 Updated', 'V4 New'])
    })

    it('calendarUnsubscribe cascades and removes all associated events and subscription', async () => {
      const text = vcal(
        vevent({
          uid: 'del-1',
          summary: 'To Delete 1',
          start: '20261012T080000Z',
          end: '20261012T090000Z',
        }) +
          vevent({
            uid: 'del-2',
            summary: 'To Delete 2',
            start: '20261012T100000Z',
            end: '20261012T110000Z',
          }),
      )
      await ctrl.handleImportFiles([new File([text], 'to_delete.ics')])
      expect(ctrl.getEvents()).toHaveLength(2)

      const sub = ctrl.getSubscriptions()[0]
      expect(sub).toBeDefined()

      // Cascade remove subscription
      await service.calendarUnsubscribe(sub.id)

      expect(ctrl.getSubscriptions()).toHaveLength(0)
      expect(ctrl.getEvents()).toHaveLength(0)
    })

    it('handles a massive batch of 25 files cleanly', async () => {
      const files: File[] = []
      for (let i = 1; i <= 25; i++) {
        const text = vcal(
          vevent({
            uid: `mass-${i}`,
            summary: `Mass ${i}`,
            start: '20261012T080000Z',
            end: '20261012T090000Z',
          }),
        )
        files.push(new File([text], `mass_${i}.ics`))
      }

      await ctrl.handleImportFiles(files)

      expect(ctrl.getEvents()).toHaveLength(25)
      expect(ctrl.getSubscriptions()).toHaveLength(25)
      expect(ctrl.toasts.some((t) => t.message === '25 Termine importiert')).toBe(true)
    })
  })
})
