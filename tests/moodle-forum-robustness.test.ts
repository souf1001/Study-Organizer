import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MoodleClient, syncMoodle } from '../src/backend/moodle'
import { Store } from '../src/backend/store'
import { createService } from '../src/backend/service'
import { newModule } from '../src/shared/defaults'

function fakeFetch(
  handler: (wsfunction: string, body: URLSearchParams) => unknown,
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as string)
    const fn = body.get('wsfunction') ?? ''
    const result = handler(fn, body)
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

describe('Moodle Foren Robustness & Fallbacks', () => {
  it('fällt bei Fehlschlag von mod_forum_get_forums_by_courses zuverlässig auf core_course_get_contents zurück', async () => {
    const fetchImpl = fakeFetch((fn, body) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        // Simuliere: Batch-Aufruf wird von Moodle wegen unzureichender Berechtigungen blockiert
        return {
          exception: 'moodle_exception',
          errorcode: 'nopermissions',
          message: 'Keine Berechtigung für diese Funktion',
        }
      }
      if (fn === 'core_course_get_contents') {
        expect(body.get('courseid')).toBe('101')
        return [
          {
            name: 'Abschnitt 1',
            modules: [
              {
                id: 501,
                instance: 12,
                modname: 'forum',
                name: 'Vorlesungs-Ankündigungen',
              },
            ],
          },
        ]
      }
      if (fn === 'mod_forum_get_forum_discussions') {
        expect(body.get('forumids[0]')).toBe('12')
        return {
          discussions: [
            {
              id: 99,
              discussion: 99,
              name: 'Wichtiger Hinweis',
              firstpost: 1001,
              firstuserfullname: 'Dr. Müller',
              firstuserimageurl: 'https://moodle.de/pic.jpg',
              timemodified: 1_700_000_000,
              pinned: true,
              numreplies: 0,
            },
          ],
        }
      }
      if (fn === 'mod_assign_get_assignments') return { courses: [] }
      if (fn === 'core_calendar_get_calendar_events') return { events: [] }
      return {}
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-fallback-test-'))
    const store = await Store.open(dir)
    try {
      const mod = newModule('sem1', { name: 'Mathematik' })
      store.put('modules', mod)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '101': mod.id },
          },
        },
      })

      const res = await syncMoodle(store, client)
      expect(res.discussions).toBe(1)
      const discussions = store.get().moodleDiscussions
      expect(discussions).toHaveLength(1)
      expect(discussions[0].subject).toBe('Wichtiger Hinweis')
      expect(discussions[0].userFullName).toBe('Dr. Müller')
      expect(discussions[0].userPictureUrl).toBe('https://moodle.de/pic.jpg')
      expect(discussions[0].moduleId).toBe(mod.id)
      expect(discussions[0].isAnnouncement).toBe(true)
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bewahrt vorhandene discussion-message bei nachfolgendem Abgleich', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        return [{ id: 5, course: 202, type: 'general', name: 'Diskussionen' }]
      }
      if (fn === 'mod_forum_get_forum_discussions') {
        return {
          discussions: [
            {
              id: 77,
              name: 'Thema ohne Nachricht in Liste',
              firstpost: 500,
              firstuserfullname: 'Student B',
              timemodified: 1_700_000_000,
            },
          ],
        }
      }
      if (fn === 'mod_assign_get_assignments') return { courses: [] }
      if (fn === 'core_calendar_get_calendar_events') return { events: [] }
      return {}
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-cache-test-'))
    const store = await Store.open(dir)
    try {
      const mod = newModule('sem1', { name: 'Informatik' })
      store.put('modules', mod)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '202': mod.id },
          },
        },
        moodleDiscussions: [
          {
            id: 77,
            discussionId: 77,
            firstPostId: 500,
            forumId: 5,
            courseId: 202,
            moduleId: mod.id,
            forumName: 'Diskussionen',
            subject: 'Thema ohne Nachricht in Liste',
            message: '<p>Bereits geladene Nachricht bleibt erhalten</p>',
            userFullName: 'Student B',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 0,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      await syncMoodle(store, client)
      const disc = store.get().moodleDiscussions.find((d) => d.id === 77)
      expect(disc).toBeDefined()
      expect(disc?.message).toBe('<p>Bereits geladene Nachricht bleibt erhalten</p>')
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rematchMoodleDiscussions ordnet Diskussionen bei nachträglicher Modulzuordnung zu', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-rematch-test-'))
    const secrets = {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    }
    const store = await Store.open(dir)
    const service = createService(store, secrets)
    try {
      store.update({
        moodleDiscussions: [
          {
            id: 88,
            discussionId: 88,
            forumId: 3,
            courseId: 303,
            moduleId: null,
            forumName: 'Forum',
            subject: 'Frage',
            message: '',
            userFullName: 'User',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 0,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      // Erstelle ein Modul und mappe den Kurs
      const mod = newModule('sem1', { name: 'Physik' })
      service.put('modules', mod)
      service.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '303': mod.id },
          },
        },
      })

      const disc = store.get().moodleDiscussions.find((d) => d.id === 88)
      expect(disc?.moduleId).toBe(mod.id)
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('probiert paginated weiter wenn mod_forum_get_forum_discussions leer zurückkehrt', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        return [{ id: 42, course: 404, type: 'general', name: 'Übungsforum' }]
      }
      if (fn === 'mod_forum_get_forum_discussions') {
        // Simuliere: Leeres discussions Array in moderner API
        return { discussions: [] }
      }
      if (fn === 'mod_forum_get_forum_discussions_paginated') {
        // Die paginated API liefert die Diskussionen mit firstpostfullname
        return {
          discussions: [
            {
              id: 999,
              discussion: 999,
              name: 'Diskussion aus paginated Fallback',
              firstpost: 8888,
              firstpostfullname: 'Prof. Ada Lovelace',
              firstpostuserimageurl: 'https://moodle.de/ada.jpg',
              timemodified: 1_700_000_000,
              numreplies: 3,
            },
          ],
        }
      }
      if (fn === 'mod_assign_get_assignments') return { courses: [] }
      if (fn === 'core_calendar_get_calendar_events') return { events: [] }
      return {}
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-empty-discussions-fallback-'))
    const store = await Store.open(dir)
    try {
      const mod = newModule('sem1', { name: 'Theoretische Informatik' })
      store.put('modules', mod)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '404': mod.id },
          },
        },
      })

      const res = await syncMoodle(store, client)
      expect(res.discussions).toBe(1)
      const discussions = store.get().moodleDiscussions
      expect(discussions).toHaveLength(1)
      expect(discussions[0].id).toBe(999)
      expect(discussions[0].subject).toBe('Diskussion aus paginated Fallback')
      expect(discussions[0].userFullName).toBe('Prof. Ada Lovelace')
      expect(discussions[0].userPictureUrl).toBe('https://moodle.de/ada.jpg')
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('behält Diskussionen anderer Kurse bei erneutem Abgleich bei', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        return [{ id: 50, course: 505, type: 'general', name: 'Neuer Kurs Forum' }]
      }
      if (fn === 'mod_forum_get_forum_discussions') {
        return {
          discussions: [
            {
              id: 1234,
              name: 'Neues Thema',
              firstpost: 5001,
              userfullname: 'Dozent Neu',
              timemodified: 1_700_000_000,
            },
          ],
        }
      }
      if (fn === 'mod_assign_get_assignments') return { courses: [] }
      if (fn === 'core_calendar_get_calendar_events') return { events: [] }
      return {}
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-merge-courses-'))
    const store = await Store.open(dir)
    try {
      const mod1 = newModule('sem1', { id: 'm1', name: 'Bereits vorhandenes Modul' })
      const mod2 = newModule('sem1', { id: 'm2', name: 'Neues Modul' })
      store.put('modules', mod1)
      store.put('modules', mod2)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '505': mod2.id }, // Nur Kurs 505 wird in diesem Durchlauf abgeglichen
          },
        },
        moodleDiscussions: [
          {
            id: 1111,
            discussionId: 1111,
            firstPostId: 111,
            forumId: 10,
            courseId: 999, // Anderer Kurs
            moduleId: mod1.id,
            forumName: 'Altes Forum',
            subject: 'Altes Thema bleibt erhalten',
            message: '<p>Alt</p>',
            userFullName: 'Alter Dozent',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 0,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      const res = await syncMoodle(store, client)
      expect(res.discussions).toBe(2)
      const discussions = store.get().moodleDiscussions
      expect(discussions).toHaveLength(2)
      expect(discussions.some((d) => d.id === 1111)).toBe(true)
      expect(discussions.some((d) => d.id === 1234)).toBe(true)
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
