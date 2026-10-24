// Electron BrowserWindow TUCaN session wizard with automated download interception.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { BrowserWindow, session, type DownloadItem, type Event, type WebContents } from 'electron'
import type { Service } from '../backend/service'
import { combineIcs } from '../backend/ics'

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

    const accumulatedIcsBuffers: Buffer[] = []
    let totalImportedCount = 0

    // Inject visual banner at top of loaded pages to guide the student
    // Using position: relative ensures the TUCaN login button and header
    // are physically rendered BELOW this tutorial header and never obscured.
    window.webContents.on('dom-ready', () => {
      window.webContents
        .executeJavaScript(`
          (() => {
            if (document.getElementById('study-organizer-tucan-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'study-organizer-tucan-banner';
            banner.style.cssText = 'position:relative;z-index:999999;background:#1e3a8a;color:#ffffff;padding:12px 18px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:500;box-shadow:0 3px 10px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:space-between;gap:14px;box-sizing:border-box;width:100%;pointer-events:auto;';
            banner.innerHTML = \`
              <div style="display:flex;align-items:center;gap:12px;text-align:left;flex-wrap:wrap;">
                <span style="background:#2563eb;color:#fff;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap;">TUCaN Assistent</span>
                <span>1. Anmelden &gt; 2. „Mein Studium“ ➔ „Stundenplan“ &gt; 3. Klicke auf „Semester einlesen“</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
                <button id="study-organizer-crawl-btn" style="background:#16a34a;color:#ffffff;border:none;padding:7px 15px;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 2px 4px rgba(0,0,0,0.2);">
                  ⚡ Semester-Termine einlesen (Crawlen)
                </button>
                <span id="study-organizer-crawl-status" style="font-size:12px;font-weight:500;opacity:0.95;"></span>
              </div>
            \`;
            document.body.prepend(banner);

            const btn = document.getElementById('study-organizer-crawl-btn');
            const status = document.getElementById('study-organizer-crawl-status');
            if (btn && status) {
              btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.style.opacity = '0.6';
                status.textContent = 'Prüfe TUCaN-Seite…';

                const bodyText = document.body.innerText || '';
                if ((bodyText.includes('Anmelden') || bodyText.includes('Login')) && !bodyText.includes('Abmelden') && !bodyText.includes('Logout')) {
                  status.textContent = '⚠️ Bitte melde dich zuerst an!';
                  btn.disabled = false;
                  btn.style.opacity = '1';
                  return;
                }

                // Suche nach Monats-Auswahl im Export-Bereich
                const select = document.querySelector('select[name*="month"], select[name*="monat"], select[name*="zeitraum"], #month, #monat')
                  || Array.from(document.querySelectorAll('select')).find(s => 
                       Array.from(s.options).some(o => /Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember/i.test(o.text))
                     );

                if (select) {
                  const options = Array.from(select.options).filter(o => 
                    /Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember/i.test(o.text)
                  );
                  if (options.length > 0) {
                    status.textContent = 'Gefunden: ' + options.length + ' Monate. Starte Crawl…';
                    for (let i = 0; i < options.length; i++) {
                      status.textContent = 'Lese Monat ' + (i + 1) + '/' + options.length + ' (' + options[i].text.trim() + ') ein…';
                      select.value = options[i].value;
                      select.dispatchEvent(new Event('change', { bubbles: true }));
                      await new Promise(r => setTimeout(r, 600));

                      const submitBtn = document.querySelector('input[type="submit"][value*="Export"], input[type="submit"][value*="export"], button[type="submit"]')
                        || select.form?.querySelector('input[type="submit"]');
                      if (submitBtn) {
                        submitBtn.click();
                        await new Promise(r => setTimeout(r, 1200));
                        const calLink = Array.from(document.querySelectorAll('a')).find(a => 
                          a.textContent?.includes('Kalenderdatei') || a.href.includes('.ics') || a.textContent?.includes('.ics')
                        );
                        if (calLink) {
                          calLink.click();
                          await new Promise(r => setTimeout(r, 800));
                        }
                      }
                    }
                    status.textContent = '✓ Semester erfolgreich importiert!';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    return;
                  }
                }

                // Falls nicht auf Export-Seite: Zur Export-Seite navigieren
                const exportLink = Array.from(document.querySelectorAll('a')).find(a => 
                  a.textContent?.trim() === 'Export' || a.textContent?.trim() === 'Exportieren'
                );
                if (exportLink) {
                  status.textContent = 'Wechsle zur Export-Seite…';
                  exportLink.click();
                  return;
                }

                // Zur Stundenplan-Seite navigieren
                const timetableLink = Array.from(document.querySelectorAll('a')).find(a => 
                  a.textContent?.includes('Stundenplan')
                );
                if (timetableLink) {
                  status.textContent = 'Wechsle zum Stundenplan…';
                  timetableLink.click();
                  return;
                }

                status.textContent = 'Navigiere zu „Mein Studium“ ➔ „Stundenplan“ ➔ „Export“';
                btn.disabled = false;
                btn.style.opacity = '1';
              });
            }
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
            accumulatedIcsBuffers.push(buffer)

            if (service) {
              const contentToImport =
                accumulatedIcsBuffers.length > 1
                  ? combineIcs(accumulatedIcsBuffers)
                  : buffer
              const res = await service.calendarImportFile(originalFilename, contentToImport)
              totalImportedCount = res.count ?? 0
              await finish({ success: true, count: totalImportedCount })
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
