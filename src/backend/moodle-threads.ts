// Reading and replying to Moodle forum threads.
//
// Moodle identifies a thread by its discussion id, but replies must target a post id (the
// thread's root post). Depending on the Moodle version and the web service role, the root post
// id is not always part of the synced discussion list, so it is resolved lazily here and
// remembered in the database once found.
import type { MoodleDiscussion, MoodlePost } from '../shared/types'
import type { DataStore } from './data-store'
import type { MoodleClient } from './moodle'

const threadIdOf = (discussion: MoodleDiscussion): number =>
  discussion.discussionId || discussion.id

/** Finds a synced discussion by any of the ids the UI may hand us */
function findDiscussion(store: DataStore, id: number): MoodleDiscussion | undefined {
  return store
    .get()
    .moodleDiscussions.find((d) => d.id === id || d.discussionId === id || d.firstPostId === id)
}

/** Root post id stored during sync, if it is a real post id and not just the discussion id */
function knownRootPostId(discussion: MoodleDiscussion): number | null {
  const { firstPostId } = discussion
  if (!firstPostId || firstPostId === discussion.discussionId || firstPostId === discussion.id) {
    return null
  }
  return firstPostId
}

function rememberRootPost(
  store: DataStore,
  discussion: MoodleDiscussion,
  rootPostId: number,
  message?: string,
): void {
  store.update({
    moodleDiscussions: store
      .get()
      .moodleDiscussions.map((d) =>
        d.id === discussion.id
          ? { ...d, firstPostId: rootPostId, message: d.message || message || '' }
          : d,
      ),
  })
}

const rootOf = (posts: MoodlePost[]): MoodlePost | undefined =>
  posts.find((post) => post.parentId === 0) ?? posts[0]

async function rootPostFromThread(
  client: MoodleClient,
  discussion: MoodleDiscussion,
): Promise<MoodlePost | null> {
  try {
    return rootOf(await client.discussionPosts(threadIdOf(discussion))) ?? null
  } catch {
    return null
  }
}

async function rootPostFromForum(
  client: MoodleClient,
  discussion: MoodleDiscussion,
): Promise<{ id: number; message: string } | null> {
  if (!discussion.forumId) return null
  const threadId = threadIdOf(discussion)
  try {
    const listed = await client.discussions(discussion.forumId)
    const match = listed.find((d) => d.id === threadId || d.discussion === threadId)
    if (!match?.firstpost || match.firstpost === threadId) return null
    return { id: match.firstpost, message: match.message ?? '' }
  } catch {
    return null
  }
}

/** Tries all known ways to find the root post id of a thread and remembers the result */
async function resolveRootPostId(
  store: DataStore,
  client: MoodleClient,
  discussion: MoodleDiscussion,
): Promise<number | null> {
  const known = knownRootPostId(discussion)
  if (known) return known

  const fromThread = await rootPostFromThread(client, discussion)
  if (fromThread?.id && fromThread.id !== threadIdOf(discussion)) {
    rememberRootPost(store, discussion, fromThread.id, fromThread.message)
    return fromThread.id
  }
  const fromForum = await rootPostFromForum(client, discussion)
  if (fromForum) {
    rememberRootPost(store, discussion, fromForum.id, fromForum.message)
    return fromForum.id
  }
  if (fromThread?.id) {
    rememberRootPost(store, discussion, fromThread.id, fromThread.message)
    return fromThread.id
  }
  return null
}

/** Moodle answers unknown ids with "cannotfindrecord"; treat that as an empty thread */
async function postsOrEmpty(client: MoodleClient, threadId: number): Promise<MoodlePost[]> {
  try {
    return await client.discussionPosts(threadId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('cannotfindrecord') || message.includes('Datensatz')) return []
    throw error
  }
}

/**
 * When Moodle returns no posts (restricted web service role, offline …) we still show the
 * opening post we know from the sync, so the thread view is never empty.
 */
function synthesizeOpeningPost(discussion: MoodleDiscussion): MoodlePost[] {
  if (!discussion.message && !discussion.subject) return []
  return [
    {
      id: knownRootPostId(discussion) ?? threadIdOf(discussion),
      discussionId: threadIdOf(discussion),
      parentId: 0,
      subject: discussion.subject,
      message: discussion.message || '<p>Kein weiterer Textinhalt vorhanden.</p>',
      userFullName: discussion.userFullName || 'Moodle',
      userPictureUrl: discussion.userPictureUrl,
      timeCreated: discussion.timeCreated,
      canReply: !discussion.isAnnouncement,
    },
  ]
}

export async function loadThreadPosts(
  store: DataStore,
  client: MoodleClient,
  requestedId: number,
): Promise<MoodlePost[]> {
  const threadId = Math.trunc(Number(requestedId))
  if (!Number.isFinite(threadId) || threadId <= 0) return []

  const discussion = findDiscussion(store, threadId)
  let posts = await postsOrEmpty(client, threadId)

  if (posts.length === 0 && discussion) {
    // The UI may have passed the wrong kind of id; try the other ids of this discussion
    const candidates = [discussion.discussionId, discussion.id, discussion.firstPostId].filter(
      (id): id is number => typeof id === 'number' && id > 0 && id !== threadId,
    )
    for (const candidate of candidates) {
      posts = await client.discussionPosts(candidate).catch(() => [])
      if (posts.length > 0) break
    }
  }

  if (!discussion) return posts
  if (posts.length === 0) return synthesizeOpeningPost(discussion)

  const root = rootOf(posts)
  const isRootUnknown =
    !discussion.message ||
    !discussion.firstPostId ||
    discussion.firstPostId === discussion.discussionId
  if (root && isRootUnknown) rememberRootPost(store, discussion, root.id, root.message)
  return posts
}

/** Root post ids worth retrying when Moodle rejected the first reply target */
async function fallbackReplyTargets(
  client: MoodleClient,
  discussion: MoodleDiscussion | undefined,
  postId: number,
): Promise<number[]> {
  if (!discussion) {
    const resolved = await client.getDiscussionPost(postId).catch(() => null)
    if (!resolved?.discussion) return []
    const root = rootOf(await client.discussionPosts(resolved.discussion).catch(() => []))
    return root?.id ? [root.id] : []
  }
  const fromThread = await rootPostFromThread(client, discussion)
  const fromForum = await rootPostFromForum(client, discussion)
  return [fromThread?.id, fromForum?.id].filter((id): id is number => Boolean(id))
}

/** Replies to a thread; accepts a post id or a discussion id */
export async function replyToThread(
  store: DataStore,
  client: MoodleClient,
  postOrDiscussionId: number,
  subject: string,
  message: string,
): Promise<{ postId: number }> {
  const requestedId = Math.trunc(Number(postOrDiscussionId))
  if (!Number.isFinite(requestedId) || requestedId <= 0) {
    throw new Error('Ungültige Beitrags- oder Diskussions-ID.')
  }

  const discussion = findDiscussion(store, requestedId)
  const firstTarget =
    (discussion && (await resolveRootPostId(store, client, discussion))) || requestedId

  try {
    const result = await client.replyPost(firstTarget, subject, message)
    return { postId: result.postid }
  } catch (error) {
    const fallbacks = await fallbackReplyTargets(client, discussion, firstTarget)
    for (const target of fallbacks.filter((id) => id !== firstTarget)) {
      try {
        const result = await client.replyPost(target, subject, message)
        if (discussion) rememberRootPost(store, discussion, target)
        return { postId: result.postid }
      } catch {
        // Try the next candidate
      }
    }
    throw error
  }
}
