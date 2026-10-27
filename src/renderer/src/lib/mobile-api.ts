// Vollständige Api-Implementierung für Android und Browser.
// Nutzt ClientStore (IndexedDB) und verbindet direkt die bewährte Service-Geschäftslogik.
import type { Api } from '@shared/api'
import { createService } from '@backend/service'
import { ClientSecrets, ClientStore } from '@backend/client-store'

const listeners = new Set<() => void>()

function notifyChange(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('Fehler im onChange-Listener:', error)
    }
  }
}

let storePromise: Promise<ClientStore> | null = null

function getStore(): Promise<ClientStore> {
  if (!storePromise) {
    storePromise = ClientStore.open()
  }
  return storePromise
}

export async function createMobileApi(): Promise<Api> {
  const clientStore = await getStore()
  const clientSecrets = new ClientSecrets(clientStore)
  const service = createService(clientStore as any, clientSecrets)

  const isAndroid =
    typeof navigator !== 'undefined' &&
    (navigator.userAgent.toLowerCase().includes('android') ||
      (typeof window !== 'undefined' &&
        Boolean((window as unknown as { Capacitor?: { getPlatform: () => string } }).Capacitor?.getPlatform() === 'android')))

  const mobileApi: Api = {
    platform: isAndroid ? 'android' : 'web',

    loadDb: async () => clientStore.get(),
    put: async (collection, record) => {
      service.put(collection, record)
      notifyChange()
    },
    remove: async (collection, id) => {
      await service.remove(collection, id)
      notifyChange()
    },
    update: async (patch) => {
      service.update(patch)
      notifyChange()
    },

    readNote: (id) => service.readNote(id),
    writeNote: async (id, doc) => {
      await service.writeNote(id, doc)
      notifyChange()
    },
    readAnnotations: (id) => service.readAnnotations(id),
    writeAnnotations: async (id, annotations) => {
      await service.writeAnnotations(id, annotations)
    },
    readText: (id) => service.readText(id),
    writeText: async (id, text) => {
      await service.writeText(id, text)
    },

    addFiles: async (target, files) => {
      const items = []
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const item = await clientStore.addFile(target, {
          name: file.name,
          type: file.type,
          bytes,
        })
        items.push(item)
      }
      notifyChange()
      return items
    },
    fileUrl: (item) => clientStore.fileUrl(item),
    openFile: async (item) => {
      const url = clientStore.fileUrl(item)
      if (url) {
        window.open(url, '_blank')
      }
    },

    search: (query) => service.search(query),

    ai: {
      setKey: async (provider, key) => service.aiSetKey(provider, key),
      hasKey: async (provider) => service.aiHasKey(provider),
      listModels: async () => service.aiListModels(),
      stream: (request, onText) => {
        const controller = new AbortController()
        const done = service.aiStream(request, onText, controller.signal)
        return {
          done,
          cancel: () => controller.abort(),
        }
      },
    },

    calendar: {
      subscribe: async (name, url) => {
        const sub = await service.calendarSubscribe(name, url)
        notifyChange()
        return sub
      },
      unsubscribe: async (id) => {
        await service.calendarUnsubscribe(id)
        notifyChange()
      },
      removeSubscription: async (id) => {
        await service.calendarUnsubscribe(id)
        notifyChange()
      },
      sync: async (id) => {
        const res = await service.calendarSync(id)
        notifyChange()
        return res
      },
      importFile: async (name, text) => {
        const res = await service.calendarImportFile(name, text)
        notifyChange()
        return res
      },
      rematchEvents: async () => {
        const count = await service.calendarRematchEvents()
        if (count > 0) notifyChange()
        return count
      },
    },

    tucan: {
      startWizard: async () => ({
        success: false,
        count: 0,
        message:
          'Automatischer TUCaN-Web-Login benötigt die Desktop-App. Für Android kannst du den TUCaN-Kalender als .ics-Datei exportieren und über Kalender-Import hinzufügen.',
      }),
    },

    moodle: {
      siteInfo: (url) => service.moodleSiteInfo(url),
      connect: async (input) => {
        const courses = await service.moodleConnect(input)
        notifyChange()
        return courses
      },
      courses: () => service.moodleCourses(),
      sync: async () => {
        const res = await service.moodleSync()
        notifyChange()
        return res
      },
      posts: (discussionId) => service.moodlePosts(discussionId),
      reply: async (postId, subject, message) => {
        const res = await service.moodleReply(postId, subject, message)
        notifyChange()
        return res
      },
      disconnect: async () => {
        await service.moodleDisconnect()
        notifyChange()
      },
    },

    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    openExternal: async (url) => {
      const protocol = new URL(url).protocol
      if (['https:', 'http:', 'mailto:'].includes(protocol)) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    },
    dataDir: async () => clientStore.dir,
    revealDataDir: async () => undefined,
    backup: async () => {
      const data = await clientStore.exportAll()
      const blob = new Blob([data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `study-organizer-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      return 'Backup heruntergeladen'
    },
    resetAll: async () => {
      await clientStore.reset()
      notifyChange()
    },
  }

  return mobileApi
}
