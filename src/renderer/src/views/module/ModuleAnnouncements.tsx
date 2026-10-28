// Announcements & forum tab: Moodle discussions of the module with search and forum filter.
import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, RefreshCw, Search, X } from 'lucide-react'
import type { Module, MoodleCourse } from '@shared/types'
import { api } from '@/lib/api'
import { loadDb, updateSettings, useDb } from '@/lib/db'
import { openView } from '@/lib/workspace'
import { Button } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { Select } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'
import { DiscussionCard } from './DiscussionCard'
import { mappedCourseIds, moduleDiscussions } from './moduleData'

/** Normalizes a course or module name for fuzzy matching */
const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .trim()

export function ModuleAnnouncements({ module }: { module: Module }) {
  const db = useDb()
  const [syncing, setSyncing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [forumFilter, setForumFilter] = useState<'all' | 'announcements' | number>('all')
  const [availableCourses, setAvailableCourses] = useState<MoodleCourse[]>([])
  const [selectedCourseId, setSelectedCourseId] = useState<number | ''>('')
  const [linking, setLinking] = useState(false)

  const courseMap = db.settings.moodle?.courseMap
  const moodleConnected = Boolean(db.settings.moodle?.url)

  const mappedCourseKeys = useMemo(
    () => mappedCourseIds(courseMap ?? {}, module.id),
    [courseMap, module.id],
  )
  const discussions = useMemo(
    () => moduleDiscussions(db.moodleDiscussions, module.id, mappedCourseKeys),
    [db.moodleDiscussions, module.id, mappedCourseKeys],
  )

  // Without a linked course, load the Moodle courses and preselect the one matching the module
  useEffect(() => {
    if (moodleConnected && mappedCourseKeys.length === 0) {
      api.moodle
        .courses()
        .then((loaded) => {
          setAvailableCourses(loaded)
          const moduleName = normalizeName(module.name)
          const moduleCode = module.code ? normalizeName(module.code) : ''
          const matched = loaded.find((c) => {
            const fullname = normalizeName(c.fullname)
            const shortname = normalizeName(c.shortname || '')
            if (moduleCode && (shortname === moduleCode || fullname.includes(moduleCode)))
              return true
            return (
              moduleName.length >= 3 &&
              (fullname.includes(moduleName) || shortname.includes(moduleName))
            )
          })
          if (matched) {
            setSelectedCourseId(matched.id)
          }
        })
        .catch(() => undefined)
    }
  }, [moodleConnected, mappedCourseKeys.length, module.id, module.name, module.code])

  /** Runs a Moodle sync and reports errors or the given success message */
  const syncMoodle = async (successMessage: string) => {
    const res = await api.moodle.sync()
    await loadDb()
    if (res.errors.length > 0) {
      toastError(new Error(res.errors.join(' · ')))
    } else {
      toast(successMessage)
    }
  }

  const handleLinkAndSync = async () => {
    if (!selectedCourseId) return
    setLinking(true)
    try {
      const nextCourseMap = { ...(db.settings.moodle?.courseMap ?? {}) }
      nextCourseMap[String(selectedCourseId)] = module.id
      await updateSettings('moodle', { courseMap: nextCourseMap })
      await syncMoodle('Moodle-Kurs erfolgreich verknüpft und abgeglichen')
    } catch (err) {
      toastError(err)
    } finally {
      setLinking(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      await syncMoodle('Foren und Termine erfolgreich aktualisiert')
    } catch (err) {
      toastError(err)
    } finally {
      setSyncing(false)
    }
  }

  const forums = useMemo(() => {
    const map = new Map<number, { id: number; name: string; count: number }>()
    for (const d of discussions) {
      if (d.forumId && d.forumName && !d.isAnnouncement) {
        const existing = map.get(d.forumId)
        if (existing) {
          existing.count++
        } else {
          map.set(d.forumId, { id: d.forumId, name: d.forumName, count: 1 })
        }
      }
    }
    return Array.from(map.values())
  }, [discussions])

  const announcementsCount = useMemo(
    () => discussions.filter((d) => d.isAnnouncement).length,
    [discussions],
  )

  const filteredDiscussions = useMemo(() => {
    let result = discussions
    if (forumFilter === 'announcements') {
      result = result.filter((d) => d.isAnnouncement)
    } else if (typeof forumFilter === 'number') {
      result = result.filter((d) => d.forumId === forumFilter)
    }

    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (d) =>
          d.subject.toLowerCase().includes(q) ||
          d.message.toLowerCase().includes(q) ||
          d.userFullName.toLowerCase().includes(q) ||
          d.forumName.toLowerCase().includes(q),
      )
    }
    return result
  }, [discussions, forumFilter, searchQuery])

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div
          className="section-title"
          style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span>Moodle Foren & Ankündigungen</span>
          <span className="badge color-gray">{discussions.length}</span>
        </div>
        <Button
          size="sm"
          icon={<RefreshCw size={14} className={syncing ? 'spin' : ''} />}
          disabled={syncing}
          onClick={() => void handleSync()}
        >
          {syncing ? 'Gleiche ab…' : 'Jetzt abgleichen'}
        </Button>
      </div>

      {discussions.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="forum-search-box">
            <Search size={15} className="muted" />
            <input
              type="text"
              className="forum-search-input"
              value={searchQuery}
              placeholder="Beitrag, Thema oder Autor suchen…"
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="forum-search-clear"
                title="Suche zurücksetzen"
                onClick={() => setSearchQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="forum-filters-bar">
            <Button
              size="sm"
              variant={forumFilter === 'all' ? 'primary' : 'ghost'}
              onClick={() => setForumFilter('all')}
            >
              Alle ({discussions.length})
            </Button>
            {announcementsCount > 0 && (
              <Button
                size="sm"
                variant={forumFilter === 'announcements' ? 'primary' : 'ghost'}
                onClick={() => setForumFilter('announcements')}
              >
                📢 Ankündigungen ({announcementsCount})
              </Button>
            )}
            {forums.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={forumFilter === f.id ? 'primary' : 'ghost'}
                onClick={() => setForumFilter(f.id)}
              >
                💬 {f.name} ({f.count})
              </Button>
            ))}
          </div>
        </div>
      )}

      {discussions.length === 0 ? (
        <Empty
          icon={<MessageSquare />}
          title={
            mappedCourseKeys.length === 0 ? 'Kein Moodle-Kurs zugeordnet' : 'Keine Forenbeiträge'
          }
          action={
            <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
              {mappedCourseKeys.length === 0 && moodleConnected && availableCourses.length > 0 ? (
                <div
                  className="row"
                  style={{
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                  }}
                >
                  <Select
                    value={selectedCourseId}
                    options={[
                      { value: '', label: '– Moodle-Kurs wählen –' },
                      ...availableCourses.map((c) => ({
                        value: c.id,
                        label: c.fullname.length > 50 ? c.fullname.slice(0, 48) + '…' : c.fullname,
                      })),
                    ]}
                    onChange={(v) => setSelectedCourseId(v ? Number(v) : '')}
                    style={{ maxWidth: 320 }}
                  />
                  <Button
                    icon={<RefreshCw size={14} className={linking || syncing ? 'spin' : ''} />}
                    disabled={!selectedCourseId || linking || syncing}
                    onClick={() => void handleLinkAndSync()}
                  >
                    {linking ? 'Verknüpfe…' : 'Verknüpfen & Abgleichen'}
                  </Button>
                </div>
              ) : (
                <div className="row" style={{ gap: 8 }}>
                  <Button
                    icon={<RefreshCw size={14} className={syncing ? 'spin' : ''} />}
                    disabled={syncing}
                    onClick={() => void handleSync()}
                  >
                    {syncing ? 'Gleiche ab…' : 'Mit Moodle abgleichen'}
                  </Button>
                  {mappedCourseKeys.length === 0 && (
                    <Button
                      variant="ghost"
                      onClick={(ev) => openView({ type: 'settings', section: 'integrations' }, ev)}
                    >
                      Zu den Moodle-Einstellungen
                    </Button>
                  )}
                </div>
              )}
            </div>
          }
        >
          {mappedCourseKeys.length === 0
            ? moodleConnected
              ? 'Wähle deinen Moodle-Kurs für dieses Modul aus, um Ankündigungen und Forenbeiträge anzuzeigen.'
              : 'Moodle ist noch nicht eingerichtet. Verbinde Moodle in den Einstellungen, um Foren zu synchronisieren.'
            : 'Für dieses Modul sind aktuell keine Ankündigungen oder Forenbeiträge vorhanden.'}
        </Empty>
      ) : filteredDiscussions.length === 0 ? (
        <Empty icon={<MessageSquare />} title="Keine Beiträge gefunden">
          <div className="stack" style={{ alignItems: 'center', gap: 10 }}>
            <span>
              {searchQuery
                ? `Keine Suchergebnisse für „${searchQuery}“.`
                : 'In diesem Filter wurden keine Forenbeiträge gefunden.'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearchQuery('')
                setForumFilter('all')
              }}
            >
              Filter zurücksetzen
            </Button>
          </div>
        </Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {filteredDiscussions.map((d) => (
            <DiscussionCard key={d.id || d.discussionId} discussion={d} />
          ))}
        </div>
      )}
    </div>
  )
}
