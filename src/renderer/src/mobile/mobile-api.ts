// The `Api` for the Android app. Runs the same backend service as the desktop app, but inside
// the WebView: data in IndexedDB, network requests through Capacitor's native HTTP (no CORS),
// and university logins through the native WebLogin browser.
import type { Api } from '@shared/api'
import { bytesToBase64, setupFileName, type SetupFile } from '@shared/setup-bundle'
import { startBackgroundSync } from '@backend/background-sync'
import { BrowserStore, KeyValueSecrets } from '@backend/browser-store'
import { createService } from '@backend/service'
import { isAndroid } from '@/lib/platform'
import { shareFile } from './share-file'
import { connectMoodleWithSso, importTucanTimetable } from './university-logins'

/** Android may suspend or kill the app once it is in the background: save pending changes */
function saveWhenLeaving(store: BrowserStore): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flush()
  })
  window.addEventListener('pagehide', () => void store.flush())
}

/** Offers a setup file through the share sheet; resolves to its name, or null if cancelled */
async function shareSetupFile(file: SetupFile, fileName: string, title: string) {
  const shared = await shareFile(fileName, { text: JSON.stringify(file) }, title)
  return shared ? fileName : null
}

export async function createMobileApi(): Promise<Api> {
  const store = await BrowserStore.open()
  const secrets = new KeyValueSecrets(store.storage)
  const service = createService(store, secrets, { platform: isAndroid ? 'android' : 'web' })

  saveWhenLeaving(store)

  // Like on desktop, only changes the backend makes on its own (background sync) are reported.
  // The UI applies its own changes optimistically; reloading after every write would reset
  // text fields while the user is typing.
  const listeners = new Set<() => void>()
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
      startWizard: () => importTucanTimetable(service),
    },

    moodle: {
      siteInfo: (url) => service.moodleSiteInfo(url),
      connect: (input) => service.moodleConnect(input),
      connectSso: (url) => connectMoodleWithSso(service, url),
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
      return shareSetupFile(file, fileName, 'Backup speichern')
    },
    resetAll: async () => {
      await store.reset()
      await secrets.clear()
    },

    setup: {
      export: async (options) =>
        shareSetupFile(
          await service.setupExport(options),
          setupFileName(),
          'Einrichtung speichern',
        ),
      import: (content, password) => service.setupImport(content, password),
    },
  }
  return api
}
