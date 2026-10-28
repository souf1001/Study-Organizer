// Moodle integration via the official web services (the same ones the Moodle mobile app uses).
// Fetches assignments (as tasks), other calendar events (quizzes, deadlines), forums and optionally course files.
import type {
  MoodleCourse,
  MoodleDiscussion,
  MoodlePost,
  MoodleSiteInfo,
  MoodleSyncResult,
} from '../shared/types'
import { newFolder, newTask, newId } from '../shared/defaults'
import { classifyEvent } from './ics'
import { readLimited } from './http'
import type { ReserveSpace } from './service'
import type { DataStore } from './data-store'
import { matchCourseToModules } from '../shared/course-matching'

export { matchCourseToModules }

type Params = Record<string, unknown>

const ANNOUNCEMENT_PATTERN = /ankündigung|nachricht|news|announcement/i

const toIso = (unix: number): string => new Date(unix * 1000).toISOString()
const nowUnix = (): number => Math.floor(Date.now() / 1000)

/** Truncates an id-like value to a positive integer, or returns null if that is not possible. */
function toPositiveId(value: unknown): number | null {
  const id = Math.trunc(Number(value))
  return id > 0 ? id : null
}

/** Moodle web services return lists either directly or wrapped in an object under `key`. */
function unwrapList<T>(response: unknown, key: string): T[] | null {
  if (Array.isArray(response)) return response as T[]
  if (response && typeof response === 'object') {
    const wrapped = (response as Record<string, unknown>)[key]
    if (Array.isArray(wrapped)) return wrapped as T[]
  }
  return null
}

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

/** Public info about a Moodle instance (no login required): name, address and login type */
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
  // typeoflogin: 1 = login form, 2/3 = university login in the browser (SSO)
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

export interface MoodleRawDiscussion {
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
}

/** Superset of the post fields returned by the current and the legacy post endpoints */
interface MoodleRawPost {
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
}

/** Oldest post (the root post) first */
function sortPostsChronologically(posts: MoodlePost[]): MoodlePost[] {
  return posts.sort((a, b) => a.id - b.id || a.timeCreated.localeCompare(b.timeCreated))
}

const MAX_FILE_BYTES = 250 * 1024 * 1024

export class MoodleClient {
  constructor(
    readonly site: string,
    readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Exchanges username/password for a token (does not work for SSO-only logins) */
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
    const data = (await response.json()) as T & {
      exception?: string
      message?: string
      errorcode?: string
      error?: string
    }
    if (data && typeof data === 'object' && (data.exception || data.errorcode || data.error)) {
      throw new Error(
        `Moodle: ${String(data.message || data.error || data.exception || data.errorcode)}`,
      )
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

  /** All calendar events of the courses (quizzes, deadlines, course events) within the time range */
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

  forums(courseids?: number[]): Promise<
    {
      id: number
      course: number
      type: string
      name: string
      intro?: string
      numdiscussions?: number
    }[]
  > {
    return this.call(
      'mod_forum_get_forums_by_courses',
      courseids && courseids.length > 0 ? { courseids } : {},
    )
  }

  async discussions(forumid: number): Promise<MoodleRawDiscussion[]> {
    const forumId = toPositiveId(forumid)
    if (!forumId) return []

    // Moodle versions differ in which endpoint/parameters they accept, so try them in turn:
    // the documented `forumids` array, a plain `forumid`, and finally the paginated endpoint.
    const attempts: [wsfunction: string, params: Params][] = [
      ['mod_forum_get_forum_discussions', { forumids: [forumId] }],
      ['mod_forum_get_forum_discussions', { forumid: forumId }],
      ['mod_forum_get_forum_discussions_paginated', { forumid: forumId, page: 0, perpage: 50 }],
    ]
    for (const [wsfunction, params] of attempts) {
      try {
        const list = unwrapList<MoodleRawDiscussion>(
          await this.call<unknown>(wsfunction, params),
          'discussions',
        )
        if (list && list.length > 0) return list
      } catch {
        // Not supported by this Moodle version; try the next variant
      }
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
      // Not supported by this Moodle version
    }
    return null
  }

  async discussionPosts(discussionid: number): Promise<MoodlePost[]> {
    const discussionId = toPositiveId(discussionid)
    if (!discussionId) return []
    try {
      const res = await this.call<{ posts?: MoodleRawPost[] }>('mod_forum_get_discussion_posts', {
        discussionid: discussionId,
      })
      if (res && Array.isArray(res.posts) && res.posts.length > 0) {
        return sortPostsChronologically(
          res.posts.map((p) => ({
            id: p.id,
            discussionId: p.discussion ?? p.discussionid ?? discussionId,
            parentId: p.parent ?? p.parentid ?? 0,
            subject: p.subject || '',
            message: p.message || '',
            userFullName: p.author?.fullname ?? p.userfullname ?? 'Moodle-Nutzer',
            userPictureUrl: p.author?.urls?.profileimage ?? p.userpictureurl,
            timeCreated: toIso(p.created ?? p.timecreated ?? nowUnix()),
            canReply: p.capabilities?.reply ?? p.canreply,
          })),
        )
      }
    } catch {
      // Fall back to the legacy endpoint below
    }

    try {
      const legacyRes = await this.call<{ posts?: MoodleRawPost[] }>(
        'mod_forum_get_forum_discussion_posts',
        {
          discussionid: discussionId,
        },
      )
      if (legacyRes && Array.isArray(legacyRes.posts) && legacyRes.posts.length > 0) {
        return sortPostsChronologically(
          legacyRes.posts.map((p) => ({
            id: p.id,
            discussionId: p.discussionid ?? p.discussion ?? discussionId,
            parentId: p.parentid ?? p.parent ?? 0,
            subject: p.subject || '',
            message: p.message || '',
            userFullName: p.author?.fullname ?? p.userfullname ?? 'Moodle-Nutzer',
            userPictureUrl: p.author?.urls?.profileimage ?? p.userpictureurl,
            timeCreated: toIso(p.timecreated ?? p.created ?? nowUnix()),
            canReply: p.canreply,
          })),
        )
      }
    } catch {
      // Fall through to resolving the id as a post id
    }

    // The id may actually be a post id: resolve its discussion and retry with that
    try {
      const resolved = await this.getDiscussionPost(discussionId)
      if (resolved?.discussion && resolved.discussion !== discussionId) {
        return await this.discussionPosts(resolved.discussion)
      }
    } catch {
      // Ignore
    }

    return []
  }

  async replyPost(postid: number, subject: string, message: string): Promise<{ postid: number }> {
    const id = toPositiveId(postid)
    if (!id) throw new Error('Ungültige Post-ID.')
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

/** Fetches assignments, events, forums and (optionally) files of the mapped courses */
export async function syncMoodle(
  store: DataStore,
  client: MoodleClient,
  reserveSpace: ReserveSpace = async () => () => undefined,
): Promise<MoodleSyncResult> {
  const result: MoodleSyncResult = { tasks: 0, events: 0, files: 0, errors: [] }
  const db = store.get()
  const courseMap: Record<string, string> = { ...(db.settings.moodle.courseMap ?? {}) }

  // Auto-map courses that are not mapped yet, based on module name or code
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
        const { settings } = store.get()
        const mergedCourseMap = { ...courseMap, ...settings.moodle.courseMap }
        store.update({
          settings: { ...settings, moodle: { ...settings.moodle, courseMap: mergedCourseMap } },
        })
      }
    } catch {
      // Network/permission errors while loading the course list are not fatal
    }
  }

  const moduleFor = (courseId: number | string | undefined): string | null => {
    if (courseId === undefined || courseId === null) return null
    const moduleId = courseMap[courseId] ?? courseMap[String(courseId)]
    return moduleId && db.modules.some((m) => m.id === moduleId) ? moduleId : null
  }

  const courseIds = Object.keys(courseMap)
    .map(Number)
    .filter((id) => !isNaN(id) && Boolean(moduleFor(id)))

  if (courseIds.length === 0) {
    result.errors.push('Noch keine Moodle-Kurse einem Modul zugeordnet.')
    return result
  }

  // Assignments become tasks (an existing task keeps its done state)
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

  // Other events (quizzes, forums, course events) go to the calendar; assignments are already tasks
  try {
    const now = Math.floor(Date.now() / 1000)
    const { events } = await client.calendarEvents(courseIds, now - 30 * 86_400, now + 365 * 86_400)
    const existingMoodleEvents = db.events.filter((e) =>
      Boolean(e.externalId?.startsWith('moodle:event:')),
    )
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

        // Keep a module the user already assigned manually to another event of the same series
        if (!exact && existingMoodleEvents.length > 0) {
          const normalizedTitle = e.name.trim().toLowerCase()
          const seriesMatch = existingMoodleEvents.find(
            (ex) =>
              Boolean(ex.moduleId && db.modules.some((m) => m.id === ex.moduleId)) &&
              ex.title.trim().toLowerCase() === normalizedTitle,
          )
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
        result.files += await syncCourseFiles(
          store,
          client,
          courseId,
          moduleFor(courseId)!,
          reserveSpace,
        )
      } catch (error) {
        result.errors.push(`Dateien: ${(error as Error).message}`)
      }
    }
  }

  // Forums & announcements
  try {
    interface DiscoveredForum {
      id: number
      cmid?: number
      course: number
      type: string
      name: string
    }
    type RawForum = Awaited<ReturnType<MoodleClient['forums']>>[number] & { cmid?: number }
    const forums: DiscoveredForum[] = []

    const addForum = (
      id: unknown,
      course: unknown,
      type?: string,
      name?: string,
      cmid?: unknown,
    ) => {
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
    const addRawForum = (f: RawForum | null | undefined, fallbackCourse?: number) =>
      addForum(f?.id, f?.course ?? fallbackCourse, f?.type, f?.name, f?.cmid)
    const forumList = (response: unknown) =>
      unwrapList<RawForum | null | undefined>(response, 'forums') ?? []

    // 1. One bulk call for all mapped courses
    try {
      for (const f of forumList(await client.forums(courseIds))) addRawForum(f)
    } catch {
      // Bulk call with course filter failed
    }

    // 1b. If nothing was found, try the bulk call without a course filter
    if (forums.length === 0) {
      try {
        for (const f of forumList(await client.forums())) {
          if (courseIds.includes(Number(f?.course))) addRawForum(f)
        }
      } catch {
        // Unfiltered bulk call failed
      }
    }

    const coveredCourses = new Set(forums.map((f) => f.course))
    for (const courseId of courseIds) {
      // 2. Query courses not covered yet one by one
      if (!coveredCourses.has(courseId)) {
        try {
          const list = forumList(await client.forums([courseId]))
          if (list.length > 0) {
            for (const f of list) addRawForum(f, courseId)
            coveredCourses.add(courseId)
          }
        } catch {
          // Per-course forum call failed
        }
      }

      // 3. Fallback: read the forums from the course contents (available on every Moodle)
      if (!coveredCourses.has(courseId)) {
        try {
          const sections = await client.contents(courseId)
          for (const section of sections ?? []) {
            for (const mod of section.modules ?? []) {
              if (mod.modname !== 'forum') continue
              const forumId = mod.instance ?? mod.id
              if (forumId) {
                addForum(
                  forumId,
                  courseId,
                  ANNOUNCEMENT_PATTERN.test(mod.name) ? 'news' : 'general',
                  mod.name,
                  mod.id,
                )
                coveredCourses.add(courseId)
              }
            }
          }
        } catch {
          // Course contents unavailable
        }
      }
    }

    const allDiscussions: MoodleDiscussion[] = []
    const existingDiscussions = db.moodleDiscussions ?? []

    /** Some Moodle versions return extra or differently named fields */
    type LooseDiscussion = MoodleRawDiscussion & {
      author?: string | { fullname?: string; urls?: { profileimage?: string } } | null
      timestart?: number
    }

    for (const forum of forums) {
      try {
        const discussionsRaw = await client.discussions(forum.id).catch(() => [])
        let discussions: LooseDiscussion[] = Array.isArray(discussionsRaw) ? discussionsRaw : []
        // Some sites only accept the course-module id instead of the forum instance id
        if (discussions.length === 0 && forum.cmid && forum.cmid !== forum.id) {
          const fallbackRaw = await client.discussions(forum.cmid).catch(() => [])
          if (Array.isArray(fallbackRaw) && fallbackRaw.length > 0) {
            discussions = fallbackRaw
          }
        }
        const isNews = forum.type === 'news' || ANNOUNCEMENT_PATTERN.test(forum.name)

        for (const d of discussions) {
          const discId = Number(d.discussion ?? d.id)
          const rootPostId = Number(
            d.firstpost ?? (d.discussion && d.discussion !== d.id ? d.id : discId),
          )
          const existingDisc = existingDiscussions.find(
            (ex) => ex.id === discId || ex.discussionId === discId,
          )
          const effectiveCourseId = forum.course || Number(d.course)
          const effectiveModuleId = moduleFor(effectiveCourseId)
          const authorObject = d.author && typeof d.author === 'object' ? d.author : undefined

          const author =
            d.userfullname ||
            d.firstpostfullname ||
            d.firstuserfullname ||
            authorObject?.fullname ||
            (typeof d.author === 'string' ? d.author : '') ||
            existingDisc?.userFullName ||
            'Moodle'
          const picture =
            d.userpictureurl ||
            d.firstpostuserimageurl ||
            d.firstuserimageurl ||
            authorObject?.urls?.profileimage ||
            existingDisc?.userPictureUrl

          const createdUnix = Number(
            d.created || d.timecreated || d.timestart || d.timemodified || d.modified || nowUnix(),
          )
          const modifiedUnix = Number(
            d.timemodified || d.modified || d.timecreated || d.created || createdUnix,
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
            numReplies: d.numreplies ?? 0,
            pinned: Boolean(d.pinned),
            isAnnouncement: isNews,
          })
        }
      } catch {
        // Skip forums that fail to load
      }
    }

    // Fill in the body of up to 10 discussions without text from their first post
    const discussionsNeedingBody = allDiscussions.filter((d) => !d.message).slice(0, 10)
    for (const item of discussionsNeedingBody) {
      try {
        const posts = await client.discussionPosts(item.discussionId)
        const root = posts.find((p) => p.parentId === 0 || p.id === item.firstPostId) ?? posts[0]
        if (root?.message) {
          item.message = root.message
          if (root.id) item.firstPostId = root.id
        }
      } catch {
        // Not fatal: the UI loads the posts on demand
      }
    }

    const updatedDiscIds = new Set(allDiscussions.map((d) => d.id))
    const otherDiscussions = existingDiscussions.filter(
      (d) =>
        !updatedDiscIds.has(d.id) && !courseIds.some((cid) => String(cid) === String(d.courseId)),
    )
    const mergedDiscussions = [...otherDiscussions, ...allDiscussions].sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timeCreated.localeCompare(a.timeCreated),
    )
    store.update({ moodleDiscussions: mergedDiscussions })
    if (mergedDiscussions.length > 0) {
      result.discussions = mergedDiscussions.length
    }
  } catch (err) {
    result.errors.push(`Foren: ${(err as Error).message}`)
  }

  // Re-read the settings: the course map or other settings may have changed during the sync
  const { settings } = store.get()
  store.update({
    settings: { ...settings, moodle: { ...settings.moodle, lastSync: new Date().toISOString() } },
  })
  return result
}

async function syncCourseFiles(
  store: DataStore,
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
        // Download the new version first, then replace the old one (a failure keeps the old file)
        const bytes = await client.download(file.fileurl)
        const release = await reserveSpace(bytes.length)
        const folderId = folderNamed(section.name || 'Allgemein', rootId)
        const item = await store
          .addFile(
            { moduleId, folderId },
            { name: file.filename, type: '', bytes, fromInternet: true },
          )
          .finally(release)
        store.put('items', { ...item, source: 'moodle', externalId })
        const outdated = db.items.find(
          (i) => i.id !== item.id && i.externalId?.startsWith(`moodle:file:${file.fileurl}@`),
        )
        if (outdated) await store.remove('items', outdated.id)
        count += 1
      }
    }
  }
  return count
}
