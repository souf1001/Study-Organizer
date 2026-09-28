// Moodle-Anbindung über die offiziellen Web-Services (dieselben, die auch die Moodle-App nutzt).
// Holt Abgaben (als Aufgaben), weitere Termine (Tests, Fristen) und optional Kursdateien.
import type { MoodleCourse, MoodleSiteInfo, MoodleSyncResult } from '../shared/types'
import { newFolder, newTask, newEvent } from '../shared/defaults'
import { classifyEvent } from './ics'
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

  async download(fileurl: string): Promise<Uint8Array> {
    const url = new URL(fileurl)
    if (url.origin !== new URL(this.site).origin)
      throw new Error('Datei liegt nicht auf dem Moodle-Server.')
    url.searchParams.set('token', this.token)
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Download fehlgeschlagen (HTTP ${response.status}).`)
    return new Uint8Array(await response.arrayBuffer())
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

/** Holt Abgaben, Termine und (optional) Dateien der zugeordneten Kurse */
export async function syncMoodle(store: Store, client: MoodleClient): Promise<MoodleSyncResult> {
  const result: MoodleSyncResult = { tasks: 0, events: 0, files: 0, errors: [] }
  const db = store.get()
  const courseMap = db.settings.moodle.courseMap
  const moduleFor = (courseId: number | undefined): string | null =>
    courseId !== undefined && db.modules.some((m) => m.id === courseMap[courseId])
      ? courseMap[courseId]
      : null
  const courseIds = Object.keys(courseMap)
    .map(Number)
    .filter((id) => moduleFor(id))
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
    const records = events
      .filter((e) => e.modulename !== 'assign')
      .map((e) => {
        const kind = classifyEvent(e.name)
        return newEvent({
          title: e.name,
          kind: kind === 'other' && !e.timeduration ? 'deadline' : kind,
          start: toIso(e.timestart),
          end: toIso(e.timestart + (e.timeduration || 0)),
          moduleId: moduleFor(e.courseid),
          externalId: `moodle:event:${e.id}`,
        })
      })
    store.replaceMany('events', (e) => Boolean(e.externalId?.startsWith('moodle:event:')), records)
    result.events = records.length
  } catch (error) {
    result.errors.push(`Termine: ${(error as Error).message}`)
  }

  if (db.settings.moodle.syncFiles) {
    for (const courseId of courseIds) {
      try {
        result.files += await syncCourseFiles(store, client, courseId, moduleFor(courseId)!)
      } catch (error) {
        result.errors.push(`Dateien: ${(error as Error).message}`)
      }
    }
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
        const folderId = folderNamed(section.name || 'Allgemein', rootId)
        const item = await store.addFile({ moduleId, folderId }, { name: file.filename, type: '', bytes })
        store.put('items', { ...item, source: 'moodle', externalId })
        const outdated = db.items.find((i) => i.id !== item.id && i.externalId?.startsWith(`moodle:file:${file.fileurl}@`))
        if (outdated) await store.remove('items', outdated.id)
        count += 1
      }
    }
  }
  return count
}
