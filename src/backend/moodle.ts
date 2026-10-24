// Moodle-Anbindung über die offiziellen Web-Services (dieselben, die auch die Moodle-App nutzt).
// Holt Abgaben (als Aufgaben), weitere Termine (Tests, Fristen) und optional Kursdateien.
import type { Module, MoodleCourse, MoodleDiscussion, MoodlePost, MoodleSiteInfo, MoodleSyncResult } from '../shared/types'
import { newFolder, newTask, newId } from '../shared/defaults'
import { classifyEvent } from './ics'
import { markAsDownloaded } from './files'
import { readLimited } from './http'
import type { ReserveSpace } from './service'
import type { Store } from './store'

type Params = Record<string, unknown>

function encodeParams(params: Params, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((entry, i) =>
        entry && typeof entry === 'object'
          ? encodeParams(entry as Params, `${name}[${i}]`, out)
          : out.append(`${name}[${i}]`, String(entry)),
      )
    } else if (value && typeof value === 'object') {
      encodeParams(value as Params, name, out)
    } else if (value !== undefined && value !== null) {
      out.append(name, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    }
  }
  return out
}

/** 'lernen.h-da.de/my/' → 'https://lernen.h-da.de' */
export function normalizeMoodleUrl(input: string): string {
  const withProtocol = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'https:') throw new Error('Moodle muss über https erreichbar sein.')
  const path = url.pathname
    .replace(/\/(login|my|course|user|calendar|admin)(\/.*)?$/, '')
    .replace(/\/$/, '')
  return `${url.origin}${path}`
}

/** Öffentliche Infos einer Moodle-Instanz (ohne Anmeldung): Name, Adresse und Login-Art */
export async function moodleSiteInfo(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MoodleSiteInfo> {
  const site = normalizeMoodleUrl(input)
  const response = await fetchImpl(
    `${site}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }]),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) throw new Error(`Moodle nicht erreichbar (HTTP ${response.status}).`)
  const [result] = (await response.json()) as {
    error: boolean
    data?: {
      sitename: string
      wwwroot: string
      typeoflogin: number
      enablemobilewebservice?: number
    }
  }[]
  if (!result || result.error || !result.data)
    throw new Error('Unter dieser Adresse wurde kein Moodle mit App-Zugang gefunden.')
  if (result.data.enablemobilewebservice === 0)
    throw new Error(
      'Diese Moodle-Instanz erlaubt keinen App-Zugang. Nutze stattdessen den Kalender-Export (iCal).',
    )
  // typeoflogin: 1 = Login-Formular, 2/3 = Hochschul-Login im Browser (SSO)
  return {
    siteName: result.data.sitename,
    url: result.data.wwwroot.replace(/\/$/, ''),
    ssoRequired: result.data.typeoflogin !== 1,
  }
}

interface MoodleSection {
  name: string
  modules: {
    id?: number
    instance?: number
    modname: string
    name: string
    contents?: {
      type: string
      filename: string
      fileurl: string
      filesize: number
      timemodified: number
    }[]
  }[]
}

const MAX_FILE_BYTES = 250 * 1024 * 1024

export class MoodleClient {
  constructor(
    readonly site: string,
    readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Tauscht Benutzername/Passwort gegen einen Token (klappt nicht bei reinem SSO-Login) */
  static async login(
    site: string,
    username: string,
    password: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<string> {
    const response = await fetchImpl(`${site}/login/token.php`, {
      method: 'POST',
      body: new URLSearchParams({ username, password, service: 'moodle_mobile_app' }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await response.json()) as { token?: string; error?: string }
    if (!data.token) {
      throw new Error(
        data.error
          ? `Moodle: ${data.error} – nutzt deine Hochschule SSO, trage stattdessen den Sicherheitsschlüssel ein.`
          : 'Moodle-Anmeldung fehlgeschlagen.',
      )
    }
    return data.token
  }

  async call<T>(wsfunction: string, params: Params = {}): Promise<T> {
    const body = encodeParams({
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: 'json',
      ...params,
    })
    const response = await this.fetchImpl(`${this.site}/webservice/rest/server.php`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Moodle antwortet mit HTTP ${response.status}.`)
    const data = (await response.json()) as T & { exception?: string; message?: string }
    if (data && typeof data === 'object' && 'exception' in data && data.exception) {
      throw new Error(`Moodle: ${data.message ?? data.exception}`)
    }
    return data
  }

  siteInfo(): Promise<{ sitename: string; userid: number; fullname: string }> {
    return this.call('core_webservice_get_site_info')
  }

  async courses(userid: number): Promise<MoodleCourse[]> {
    const list = await this.call<MoodleCourse[]>('core_enrol_get_users_courses', {
      userid,
      returnusercount: false,
    })
    return list.map(({ id, fullname, shortname }) => ({ id, fullname, shortname }))
  }

  assignments(courseids: number[]): Promise<{
    courses: {
      id: number
      assignments: { id: number; name: string; duedate: number; intro?: string }[]
    }[]
  }> {
    return this.call('mod_assign_get_assignments', { courseids })
  }

  /** Alle Kalendertermine der Kurse (Tests, Fristen, Kurstermine) im Zeitraum */
  calendarEvents(
    courseids: number[],
    from: number,
    to: number,
  ): Promise<{
    events: {
      id: number
      name: string
      courseid: number
      modulename: string | null
      timestart: number
      timeduration: number
    }[]
  }> {
    return this.call('core_calendar_get_calendar_events', {
      events: { courseids },
      options: {
        userevents: true,
        siteevents: true,
        timestart: from,
        timeend: to,
        ignorehidden: true,
      },
    })
  }

  contents(courseid: number): Promise<MoodleSection[]> {
    return this.call('core_course_get_contents', { courseid })
  }

  forums(courseids?: number[]): Promise<{
    id: number
    course: number
    type: string
    name: string
    intro?: string
    numdiscussions?: number
  }[]> {
    return this.call('mod_forum_get_forums_by_courses', courseids && courseids.length > 0 ? { courseids } : {})
  }

  async discussions(forumid: number): Promise<{
    id: number
    discussion?: number
    firstpost?: number
    name: string
    forumid?: number
    course?: number
    subject?: string
    message?: string
    userfullname?: string
    firstpostfullname?: string
    firstuserfullname?: string
    userpictureurl?: string
    firstpostuserimageurl?: string
    firstuserimageurl?: string
    created: number
    timecreated?: number
    modified?: number
    timemodified?: number
    numreplies?: number
    pinned?: boolean
  }[]> {
    // 1. Versuche mod_forum_get_forum_discussions mit { forumid, forumids: [forumid] }
    try {
      const res = await this.call<any>('mod_forum_get_forum_discussions', { forumid, forumids: [forumid] })
      const list = Array.isArray(res) ? res : Array.isArray(res?.discussions) ? res.discussions : null
      if (list && list.length > 0) return list
    } catch {
      // Weiter mit nächstem Versuch
    }

    // 1b. Versuche mod_forum_get_forum_discussions mit nur { forumid }
    try {
      const res = await this.call<any>('mod_forum_get_forum_discussions', { forumid })
      const list = Array.isArray(res) ? res : Array.isArray(res?.discussions) ? res.discussions : null
      if (list && list.length > 0) return list
    } catch {
      // Weiter mit paginated
    }

    // 2. Versuche mod_forum_get_forum_discussions_paginated mit Sortierung
    try {
      const res = await this.call<any>('mod_forum_get_forum_discussions_paginated', {
        forumid,
        page: 0,
        perpage: 50,
        sortby: 'timemodified',
        sortdirection: 'DESC',
      })
      const list = Array.isArray(res) ? res : Array.isArray(res?.discussions) ? res.discussions : null
      if (list && list.length > 0) return list
    } catch {
      // Weiter mit paginated ohne Sortierparameter
    }

    // 3. Versuche mod_forum_get_forum_discussions_paginated ohne Sortierung
    try {
      const res = await this.call<any>('mod_forum_get_forum_discussions_paginated', {
        forumid,
        page: 0,
        perpage: 50,
      })
      const list = Array.isArray(res) ? res : Array.isArray(res?.discussions) ? res.discussions : null
      if (list && list.length > 0) return list
    } catch {
      // Keine Beiträge oder nicht unterstützt
    }

    return []
  }

  async getDiscussionPost(postid: number): Promise<{ id: number; discussion: number } | null> {
    try {
      const res = await this.call<{
        post?: { id: number; discussion: number }
      }>('mod_forum_get_discussion_post', { postid })
      if (res?.post?.discussion) {
        return { id: res.post.id, discussion: res.post.discussion }
      }
    } catch {
      // Ignoriere, falls nicht unterstützt
    }
    return null
  }

  async discussionPosts(discussionid: number): Promise<MoodlePost[]> {
    const discIdNum = Math.trunc(Number(discussionid))
    try {
      const res = await this.call<{
        posts?: {
          id: number
          discussion?: number
          discussionid?: number
          parent?: number
          parentid?: number
          subject?: string
          message?: string
          author?: { fullname?: string; urls?: { profileimage?: string } }
          userfullname?: string
          userpictureurl?: string
          created?: number
          timecreated?: number
          capabilities?: { reply?: boolean }
          canreply?: boolean
        }[]
      }>('mod_forum_get_discussion_posts', {
        discussionid: discIdNum,
      })
      if (res && Array.isArray(res.posts) && res.posts.length > 0) {
        const mapped = res.posts.map((p) => ({
          id: p.id,
          discussionId: p.discussion ?? p.discussionid ?? discIdNum,
          parentId: p.parent ?? p.parentid ?? 0,
          subject: p.subject || '',
          message: p.message || '',
          userFullName: p.author?.fullname ?? p.userfullname ?? 'Moodle-Nutzer',
          userPictureUrl: p.author?.urls?.profileimage ?? p.userpictureurl,
          timeCreated: toIso(p.created ?? p.timecreated ?? Math.floor(Date.now() / 1000)),
          canReply: p.capabilities?.reply ?? p.canreply,
        }))
        // Chronologisch sortieren: der älteste Beitrag (Root-Post) steht immer an Index 0
        mapped.sort((a, b) => a.id - b.id || a.timeCreated.localeCompare(b.timeCreated))
        return mapped
      }
    } catch {
      // Fallback zu mod_forum_get_forum_discussion_posts
    }

    try {
      const legacyRes = await this.call<{
        posts?: {
          id: number
          discussionid?: number
          discussion?: number
          parentid?: number
          parent?: number
          subject?: string
          message?: string
          userfullname?: string
          userpictureurl?: string
          timecreated?: number
          created?: number
          canreply?: boolean
        }[]
      }>('mod_forum_get_forum_discussion_posts', {
        discussionid: discIdNum,
      })
      if (legacyRes && Array.isArray(legacyRes.posts) && legacyRes.posts.length > 0) {
        const mapped = legacyRes.posts.map((p) => ({
          id: p.id,
          discussionId: p.discussionid ?? p.discussion ?? discIdNum,
          parentId: p.parentid ?? p.parent ?? 0,
          subject: p.subject || '',
          message: p.message || '',
          userFullName: p.userfullname || 'Moodle-Nutzer',
          userPictureUrl: p.userpictureurl,
          timeCreated: toIso(p.timecreated ?? p.created ?? Math.floor(Date.now() / 1000)),
          canReply: p.canreply,
        }))
        mapped.sort((a, b) => a.id - b.id || a.timeCreated.localeCompare(b.timeCreated))
        return mapped
      }
    } catch {
      // Weiter mit Post-ID Auflösung
    }

    try {
      const resolved = await this.getDiscussionPost(discIdNum)
      if (resolved && resolved.discussion && resolved.discussion !== discIdNum) {
        return await this.discussionPosts(resolved.discussion)
      }
    } catch {
      // Ignorieren
    }

    return []
  }

  async replyPost(postid: number, subject: string, message: string): Promise<{ postid: number }> {
    const id = Math.trunc(Number(postid))
    if (!id || isNaN(id) || id <= 0) throw new Error('Ungültige Post-ID.')
    if (!message || !message.trim()) throw new Error('Nachricht darf nicht leer sein.')
    return this.call<{ postid: number }>('mod_forum_add_discussion_post', {
      postid: id,
      subject: subject?.trim() || 'Re:',
      message: message.trim(),
      messageformat: 1,
    })
  }

  async download(fileurl: string): Promise<Uint8Array> {
    const url = new URL(fileurl)
    if (url.origin !== new URL(this.site).origin)
      throw new Error('Datei liegt nicht auf dem Moodle-Server.')
    url.searchParams.set('token', this.token)
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Download fehlgeschlagen (HTTP ${response.status}).`)
    return readLimited(response, MAX_FILE_BYTES, 'Die Datei')
  }
}

export async function connectMoodle(
  input: { url: string; username?: string; password?: string; token?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  site: string
  token: string
  siteName: string
  userId: number
  courses: MoodleCourse[]
}> {
  const site = normalizeMoodleUrl(input.url)
  const token =
    input.token?.trim() ||
    (input.username && input.password
      ? await MoodleClient.login(site, input.username, input.password, fetchImpl)
      : '')
  if (!token)
    throw new Error('Bitte Benutzername und Passwort oder einen Sicherheitsschlüssel angeben.')
  const client = new MoodleClient(site, token, fetchImpl)
  const info = await client.siteInfo()
  const courses = await client.courses(info.userid)
  return { site, token, siteName: info.sitename, userId: info.userid, courses }
}

const toIso = (unix: number): string => new Date(unix * 1000).toISOString()

export function matchCourseToModules(
  course: { id: number; fullname: string; shortname?: string },
  modules: Module[],
): Module | null {
  if (modules.length === 0) return null
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(?:ws|wise|sose|ss)\s*\d{2}(?:\/\d{2})?\b/gi, '')
      .replace(/\b(?:vorlesung|übung|uebung|praktikum|integrierte veranstaltung|vl|ue|pr|iv)\b/gi, '')
      .replace(/[^a-z0-9äöüß]+/gi, ' ')
      .trim()

  const cFullNorm = clean(course.fullname)
  const cShortNorm = clean(course.shortname || '')

  // 1. Exakter Match nach Modul-Code
  for (const m of modules) {
    if (m.code && m.code.trim().length >= 2) {
      const codeClean = clean(m.code)
      if (
        (codeClean && cShortNorm === codeClean) ||
        (codeClean && cFullNorm.includes(codeClean)) ||
        (course.shortname && course.shortname.toLowerCase().includes(m.code.trim().toLowerCase()))
      ) {
        return m
      }
    }
  }

  // 2. Exakter Match nach Modul-Name
  for (const m of modules) {
    const mNameClean = clean(m.name)
    if (mNameClean && (cFullNorm === mNameClean || cShortNorm === mNameClean)) {
      return m
    }
  }

  // 3. Substring-Match: Modulname ist signifikant im Kursnamen enthalten (oder umgekehrt)
  let bestMatch: Module | null = null
  let bestMatchLength = 0

  for (const m of modules) {
    const mNameClean = clean(m.name)
    if (mNameClean.length >= 4) {
      if (cFullNorm.includes(mNameClean) || (cShortNorm && cShortNorm.includes(mNameClean))) {
        if (mNameClean.length > bestMatchLength) {
          bestMatch = m
          bestMatchLength = mNameClean.length
        }
      } else if (mNameClean.length >= 6 && cFullNorm.length >= 6 && mNameClean.includes(cFullNorm)) {
        if (cFullNorm.length > bestMatchLength) {
          bestMatch = m
          bestMatchLength = cFullNorm.length
        }
      }
    }
  }

  return bestMatch
}

/** Holt Abgaben, Termine und (optional) Dateien der zugeordneten Kurse */
export async function syncMoodle(
  store: Store,
  client: MoodleClient,
  reserveSpace: ReserveSpace = async () => () => undefined,
): Promise<MoodleSyncResult> {
  const result: MoodleSyncResult = { tasks: 0, events: 0, files: 0, errors: [] }
  const db = store.get()
  const courseMap: Record<string, string> = { ...(db.settings.moodle.courseMap ?? {}) }

  // Automatische Kurszuordnung: Falls Kurse noch nicht zugeordnet sind, versuche sie anhand des Modulnamens oder -codes zuzuordnen
  if (db.settings.moodle.userId) {
    try {
      const userCourses = await client.courses(db.settings.moodle.userId)
      let courseMapUpdated = false
      for (const course of userCourses) {
        const key = String(course.id)
        if (!courseMap[key] && !courseMap[course.id]) {
          const matched = matchCourseToModules(course, db.modules)
          if (matched) {
            courseMap[key] = matched.id
            courseMapUpdated = true
          }
        }
      }
      if (courseMapUpdated) {
        store.update({
          settings: {
            ...db.settings,
            moodle: {
              ...db.settings.moodle,
              courseMap,
            },
          },
        })
      }
    } catch {
      // Ignoriere Netzwerk-/Berechtigungsfehler beim Laden der Kursliste
    }
  }

  const moduleFor = (courseId: number | string | undefined): string | null => {
    if (courseId === undefined || courseId === null) return null
    const targetModId = courseMap[courseId] ?? courseMap[String(courseId)]
    return targetModId && db.modules.some((m) => m.id === targetModId) ? targetModId : null
  }

  const courseIds = Object.keys(courseMap)
    .map(Number)
    .filter((id) => !isNaN(id) && Boolean(moduleFor(id)))

  if (courseIds.length === 0) {
    result.errors.push('Noch keine Moodle-Kurse einem Modul zugeordnet.')
    return result
  }

  // Abgaben → Aufgaben (Erledigt-Status bleibt erhalten)
  try {
    const { courses } = await client.assignments(courseIds)
    for (const course of courses) {
      for (const a of course.assignments) {
        const externalId = `moodle:assign:${a.id}`
        const existing = db.tasks.find((t) => t.externalId === externalId)
        const due = a.duedate ? toIso(a.duedate) : null
        store.put(
          'tasks',
          existing
            ? { ...existing, title: a.name, due }
            : newTask({
                title: a.name,
                due,
                moduleId: moduleFor(course.id),
                kind: 'assignment',
                source: 'moodle',
                externalId,
              }),
        )
        result.tasks += 1
      }
    }
  } catch (error) {
    result.errors.push(`Abgaben: ${(error as Error).message}`)
  }

  // Weitere Termine (Tests, Foren, Kurstermine) → Kalender. Abgaben kommen schon als Aufgaben.
  try {
    const now = Math.floor(Date.now() / 1000)
    const { events } = await client.calendarEvents(courseIds, now - 30 * 86_400, now + 365 * 86_400)
    const existingMoodleEvents = db.events.filter((e) => Boolean(e.externalId?.startsWith('moodle:event:')))
    const records = events
      .filter((e) => e.modulename !== 'assign')
      .map((e) => {
        const externalId = `moodle:event:${e.id}`
        const exact = existingMoodleEvents.find((ex) => ex.externalId === externalId)
        const kind = classifyEvent(e.name)

        let targetModuleId =
          exact?.moduleId && db.modules.some((m) => m.id === exact.moduleId)
            ? exact.moduleId
            : moduleFor(e.courseid)

        // Prüfe, ob die Serie dieses Termins bereits manuell einem Modul zugewiesen wurde
        if (!exact && existingMoodleEvents.length > 0) {
          const eTitleNorm = e.name.trim().toLowerCase()
          const seriesMatch = existingMoodleEvents.find((ex) => {
            if (!ex.moduleId || !db.modules.some((m) => m.id === ex.moduleId)) return false
            return ex.title.trim().toLowerCase() === eTitleNorm
          })
          if (seriesMatch?.moduleId) {
            targetModuleId = seriesMatch.moduleId
          }
        }

        return {
          id: exact?.id ?? newId(),
          title: e.name,
          kind: exact?.kind ?? (kind === 'other' && !e.timeduration ? 'deadline' : kind),
          start: toIso(e.timestart),
          end: toIso(e.timestart + (e.timeduration || 0)),
          allDay: false,
          moduleId: targetModuleId,
          location: exact?.location ?? '',
          notes: exact?.notes ?? '',
          subscriptionId: null,
          externalId,
        }
      })
    store.replaceMany('events', (e) => Boolean(e.externalId?.startsWith('moodle:event:')), records)
    result.events = records.length
  } catch (error) {
    result.errors.push(`Termine: ${(error as Error).message}`)
  }

  if (db.settings.moodle.syncFiles) {
    for (const courseId of courseIds) {
      try {
        result.files += await syncCourseFiles(store, client, courseId, moduleFor(courseId)!, reserveSpace)
      } catch (error) {
        result.errors.push(`Dateien: ${(error as Error).message}`)
      }
    }
  }

  // Foren & Ankündigungen
  try {
    interface DiscoveredForum {
      id: number
      cmid?: number
      course: number
      type: string
      name: string
    }
    const forums: DiscoveredForum[] = []

    const addForum = (id: unknown, course: unknown, type?: string, name?: string, cmid?: unknown) => {
      const numId = Number(id)
      const numCourse = Number(course)
      const numCmid = cmid !== undefined && cmid !== null ? Number(cmid) : undefined
      if (!numId || isNaN(numId)) return
      if (!forums.some((ex) => ex.id === numId)) {
        forums.push({
          id: numId,
          cmid: numCmid && !isNaN(numCmid) ? numCmid : undefined,
          course: numCourse && !isNaN(numCourse) ? numCourse : 0,
          type: type || 'general',
          name: name || 'Forum',
        })
      }
    }

    // 1. Versuch: mod_forum_get_forums_by_courses für alle Kurse im Sammelaufruf
    try {
      const raw = await client.forums(courseIds)
      const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.forums) ? (raw as any).forums : []
      for (const f of list) {
        addForum(f?.id, f?.course, f?.type, f?.name, (f as any)?.cmid)
      }
    } catch {
      // Sammelaufruf mit Kursliste fehlgeschlagen
    }

    // 1b. Versuch: Falls noch keine Foren gefunden wurden, versuche Sammelaufruf ohne Kursfilter
    if (forums.length === 0) {
      try {
        const rawAll = await client.forums()
        const list = Array.isArray(rawAll) ? rawAll : Array.isArray((rawAll as any)?.forums) ? (rawAll as any).forums : []
        for (const f of list) {
          const cid = Number(f?.course)
          if (courseIds.includes(cid)) {
            addForum(f?.id, f?.course, f?.type, f?.name, (f as any)?.cmid)
          }
        }
      } catch {
        // Sammelaufruf ohne Filter fehlgeschlagen
      }
    }

    // 2. Versuch: Für nicht abgedeckte Kurse einzeln aufrufen
    const coveredCourses = new Set(forums.map((f) => f.course))
    for (const courseId of courseIds) {
      if (!coveredCourses.has(courseId)) {
        try {
          const raw = await client.forums([courseId])
          const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.forums) ? (raw as any).forums : []
          if (list.length > 0) {
            for (const f of list) {
              addForum(f?.id, f?.course ?? courseId, f?.type, f?.name, (f as any)?.cmid)
            }
            coveredCourses.add(courseId)
          }
        } catch {
          // Einzelforenaufruf für diesen Kurs fehlgeschlagen
        }
      }

      // 3. Fallback: core_course_get_contents für diesen Kurs auslesen (Standard in Moodle)
      if (!coveredCourses.has(courseId)) {
        try {
          const sections = await client.contents(courseId)
          for (const section of sections ?? []) {
            for (const mod of section.modules ?? []) {
              if (mod.modname === 'forum') {
                const forumId = mod.instance ?? mod.id
                if (forumId) {
                  const isNews = /ankündigung|nachricht|news|announcement/i.test(mod.name)
                  addForum(forumId, courseId, isNews ? 'news' : 'general', mod.name, mod.id)
                  coveredCourses.add(courseId)
                }
              }
            }
          }
        } catch {
          // Ignoriere Fehler beim Laden der Kursinhalte
        }
      }
    }

    const allDiscussions: MoodleDiscussion[] = []
    const existingDiscussions = db.moodleDiscussions ?? []

    for (const forum of forums) {
      try {
        let discussionsRaw = await client.discussions(forum.id).catch(() => [])
        let discussions = Array.isArray(discussionsRaw) ? discussionsRaw : []
        if (discussions.length === 0 && forum.cmid && forum.cmid !== forum.id) {
          const fallbackRaw = await client.discussions(forum.cmid).catch(() => [])
          if (Array.isArray(fallbackRaw) && fallbackRaw.length > 0) {
            discussions = fallbackRaw
          }
        }
        const isNews = forum.type === 'news' || /ankündigung|nachricht|news|announcement/i.test(forum.name)

        for (const d of discussions) {
          const discId = Number(d.discussion ?? d.id)
          const rootPostId = Number(d.firstpost ?? (d.discussion && d.discussion !== d.id ? d.id : discId))
          const existingDisc = existingDiscussions.find((ex) => ex.id === discId || ex.discussionId === discId)
          const effectiveCourseId = forum.course || Number((d as any).course)
          const effectiveModuleId = moduleFor(effectiveCourseId)

          const author =
            d.userfullname ||
            (d as any).firstpostfullname ||
            (d as any).firstuserfullname ||
            (d as any).author?.fullname ||
            (typeof (d as any).author === 'string' ? (d as any).author : '') ||
            existingDisc?.userFullName ||
            'Moodle'
          const picture =
            d.userpictureurl ||
            (d as any).firstpostuserimageurl ||
            (d as any).firstuserimageurl ||
            (d as any).author?.urls?.profileimage ||
            existingDisc?.userPictureUrl

          const createdUnix = Number(
            d.created ||
              (d as any).timecreated ||
              (d as any).timestart ||
              d.timemodified ||
              (d as any).modified ||
              Math.floor(Date.now() / 1000),
          )
          const modifiedUnix = Number(
            d.timemodified ||
              d.modified ||
              (d as any).timecreated ||
              d.created ||
              createdUnix,
          )

          allDiscussions.push({
            id: discId,
            discussionId: discId,
            firstPostId: rootPostId,
            forumId: forum.id,
            courseId: effectiveCourseId,
            moduleId: effectiveModuleId,
            forumName: forum.name,
            subject: d.name || d.subject || '(Ohne Betreff)',
            message: d.message || existingDisc?.message || '',
            userFullName: author,
            userPictureUrl: picture,
            timeCreated: toIso(createdUnix),
            timeModified: toIso(modifiedUnix),
            numReplies: d.numreplies ?? (d as any).numreplies ?? 0,
            pinned: Boolean(d.pinned),
            isAnnouncement: isNews,
          })
        }
      } catch {
        // Ignoriere Fehler einzelner Foren
      }
    }

    // Bis zu 5 neueste Ankündigungen ohne Text direkt mit Erstbeitrag anreichern
    const announcementsNeedingBody = allDiscussions.filter((d) => !d.message && d.isAnnouncement).slice(0, 5)
    for (const ann of announcementsNeedingBody) {
      try {
        const posts = await client.discussionPosts(ann.discussionId)
        const root = posts.find((p) => p.parentId === 0 || p.id === ann.firstPostId) ?? posts[0]
        if (root?.message) {
          ann.message = root.message
          if (root.id) ann.firstPostId = root.id
        }
      } catch {
        // Kein Fehler, wird bei Bedarf in der UI nachgeladen
      }
    }

    const updatedDiscIds = new Set(allDiscussions.map((d) => d.id))
    const otherDiscussions = existingDiscussions.filter(
      (d) =>
        !updatedDiscIds.has(d.id) &&
        !courseIds.some((cid) => String(cid) === String(d.courseId)),
    )
    const mergedDiscussions = [...otherDiscussions, ...allDiscussions].sort(
      (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timeCreated.localeCompare(a.timeCreated),
    )
    store.update({ moodleDiscussions: mergedDiscussions })
    if (mergedDiscussions.length > 0) {
      result.discussions = mergedDiscussions.length
    }
  } catch (err) {
    result.errors.push(`Foren: ${(err as Error).message}`)
  }

  store.update({
    settings: {
      ...db.settings,
      moodle: { ...db.settings.moodle, lastSync: new Date().toISOString() },
    },
  })
  return result
}

async function syncCourseFiles(
  store: Store,
  client: MoodleClient,
  courseId: number,
  moduleId: string,
  reserveSpace: ReserveSpace,
): Promise<number> {
  const db = store.get()
  const folderNamed = (name: string, parentId: string | null): string => {
    const found = db.folders.find(
      (f) => f.moduleId === moduleId && f.parentId === parentId && f.name === name,
    )
    if (found) return found.id
    const folder = newFolder(moduleId, { name, parentId })
    store.put('folders', folder)
    return folder.id
  }

  let count = 0
  const rootId = folderNamed('Moodle', null)
  for (const section of await client.contents(courseId)) {
    for (const mod of section.modules) {
      if (mod.modname !== 'resource' && mod.modname !== 'folder') continue
      for (const file of mod.contents ?? []) {
        if (file.type !== 'file' || file.filesize > MAX_FILE_BYTES) continue
        const externalId = `moodle:file:${file.fileurl}@${file.timemodified}`
        if (db.items.some((i) => i.externalId === externalId)) continue
        // Erst die neue Version laden, dann die alte ersetzen (ein Fehler lässt die alte Datei stehen)
        const bytes = await client.download(file.fileurl)
        const release = await reserveSpace(bytes.length)
        const folderId = folderNamed(section.name || 'Allgemein', rootId)
        const item = await store.addFile({ moduleId, folderId }, { name: file.filename, type: '', bytes }).finally(release)
        store.put('items', { ...item, source: 'moodle', externalId })
        await markAsDownloaded(store.filePath(item.fileName!))
        const outdated = db.items.find((i) => i.id !== item.id && i.externalId?.startsWith(`moodle:file:${file.fileurl}@`))
        if (outdated) await store.remove('items', outdated.id)
        count += 1
      }
    }
  }
  return count
}
