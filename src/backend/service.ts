// All backend operations in one place. The Electron IPC layer and the Android client only call
// into this service, so the business logic exists exactly once.
import { AI_PROVIDERS, getProvider } from '../shared/ai-providers'
import { newId } from '../shared/defaults'
import type { SetupExportOptions } from '../shared/setup-bundle'
import type {
  AiRequest,
  Annotations,
  CollectionName,
  DbPatch,
  FileInput,
  FileTarget,
  Module,
  MoodleConnectInput,
  MoodleCourse,
  MoodlePost,
  MoodleSyncResult,
  NoteDoc,
  RecordOf,
  Subscription,
  SyncResult,
} from '../shared/types'
import { checkKey, listModels, streamChat } from './ai'
import type { DataStore } from './data-store'
import {
  decodeIcsText,
  eventsFromIcs,
  fetchCalendar,
  maskCalendarUrl,
  matchModule,
  mergeSubscriptionEvents,
  normalizeCalendarUrl,
  normalizeIcsFilename,
} from './ics'
import {
  MoodleClient,
  connectMoodle,
  matchCourseToModules,
  moodleSiteInfo,
  syncMoodle,
} from './moodle'
import { loadThreadPosts, replyToThread } from './moodle-threads'
import type { Secrets } from './secrets'
import { applySetupFile, createSetupFile } from './setup-transfer'

export type { Secrets } from './secrets'

export interface ServiceOptions {
  /** Web server: validates addresses before fetching them (blocks access to internal networks) */
  fetchImpl?: typeof fetch
  /** Web server: reserves room in the storage quota (throws if it does not fit) and returns a release function */
  reserveSpace?: ReserveSpace
  /** Name of the platform written into exported setup files */
  platform?: string
}

export type ReserveSpace = (bytes: number) => Promise<() => void>
const noLimit: ReserveSpace = async () => () => undefined
const jsonSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

const aiSecretName = (provider: string): string => {
  if (!AI_PROVIDERS.some((p) => p.id === provider)) throw new Error('Unbekannter Anbieter')
  return `ai:${provider}`
}
const calendarSecretName = (subscriptionId: string): string => `ics:${subscriptionId}`
const MOODLE_SECRET = 'moodle'

// Secrets are stored together with the address they belong to. That way a changed setting can
// never send a key or token to a different server.
interface BoundSecret {
  value: string
  target: string
}

async function readBound(secrets: Secrets, name: string, target: string): Promise<string | null> {
  const raw = await secrets.get(name)
  if (!raw) return null
  try {
    const bound = JSON.parse(raw) as BoundSecret
    if (bound.target !== target) {
      throw new Error(
        'Die Adresse hat sich geändert – bitte den Key bzw. die Anmeldung neu speichern.',
      )
    }
    return bound.value
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

const writeBound = (secrets: Secrets, name: string, value: string, target: string) =>
  secrets.set(name, JSON.stringify({ value, target } satisfies BoundSecret))

/** Where an AI key may be sent: the provider's fixed address or the user's custom one */
function aiTarget(settings: { provider: string; baseUrl: string }): string {
  const provider = getProvider(settings.provider)
  return provider.customBaseUrl ? settings.baseUrl.trim() || provider.baseUrl : provider.baseUrl
}

export type Service = ReturnType<typeof createService>

export function createService(store: DataStore, secrets: Secrets, options: ServiceOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const reserveSpace = options.reserveSpace ?? noLimit

  async function moodleClient(): Promise<MoodleClient> {
    const { url } = store.get().settings.moodle
    const token = url ? await readBound(secrets, MOODLE_SECRET, url) : null
    if (!token || !url) throw new Error('Moodle ist nicht verbunden.')
    return new MoodleClient(url, token, fetchImpl)
  }

  const aiKey = async () => {
    const settings = store.get().settings.ai
    return checkKey(
      settings,
      await readBound(secrets, aiSecretName(settings.provider), aiTarget(settings)),
    )
  }

  /** Assigns events without a module to a module by name or code; returns how many changed */
  function rematchEvents(): number {
    const db = store.get()
    const activeSemesterId = db.activeSemesterId ?? db.semesters[0]?.id ?? null
    let changed = 0
    const events = db.events.map((event) => {
      if (event.moduleId) return event
      const module = matchModule(event.title, event.notes || '', [], db.modules, activeSemesterId)
      if (!module) return event
      changed++
      return { ...event, moduleId: module.id }
    })
    if (changed > 0) store.replaceMany('events', () => true, events)
    return changed
  }

  /** Keeps forum threads in the module their Moodle course is mapped to */
  function rematchMoodleDiscussions(): number {
    const db = store.get()
    const courseMap = db.settings.moodle?.courseMap ?? {}
    const moduleExists = (id: string) => db.modules.some((m) => m.id === id)
    let changed = 0
    const discussions = db.moodleDiscussions.map((discussion) => {
      const mappedModuleId = discussion.courseId
        ? (courseMap[String(discussion.courseId)] ?? null)
        : null
      if (
        mappedModuleId &&
        discussion.moduleId !== mappedModuleId &&
        moduleExists(mappedModuleId)
      ) {
        changed++
        return { ...discussion, moduleId: mappedModuleId }
      }
      if (discussion.moduleId && !moduleExists(discussion.moduleId)) {
        changed++
        return { ...discussion, moduleId: null }
      }
      return discussion
    })
    if (changed > 0) store.update({ moodleDiscussions: discussions })
    return changed
  }

  /** Stores a calendar's events, replacing the previous ones of the same subscription */
  async function storeSubscriptionEvents(
    subscriptionId: string,
    events: RecordOf<'events'>[],
  ): Promise<void> {
    const release = await reserveSpace(jsonSize(events))
    try {
      store.replaceMany('events', (e) => e.subscriptionId === subscriptionId, events)
    } finally {
      release()
    }
    rematchEvents()
  }

  /** Finds an earlier import of the same .ics file, ignoring download suffixes like "(1)" */
  function findFileImport(name: string): Subscription | undefined {
    const cleanName = normalizeIcsFilename(name).toLowerCase()
    const rawName = name.trim().toLowerCase()
    const isSameFile = (s: Subscription) =>
      [rawName, cleanName].includes(s.name.toLowerCase()) ||
      normalizeIcsFilename(s.name).toLowerCase() === cleanName
    return store.get().subscriptions.find((s) => s.kind === 'file' && isSameFile(s))
  }

  const service = {
    loadDb: () => store.get(),
    put: <C extends CollectionName>(collection: C, record: RecordOf<C>) => {
      store.put(collection, record)
      if (collection === 'modules') {
        rematchEvents()
        rematchMoodleDiscussions()
      }
    },
    remove: (collection: CollectionName, id: string) => store.remove(collection, id),
    update: (patch: DbPatch) => {
      store.update(patch)
      if (patch.activeSemesterId) rematchEvents()
      if (patch.settings?.moodle?.courseMap) rematchMoodleDiscussions()
    },

    readNote: (id: string) => store.readNote(id),
    writeNote: (id: string, doc: NoteDoc) => store.writeNote(id, doc),
    readAnnotations: (id: string) => store.readAnnotations(id),
    writeAnnotations: (id: string, annotations: Annotations) =>
      store.writeAnnotations(id, annotations),
    readText: (id: string) => store.readText(id),
    writeText: (id: string, text: string) => store.writeText(id, text),
    search: (query: string) => store.search(query),
    addFile: (target: FileTarget, input: FileInput) => store.addFile(target, input),

    // ---- AI ----
    aiSetKey: async (provider: string, key: string) => {
      const name = aiSecretName(provider)
      const settings = store.get().settings.ai
      if (key.trim())
        await writeBound(secrets, name, key.trim(), aiTarget({ ...settings, provider }))
      else await secrets.remove(name)
    },
    aiHasKey: async (provider: string) => Boolean(await secrets.get(aiSecretName(provider))),
    aiListModels: async () => listModels(store.get().settings.ai, await aiKey(), fetchImpl),
    aiStream: async (request: AiRequest, onText: (chunk: string) => void, signal: AbortSignal) =>
      streamChat(store.get().settings.ai, await aiKey(), request, onText, signal, fetchImpl),

    // ---- Calendar subscriptions ----
    // Feed addresses often contain a personal key (e.g. Moodle's authtoken), so the full address
    // lives in the secrets store. The database only keeps a masked address for display.
    calendarSubscribe: async (name: string, url: string): Promise<Subscription> => {
      const fullUrl = normalizeCalendarUrl(url)
      const subscription: Subscription = {
        id: newId(),
        name: name.trim() || new URL(fullUrl).host,
        kind: 'url',
        url: maskCalendarUrl(fullUrl),
        enabled: true,
        lastSync: null,
        lastError: null,
      }
      await secrets.set(calendarSecretName(subscription.id), fullUrl)
      store.put('subscriptions', subscription)
      await service.calendarSync(subscription.id)
      return store.get().subscriptions.find((s) => s.id === subscription.id) ?? subscription
    },
    calendarUnsubscribe: async (id: string) => {
      await secrets.remove(calendarSecretName(id))
      await store.remove('subscriptions', id)
    },
    calendarSync: async (id: string): Promise<SyncResult> => {
      const subscription = store.get().subscriptions.find((s) => s.id === id)
      if (!subscription || subscription.kind !== 'url') throw new Error('Abo nicht gefunden')
      const isStillSubscribed = () => store.get().subscriptions.some((s) => s.id === id)
      try {
        const url = await secrets.get(calendarSecretName(id))
        if (!url) throw new Error('Adresse fehlt – bitte das Abo neu anlegen.')
        const text = await fetchCalendar(url, fetchImpl)
        // Removed while we were downloading? Then do not write anything back.
        if (!isStillSubscribed()) return { count: 0, error: null }

        const existing = store.get().events.filter((e) => e.subscriptionId === id)
        const incoming = eventsFromIcs(text, subscription, store.get().modules, {
          existingEvents: existing,
          activeSemesterId: store.get().activeSemesterId,
        })
        await storeSubscriptionEvents(id, mergeSubscriptionEvents(existing, incoming))
        store.put('subscriptions', {
          ...subscription,
          lastSync: new Date().toISOString(),
          lastError: null,
        })
        return { count: incoming.length, error: null }
      } catch (error) {
        const message = (error as Error).message
        const current = store.get().subscriptions.find((s) => s.id === id)
        if (current) store.put('subscriptions', { ...current, lastError: message })
        return { count: 0, error: message }
      }
    },
    /** One-time import of an .ics file; importing the same file name again replaces the previous import */
    calendarImportFile: async (name: string, content: string | Uint8Array): Promise<SyncResult> => {
      const text = decodeIcsText(content)
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Das ist keine iCal-Datei (.ics).')

      const cleanName = normalizeIcsFilename(name)
      const previous = findFileImport(name)
      const subscription: Subscription = previous
        ? { ...previous, name: cleanName }
        : {
            id: newId(),
            name: cleanName,
            kind: 'file',
            url: 'Datei-Import',
            enabled: false,
            lastSync: null,
            lastError: null,
          }

      const db = store.get()
      const createdModules: Module[] = []
      const events = eventsFromIcs(text, subscription, db.modules, {
        activeSemesterId: db.activeSemesterId ?? db.semesters[0]?.id ?? null,
        autoCreateModules: true,
        existingEvents: db.events.filter((e) => e.subscriptionId === subscription.id),
        onModuleCreated: (module) => {
          createdModules.push(module)
          store.put('modules', module)
        },
      })

      store.put('subscriptions', {
        ...subscription,
        lastSync: new Date().toISOString(),
        lastError: null,
      })
      await storeSubscriptionEvents(subscription.id, events)
      return { count: events.length, error: null, newModules: createdModules.length }
    },
    calendarRematchEvents: rematchEvents,

    // ---- Moodle ----
    moodleSiteInfo: (url: string) => moodleSiteInfo(url, fetchImpl),
    moodleConnect: async (input: MoodleConnectInput): Promise<MoodleCourse[]> => {
      const result = await connectMoodle(input, fetchImpl)
      await writeBound(secrets, MOODLE_SECRET, result.token, result.site)

      const { settings, modules } = store.get()
      const courseMap: Record<string, string> = { ...(settings.moodle.courseMap ?? {}) }
      for (const course of result.courses) {
        const key = String(course.id)
        if (courseMap[key]) continue
        const module = matchCourseToModules(course, modules)
        if (module) courseMap[key] = module.id
      }
      store.update({
        settings: {
          ...settings,
          moodle: {
            ...settings.moodle,
            url: result.site,
            siteName: result.siteName,
            userId: result.userId,
            courseMap,
          },
        },
      })
      // Fetch everything right away, but do not make the user wait for it
      service.moodleSync().catch(() => undefined)
      return result.courses
    },
    moodleCourses: async (): Promise<MoodleCourse[]> => {
      const { userId } = store.get().settings.moodle
      if (userId === null) throw new Error('Moodle ist nicht verbunden.')
      return (await moodleClient()).courses(userId)
    },
    moodleSync: async (): Promise<MoodleSyncResult> =>
      syncMoodle(store, await moodleClient(), reserveSpace),
    moodlePosts: async (discussionId: number): Promise<MoodlePost[]> =>
      loadThreadPosts(store, await moodleClient(), discussionId),
    moodleReply: async (postOrDiscussionId: number, subject: string, message: string) =>
      replyToThread(store, await moodleClient(), postOrDiscussionId, subject, message),
    moodleDisconnect: async () => {
      await secrets.remove(MOODLE_SECRET)
      const settings = store.get().settings
      store.update({
        settings: {
          ...settings,
          moodle: {
            ...settings.moodle,
            url: '',
            siteName: '',
            userId: null,
            courseMap: {},
            lastSync: null,
          },
        },
      })
    },

    // ---- Moving a setup to another device ----
    setupExport: (exportOptions: SetupExportOptions) =>
      createSetupFile(store, secrets, exportOptions, options.platform ?? 'desktop'),
    setupImport: async (text: string, password?: string) => {
      const result = await applySetupFile(store, secrets, text, password)
      rematchEvents()
      rematchMoodleDiscussions()
      return result
    },

    /** Syncs all calendar subscriptions and Moodle (at startup and periodically) */
    syncAll: async () => {
      for (const subscription of store.get().subscriptions) {
        if (subscription.enabled && subscription.kind === 'url')
          await service.calendarSync(subscription.id)
      }
      const moodleConnected =
        store.get().settings.moodle.url && (await secrets.get(MOODLE_SECRET).catch(() => null))
      if (moodleConnected) await service.moodleSync().catch(() => undefined)
    },
  }

  // Assign existing events and threads that have no module yet
  rematchEvents()
  rematchMoodleDiscussions()

  return service
}
