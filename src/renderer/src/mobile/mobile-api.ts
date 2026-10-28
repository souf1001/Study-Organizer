// The `Api` for the Android app. Runs the same backend service as the desktop app, but inside
// the WebView: data in IndexedDB, network requests through Capacitor's native HTTP (no CORS),
// and university logins through the native WebLogin browser.
import type { Api } from '@shared/api'
import {
  MOODLE_LAUNCH_SCHEME,
  createPassport,
  moodleLaunchUrl,
  parseLaunchToken,
} from '@shared/moodle-launch'
import { base64ToBytes, bytesToBase64, setupFileName } from '@shared/setup-bundle'
import { startBackgroundSync } from '@backend/background-sync'
import { BrowserStore, KeyValueSecrets } from '@backend/browser-store'
import { combineIcs } from '@backend/ics'
import { createService } from '@backend/service'
import { isAndroid } from '@/lib/platform'
import { shareFile } from './share-file'
import { WebLogin, type CapturedDownload } from './web-login'

const TUCAN_URL = 'https://www.tucan.tu-darmstadt.de/'
const TUCAN_IMPORT_NAME = 'tucan-stundenplan.ics'

const isCalendarFile = (file: CapturedDownload) =>
  file.fileName.toLowerCase().endsWith('.ics') || file.mimeType.includes('calendar')

export async function createMobileApi(): Promise<Api> {
  const store = await BrowserStore.open()
  const secrets = new KeyValueSecrets(store.storage)
  const service = createService(store, secrets, { platform: isAndroid ? 'android' : 'web' })

  // Like on desktop, only changes the backend makes on its own (background sync) are reported.
  // The UI applies its own changes optimistically; reloading after every write would reset
  // text fields while the user is typing.
  const listeners = new Set<() => void>()
  // Android may suspend or kill the app once it is in the background: save pending changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flush()
  })
  window.addEventListener('pagehide', () => void store.flush())
  startBackgroundSync(service, store, () => {
    for (const listener of listeners) listener()
  })

  const api: Api = {
    platform: isAndroid ? 'android' : 'web',

    loadDb: async () => service.loadDb(),
    put: async (collection, record) => service.put(collection, record),
    remove: (collection, id) => service.remove(collection, id),
    update: async (patch) => service.update(patch),

    readNote: (id) => service.readNote(id),
    writeNote: (id, doc) => service.writeNote(id, doc),
    readAnnotations: (id) => service.readAnnotations(id),
    writeAnnotations: (id, annotations) => service.writeAnnotations(id, annotations),
    readText: (id) => service.readText(id),
    writeText: (id, text) => service.writeText(id, text),

    addFiles: async (target, files) => {
      const items = []
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        items.push(await service.addFile(target, { name: file.name, type: file.type, bytes }))
      }
      return items
    },
    fileUrl: (item) => store.fileUrl(item),
    openFile: async (item) => {
      const bytes = item.fileName ? await store.readFile(item.fileName) : null
      if (!bytes || !item.fileName) throw new Error('Datei nicht gefunden.')
      await shareFile(item.fileName, { base64: bytesToBase64(bytes) }, item.title)
    },

    search: (query) => service.search(query),

    ai: {
      setKey: (provider, key) => service.aiSetKey(provider, key),
      hasKey: (provider) => service.aiHasKey(provider),
      listModels: () => service.aiListModels(),
      stream: (request, onText) => {
        const controller = new AbortController()
        return {
          done: service.aiStream(request, onText, controller.signal),
          cancel: () => controller.abort(),
        }
      },
    },

    calendar: {
      subscribe: (name, url) => service.calendarSubscribe(name, url),
      unsubscribe: (id) => service.calendarUnsubscribe(id),
      removeSubscription: (id) => service.calendarUnsubscribe(id),
      sync: (id) => service.calendarSync(id),
      importFile: (name, text) => service.calendarImportFile(name, text),
      rematchEvents: async () => service.calendarRematchEvents(),
    },

    tucan: {
      // TUCaN has no API: the user signs in and exports the timetable in the in-app browser,
      // which captures the .ics downloads.
      startWizard: async () => {
        let downloads: CapturedDownload[]
        try {
          ;({ downloads } = await WebLogin.open({
            url: TUCAN_URL,
            title: 'TUCaN',
            hint: 'Anmelden → Veranstaltungen → Stundenplan → „Export“ (.ics). Du kannst mehrere Monate exportieren und tippst dann auf „Fertig“.',
            captureDownloads: true,
          }))
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
        const calendars = downloads.filter(isCalendarFile)
        if (calendars.length === 0) {
          return { success: false, error: 'Es wurde keine Kalenderdatei (.ics) heruntergeladen.' }
        }
        const combined = combineIcs(calendars.map((file) => base64ToBytes(file.data)))
        const result = await service.calendarImportFile(TUCAN_IMPORT_NAME, combined)
        return { success: true, count: result.count }
      },
    },

    moodle: {
      siteInfo: (url) => service.moodleSiteInfo(url),
      connect: (input) => service.moodleConnect(input),
      connectSso: async (url) => {
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
      },
      courses: () => service.moodleCourses(),
      sync: () => service.moodleSync(),
      posts: (discussionId) => service.moodlePosts(discussionId),
      reply: (postId, subject, message) => service.moodleReply(postId, subject, message),
      disconnect: () => service.moodleDisconnect(),
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    openExternal: async (url) => {
      if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    },
    dataDir: async () => store.dir,
    revealDataDir: async () => undefined,
    // A backup is a complete setup file without credentials
    backup: async () => {
      const file = await service.setupExport({ scope: 'everything', includeCredentials: false })
      const fileName = setupFileName().replace('Einrichtung', 'Backup')
      const shared = await shareFile(fileName, { text: JSON.stringify(file) }, 'Backup speichern')
      return shared ? fileName : null
    },
    resetAll: async () => {
      await store.reset()
      await secrets.clear()
    },

    setup: {
      export: async (options) => {
        const file = await service.setupExport(options)
        const fileName = setupFileName()
        const shared = await shareFile(
          fileName,
          { text: JSON.stringify(file) },
          'Einrichtung speichern',
        )
        return shared ? fileName : null
      },
      import: (content, password) => service.setupImport(content, password),
    },
  }
  return api
}
