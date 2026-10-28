// A Moodle forum discussion or announcement with lazily loaded replies and a reply form.
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, CornerDownRight, MessageSquare, Pin, Send, X } from 'lucide-react'
import DOMPurify from 'dompurify'
import type { MoodleDiscussion, MoodlePost } from '@shared/types'
import { api } from '@/lib/api'
import { loadDb } from '@/lib/db'
import { formatDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Input, Textarea } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'

/** Up to two initials of a name, used as avatar fallback */
function initials(name: string): string {
  return (name || 'M')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

const replySubjectFor = (subject: string) =>
  subject.startsWith('Re:') ? subject : `Re: ${subject}`

export function DiscussionCard({ discussion }: { discussion: MoodleDiscussion }) {
  const [expanded, setExpanded] = useState(false)
  const [posts, setPosts] = useState<MoodlePost[] | null>(null)
  const [loadingPosts, setLoadingPosts] = useState(false)
  const [errorLoadingPosts, setErrorLoadingPosts] = useState<string | null>(null)
  const [showReplyBox, setShowReplyBox] = useState(false)
  const [replyTargetPostId, setReplyTargetPostId] = useState<number | null>(null)
  const [replyTargetAuthor, setReplyTargetAuthor] = useState<string | null>(null)
  const [replySubject, setReplySubject] = useState(`Re: ${discussion.subject}`)
  const [replyMessage, setReplyMessage] = useState('')
  const [sendingReply, setSendingReply] = useState(false)

  const discId = Number(discussion.discussionId || discussion.id || 0)
  // The first post's ID, unless Moodle reports it as the discussion ID itself
  const firstPostId =
    discussion.firstPostId && discussion.firstPostId !== discId ? discussion.firstPostId : null

  const fetchPosts = async () => {
    setLoadingPosts(true)
    setErrorLoadingPosts(null)
    try {
      setPosts(await api.moodle.posts(discId))
    } catch (err) {
      setErrorLoadingPosts(err instanceof Error ? err.message : String(err))
      toastError(err)
    } finally {
      setLoadingPosts(false)
    }
  }

  const toggleReplies = async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (!posts && !loadingPosts) {
      await fetchPosts()
    }
  }

  const rootPost = useMemo(() => {
    if (!posts || posts.length === 0) return null
    const firstId = Number(discussion.firstPostId)
    return posts.find((p) => p.parentId === 0 || (firstId && p.id === firstId)) ?? posts[0]
  }, [posts, discussion.firstPostId])

  const rawBody = discussion.message || rootPost?.message || ''
  const sanitizedBody = useMemo(() => DOMPurify.sanitize(rawBody), [rawBody])

  const replies = useMemo(() => {
    if (!posts || posts.length === 0) return []
    const rootId = rootPost?.id ?? firstPostId
    if (!rootId) return posts.slice(1)
    return posts.filter((p) => p.id !== rootId)
  }, [posts, rootPost, firstPostId])

  const canReplyToDiscussion =
    !discussion.isAnnouncement && (!rootPost || rootPost.canReply !== false)
  const defaultReplyTarget = rootPost?.id ?? firstPostId ?? discId

  const closeReplyBox = () => {
    setShowReplyBox(false)
    setReplyTargetPostId(null)
    setReplyTargetAuthor(null)
  }

  const handleOpenDiscussionReply = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    setReplyTargetPostId(defaultReplyTarget)
    setReplyTargetAuthor(discussion.userFullName)
    setReplySubject(replySubjectFor(discussion.subject))
    setShowReplyBox(true)
    if (!expanded) {
      void toggleReplies()
    }
  }

  const handleOpenPostReply = (post: MoodlePost, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setReplyTargetPostId(post.id)
    setReplyTargetAuthor(post.userFullName)
    setReplySubject(replySubjectFor(post.subject))
    setShowReplyBox(true)
  }

  const handleSendReply = async () => {
    if (!replyMessage.trim()) return
    setSendingReply(true)
    try {
      const targetId = replyTargetPostId ?? defaultReplyTarget
      if (!targetId || isNaN(targetId) || targetId <= 0) {
        throw new Error(
          'Ungültige Ziel-Post-ID. Bitte synchronisiere Moodle oder lade die Beiträge neu.',
        )
      }
      await api.moodle.reply(
        targetId,
        replySubject.trim() || `Re: ${discussion.subject}`,
        replyMessage.trim(),
      )
      toast('Antwort erfolgreich gesendet!')
      setReplyMessage('')
      closeReplyBox()
      await fetchPosts()
      await loadDb()
      setExpanded(true)
    } catch (err) {
      toastError(err)
    } finally {
      setSendingReply(false)
    }
  }

  const replyCount = posts ? replies.length : discussion.numReplies

  return (
    <div
      className={`discussion-card ${discussion.pinned ? 'pinned' : ''} ${discussion.isAnnouncement ? 'announcement-card' : ''}`}
    >
      <div className="discussion-card-main" onClick={() => void toggleReplies()}>
        <div className="discussion-header">
          <div className="discussion-user-meta">
            <div className="forum-avatar" title={discussion.userFullName}>
              {discussion.userPictureUrl ? (
                <img src={discussion.userPictureUrl} alt={discussion.userFullName} />
              ) : (
                <span>{initials(discussion.userFullName)}</span>
              )}
            </div>
            <div className="forum-user-info">
              <span className="forum-author-name">{discussion.userFullName}</span>
              <span className="forum-date-meta">{formatDateTime(discussion.timeCreated)}</span>
            </div>
          </div>

          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {discussion.pinned && (
              <span className="badge color-orange row" style={{ gap: 4 }}>
                <Pin size={11} /> Angepinnt
              </span>
            )}
            {discussion.isAnnouncement ? (
              <span className="badge color-red">📢 Ankündigung</span>
            ) : (
              <span className="badge color-blue">Forum: {discussion.forumName}</span>
            )}
            <button
              type="button"
              className="forum-expand-btn"
              title={expanded ? 'Einklappen' : 'Ausklappen'}
              onClick={(e) => {
                e.stopPropagation()
                void toggleReplies()
              }}
            >
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>
        </div>

        <h3 className="discussion-title">{discussion.subject}</h3>

        {sanitizedBody ? (
          <div
            className={`discussion-body ${!expanded ? 'discussion-body-collapsed' : ''}`}
            dangerouslySetInnerHTML={{ __html: sanitizedBody }}
          />
        ) : (
          <div className="discussion-body muted small" style={{ fontStyle: 'italic' }}>
            {expanded
              ? 'Kein Text im Eröffnungsbeitrag.'
              : 'Klicke zum Öffnen und Laden des Inhalts.'}
          </div>
        )}
      </div>

      <div className="discussion-actions">
        <div className="discussion-actions-left">
          <Button
            size="sm"
            variant={expanded ? 'default' : 'ghost'}
            icon={<MessageSquare size={14} />}
            onClick={() => void toggleReplies()}
          >
            {replyCount} {replyCount === 1 ? 'Antwort' : 'Antworten'}
          </Button>
          {discussion.isAnnouncement && (
            <span className="forum-announcement-hint muted small">📢 Nur Lesezugriff</span>
          )}
        </div>

        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {canReplyToDiscussion && (
            <Button
              size="sm"
              variant="default"
              icon={<CornerDownRight size={14} />}
              onClick={handleOpenDiscussionReply}
            >
              Antworten
            </Button>
          )}
        </div>
      </div>

      {showReplyBox && (
        <div className="discussion-reply-box">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="small muted font-semibold">
              {replyTargetAuthor ? `Antwort an ${replyTargetAuthor}` : 'Antwort verfassen'}
            </span>
            <button
              type="button"
              className="forum-search-clear"
              title="Abbrechen"
              onClick={closeReplyBox}
            >
              <X size={14} />
            </button>
          </div>
          <Input
            value={replySubject}
            placeholder="Betreff"
            onChange={(e) => setReplySubject(e.target.value)}
          />
          <Textarea
            value={replyMessage}
            placeholder="Deine Antwort verfassen…"
            rows={4}
            onChange={(e) => setReplyMessage(e.target.value)}
          />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            <Button size="sm" variant="ghost" onClick={closeReplyBox}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Send size={13} />}
              disabled={!replyMessage.trim() || sendingReply}
              onClick={() => void handleSendReply()}
            >
              {sendingReply ? 'Sendet…' : 'Abschicken'}
            </Button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="discussion-thread">
          <div className="thread-section-title">
            <span>Antworten</span>
            <span className="badge color-gray">{replies.length}</span>
          </div>

          {loadingPosts && (
            <div className="forum-state-box muted small row" style={{ gap: 8 }}>
              <span className="spinner" /> Antworten werden geladen…
            </div>
          )}

          {errorLoadingPosts && (
            <div
              className="forum-state-box forum-error row"
              style={{ justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span>Fehler beim Laden: {errorLoadingPosts}</span>
              <Button size="sm" onClick={() => void fetchPosts()}>
                Erneut versuchen
              </Button>
            </div>
          )}

          {!loadingPosts && !errorLoadingPosts && replies.length === 0 && (
            <div className="forum-empty-replies">
              {discussion.numReplies > 0 ? (
                <div
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    width: '100%',
                    gap: 12,
                  }}
                >
                  <span className="small muted">
                    Laut Moodle{' '}
                    {discussion.numReplies === 1
                      ? 'liegt 1 Antwort vor'
                      : `liegen ${discussion.numReplies} Antworten vor`}
                    . Falls diese noch nicht geladen sind, prüfe die VPN-Verbindung oder versuche es
                    erneut.
                  </span>
                  <Button size="sm" variant="default" onClick={() => void fetchPosts()}>
                    Erneut laden
                  </Button>
                </div>
              ) : discussion.isAnnouncement ? (
                'In Ankündigungen gibt es keine weiteren Antworten.'
              ) : (
                'Noch keine Antworten in diesem Strang. Sei der/die Erste, der/die antwortet!'
              )}
            </div>
          )}

          {!loadingPosts &&
            replies.map((post) => {
              const canReplyToPost = !discussion.isAnnouncement && post.canReply !== false
              return (
                <div key={post.id} className="post-reply">
                  <div className="post-header">
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <div className="forum-avatar" style={{ width: 26, height: 26, fontSize: 10 }}>
                        {post.userPictureUrl ? (
                          <img src={post.userPictureUrl} alt={post.userFullName} />
                        ) : (
                          <span>{initials(post.userFullName)}</span>
                        )}
                      </div>
                      <span className="post-author">{post.userFullName}</span>
                      <span className="forum-date-meta">· {formatDateTime(post.timeCreated)}</span>
                    </div>
                    {canReplyToPost && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<CornerDownRight size={13} />}
                        onClick={(e) => handleOpenPostReply(post, e)}
                      >
                        Antworten
                      </Button>
                    )}
                  </div>
                  <div
                    className="post-body"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.message || '') }}
                  />
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
