// Electron BrowserWindow TUCaN session wizard with automated download interception.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { BrowserWindow, session, type DownloadItem, type Event, type WebContents } from 'electron'
import type { Service } from '../backend/service'

export interface TucanWizardResult {
  success: boolean
  count?: number
  error?: string
}

const TUCAN_START_URL = 'https://www.tucan.tu-darmstadt.de/'
const TUCAN_PARTITION = 'tucan-session'
const TUCAN_GUIDANCE_TITLE =
  'TUCaN: Melde dich an, navigiere zu „Stundenplan“ -> „Exportieren“ -> „Kalenderdatei (.ics)“'

/**
 * Checks if a downloaded file represents an iCalendar (.ics) export.
 */
export function isIcsDownload(item: DownloadItem): boolean {
  const filename = item.getFilename().toLowerCase()
  const mime = item.getMimeType().toLowerCase()
  const url = item.getURL().toLowerCase()

  return (
    filename.endsWith('.ics') ||
    mime.includes('calendar') ||
    mime.includes('ics') ||
    url.endsWith('.ics') ||
    url.includes('.ics') ||
    url.includes('format=ics')
  )
}

/**
 * Starts the TUCaN guided export wizard in an isolated BrowserWindow.
 * Intercepts calendar file downloads, imports them via service.calendarImportFile,
 * and gracefully resolves with the number of imported events.
 *
 * Supports both (service, parentWindow) and (parentWindow, service) signatures.
 */
export function startTucanWizard(
  serviceOrParent?: Service | BrowserWindow | null,
  parentOrService?: BrowserWindow | Service | null,
): Promise<TucanWizardResult> {
  let service: Service | undefined
  let parentWindow: BrowserWindow | null | undefined

  if (serviceOrParent && 'calendarImportFile' in serviceOrParent) {
    service = serviceOrParent as Service
    parentWindow = parentOrService as BrowserWindow | null | undefined
  } else if (parentOrService && 'calendarImportFile' in parentOrService) {
    service = parentOrService as Service
    parentWindow = serviceOrParent as BrowserWindow | null | undefined
  } else if (serviceOrParent instanceof BrowserWindow) {
    parentWindow = serviceOrParent
  }

  // Use isolated in-memory partition for security and session independence
  const ses = session.fromPartition(TUCAN_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  return new Promise<TucanWizardResult>((resolve) => {
    let settled = false
    let tempFilePathToClean: string | null = null

    const window = new BrowserWindow({
      width: 1060,
      height: 780,
      minWidth: 800,
      minHeight: 600,
      parent: parentWindow ?? undefined,
      modal: Boolean(parentWindow),
      title: TUCAN_GUIDANCE_TITLE,
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: TUCAN_PARTITION,
      },
    })

    const cleanup = async () => {
      ses.removeListener('will-download', onWillDownload)
      if (tempFilePathToClean) {
        const file = tempFilePathToClean
        tempFilePathToClean = null
        await fs.unlink(file).catch(() => undefined)
      }
    }

    const finish = async (result: TucanWizardResult) => {
      if (settled) return
      settled = true
      await cleanup()
      if (!window.isDestroyed()) {
        window.close()
      }
      resolve(result)
    }

    // Preserve the user instruction title when the web page tries to change document.title
    window.on('page-title-updated', (event) => {
      event.preventDefault()
    })

    // Inject visual banner at top of loaded pages to guide the student
    window.webContents.on('dom-ready', () => {
      window.webContents
        .executeJavaScript(`
          (() => {
            if (document.getElementById('study-organizer-tucan-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'study-organizer-tucan-banner';
            banner.textContent = "ℹ️ TUCaN: Melde dich an, navigiere zu 'Stundenplan' ➔ 'Exportieren' ➔ 'Kalenderdatei (.ics)'";
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#1e40af;color:#ffffff;padding:8px 16px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,0.25);pointer-events:none;';
            document.body.prepend(banner);
          })();
        `)
        .catch(() => undefined)
    })

    // Intercept download events on the session
    const onWillDownload = (_event: Event, item: DownloadItem, webContents: WebContents) => {
      // Ignore downloads from other web contents / windows
      if (webContents.id !== window.webContents.id) return

      if (!isIcsDownload(item)) {
        // Non-calendar downloads inside wizard can be safely cancelled
        item.cancel()
        return
      }

      const originalFilename = item.getFilename() || 'tucan-stundenplan.ics'
      const tempFile = path.join(
        os.tmpdir(),
        `tucan-timetable-${Date.now()}-${randomBytes(4).toString('hex')}.ics`,
      )
      tempFilePathToClean = tempFile

      // Instruct Electron to write directly to temp path without opening OS dialog
      item.setSavePath(tempFile)

      item.on('updated', (_ev, state) => {
        if (state === 'interrupted') {
          void finish({
            success: false,
            error: 'Verbindung zu TUCaN fehlgeschlagen (Download abgebrochen).',
          })
        }
      })

      item.once('done', async (_ev, state) => {
        if (state === 'completed') {
          try {
            const buffer = await fs.readFile(tempFile)
            if (service) {
              const res = await service.calendarImportFile(originalFilename, buffer)
              await finish({ success: true, count: res.count })
            } else {
              await finish({ success: true, count: 0 })
            }
          } catch (error) {
            await finish({
              success: false,
              error:
                error instanceof Error ? error.message : 'Fehler beim Import der Kalenderdatei.',
            })
          } finally {
            await fs.unlink(tempFile).catch(() => undefined)
          }
        } else if (state === 'cancelled') {
          await fs.unlink(tempFile).catch(() => undefined)
          void finish({ success: false, error: 'Vorgang durch Benutzer abgebrochen.' })
        } else {
          await fs.unlink(tempFile).catch(() => undefined)
          void finish({
            success: false,
            error: 'Verbindung zu TUCaN fehlgeschlagen (Download abgebrochen).',
          })
        }
      })
    }

    ses.on('will-download', onWillDownload)

    // Handle user closing the modal before downloading export
    window.on('closed', () => {
      void finish({ success: false, error: 'Vorgang durch Benutzer abgebrochen.' })
    })

    // Prevent rogue popups; keep navigation inside the wizard window
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith('https://www.tucan.tu-darmstadt.de') ||
        url.startsWith('https://tucan.tu-darmstadt.de')
      ) {
        void window.loadURL(url)
      }
      return { action: 'deny' }
    })

    window.webContents.on('did-fail-load', (_e, errorCode, errorDesc, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3 /* ABORTED */) {
        void finish({
          success: false,
          error: `Verbindung zu TUCaN fehlgeschlagen (${errorDesc}).`,
        })
      }
    })

    // Load initial TUCaN page
    window.loadURL(TUCAN_START_URL).catch((error) => {
      void finish({
        success: false,
        error: `Verbindung zu TUCaN fehlgeschlagen (${(error as Error).message}).`,
      })
    })
  })
}
