import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MoodleClient,
  connectMoodle,
  moodleSiteInfo,
  normalizeMoodleUrl,
  syncMoodle,
} from '../src/backend/moodle'
import { Store } from '../src/backend/store'
import { newModule } from '../src/shared/defaults'

type Handler = (fn: string, body: URLSearchParams) => unknown

function fakeFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/login/token.php')) return Response.json({ token: 'tok123' })
    if (url.includes('pluginfile.php')) return new Response(new Uint8Array([37, 80, 68, 70]))
    const body = init?.body as URLSearchParams
    return Response.json(handler(body.get('wsfunction')!, body))
  }) as typeof fetch
}

describe('Moodle', () => {
  it('normalisiert Moodle-Adressen', () => {
    expect(normalizeMoodleUrl('lernen.h-da.de/my/')).toBe('https://lernen.h-da.de')
    expect(normalizeMoodleUrl('https://moodle.uni.de/moodle/login/index.php')).toBe(
      'https://moodle.uni.de/moodle',
    )
    expect(() => normalizeMoodleUrl('http://unsicher.de')).toThrow()
  })

  it('meldet sich an und lädt Kurse', async () => {
    const fetchImpl = fakeFetch((fn) =>
      fn === 'core_webservice_get_site_info'
        ? { sitename: 'h_da Moodle', userid: 7, fullname: 'Test' }
        : [{ id: 11, fullname: 'Analysis 1', shortname: 'ANA1', extra: true }],
    )
    const result = await connectMoodle(
      { url: 'lernen.h-da.de', username: 'u', password: 'p' },
      fetchImpl,
    )
    expect(result.token).toBe('tok123')
    expect(result.courses).toEqual([{ id: 11, fullname: 'Analysis 1', shortname: 'ANA1' }])
  })

  it('erkennt die Login-Art über die öffentliche Konfiguration', async () => {
    const fetchImpl = (async () =>
      Response.json([
        {
          error: false,
          data: { sitename: 'Kurse der h_da', wwwroot: 'https://lernen.h-da.de/', typeoflogin: 2 },
        },
      ])) as unknown as typeof fetch
    expect(await moodleSiteInfo('lernen.h-da.de', fetchImpl)).toEqual({
      siteName: 'Kurse der h_da',
      url: 'https://lernen.h-da.de',
      ssoRequired: true,
    })
  })

  it('übernimmt Fehlermeldungen von Moodle', async () => {
    const client = new MoodleClient(
      'https://m.de',
      't',
      fakeFetch(() => ({ exception: 'x', message: 'Ungültiges Token' })),
    )
    await expect(client.siteInfo()).rejects.toThrow('Ungültiges Token')
  })

  it('synchronisiert Abgaben, Termine und Dateien', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-'))
    try {
      const store = await Store.open(dir)
      const module = newModule('s', { name: 'Analysis 1' })
      store.put('modules', module)
      const settings = store.get().settings
      store.update({
        settings: {
          ...settings,
          moodle: {
            ...settings.moodle,
            url: 'https://m.de',
            courseMap: { 11: module.id },
            syncFiles: true,
          },
        },
      })

      const fetchImpl = fakeFetch((fn, body) => {
        if (fn === 'mod_assign_get_assignments') {
          expect(body.get('courseids[0]')).toBe('11')
          return {
            courses: [
              { id: 11, assignments: [{ id: 5, name: 'Blatt 1', duedate: 1_800_000_000 }] },
            ],
          }
        }
        if (fn === 'core_calendar_get_calendar_events') {
          expect(body.get('events[courseids][0]')).toBe('11')
          expect(body.get('options[userevents]')).toBe('1')
          return {
            events: [
              {
                id: 9,
                name: 'Quiz 1 schließt',
                courseid: 11,
                modulename: 'quiz',
                timestart: 1_800_000_000,
                timeduration: 0,
              },
              {
                id: 10,
                name: 'Blatt 1 ist fällig',
                courseid: 11,
                modulename: 'assign',
                timestart: 1_800_000_000,
                timeduration: 0,
              },
            ],
          }
        }
        if (fn === 'core_course_get_contents') {
          return [
            {
              name: 'Woche 1',
              modules: [
                {
                  modname: 'resource',
                  name: 'Folien',
                  contents: [
                    {
                      type: 'file',
                      filename: 'folien1.pdf',
                      fileurl: 'https://m.de/webservice/pluginfile.php/1/folien1.pdf',
                      filesize: 4,
                      timemodified: 1,
                    },
                  ],
                },
              ],
            },
          ]
        }
        return {}
      })
      const client = new MoodleClient('https://m.de', 't', fetchImpl)
      const first = await syncMoodle(store, client)
      expect(first).toEqual({ tasks: 1, events: 1, files: 1, errors: [] })

      // Erledigt-Status bleibt beim erneuten Abgleich erhalten, nichts wird doppelt angelegt
      const task = store.get().tasks[0]
      store.put('tasks', { ...task, done: true })
      const second = await syncMoodle(store, client)
      expect(second.files).toBe(0)
      expect(store.get().tasks).toHaveLength(1)
      expect(store.get().tasks[0].done).toBe(true)
      expect(store.get().events).toHaveLength(1)
      expect(store.get().events[0]).toMatchObject({ title: 'Quiz 1 schließt', kind: 'deadline' })
      expect(
        store
          .get()
          .folders.map((f) => f.name)
          .sort(),
      ).toEqual(['Moodle', 'Woche 1'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lädt keine Dateien, wenn das Speicherlimit erreicht ist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-'))
    try {
      const store = await Store.open(dir)
      const module = newModule('s', { name: 'Physik' })
      store.put('modules', module)
      const settings = store.get().settings
      store.update({
        settings: { ...settings, moodle: { ...settings.moodle, url: 'https://m.de', courseMap: { 11: module.id }, syncFiles: true } },
      })
      const file = { type: 'file', filename: 'a.pdf', fileurl: 'https://m.de/webservice/pluginfile.php/1/a.pdf', filesize: 4, timemodified: 1 }
      const fetchImpl = fakeFetch((fn) =>
        fn === 'core_course_get_contents'
          ? [{ name: 'Woche 1', modules: [{ modname: 'resource', name: 'Folien', contents: [file] }] }]
          : fn === 'mod_assign_get_assignments'
            ? { courses: [] }
            : { events: [] },
      )
      const reserved: number[] = []
      const full = async (bytes: number): Promise<() => void> => {
        reserved.push(bytes)
        throw new Error('Speicher voll')
      }
      const result = await syncMoodle(store, new MoodleClient('https://m.de', 't', fetchImpl), full)
      expect(reserved).toEqual([4])
      expect(result.errors).toEqual(['Dateien: Speicher voll'])
      expect(store.get().items).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
