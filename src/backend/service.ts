// Alle Backend-Funktionen an einer Stelle. Electron (IPC) und der Web-Server rufen nur diese auf.
import { AI_PROVIDERS, getProvider } from '../shared/ai-providers'
import type {
  AiRequest,
  Annotations,
  CollectionName,
  DbPatch,
  FileInput,
  FileTarget,
  MoodleConnectInput,
  MoodleCourse,
  MoodleSyncResult,
  NoteDoc,
  RecordOf,
  Subscription,
  SyncResult,
} from '../shared/types'
import { checkKey, listModels, streamChat } from './ai'
import { newId } from '../shared/defaults'
import { eventsFromIcs, fetchCalendar, maskCalendarUrl, mergeSubscriptionEvents, normalizeCalendarUrl } from './ics'
import { MoodleClient, connectMoodle, moodleSiteInfo, syncMoodle } from './moodle'
import type { Store } from './store'

/** Ablage für geheime Werte (API-Keys, Moodle-Token) – verschlüsselt, getrennt von db.json */
export interface Secrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
}

export interface ServiceOptions {
  /** Web-Server: prüft Adressen vor dem Abruf (Schutz vor Zugriff auf interne Netze) */
  fetchImpl?: typeof fetch
  /** Web-Server: hält Platz im Speicherlimit frei (wirft, wenn er nicht reicht); Rückgabe gibt ihn wieder frei */
  reserveSpace?: ReserveSpace
}

export type ReserveSpace = (bytes: number) => Promise<() => void>
const noLimit: ReserveSpace = async () => () => undefined
const jsonSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

const aiSecret = (provider: string): string => {
  if (!AI_PROVIDERS.some((p) => p.id === provider)) throw new Error('Unbekannter Anbieter')
  return `ai:${provider}`
}

// Geheimnisse werden zusammen mit ihrer Zieladresse gespeichert. So kann eine geänderte
// Einstellung einen Key oder Token nie an einen anderen Server schicken.
interface BoundSecret {
  value: string
  target: string
}

async function readBound(secrets: Secrets, name: string, target: string): Promise<string | null> {
  const raw = await secrets.get(name)
  if (!raw) return null
  try {
    const bound = JSON.parse(raw) as BoundSecret
    if (bound.target !== target) throw new Error('Die Adresse hat sich geändert – bitte den Key bzw. die Anmeldung neu speichern.')
    return bound.value
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

const writeBound = (secrets: Secrets, name: string, value: string, target: string) =>
  secrets.set(name, JSON.stringify({ value, target } satisfies BoundSecret))

/** Wohin ein KI-Key geschickt werden darf: feste Anbieter-Adresse oder die eingestellte eigene */
function aiTarget(settings: { provider: string; baseUrl: string }): string {
  const provider = getProvider(settings.provider)
  return provider.customBaseUrl ? settings.baseUrl.trim() || provider.baseUrl : provider.baseUrl
}

export type Service = ReturnType<typeof createService>

export function createService(store: Store, secrets: Secrets, options: ServiceOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const reserveSpace = options.reserveSpace ?? noLimit

  async function moodleClient(): Promise<MoodleClient> {
    const { url } = store.get().settings.moodle
    const token = url ? await readBound(secrets, 'moodle', url) : null
    if (!token || !url) throw new Error('Moodle ist nicht verbunden.')
    return new MoodleClient(url, token, fetchImpl)
  }

  const aiKey = async () => {
    const settings = store.get().settings.ai
    return checkKey(settings, await readBound(secrets, aiSecret(settings.provider), aiTarget(settings)))
  }

  const service = {
    loadDb: () => store.get(),
    put: <C extends CollectionName>(collection: C, record: RecordOf<C>) => store.put(collection, record),
    remove: (collection: CollectionName, id: string) => store.remove(collection, id),
    update: (patch: DbPatch) => store.update(patch),

    readNote: (id: string) => store.readNote(id),
    writeNote: (id: string, doc: NoteDoc) => store.writeNote(id, doc),
    readAnnotations: (id: string) => store.readAnnotations(id),
    writeAnnotations: (id: string, a: Annotations) => store.writeAnnotations(id, a),
    readText: (id: string) => store.readText(id),
    writeText: (id: string, text: string) => store.writeText(id, text),
    search: (query: string) => store.search(query),
    addFile: (target: FileTarget, input: FileInput) => store.addFile(target, input),

    // ---- KI ----
    aiSetKey: async (provider: string, key: string) => {
      const name = aiSecret(provider)
      const settings = store.get().settings.ai
      if (key.trim()) await writeBound(secrets, name, key.trim(), aiTarget({ ...settings, provider }))
      else await secrets.remove(name)
    },
    aiHasKey: async (provider: string) => Boolean(await secrets.get(aiSecret(provider))),
    aiListModels: async () => listModels(store.get().settings.ai, await aiKey(), fetchImpl),
    aiStream: async (request: AiRequest, onText: (chunk: string) => void, signal: AbortSignal) =>
      streamChat(store.get().settings.ai, await aiKey(), request, onText, signal, fetchImpl),

    // ---- Kalender-Abos ----
    // Abo-Adressen enthalten oft einen persönlichen Schlüssel (z. B. Moodle authtoken) und
    // werden deshalb verschlüsselt abgelegt. In db.json steht nur eine gekürzte Anzeige-Adresse.
    calendarSubscribe: async (name: string, url: string): Promise<Subscription> => {
      const full = normalizeCalendarUrl(url)
      const subscription: Subscription = {
        id: newId(),
        name: name.trim() || new URL(full).host,
        kind: 'url',
        url: maskCalendarUrl(full),
        enabled: true,
        lastSync: null,
        lastError: null,
      }
      await secrets.set(`ics:${subscription.id}`, full)
      store.put('subscriptions', subscription)
      await service.calendarSync(subscription.id)
      return store.get().subscriptions.find((s) => s.id === subscription.id) ?? subscription
    },
    calendarUnsubscribe: async (id: string) => {
      await secrets.remove(`ics:${id}`)
      await store.remove('subscriptions', id)
    },
    calendarSync: async (id: string): Promise<SyncResult> => {
      const subscription = store.get().subscriptions.find((s) => s.id === id)
      if (!subscription || subscription.kind !== 'url') throw new Error('Abo nicht gefunden')
      try {
        const url = await secrets.get(`ics:${id}`)
        if (!url) throw new Error('Adresse fehlt – bitte das Abo neu anlegen.')
        const text = await fetchCalendar(url, fetchImpl)
        // Während des Abrufs gelöscht? Dann nichts zurückschreiben.
        if (!store.get().subscriptions.some((s) => s.id === id)) return { count: 0, error: null }
        const incoming = eventsFromIcs(text, subscription, store.get().modules)
        const existing = store.get().events.filter((e) => e.subscriptionId === id)
        const merged = mergeSubscriptionEvents(existing, incoming)
        const release = await reserveSpace(jsonSize(merged))
        store.replaceMany('events', (e) => e.subscriptionId === id, merged)
        release()
        store.put('subscriptions', { ...subscription, lastSync: new Date().toISOString(), lastError: null })
        return { count: incoming.length, error: null }
      } catch (error) {
        const message = (error as Error).message
        const current = store.get().subscriptions.find((s) => s.id === id)
        if (current) store.put('subscriptions', { ...current, lastError: message })
        return { count: 0, error: message }
      }
    },
    /** .ics-Datei einmalig importieren; derselbe Dateiname ersetzt den vorherigen Import */
    calendarImportFile: async (name: string, text: string): Promise<SyncResult> => {
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Das ist keine iCal-Datei (.ics).')
      const existing = store.get().subscriptions.find((s) => s.kind === 'file' && s.name === name)
      const subscription: Subscription = existing ?? { id: newId(), name, kind: 'file', url: 'Datei-Import', enabled: false, lastSync: null, lastError: null }
      const events = eventsFromIcs(text, subscription, store.get().modules)
      const release = await reserveSpace(jsonSize(events))
      store.put('subscriptions', { ...subscription, lastSync: new Date().toISOString() })
      store.replaceMany('events', (e) => e.subscriptionId === subscription.id, events)
      release()
      return { count: events.length, error: null }
    },

    // ---- Moodle ----
    moodleSiteInfo: (url: string) => moodleSiteInfo(url, fetchImpl),
    moodleConnect: async (input: MoodleConnectInput): Promise<MoodleCourse[]> => {
      const result = await connectMoodle(input, fetchImpl)
      await writeBound(secrets, 'moodle', result.token, result.site)
      const settings = store.get().settings
      store.update({
        settings: {
          ...settings,
          moodle: { ...settings.moodle, url: result.site, siteName: result.siteName, userId: result.userId },
        },
      })
      return result.courses
    },
    moodleCourses: async (): Promise<MoodleCourse[]> => {
      const { userId } = store.get().settings.moodle
      if (userId === null) throw new Error('Moodle ist nicht verbunden.')
      return (await moodleClient()).courses(userId)
    },
    moodleSync: async (): Promise<MoodleSyncResult> => syncMoodle(store, await moodleClient(), reserveSpace),
    moodleDisconnect: async () => {
      await secrets.remove('moodle')
      const settings = store.get().settings
      store.update({
        settings: {
          ...settings,
          moodle: { ...settings.moodle, url: '', siteName: '', userId: null, courseMap: {}, lastSync: null },
        },
      })
    },

    /** Alle Abos und Moodle abgleichen (beim Start und regelmäßig) */
    syncAll: async () => {
      for (const s of store.get().subscriptions.filter((s) => s.enabled && s.kind === 'url')) {
        await service.calendarSync(s.id)
      }
      if (store.get().settings.moodle.url && (await secrets.get('moodle').catch(() => null))) {
        await service.moodleSync().catch(() => undefined)
      }
    },
  }
  return service
}
