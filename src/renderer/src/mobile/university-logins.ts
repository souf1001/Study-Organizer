// University logins that need a real browser, run in the native in-app browser (WebLogin).
import type { TucanWizardResult } from '@shared/api'
import {
  MOODLE_LAUNCH_SCHEME,
  createPassport,
  moodleLaunchUrl,
  parseLaunchToken,
} from '@shared/moodle-launch'
import { base64ToBytes } from '@shared/setup-bundle'
import type { MoodleCourse } from '@shared/types'
import { combineIcs } from '@backend/ics'
import type { Service } from '@backend/service'
import { WebLogin, type CapturedDownload } from './web-login'

const TUCAN_URL = 'https://www.tucan.tu-darmstadt.de/'
/** Same name as the desktop wizard, so a new import replaces the previous one */
const TUCAN_IMPORT_NAME = 'tucan-stundenplan.ics'

const isCalendarFile = (file: CapturedDownload) =>
  file.fileName.toLowerCase().endsWith('.ics') || file.mimeType.includes('calendar')

/** Moodle SSO like the official Moodle app: sign in, then catch the token redirect */
export async function connectMoodleWithSso(service: Service, url: string): Promise<MoodleCourse[]> {
  const { url: site } = await service.moodleSiteInfo(url)
  const passport = createPassport()
  const { redirectUrl } = await WebLogin.open({
    url: moodleLaunchUrl(site, passport),
    title: 'Moodle-Anmeldung',
    hint: 'Melde dich mit deinem Hochschul-Login an. Dein Passwort wird nicht gespeichert.',
    interceptPrefix: MOODLE_LAUNCH_SCHEME,
  })
  const token = parseLaunchToken(redirectUrl ?? '', site, passport)
  if (!token) throw new Error('Moodle hat keinen Zugang zurückgegeben.')
  return service.moodleConnect({ url: site, token })
}

/**
 * TUCaN has no API: the user signs in and exports the timetable month by month; the in-app
 * browser captures the .ics downloads, which are merged and imported as one calendar.
 */
export async function importTucanTimetable(service: Service): Promise<TucanWizardResult> {
  let downloads: CapturedDownload[]
  try {
    ;({ downloads } = await WebLogin.open({
      url: TUCAN_URL,
      title: 'TUCaN',
      hint: 'Anmelden → Veranstaltungen → Stundenplan → „Export“ (.ics). Du kannst mehrere Monate exportieren und tippst dann auf „Fertig“.',
      captureDownloads: true,
    }))
  } catch (error) {
    // Closing the browser is reported as "abgebrochen", which the settings show as a cancel
    return { success: false, error: (error as Error).message }
  }
  const calendars = downloads.filter(isCalendarFile)
  if (calendars.length === 0) {
    return { success: false, error: 'Es wurde keine Kalenderdatei (.ics) heruntergeladen.' }
  }
  const combined = combineIcs(calendars.map((file) => base64ToBytes(file.data)))
  const result = await service.calendarImportFile(TUCAN_IMPORT_NAME, combined)
  return { success: true, count: result.count }
}
