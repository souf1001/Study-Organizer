import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MoodleClient, matchCourseToModules, syncMoodle } from '../src/backend/moodle'
import { Store } from '../src/backend/store'
import { createService } from '../src/backend/service'
import { newModule } from '../src/shared/defaults'

function fakeFetch(handler: (wsfunction: string, body: URLSearchParams) => unknown): typeof fetch {
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

describe('Moodle forum robustness & fallbacks', () => {
  it('falls back to core_course_get_contents when mod_forum_get_forums_by_courses fails', async () => {
    const fetchImpl = fakeFetch((fn, body) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        // Simulate: Moodle blocks the batch call due to insufficient permissions
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

  it('keeps an existing discussion message on a subsequent sync', async () => {
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

  it('rematchMoodleDiscussions assigns discussions when a module is mapped later', async () => {
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

      // Create a module and map the course
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

  it('tries the paginated API when mod_forum_get_forum_discussions returns empty', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        return [{ id: 42, course: 404, type: 'general', name: 'Übungsforum' }]
      }
      if (fn === 'mod_forum_get_forum_discussions') {
        // Simulate: empty discussions array in the modern API
        return { discussions: [] }
      }
      if (fn === 'mod_forum_get_forum_discussions_paginated') {
        // The paginated API returns the discussions with firstpostfullname
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

  it('keeps discussions of other courses on a repeated sync', async () => {
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
            courseMap: { '505': mod2.id }, // Only course 505 is synced in this run
          },
        },
        moodleDiscussions: [
          {
            id: 1111,
            discussionId: 1111,
            firstPostId: 111,
            forumId: 10,
            courseId: 999, // Other course
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

  it('matchCourseToModules matches Moodle courses to modules by code, name and substring', () => {
    const modAlgo = newModule('sem1', {
      id: 'm1',
      name: 'Algorithmen und Datenstrukturen',
      code: 'CS-101',
    })
    const modMathe = newModule('sem1', { id: 'm2', name: 'Mathematik 1', code: 'MA-01' })
    const modEnglisch = newModule('sem1', { id: 'm3', name: 'Technisches Englisch' })
    const modules = [modAlgo, modMathe, modEnglisch]

    // 1. Match via module code in shortname
    const c1 = { id: 1, fullname: 'AuD WiSe 2026/27', shortname: 'CS-101' }
    expect(matchCourseToModules(c1, modules)?.id).toBe('m1')

    // 2. Match via module code in fullname
    const c2 = { id: 2, fullname: 'Vorlesung MA-01 (Prof. Gauss)', shortname: 'V-MA' }
    expect(matchCourseToModules(c2, modules)?.id).toBe('m2')

    // 3. Match via substring of the module name
    const c3 = { id: 3, fullname: 'Technisches Englisch für Ingenieure (B.Sc.)', shortname: 'ENG' }
    expect(matchCourseToModules(c3, modules)?.id).toBe('m3')

    // 4. No match
    const c4 = { id: 4, fullname: 'Physikalisches Praktikum', shortname: 'PHY' }
    expect(matchCourseToModules(c4, modules)).toBeNull()
  })

  it('syncMoodle auto-maps unmapped courses when courseMap is empty', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'core_enrol_get_users_courses') {
        return [{ id: 201, fullname: 'Lineare Algebra I', shortname: 'LA1' }]
      }
      if (fn === 'mod_forum_get_forums_by_courses') {
        return [{ id: 42, course: 201, type: 'general', name: 'Ankündigungen LA1' }]
      }
      if (fn === 'mod_forum_get_forum_discussions') {
        return {
          discussions: [
            {
              id: 777,
              name: 'Willkommen zu LA1',
              firstpost: 1,
              userfullname: 'Prof. X',
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
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-automap-test-'))
    const store = await Store.open(dir)
    try {
      const mod = newModule('sem1', { id: 'm-la', name: 'Lineare Algebra I' })
      store.put('modules', mod)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            userId: 99,
            courseMap: {},
          },
        },
      })

      const res = await syncMoodle(store, client)
      expect(res.discussions).toBe(1)
      expect(store.get().settings.moodle.courseMap['201']).toBe('m-la')
      expect(store.get().moodleDiscussions).toHaveLength(1)
      expect(store.get().moodleDiscussions[0].moduleId).toBe('m-la')
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('syncMoodle does not overwrite user-defined module assignments or event notes on re-sync', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'core_calendar_get_calendar_events') {
        return {
          events: [
            {
              id: 888,
              name: 'Übung Mathematik Termin 1',
              courseid: 301,
              timestart: 1_700_000_000,
              timeduration: 5400,
            },
            {
              id: 889,
              name: 'Übung Mathematik Termin 1',
              courseid: 301,
              timestart: 1_700_604_800,
              timeduration: 5400,
            },
          ],
        }
      }
      if (fn === 'mod_forum_get_forums_by_courses') return []
      if (fn === 'mod_assign_get_assignments') return { courses: [] }
      return {}
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-event-preserve-'))
    const store = await Store.open(dir)
    try {
      const defaultMod = newModule('sem1', { id: 'mod-default', name: 'Standard Kurs' })
      const customMod = newModule('sem1', { id: 'mod-custom', name: 'Mein Spezielles Modul' })
      store.put('modules', defaultMod)
      store.put('modules', customMod)

      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '301': defaultMod.id },
          },
        },
      })
      store.put('events', {
        id: 'local-event-id-888',
        title: 'Übung Mathematik Termin 1',
        kind: 'exercise',
        start: new Date(1_700_000_000 * 1000).toISOString(),
        end: new Date((1_700_000_000 + 5400) * 1000).toISOString(),
        allDay: false,
        moduleId: customMod.id,
        location: 'Raum C10/01',
        notes: 'Wichtige Vorbereitung für Hausaufgabe',
        subscriptionId: null,
        externalId: 'moodle:event:888',
      })

      const res = await syncMoodle(store, client)
      expect(res.events).toBe(2)

      const events = store.get().events
      const event888 = events.find((e) => e.externalId === 'moodle:event:888')
      expect(event888).toBeDefined()
      expect(event888?.id).toBe('local-event-id-888')
      expect(event888?.moduleId).toBe(customMod.id)
      expect(event888?.notes).toBe('Wichtige Vorbereitung für Hausaufgabe')
      expect(event888?.location).toBe('Raum C10/01')

      const event889 = events.find((e) => e.externalId === 'moodle:event:889')
      expect(event889).toBeDefined()
      expect(event889?.moduleId).toBe(customMod.id)
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('service.moodleReply uses a known firstPostId directly when the user replies with the discussion ID', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-reply-firstpost-direct-'))
    const store = await Store.open(dir)
    try {
      const secretsData = new Map<string, string>()
      const secrets = {
        get: async (n: string) => secretsData.get(n) ?? null,
        set: async (n: string, v: string) => void secretsData.set(n, v),
        remove: async (n: string) => void secretsData.delete(n),
      }
      await secrets.set(
        'moodle',
        JSON.stringify({ value: 'token123', target: 'https://moodle.hochschule.de' }),
      )
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            url: 'https://moodle.hochschule.de',
            userId: 55,
          },
        },
        moodleDiscussions: [
          {
            id: 300,
            discussionId: 300,
            firstPostId: 6543, // Already known and different from 300
            forumId: 20,
            courseId: 101,
            moduleId: null,
            forumName: 'Diskussionen',
            subject: 'Frage zu Projekt',
            message: '<p>Projekttext</p>',
            userFullName: 'Student X',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 2,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      let postedToPostId = ''
      const fetchImpl = fakeFetch((fn, body) => {
        if (fn === 'mod_forum_add_discussion_post') {
          postedToPostId = body.get('postid') ?? ''
          return { postid: 7777 }
        }
        throw new Error(`Unerwarteter Aufruf: ${fn}`)
      })

      const service = createService(store, secrets, { fetchImpl })
      // User calls moodleReply with the discussion ID (300):
      const res = await service.moodleReply(300, 'Re: Frage zu Projekt', 'Meine Antwort')
      expect(res.postId).toBe(7777)
      // Must have been sent directly to the known firstPostId (6543)!
      expect(postedToPostId).toBe('6543')
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('service.moodleReply falls back to the forum list when discussionPosts fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-reply-fallback-forum-'))
    const store = await Store.open(dir)
    try {
      const secretsData = new Map<string, string>()
      const secrets = {
        get: async (n: string) => secretsData.get(n) ?? null,
        set: async (n: string, v: string) => void secretsData.set(n, v),
        remove: async (n: string) => void secretsData.delete(n),
      }
      await secrets.set(
        'moodle',
        JSON.stringify({ value: 'token123', target: 'https://moodle.hochschule.de' }),
      )
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            url: 'https://moodle.hochschule.de',
            userId: 55,
          },
        },
        moodleDiscussions: [
          {
            id: 400,
            discussionId: 400,
            firstPostId: 400, // Still wrongly equal to the discussion ID
            forumId: 25,
            courseId: 101,
            moduleId: null,
            forumName: 'Forum 25',
            subject: 'Thema',
            message: '',
            userFullName: 'Dozent',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 0,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      let postedToPostId = ''
      const fetchImpl = fakeFetch((fn, body) => {
        if (fn === 'mod_forum_get_discussion_posts') {
          // Simulate: fetching posts via discussionPosts is blocked / returns empty
          return { posts: [] }
        }
        if (fn === 'mod_forum_get_forum_discussions') {
          // The forum fetch, however, returns the correct firstpost ID
          return {
            discussions: [
              {
                id: 400,
                firstpost: 9876,
                name: 'Thema',
                message: '<p>Eröffnung</p>',
              },
            ],
          }
        }
        if (fn === 'mod_forum_add_discussion_post') {
          postedToPostId = body.get('postid') ?? ''
          return { postid: 8888 }
        }
        throw new Error(`Unerwarteter Aufruf: ${fn}`)
      })

      const service = createService(store, secrets, { fetchImpl })
      const res = await service.moodleReply(400, 'Re: Thema', 'Antwort über Forum-Auflösung')
      expect(res.postId).toBe(8888)
      expect(postedToPostId).toBe('9876')
      expect(store.get().moodleDiscussions.find((d) => d.id === 400)?.firstPostId).toBe(9876)
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('service.moodlePosts synthesizes the opening post when the Moodle server returns no posts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-posts-synthesize-'))
    const store = await Store.open(dir)
    try {
      const secretsData = new Map<string, string>()
      const secrets = {
        get: async (n: string) => secretsData.get(n) ?? null,
        set: async (n: string, v: string) => void secretsData.set(n, v),
        remove: async (n: string) => void secretsData.delete(n),
      }
      await secrets.set(
        'moodle',
        JSON.stringify({ value: 'token123', target: 'https://moodle.hochschule.de' }),
      )
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            url: 'https://moodle.hochschule.de',
            userId: 55,
          },
        },
        moodleDiscussions: [
          {
            id: 500,
            discussionId: 500,
            firstPostId: 12345,
            forumId: 30,
            courseId: 101,
            moduleId: null,
            forumName: 'Ankündigungen',
            subject: 'Wichtige Ankündigung',
            message: '<p>Bitte beachten Sie die Frist.</p>',
            userFullName: 'Prof. Wichtig',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 0,
            pinned: true,
            isAnnouncement: true,
          },
        ],
      })

      const fetchImpl = fakeFetch((fn) => {
        if (fn === 'mod_forum_get_discussion_posts') {
          // Simulate: server blocks the API (e.g. insufficient web service role)
          return { exception: 'webservice_access_exception', message: 'Access control exception' }
        }
        if (fn === 'mod_forum_get_forum_discussion_posts') {
          return { exception: 'webservice_access_exception', message: 'Access control exception' }
        }
        return {}
      })

      const service = createService(store, secrets, { fetchImpl })
      const posts = await service.moodlePosts(500)
      // Must NEVER be empty when the discussion has text in the store!
      expect(posts).toHaveLength(1)
      expect(posts[0].id).toBe(12345)
      expect(posts[0].subject).toBe('Wichtige Ankündigung')
      expect(posts[0].message).toBe('<p>Bitte beachten Sie die Frist.</p>')
      expect(posts[0].userFullName).toBe('Prof. Wichtig')
    } finally {
      await store.flush()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
