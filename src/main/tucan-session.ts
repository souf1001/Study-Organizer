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
    let hasCompletedImport = false
    let totalImportedCount = 0

    interface CrawlerState {
      active: boolean
      monthIndex: number
      totalMonths: number
      exportUrl: string
    }
    let crawlerState: CrawlerState | null = null

    window.webContents.on('console-message', async (_e, _level, message) => {
      if (typeof message === 'string' && message.startsWith('STUDY_ORGANIZER_DIRECT_ICS:')) {
        try {
          const raw = JSON.parse(message.slice('STUDY_ORGANIZER_DIRECT_ICS:'.length))
          const icsList: string[] = Array.isArray(raw) ? raw : (raw?.icsList ?? [])
          const totalCount: number = Array.isArray(raw)
            ? icsList.length
            : (raw?.total ?? icsList.length)
          const unitPlural: string = Array.isArray(raw)
            ? 'Abschnitte'
            : (raw?.unit || (raw?.isMonth ? 'Monate' : 'Abschnitte'))

          if (Array.isArray(icsList) && icsList.length > 0) {
            let count = 0
            if (service) {
              const combined = combineIcs(icsList)
              const res = await service.calendarImportFile('tucan-stundenplan.ics', combined)
              count = res.count ?? 0
              totalImportedCount = count
              hasCompletedImport = true
            }

            if (!window.isDestroyed()) {
              await window.webContents.executeJavaScript(`
                (() => {
                  const status = document.getElementById('study-organizer-crawl-status');
                  const btn = document.getElementById('study-organizer-crawl-btn');
                  if (status) {
                    status.textContent = '✓ Alle ${totalCount} ${unitPlural} erfolgreich eingelesen! (${count} Termine importiert)';
                  }
                  if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.textContent = '✓ Fertigstellen / Schließen';
                    btn.style.background = '#2563eb';
                    btn.onclick = () => window.close();
                  }
                })()
              `).catch(() => undefined)
            }
          } else {
            if (!window.isDestroyed()) {
              await window.webContents.executeJavaScript(`
                (() => {
                  const status = document.getElementById('study-organizer-crawl-status');
                  const btn = document.getElementById('study-organizer-crawl-btn');
                  if (status) status.textContent = '⚠️ Keine Termine im ausgewählten Zeitraum gefunden.';
                  if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.textContent = '⚡ Erneut versuchen';
                  }
                })()
              `).catch(() => undefined)
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          if (!window.isDestroyed()) {
            await window.webContents.executeJavaScript(`
              (() => {
                const status = document.getElementById('study-organizer-crawl-status');
                const btn = document.getElementById('study-organizer-crawl-btn');
                if (status) status.textContent = '❌ Fehler beim Import: ${errMsg.replace(/['"\\\r\n]/g, ' ')}';
                if (btn) {
                  btn.disabled = false;
                  btn.style.opacity = '1';
                  btn.textContent = '⚡ Erneut versuchen';
                }
              })()
            `).catch(() => undefined)
          }
        }
      } else if (typeof message === 'string' && message.startsWith('STUDY_ORGANIZER_CRAWLER:')) {
        try {
          const payload = JSON.parse(message.slice('STUDY_ORGANIZER_CRAWLER:'.length))
          if (payload && typeof payload === 'object') {
            crawlerState = payload as CrawlerState
          }
        } catch {
          // ignore
        }
      }
    })

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
                <span>1. Anmelden &gt; 2. „Mein Studium“ ➔ „Stundenplan“ ➔ „Exportieren“ &gt; 3. Klicke auf „Semester einlesen“</span>
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

            const findDownloadTrigger = () => {
              const elements = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
              const directLink = elements.find(el => {
                const text = (el.textContent || el.value || '').toLowerCase();
                const href = (el.getAttribute('href') || '').toLowerCase();
                return text.includes('kalenderdatei') || text.includes('.ics') || href.includes('.ics') || href.includes('format=ics');
              });
              if (directLink) return directLink;

              const downloadBtn = elements.find(el => {
                const text = (el.textContent || el.value || '').toLowerCase().trim();
                const href = (el.getAttribute('href') || '').toLowerCase();
                const matchesText = /herunterladen|download|datei|kalender|speichern|hier\\s+klicken/i.test(text);
                const matchesHref = /download|file|format=ics|calendar|dispatcher|getfile/i.test(href);
                return matchesText || matchesHref;
              });
              if (downloadBtn) return downloadBtn;

              const contentArea = document.querySelector('#content, .content, #main, .main, form');
              if (contentArea) {
                const singleLink = contentArea.querySelector('a[href*="download"], a[href*="file"], a[href*="dispatcher"], a[href*=".ics"]');
                if (singleLink) return singleLink;
              }
              return null;
            };

            const findSelect = () => {
              const selects = Array.from(document.querySelectorAll('select'));
              // Prefer a select dropdown that contains month names
              const monthSelect = selects.find(s => 
                Array.from(s.options).some(o => /Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember/i.test(o.text))
              );
              if (monthSelect) return monthSelect;

              return document.querySelector('select[name*="month" i], select[name*="monat" i], select[name*="zeitraum" i], select[name*="period" i], #month, #monat')
                || selects.find(s => 
                     Array.from(s.options).some(o => /Semester|WiSe|SoSe|Vorlesungszeit/i.test(o.text))
                   );
            };

            // In-Page Abruf eines einzelnen Monats oder Semester-Abschnitts ohne Seiten-Reload
            const fetchIcsOption = async (form, select, opt) => {
              const actionUrl = form.action || window.location.href;
              const isMultipart = form.enctype && form.enctype.toLowerCase().includes('multipart');
              const isPost = (form.method || 'POST').toUpperCase() === 'POST';

              // Ensure the option is selected in the DOM and change event dispatched
              select.value = opt.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(r => setTimeout(r, 80));

              const fd = new FormData(form);
              if (select.name) {
                fd.set(select.name, opt.value);
              }
              const submitBtn = form.querySelector('input[type="submit"][value*="Export" i], button[type="submit"][value*="Export" i], input[type="submit"][name*="export" i], button[name*="export" i]')
                || Array.from(form.querySelectorAll('input[type="submit"], button[type="submit"], button')).find(b => /export|kalender|herunterladen|download/i.test(b.value || b.textContent || ''))
                || form.querySelector('input[type="submit"][name], button[type="submit"][name]')
                || document.querySelector('input[type="submit"][name]');
              if (submitBtn && submitBtn.name && !fd.has(submitBtn.name)) {
                fd.append(submitBtn.name, submitBtn.value || '');
              }

              let resp;
              if (isPost) {
                const body = isMultipart ? fd : new URLSearchParams(fd);
                resp = await fetch(actionUrl, {
                  method: 'POST',
                  body: body,
                  credentials: 'include',
                  headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml,text/calendar,*/*'
                  }
                });
              } else {
                const u = new URL(actionUrl, window.location.href);
                const sp = new URLSearchParams(fd);
                for (const [k, v] of sp.entries()) {
                  u.searchParams.set(k, v);
                }
                resp = await fetch(u.href, {
                  method: 'GET',
                  credentials: 'include',
                  headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml,text/calendar,*/*'
                  }
                });
              }

              if (!resp.ok) return null;
              const text = await resp.text();
              if (text.includes('BEGIN:VCALENDAR')) {
                return text;
              }

              // Nicht direkt ICS, parse HTML nach Download-Link
              const parser = new DOMParser();
              const doc = parser.parseFromString(text, 'text/html');
              const elements = Array.from(doc.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));

              const link = elements.find(el => {
                const href = (el.getAttribute('href') || '').toLowerCase();
                const t = (el.textContent || el.value || '').toLowerCase();
                return href.endsWith('.ics') || href.includes('.ics') || href.includes('format=ics') ||
                  t.includes('kalenderdatei') || t.includes('.ics') ||
                  ((t.includes('herunterladen') || t.includes('download') || t.includes('hier klicken') || t.includes('speichern') || t.includes('datei')) &&
                   (href.includes('download') || href.includes('file') || href.includes('dispatcher') || href.includes('getfile') || href.includes('.ics')));
              }) || doc.querySelector('a[href*="download"], a[href*="file"], a[href*="dispatcher"], a[href*=".ics"]');

              if (link && link.getAttribute('href')) {
                const rawHref = link.getAttribute('href');
                if (!rawHref.startsWith('javascript:')) {
                  const downloadUrl = new URL(rawHref, resp.url || actionUrl).href;
                  const fileResp = await fetch(downloadUrl, { credentials: 'include' });
                  if (fileResp.ok) {
                    const fileText = await fileResp.text();
                    if (fileText.includes('BEGIN:VCALENDAR')) return fileText;

                    // Follow nested link/dispatcher if necessary
                    const subDoc = parser.parseFromString(fileText, 'text/html');
                    const nestedLink = subDoc.querySelector('a[href*=".ics"], a[href*="dispatcher"], a[href*="download"], a[href*="file"]');
                    if (nestedLink && nestedLink.getAttribute('href')) {
                      const nestedUrl = new URL(nestedLink.getAttribute('href'), fileResp.url || downloadUrl).href;
                      const nestedResp = await fetch(nestedUrl, { credentials: 'include' });
                      if (nestedResp.ok) {
                        const nestedText = await nestedResp.text();
                        if (nestedText.includes('BEGIN:VCALENDAR')) return nestedText;
                      }
                    }
                  }
                }
              }

              // Prüfe Meta-Refresh
              const meta = doc.querySelector('meta[http-equiv="refresh" i]');
              if (meta) {
                const content = meta.getAttribute('content') || '';
                const m = content.match(/url=['"]?([^'";]+)/i);
                if (m) {
                  const metaUrl = new URL(m[1].trim(), resp.url || actionUrl).href;
                  const metaResp = await fetch(metaUrl, { credentials: 'include' });
                  if (metaResp.ok) {
                    const metaText = await metaResp.text();
                    if (metaText.includes('BEGIN:VCALENDAR')) return metaText;
                  }
                }
              }

              // Prüfe Zwischenformular
              const subForm = doc.querySelector('form');
              if (subForm && subForm.action) {
                const subAction = new URL(subForm.action, resp.url || actionUrl).href;
                const isSubPost = (subForm.method || 'POST').toUpperCase() === 'POST';
                const subParams = new URLSearchParams();
                for (const input of subForm.querySelectorAll('input, select, textarea')) {
                  if (input.name && input.value !== undefined) {
                    subParams.append(input.name, input.value);
                  }
                }
                let subResp;
                if (isSubPost) {
                  subResp = await fetch(subAction, {
                    method: 'POST',
                    body: subParams,
                    credentials: 'include'
                  });
                } else {
                  const subGetUrl = new URL(subAction);
                  for (const [k, v] of subParams.entries()) {
                    subGetUrl.searchParams.set(k, v);
                  }
                  subResp = await fetch(subGetUrl.href, {
                    method: 'GET',
                    credentials: 'include'
                  });
                }
                if (subResp && subResp.ok) {
                  const subText = await subResp.text();
                  if (subText.includes('BEGIN:VCALENDAR')) return subText;
                }
              }

              return null;
            };

            // Fortsetzung eines laufenden Fallback-Crawls nach Seiten-Reload / Navigation
            let rawState = null;
            try { rawState = sessionStorage.getItem('study_organizer_crawler_state'); } catch(e) {}
            if (rawState) {
              let state = null;
              try { state = JSON.parse(rawState); } catch(e) {}
              if (state && state.active) {
                console.log('STUDY_ORGANIZER_CRAWLER:' + JSON.stringify(state));
                if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
                const select = findSelect();
                const downloadTrigger = findDownloadTrigger();

                if (downloadTrigger && !select) {
                  if (status) status.textContent = '📥 Lese Monat ' + (state.monthIndex + 1) + '/' + state.totalMonths + ' herunter…';
                  setTimeout(() => {
                    downloadTrigger.click();
                  }, 500);
                  return;
                }

                if (select) {
                  const monthOptions = Array.from(select.options).filter(o => 
                    /Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember/i.test(o.text)
                  );
                  if (state.monthIndex < state.totalMonths && monthOptions[state.monthIndex]) {
                    const opt = monthOptions[state.monthIndex];
                    if (status) status.textContent = 'Lese Monat ' + (state.monthIndex + 1) + '/' + state.totalMonths + ' (' + opt.text.trim() + ') ein…';
                    select.value = opt.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));

                    setTimeout(() => {
                      const submitBtn = document.querySelector('input[type="submit"][value*="Export" i], button[type="submit"]')
                        || select.form?.querySelector('input[type="submit"]');
                      if (submitBtn) {
                        submitBtn.click();
                      }
                    }, 600);
                    return;
                  } else {
                    sessionStorage.removeItem('study_organizer_crawler_state');
                    sessionStorage.setItem('study_organizer_crawler_done', 'true');
                    if (status) status.textContent = '✓ Alle ' + state.totalMonths + ' Monate erfolgreich eingelesen!';
                    if (btn) {
                      btn.disabled = false;
                      btn.style.opacity = '1';
                      btn.textContent = '✓ Fertigstellen / Schließen';
                      btn.style.background = '#2563eb';
                      btn.onclick = () => window.close();
                    }
                    return;
                  }
                }
              }
            }

            if (sessionStorage.getItem('study_organizer_crawler_done')) {
              if (status) status.textContent = '✓ Semester-Termine erfolgreich importiert!';
              if (btn) {
                btn.textContent = '✓ Schließen';
                btn.style.background = '#2563eb';
                btn.onclick = () => window.close();
              }
            }

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

                const directCalLink = findDownloadTrigger();
                if (directCalLink && !findSelect()) {
                  status.textContent = 'Lade Kalenderdatei herunter…';
                  directCalLink.click();
                  return;
                }

                const select = findSelect();
                if (select) {
                  const monthOptions = Array.from(select.options).filter(o => 
                    /Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember/i.test(o.text)
                  );
                  const semesterOptions = Array.from(select.options).filter(o => 
                    /Semester|Gesamt|Vorlesungszeit|WiSe|SoSe|Wintersemester|Sommersemester|Termine\\s+gesamt/i.test(o.text)
                  );
                  const targetOptions = monthOptions.length > 0
                    ? monthOptions
                    : semesterOptions.length > 0
                      ? semesterOptions
                      : Array.from(select.options).filter(o => Boolean(o.value));

                  const form = select.form || select.closest('form') || document.querySelector('form');

                  const isMonth = monthOptions.length > 0;
                  const unitName = isMonth ? 'Monat' : 'Abschnitt';
                  const unitPlural = isMonth ? 'Monate' : 'Abschnitte';

                  // In-Page Fetch Schleife (ohne die Seite zu verlassen oder Navigationen auszulösen)
                  if (form && targetOptions.length > 0) {
                    status.textContent = 'Starte Abruf für ' + targetOptions.length + ' ' + unitPlural + '…';
                    const icsList = [];
                    let inPageFailed = false;

                    for (let i = 0; i < targetOptions.length; i++) {
                      const opt = targetOptions[i];
                      const optLabel = opt.text.trim();
                      status.textContent = 'Lese ' + unitName + ' ' + (i + 1) + ' von ' + targetOptions.length + (optLabel ? ' (' + optLabel + ')' : '') + '…';
                      try {
                        const ics = await fetchIcsOption(form, select, opt);
                        if (ics && ics.includes('BEGIN:VCALENDAR')) {
                          icsList.push(ics);
                        }
                        await new Promise(r => setTimeout(r, 150));
                      } catch (err) {
                        console.warn('In-page fetch error for option ' + opt.text, err);
                        inPageFailed = true;
                        break;
                      }
                    }

                    if (icsList.length > 0) {
                      status.textContent = 'Verarbeite ' + icsList.length + ' gelesene ' + unitPlural + '…';
                      console.log('STUDY_ORGANIZER_DIRECT_ICS:' + JSON.stringify({
                        icsList,
                        total: targetOptions.length,
                        isMonth,
                        unit: unitPlural,
                      }));
                      return;
                    }
                  }

                  // Fallback: Klick-basierter Standardexport falls In-Page-Fetch nicht möglich
                  status.textContent = 'Nutze Standard-Download…';
                  if (targetOptions.length > 0) {
                    const fallbackCrawlerState = {
                      active: true,
                      monthIndex: 0,
                      totalMonths: targetOptions.length,
                      exportUrl: window.location.href,
                    };
                    try {
                      sessionStorage.setItem('study_organizer_crawler_state', JSON.stringify(fallbackCrawlerState));
                    } catch {}
                    console.log('STUDY_ORGANIZER_CRAWLER:' + JSON.stringify(fallbackCrawlerState));

                    select.value = targetOptions[0].value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 500));
                    const submitBtn = document.querySelector('input[type="submit"][value*="Export" i], button[type="submit"]')
                      || select.form?.querySelector('input[type="submit"]');
                    if (submitBtn) {
                      submitBtn.click();
                      return;
                    }
                  }
                }

                // Navigationshilfen
                const exportLink = Array.from(document.querySelectorAll('a')).find(a => 
                  /^\\s*(?:Export|Exportieren)\\s*$/i.test(a.textContent || '')
                );
                if (exportLink) {
                  status.textContent = 'Wechsle zur Export-Seite…';
                  exportLink.click();
                  return;
                }

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

            let isCrawling = Boolean(crawlerState?.active)
            if (!isCrawling) {
              try {
                isCrawling = await window.webContents.executeJavaScript(
                  `Boolean(sessionStorage.getItem('study_organizer_crawler_state'))`,
                )
              } catch {
                isCrawling = false
              }
            }

            if (service) {
              const contentToImport =
                accumulatedIcsBuffers.length > 1
                  ? combineIcs(accumulatedIcsBuffers)
                  : buffer
              const res = await service.calendarImportFile(originalFilename, contentToImport)
              totalImportedCount = res.count ?? 0
              hasCompletedImport = true
            }

            if (isCrawling && crawlerState) {
              crawlerState.monthIndex++
              if (crawlerState.monthIndex < crawlerState.totalMonths) {
                // Update State im WebContents
                await window.webContents.executeJavaScript(`
                  (() => {
                    try {
                      const raw = sessionStorage.getItem('study_organizer_crawler_state');
                      if (raw) {
                        const s = JSON.parse(raw);
                        s.monthIndex = ${crawlerState.monthIndex};
                        sessionStorage.setItem('study_organizer_crawler_state', JSON.stringify(s));
                      }
                    } catch {}
                  })()
                `).catch(() => undefined)

                // Zurück zur Export-Seite navigieren für den nächsten Monat
                const targetUrl = crawlerState.exportUrl
                setTimeout(() => {
                  if (!window.isDestroyed()) {
                    if (targetUrl) {
                      window.loadURL(targetUrl).catch(() => {
                        window.webContents.goBack()
                      })
                    } else {
                      window.webContents.goBack()
                    }
                  }
                }, 800)
                return
              } else {
                // Alle Monate fertiggestellt
                crawlerState.active = false
                await window.webContents.executeJavaScript(`
                  (() => {
                    sessionStorage.removeItem('study_organizer_crawler_state');
                    sessionStorage.setItem('study_organizer_crawler_done', 'true');
                    const status = document.getElementById('study-organizer-crawl-status');
                    const btn = document.getElementById('study-organizer-crawl-btn');
                    if (status) status.textContent = '✓ Alle ${crawlerState.totalMonths} Monate erfolgreich eingelesen! (${totalImportedCount} Termine importiert)';
                    if (btn) {
                      btn.disabled = false;
                      btn.style.opacity = '1';
                      btn.textContent = '✓ Fertigstellen / Schließen';
                      btn.style.background = '#2563eb';
                      btn.onclick = () => window.close();
                    }
                  })()
                `).catch(() => undefined)
                return
              }
            }

            if (!isCrawling) {
              await finish({ success: true, count: totalImportedCount })
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
      if (hasCompletedImport || totalImportedCount > 0) {
        void finish({ success: true, count: totalImportedCount })
      } else {
        void finish({ success: false, error: 'Vorgang durch Benutzer abgebrochen.' })
      }
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
