// Zugriff auf die Datenhaltung.
// Desktop: Umsetzung im Preload-Skript (IPC zum Electron-Main-Prozess).
// Android / Web: Lokale Umsetzung über ClientStore (IndexedDB) & Service.
import type { Api, AiStream } from '@shared/api'
import { createMobileApi } from './mobile-api'

declare global {
  interface Window {
    studyApi?: Api
  }
}

let mobileApiInstance: Api | null = null
let mobileApiPromise: Promise<Api> | null = null

function getMobileApi(): Promise<Api> {
  if (mobileApiInstance) return Promise.resolve(mobileApiInstance)
  if (!mobileApiPromise) {
    mobileApiPromise = createMobileApi().then((inst) => {
      mobileApiInstance = inst
      return inst
    })
  }
  return mobileApiPromise
}

const isAndroid =
  typeof navigator !== 'undefined' &&
  (navigator.userAgent.toLowerCase().includes('android') ||
    Boolean((window as unknown as { Capacitor?: { getPlatform: () => string } }).Capacitor?.getPlatform() === 'android'))

const fallbackApi: Api = {
  platform: isAndroid ? 'android' : 'web',

  loadDb: async () => (await getMobileApi()).loadDb(),
  put: async (c, r) => (await getMobileApi()).put(c, r),
  remove: async (c, id) => (await getMobileApi()).remove(c, id),
  update: async (patch) => (await getMobileApi()).update(patch),

  readNote: async (id) => (await getMobileApi()).readNote(id),
  writeNote: async (id, doc) => (await getMobileApi()).writeNote(id, doc),
  readAnnotations: async (id) => (await getMobileApi()).readAnnotations(id),
  writeAnnotations: async (id, a) => (await getMobileApi()).writeAnnotations(id, a),
  readText: async (id) => (await getMobileApi()).readText(id),
  writeText: async (id, t) => (await getMobileApi()).writeText(id, t),

  addFiles: async (target, files) => (await getMobileApi()).addFiles(target, files),
  fileUrl: (item) => (mobileApiInstance ? mobileApiInstance.fileUrl(item) : ''),
  openFile: async (item) => (await getMobileApi()).openFile(item),

  search: async (q) => (await getMobileApi()).search(q),

  ai: {
    setKey: async (p, k) => (await getMobileApi()).ai.setKey(p, k),
    hasKey: async (p) => (await getMobileApi()).ai.hasKey(p),
    listModels: async () => (await getMobileApi()).ai.listModels(),
    stream: (request, onText): AiStream => {
      let activeStream: AiStream | null = null
      let cancelled = false
      const done = (async () => {
        const inst = await getMobileApi()
        if (cancelled) return ''
        activeStream = inst.ai.stream(request, onText)
        return activeStream.done
      })()
      return {
        done,
        cancel: () => {
          cancelled = true
          activeStream?.cancel()
        },
      }
    },
  },

  calendar: {
    subscribe: async (n, u) => (await getMobileApi()).calendar.subscribe(n, u),
    unsubscribe: async (id) => (await getMobileApi()).calendar.unsubscribe(id),
    removeSubscription: async (id) => (await getMobileApi()).calendar.removeSubscription(id),
    sync: async (id) => (await getMobileApi()).calendar.sync(id),
    importFile: async (n, t) => (await getMobileApi()).calendar.importFile(n, t),
    rematchEvents: async () => (await getMobileApi()).calendar.rematchEvents?.() ?? 0,
  },

  tucan: {
    startWizard: async () => (await getMobileApi()).tucan.startWizard(),
  },

  moodle: {
    siteInfo: async (url) => (await getMobileApi()).moodle.siteInfo(url),
    connect: async (i) => (await getMobileApi()).moodle.connect(i),
    courses: async () => (await getMobileApi()).moodle.courses(),
    sync: async () => (await getMobileApi()).moodle.sync(),
    posts: async (d) => (await getMobileApi()).moodle.posts(d),
    reply: async (p, s, m) => (await getMobileApi()).moodle.reply(p, s, m),
    disconnect: async () => (await getMobileApi()).moodle.disconnect(),
  },

  onChange: (listener) => {
    let unreg: (() => void) | null = null
    void getMobileApi().then((inst) => {
      unreg = inst.onChange(listener)
    })
    return () => {
      unreg?.()
    }
  },

  openExternal: async (u) => (await getMobileApi()).openExternal(u),
  dataDir: async () => (await getMobileApi()).dataDir(),
  revealDataDir: async () => (await getMobileApi()).revealDataDir(),
  backup: async () => (await getMobileApi()).backup(),
  resetAll: async () => (await getMobileApi()).resetAll(),
}

export const api: Api = typeof window !== 'undefined' && window.studyApi ? window.studyApi : fallbackApi

if (typeof window !== 'undefined' && !window.studyApi) {
  window.studyApi = api
  // Vorab initialisieren
  void getMobileApi()
}
