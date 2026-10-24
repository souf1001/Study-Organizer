import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MoodleClient, syncMoodle } from '../src/backend/moodle'
import { Store } from '../src/backend/store'
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
})
