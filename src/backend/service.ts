// Alle Backend-Funktionen an einer Stelle. Electron (IPC) und der Web-Server rufen nur diese auf.
import { AI_PROVIDERS, getProvider } from '../shared/ai-providers'
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
import { newId } from '../shared/defaults'
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
import { MoodleClient, connectMoodle, matchCourseToModules, moodleSiteInfo, syncMoodle } from './moodle'
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

  function rematchEvents(): number {
    const db = store.get()
    const modules = db.modules
    const activeSemesterId = db.activeSemesterId ?? db.semesters[0]?.id ?? null
    let updatedCount = 0
    const updatedEvents = db.events.map((event) => {
      if (event.moduleId) return event
      const matched = matchModule(
        event.title,
        event.notes || '',
        [],
        modules,
        activeSemesterId,
      )
      if (matched) {
        updatedCount++
        return { ...event, moduleId: matched.id }
      }
      return event
    })
    if (updatedCount > 0) {
      store.replaceMany('events', () => true, updatedEvents)
    }
    return updatedCount
  }

  function rematchMoodleDiscussions(): number {
    const db = store.get()
    const courseMap = db.settings.moodle?.courseMap ?? {}
    let updatedCount = 0
    const updated = db.moodleDiscussions.map((d) => {
      const expectedModuleId = d.courseId ? courseMap[d.courseId] ?? courseMap[String(d.courseId)] ?? null : null
      if (expectedModuleId && d.moduleId !== expectedModuleId && db.modules.some((m) => m.id === expectedModuleId)) {
        updatedCount++
        return { ...d, moduleId: expectedModuleId }
      }
      if (d.moduleId && !db.modules.some((m) => m.id === d.moduleId)) {
        updatedCount++
        return { ...d, moduleId: null }
      }
      return d
    })
    if (updatedCount > 0) {
      store.update({ moodleDiscussions: updated })
    }
    return updatedCount
  }

  const service = {
    loadDb: () => store.get(),
    put: <C extends CollectionName>(collection: C, record: RecordOf<C>) => {
      const res = store.put(collection, record)
      if (collection === 'modules') {
        rematchEvents()
        rematchMoodleDiscussions()
      }
      return res
    },
    remove: (collection: CollectionName, id: string) => store.remove(collection, id),
    update: (patch: DbPatch) => {
      const res = store.update(patch)
      if (patch.activeSemesterId) {
        rematchEvents()
      }
      if (patch.settings?.moodle?.courseMap) {
        rematchMoodleDiscussions()
      }
      return res
    },

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
        const existing = store.get().events.filter((e) => e.subscriptionId === id)
        const incoming = eventsFromIcs(text, subscription, store.get().modules, {
          existingEvents: existing,
          activeSemesterId: store.get().activeSemesterId,
        })
        const merged = mergeSubscriptionEvents(existing, incoming)
        const release = await reserveSpace(jsonSize(merged))
        store.replaceMany('events', (e) => e.subscriptionId === id, merged)
        release()
        rematchEvents()
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
    calendarImportFile: async (name: string, content: string | Uint8Array | Buffer): Promise<SyncResult> => {
      const text = decodeIcsText(content)
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Das ist keine iCal-Datei (.ics).')

      const cleanName = normalizeIcsFilename(name)
      const cleanLower = cleanName.toLowerCase()
      const rawLower = name.trim().toLowerCase()
      const existingSub = store.get().subscriptions.find(
        (s) =>
          s.kind === 'file' &&
          (s.name.toLowerCase() === cleanLower ||
            s.name.toLowerCase() === rawLower ||
            normalizeIcsFilename(s.name).toLowerCase() === cleanLower),
      )
      const subscription: Subscription = existingSub
        ? { ...existingSub, name: cleanName }
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
      const activeSemesterId = db.activeSemesterId ?? db.semesters[0]?.id ?? null
      const createdModules: Module[] = []
      const existingEvents = store.get().events.filter((e) => e.subscriptionId === subscription.id)

      const events = eventsFromIcs(text, subscription, db.modules, {
        activeSemesterId,
        autoCreateModules: true,
        existingEvents,
        onModuleCreated: (mod) => {
          createdModules.push(mod)
          store.put('modules', mod)
        },
      })

      const release = await reserveSpace(jsonSize(events))
      store.put('subscriptions', { ...subscription, lastSync: new Date().toISOString(), lastError: null })
      store.replaceMany('events', (e) => e.subscriptionId === subscription.id, events)
      release()
      rematchEvents()
      return { count: events.length, error: null, newModules: createdModules.length }
    },
    calendarRematchEvents: rematchEvents,

    // ---- Moodle ----
    moodleSiteInfo: (url: string) => moodleSiteInfo(url, fetchImpl),
    moodleConnect: async (input: MoodleConnectInput): Promise<MoodleCourse[]> => {
      const result = await connectMoodle(input, fetchImpl)
      await writeBound(secrets, 'moodle', result.token, result.site)
      const settings = store.get().settings
      const modules = store.get().modules
      const courseMap: Record<string, string> = { ...(settings.moodle.courseMap ?? {}) }
      for (const course of result.courses) {
        const key = String(course.id)
        if (!courseMap[key] && !courseMap[course.id]) {
          const matched = matchCourseToModules(course, modules)
          if (matched) courseMap[key] = matched.id
        }
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
      // Nach erfolgreicher Verbindung direkt im Hintergrund synchronisieren
      service.moodleSync().catch(() => undefined)
      return result.courses
    },
    moodleCourses: async (): Promise<MoodleCourse[]> => {
      const { userId } = store.get().settings.moodle
      if (userId === null) throw new Error('Moodle ist nicht verbunden.')
      return (await moodleClient()).courses(userId)
    },
    moodleSync: async (): Promise<MoodleSyncResult> => syncMoodle(store, await moodleClient(), reserveSpace),
    moodlePosts: async (discussionId: number): Promise<MoodlePost[]> => {
      const client = await moodleClient()
      const discIdNum = Math.trunc(Number(discussionId))
      if (!discIdNum || isNaN(discIdNum) || discIdNum <= 0) {
        return []
      }
      const disc = store
        .get()
        .moodleDiscussions.find((d) => d.id === discIdNum || d.discussionId === discIdNum || d.firstPostId === discIdNum)
      let posts: MoodlePost[] = []
      try {
        posts = await client.discussionPosts(discIdNum)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('cannotfindrecord') && !msg.includes('Datensatz')) throw err
      }
      if (posts.length === 0 && disc) {
        const candidates = [disc.discussionId, disc.id, disc.firstPostId].filter(
          (cand): cand is number => typeof cand === 'number' && cand > 0 && cand !== discIdNum,
        )
        for (const candidate of candidates) {
          try {
            const candidatePosts = await client.discussionPosts(candidate)
            if (candidatePosts.length > 0) {
              posts = candidatePosts
              break
            }
          } catch {
            // Weiter mit nächstem Kandidaten
          }
        }
      }
      if (posts.length > 0 && disc) {
        const root = posts.find((p) => p.parentId === 0) || posts[0]
        if (root && (!disc.message || !disc.firstPostId || disc.firstPostId === disc.discussionId)) {
          store.update({
            moodleDiscussions: store.get().moodleDiscussions.map((d) =>
              d.id === disc.id
                ? {
                    ...d,
                    message: d.message || root.message,
                    firstPostId: root.id,
                  }
                : d,
            ),
          })
        }
      } else if (posts.length === 0 && disc) {
        // Fallback: Falls Moodle-Server keine Posts liefert (z. B. eingeschränkte Web-Service-Rolle oder Offline),
        // synthetisiere mindestens den bekannten Eröffnungsbeitrag, damit die Ansicht nicht leer bleibt!
        const rootPostId =
          (disc.firstPostId && disc.firstPostId !== disc.discussionId && disc.firstPostId !== disc.id
            ? disc.firstPostId
            : null) ?? (disc.id || disc.discussionId)
        if (disc.message || disc.subject) {
          posts = [
            {
              id: rootPostId,
              discussionId: disc.discussionId || disc.id,
              parentId: 0,
              subject: disc.subject,
              message: disc.message || '<p>Kein weiterer Textinhalt vorhanden.</p>',
              userFullName: disc.userFullName || 'Moodle',
              userPictureUrl: disc.userPictureUrl,
              timeCreated: disc.timeCreated,
              canReply: !disc.isAnnouncement,
            },
          ]
        }
      }
      return posts
    },
    moodleReply: async (postIdOrDiscussionId: number, subject: string, message: string): Promise<{ postId: number }> => {
      const client = await moodleClient()
      const db = store.get()
      const targetNum = Math.trunc(Number(postIdOrDiscussionId))
      if (!targetNum || isNaN(targetNum) || targetNum <= 0) {
        throw new Error('Ungültige Beitrags- oder Diskussions-ID.')
      }

      const disc = db.moodleDiscussions.find(
        (d) =>
          d.id === targetNum ||
          d.discussionId === targetNum ||
          d.firstPostId === targetNum,
      )
      let targetPostId = targetNum

      // Wenn eine Diskussion referenziert wird, versuchen wir vorab die echte Root-Post-ID zu ermitteln
      if (disc) {
        // Fall 1: Wir kennen bereits eine separate firstPostId, die sich von der Diskussions-ID unterscheidet
        if (
          disc.firstPostId &&
          disc.firstPostId !== disc.discussionId &&
          disc.firstPostId !== disc.id
        ) {
          targetPostId = disc.firstPostId
        } else {
          // Fall 2: firstPostId auflösen via discussionPosts
          try {
            const posts = await client.discussionPosts(disc.discussionId || disc.id)
            const root = posts.find((p) => p.parentId === 0) || posts[0]
            if (root && root.id) {
              targetPostId = root.id
              store.update({
                moodleDiscussions: store.get().moodleDiscussions.map((d) =>
                  d.id === disc.id ? { ...d, firstPostId: root.id, message: d.message || root.message } : d,
                ),
              })
            }
          } catch {
            // Ignoriere Netzwerk-/API-Fehler hier
          }

          // Fall 3: Wenn discussionPosts nichts geliefert hat, versuche über mod_forum_get_forum_discussions
          if ((targetPostId === (disc.discussionId || disc.id) || !targetPostId) && disc.forumId) {
            try {
              const forumDiscs = await client.discussions(disc.forumId)
              const matched = forumDiscs.find(
                (fd) =>
                  fd.id === (disc.discussionId || disc.id) ||
                  (fd.discussion && fd.discussion === (disc.discussionId || disc.id)),
              )
              if (matched?.firstpost && matched.firstpost !== (disc.discussionId || disc.id)) {
                targetPostId = matched.firstpost
                store.update({
                  moodleDiscussions: store.get().moodleDiscussions.map((d) =>
                    d.id === disc.id
                      ? { ...d, firstPostId: matched.firstpost, message: d.message || matched.message || '' }
                      : d,
                  ),
                })
              }
            } catch {
              // Ignoriere
            }
          }
        }
      }

      try {
        const res = await client.replyPost(targetPostId, subject, message)
        return { postId: res.postid }
      } catch (err) {
        // Falls Moodle den Parameterwert zurückgewiesen hat: Post-ID über discussionPosts oder Forenliste auflösen und erneut versuchen
        if (disc) {
          try {
            const posts = await client.discussionPosts(disc.discussionId || disc.id)
            const root = posts.find((p) => p.parentId === 0) || posts[0]
            if (root && root.id && root.id !== targetPostId) {
              const retryRes = await client.replyPost(root.id, subject, message)
              store.update({
                moodleDiscussions: store.get().moodleDiscussions.map((d) =>
                  d.id === disc.id ? { ...d, firstPostId: root.id, message: d.message || root.message } : d,
                ),
              })
              return { postId: retryRes.postid }
            }
          } catch {
            // Fallback fehlgeschlagen
          }

          if (disc.forumId) {
            try {
              const forumDiscs = await client.discussions(disc.forumId)
              const matched = forumDiscs.find(
                (fd) =>
                  fd.id === (disc.discussionId || disc.id) ||
                  (fd.discussion && fd.discussion === (disc.discussionId || disc.id)),
              )
              if (matched?.firstpost && matched.firstpost !== targetPostId) {
                const retryRes = await client.replyPost(matched.firstpost, subject, message)
                store.update({
                  moodleDiscussions: store.get().moodleDiscussions.map((d) =>
                    d.id === disc.id ? { ...d, firstPostId: matched.firstpost } : d,
                  ),
                })
                return { postId: retryRes.postid }
              }
            } catch {
              // Fallback fehlgeschlagen
            }
          }
        } else {
          try {
            const resolved = await client.getDiscussionPost(targetPostId)
            if (resolved?.discussion) {
              const posts = await client.discussionPosts(resolved.discussion)
              const root = posts.find((p) => p.parentId === 0) || posts[0]
              if (root && root.id && root.id !== targetPostId) {
                const retryRes = await client.replyPost(root.id, subject, message)
                return { postId: retryRes.postid }
              }
            }
          } catch {
            // Re-throw original error
          }
        }
        throw err
      }
    },
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

  // Bereits vorhandene Termine und Diskussionen ohne Modulzuordnung beim Start automatisch zuordnen
  rematchEvents()
  rematchMoodleDiscussions()

  return service
}
