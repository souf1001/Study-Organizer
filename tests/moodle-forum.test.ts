import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MoodleClient, syncMoodle } from '../src/backend/moodle'
import { Store } from '../src/backend/store'
import { newModule } from '../src/shared/defaults'
import type { Secrets } from '../src/backend/service'

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

describe('Moodle Foren & Ankündigungen', () => {
  it('ruft Foren, Diskussionen und Beiträge ab', async () => {
    const fetchImpl = fakeFetch((fn, body) => {
      if (fn === 'mod_forum_get_forums_by_courses') {
        expect(body.get('courseids[0]')).toBe('101')
        return [
          {
            id: 1,
            course: 101,
            type: 'news',
            name: 'Ankündigungen',
            intro: 'Neuigkeiten zur Vorlesung',
          },
          {
            id: 2,
            course: 101,
            type: 'general',
            name: 'Diskussionsforum',
            intro: 'Fragen zu Übungen',
          },
        ]
      }
      if (fn === 'mod_forum_get_forum_discussions_paginated') {
        const forumId = body.get('forumid')
        if (forumId === '1') {
          return {
            discussions: [
              {
                id: 11,
                name: 'Vorlesungsausfall am Freitag',
                forumid: 1,
                course: 101,
                subject: 'Vorlesungsausfall am Freitag',
                message: '<p>Die Vorlesung am Freitag entfällt leider.</p>',
                userfullname: 'Prof. Dr. Schmidt',
                created: 1_700_000_000,
                numreplies: 2,
                pinned: true,
              },
            ],
          }
        }
        return {
          discussions: [
            {
              id: 22,
              name: 'Frage zu Aufgabe 3',
              forumid: 2,
              course: 101,
              subject: 'Frage zu Aufgabe 3',
              message: '<p>Verstehe Teil b nicht.</p>',
              userfullname: 'Max Mustermann',
              created: 1_700_100_000,
              numreplies: 1,
              pinned: false,
            },
          ],
        }
      }
      if (fn === 'mod_forum_get_forum_discussion_posts') {
        expect(body.get('discussionid')).toBe('11')
        return {
          posts: [
            {
              id: 11,
              discussionid: 11,
              parentid: 0,
              subject: 'Vorlesungsausfall am Freitag',
              message: '<p>Die Vorlesung am Freitag entfällt leider.</p>',
              userfullname: 'Prof. Dr. Schmidt',
              timecreated: 1_700_000_000,
            },
            {
              id: 12,
              discussionid: 11,
              parentid: 11,
              subject: 'Re: Vorlesungsausfall am Freitag',
              message: '<p>Gibt es eine Aufzeichnung?</p>',
              userfullname: 'Student A',
              timecreated: 1_700_005_000,
            },
          ],
        }
      }
      if (fn === 'mod_forum_add_discussion_post') {
        expect(body.get('postid')).toBe('11')
        expect(body.get('subject')).toBe('Re: Frage')
        expect(body.get('message')).toBe('Hier ist die Antwort')
        return { postid: 99 }
      }
      throw new Error(`Unerwarteter Aufruf: ${fn}`)
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)

    const forums = await client.forums([101])
    expect(forums).toHaveLength(2)
    expect(forums[0].name).toBe('Ankündigungen')

    const discussions = await client.discussions(1)
    expect(discussions).toHaveLength(1)
    expect(discussions[0].subject).toBe('Vorlesungsausfall am Freitag')
    expect(discussions[0].pinned).toBe(true)

    const posts = await client.discussionPosts(11)
    expect(posts).toHaveLength(2)
    expect(posts[1].userFullName).toBe('Student A')

    const reply = await client.replyPost(11, 'Re: Frage', 'Hier ist die Antwort')
    expect(reply.postid).toBe(99)
  })

  it('trennt discussionId und firstPostId korrekt bei mod_forum_get_forum_discussions_paginated', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'mod_forum_get_forum_discussions_paginated') {
        return {
          discussions: [
            {
              id: 9991, // Post ID in paginated API
              discussion: 4442, // Discussion ID
              forumid: 1,
              course: 101,
              name: 'Thema',
              subject: 'Thema',
              message: '<p>Inhalt</p>',
              userfullname: 'Dozent',
              created: 1_700_000_000,
              numreplies: 0,
              pinned: false,
              firstpost: 9991,
            },
          ],
        }
      }
      if (fn === 'mod_assign_get_assignments') return { courses: [] }
      if (fn === 'core_calendar_get_calendar_events') return { events: [] }
      if (fn === 'mod_forum_get_forums_by_courses') {
        return [{ id: 1, course: 101, type: 'general', name: 'Forum' }]
      }
      return {}
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const rawDiscussions = await client.discussions(1)
    expect(rawDiscussions).toHaveLength(1)
    expect(rawDiscussions[0].discussion).toBe(4442)
    expect(rawDiscussions[0].id).toBe(9991)
    expect(rawDiscussions[0].firstpost).toBe(9991)

    // Teste syncMoodle mapping
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-disc-map-'))
    const store = await Store.open(dir)
    try {
      const module = newModule('sem1', { name: 'Test' })
      store.put('modules', module)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '101': module.id },
          },
        },
      })
      await syncMoodle(store, client)
      const mapped = store.get().moodleDiscussions
      expect(mapped).toHaveLength(1)
      expect(mapped[0].discussionId).toBe(4442)
      expect(mapped[0].firstPostId).toBe(9991)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fängt cannotfindrecord in discussionPosts ab und liefert leeres Array', async () => {
    const fetchImpl = fakeFetch((fn) => {
      if (fn === 'mod_forum_get_discussion_posts') {
        return {
          exception: 'dml_missing_record_exception',
          errorcode: 'cannotfindrecord',
          message: 'Datensatz nicht gefunden',
        }
      }
      if (fn === 'mod_forum_get_forum_discussion_posts') {
        return {
          exception: 'dml_missing_record_exception',
          errorcode: 'cannotfindrecord',
          message: 'Datensatz nicht gefunden',
        }
      }
      throw new Error(`Unerwarteter Aufruf: ${fn}`)
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const posts = await client.discussionPosts(99999)
    expect(posts).toEqual([])
  })

  it('löst postid zu discussionid auf wenn cannotfindrecord auftritt', async () => {
    const fetchImpl = fakeFetch((fn, body) => {
      if (fn === 'mod_forum_get_discussion_posts') {
        const discId = body.get('discussionid')
        if (discId === '9991') {
          return {
            exception: 'dml_missing_record_exception',
            errorcode: 'cannotfindrecord',
            message: 'Datensatz nicht gefunden',
          }
        }
        if (discId === '4442') {
          return {
            posts: [
              {
                id: 9991,
                discussion: 4442,
                parent: 0,
                subject: 'Thema',
                message: '<p>Erster Post</p>',
                userfullname: 'Dozent',
                created: 1_700_000_000,
              },
              {
                id: 9992,
                discussion: 4442,
                parent: 9991,
                subject: 'Re: Thema',
                message: '<p>Antwort</p>',
                userfullname: 'Student',
                created: 1_700_001_000,
              },
            ],
          }
        }
      }
      if (fn === 'mod_forum_get_forum_discussion_posts') {
        return {
          exception: 'dml_missing_record_exception',
          errorcode: 'cannotfindrecord',
          message: 'Datensatz nicht gefunden',
        }
      }
      if (fn === 'mod_forum_get_discussion_post') {
        expect(body.get('postid')).toBe('9991')
        return {
          post: {
            id: 9991,
            discussion: 4442,
            subject: 'Thema',
          },
        }
      }
      throw new Error(`Unerwarteter Aufruf: ${fn}`)
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const posts = await client.discussionPosts(9991)
    expect(posts).toHaveLength(2)
    expect(posts[0].discussionId).toBe(4442)
    expect(posts[1].userFullName).toBe('Student')
  })

  it('synchronisiert Foren und Ankündigungen in die Modul-Datenbank', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-forum-'))
    const store = await Store.open(dir)
    try {
      const module = newModule('sem1', { name: 'Mathematik 1' })
      store.put('modules', module)
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            courseMap: { '101': module.id },
          },
        },
      })

      const fetchImpl = fakeFetch((fn) => {
        if (fn === 'mod_assign_get_assignments') return { courses: [] }
        if (fn === 'core_calendar_get_calendar_events') return { events: [] }
        if (fn === 'mod_forum_get_forums_by_courses') {
          return [
            {
              id: 5,
              course: 101,
              type: 'news',
              name: 'Ankündigungen',
            },
          ]
        }
        if (fn === 'mod_forum_get_forum_discussions_paginated') {
          return {
            discussions: [
              {
                id: 50,
                name: 'Klausurtermin steht fest',
                forumid: 5,
                course: 101,
                subject: 'Klausurtermin steht fest',
                message: 'Die Klausur findet am 15.02. statt.',
                userfullname: 'Dozent',
                created: 1_700_500_000,
                numreplies: 0,
                pinned: true,
              },
            ],
          }
        }
        return {}
      })

      const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
      const res = await syncMoodle(store, client)

      expect(res.errors).toHaveLength(0)
      expect(res.discussions).toBe(1)

      const discussions = store.get().moodleDiscussions
      expect(discussions).toHaveLength(1)
      expect(discussions[0].moduleId).toBe(module.id)
      expect(discussions[0].subject).toBe('Klausurtermin steht fest')
      expect(discussions[0].isAnnouncement).toBe(true)
      expect(discussions[0].pinned).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('MoodleClient.replyPost formatiert Parameter sauber (Ganzzahl, Re: Fallback, messageformat 1)', async () => {
    let calledPostId = ''
    let calledSubject = ''
    let calledMessage = ''
    let calledFormat = ''

    const fetchImpl = fakeFetch((fn, body) => {
      if (fn === 'mod_forum_add_discussion_post') {
        calledPostId = body.get('postid') ?? ''
        calledSubject = body.get('subject') ?? ''
        calledMessage = body.get('message') ?? ''
        calledFormat = body.get('messageformat') ?? ''
        return { postid: 8888 }
      }
      throw new Error(`Unerwartet: ${fn}`)
    })

    const client = new MoodleClient('https://moodle.hochschule.de', 'token123', fetchImpl)
    const res = await client.replyPost(1234.9, '', 'Meine Antwort')
    expect(res.postid).toBe(8888)
    expect(calledPostId).toBe('1234')
    expect(calledSubject).toBe('Re:')
    expect(calledMessage).toBe('Meine Antwort')
    expect(calledFormat).toBe('1')
  })

  it('service.moodleReply löst Diskussions-ID zuverlässig zur Root-Post-ID auf', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-reply-test-'))
    const store = await Store.open(dir)
    try {
      const secretsData = new Map<string, string>()
      const secrets: Secrets = {
        get: async (n) => secretsData.get(n) ?? null,
        set: async (n, v) => void secretsData.set(n, v),
        remove: async (n) => void secretsData.delete(n),
      }
      await secrets.set('moodle', JSON.stringify({ value: 'token123', target: 'https://moodle.hochschule.de' }))
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            url: 'https://moodle.hochschule.de',
            userId: 42,
          },
        },
        moodleDiscussions: [
          {
            id: 200,
            discussionId: 200,
            firstPostId: 200, // Versehentlich Discussion-ID als firstPostId hinterlegt
            forumId: 10,
            courseId: 101,
            moduleId: null,
            forumName: 'Allgemein',
            subject: 'Wichtiges Thema',
            message: '',
            userFullName: 'Prof',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 0,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      let addedToPostId = ''
      const fetchImpl = fakeFetch((fn, body) => {
        if (fn === 'mod_forum_get_discussion_posts') {
          return {
            posts: [
              {
                id: 7001, // Echte Root-Post-ID
                discussionid: 200,
                parentid: 0,
                subject: 'Wichtiges Thema',
                message: '<p>Der Inhalt des Themas</p>',
                userfullname: 'Prof',
              },
            ],
          }
        }
        if (fn === 'mod_forum_add_discussion_post') {
          addedToPostId = body.get('postid') ?? ''
          return { postid: 9999 }
        }
        throw new Error(`Unerwartet: ${fn}`)
      })

      const { createService } = await import('../src/backend/service')
      const service = createService(store, secrets, { fetchImpl })

      // Aufruf mit der Diskussions-ID (200)
      const replyRes = await service.moodleReply(200, 'Re: Wichtiges Thema', 'Super, danke!')
      expect(replyRes.postId).toBe(9999)
      // Muss an die aufgelöste Root-Post-ID (7001) gesendet worden sein, nicht an die Diskussions-ID (200)
      expect(addedToPostId).toBe('7001')

      // Und firstPostId im Store muss aktualisiert worden sein
      const updatedDisc = store.get().moodleDiscussions.find((d) => d.id === 200)
      expect(updatedDisc?.firstPostId).toBe(7001)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('service.moodlePosts ergänzt fehlenden Inhalt der Eröffnung im Store', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'moodle-posts-test-'))
    const store = await Store.open(dir)
    try {
      const secretsData = new Map<string, string>()
      const secrets: Secrets = {
        get: async (n) => secretsData.get(n) ?? null,
        set: async (n, v) => void secretsData.set(n, v),
        remove: async (n) => void secretsData.delete(n),
      }
      await secrets.set('moodle', JSON.stringify({ value: 'token123', target: 'https://moodle.hochschule.de' }))
      store.update({
        settings: {
          ...store.get().settings,
          moodle: {
            ...store.get().settings.moodle,
            url: 'https://moodle.hochschule.de',
            userId: 42,
          },
        },
        moodleDiscussions: [
          {
            id: 300,
            discussionId: 300,
            forumId: 10,
            courseId: 101,
            moduleId: null,
            forumName: 'Allgemein',
            subject: 'Hausübung 1',
            message: '', // Bislang leer von paginated API
            userFullName: 'Dozent',
            timeCreated: new Date().toISOString(),
            timeModified: new Date().toISOString(),
            numReplies: 1,
            pinned: false,
            isAnnouncement: false,
          },
        ],
      })

      const fetchImpl = fakeFetch((fn) => {
        if (fn === 'mod_forum_get_discussion_posts') {
          return {
            posts: [
              {
                id: 8001,
                discussionid: 300,
                parentid: 0,
                subject: 'Hausübung 1',
                message: '<p>Hier ist die Aufgabe 1.</p>',
                userfullname: 'Dozent',
              },
              {
                id: 8002,
                discussionid: 300,
                parentid: 8001,
                subject: 'Re: Hausübung 1',
                message: '<p>Frage zu Teil a.</p>',
                userfullname: 'Student',
              },
            ],
          }
        }
        throw new Error(`Unerwartet: ${fn}`)
      })

      const { createService } = await import('../src/backend/service')
      const service = createService(store, secrets, { fetchImpl })

      const posts = await service.moodlePosts(300)
      expect(posts).toHaveLength(2)

      // Store muss jetzt die Nachricht des Eröffnungsbeitrags besitzen
      const disc = store.get().moodleDiscussions.find((d) => d.id === 300)
      expect(disc?.message).toBe('<p>Hier ist die Aufgabe 1.</p>')
      expect(disc?.firstPostId).toBe(8001)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
