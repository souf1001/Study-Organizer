// Schnellsuche (Cmd/Strg + K): Module, Ordner, Notizen, Dateien, Volltext und Befehle.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { BookOpen, CalendarDays, CheckSquare, FileText, Folder, Home, MessageCircle, Moon, Search, Settings, SplitSquareHorizontal } from 'lucide-react'
import type { SearchHit } from '@shared/types'
import { api } from '@/lib/api'
import { activeSemester } from '@/lib/actions'
import { updateSettings, useDb } from '@/lib/db'
import { modKey } from '@/lib/format'
import { openInNewPane, openView, useWorkspace, type View } from '@/lib/workspace'
import { FileIcon } from '@/views/file/FileIcon'

export const usePalette = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}))

interface Result {
  key: string
  group: string
  label: string
  hint?: string
  snippet?: string
  icon: ReactNode
  view?: View
  run?: () => void
}

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

function Palette() {
  const db = useDb()
  const hide = usePalette((s) => s.hide)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Volltextsuche verzögert, damit nicht bei jedem Tastendruck gesucht wird
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) return setHits([])
    const timer = setTimeout(() => void api.search(q).then(setHits).catch(() => setHits([])), 180)
    return () => clearTimeout(timer)
  }, [query])

  const results = useMemo<Result[]>(() => {
    const q = normalize(query.trim())
    const match = (text: string) => !q || normalize(text).includes(q)
    const semester = activeSemester(db)
    const moduleName = (id: string) => db.modules.find((m) => m.id === id)?.name ?? ''

    const commands = ([
      { key: 'home', group: 'Navigation', label: 'Heute', icon: <Home />, view: { type: 'home' } },
      { key: 'cal', group: 'Navigation', label: 'Kalender', icon: <CalendarDays />, view: { type: 'calendar' } },
      { key: 'tasks', group: 'Navigation', label: 'Aufgaben', icon: <CheckSquare />, view: { type: 'tasks' } },
      ...(db.settings.ai.enabled
        ? [{ key: 'chat', group: 'Navigation', label: 'KI-Chat', icon: <MessageCircle />, view: { type: 'chat' } satisfies View }]
        : []),
      { key: 'settings', group: 'Navigation', label: 'Einstellungen', icon: <Settings />, view: { type: 'settings' } },
      {
        key: 'theme',
        group: 'Befehle',
        label: 'Hell/Dunkel wechseln',
        icon: <Moon />,
        run: () => {
          const dark = document.documentElement.dataset.theme === 'dark'
          updateSettings('appearance', { theme: dark ? 'light' : 'dark' })
        },
      },
      {
        key: 'split',
        group: 'Befehle',
        label: 'Aktuelle Ansicht nebeneinander öffnen',
        icon: <SplitSquareHorizontal />,
        run: () => {
          const { panes, activeId } = useWorkspace.getState()
          const view = panes.find((p) => p.id === activeId)?.view
          if (view) useWorkspace.getState().open(view, { newPane: true })
        },
      },
    ] satisfies Result[]).filter((c) => match(c.label))

    const modules: Result[] = db.modules
      .filter((m) => match(`${m.name} ${m.code}`))
      .sort((a, b) => Number(b.semesterId === semester?.id) - Number(a.semesterId === semester?.id))
      .slice(0, 8)
      .map((m) => ({
        key: m.id,
        group: 'Module',
        label: m.name,
        hint: db.semesters.find((s) => s.id === m.semesterId)?.name,
        icon: <BookOpen />,
        view: { type: 'module', id: m.id },
      }))

    const folders: Result[] = q
      ? db.folders
          .filter((f) => match(f.name))
          .slice(0, 8)
          .map((f) => ({ key: f.id, group: 'Ordner', label: f.name, hint: moduleName(f.moduleId), icon: <Folder />, view: { type: 'folder', id: f.id } }))
      : []

    const items: Result[] = db.items
      .filter((i) => !i.attachedTo && match(i.title))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, q ? 12 : 6)
      .map((i) => ({
        key: i.id,
        group: q ? 'Notizen & Dateien' : 'Zuletzt bearbeitet',
        label: i.title,
        hint: moduleName(i.moduleId),
        icon: i.kind === 'note' ? <FileText /> : <FileIcon type={i.fileType} />,
        view: { type: 'item', id: i.id },
      }))

    const shown = new Set(items.map((r) => r.key))
    const fullText: Result[] = hits
      .filter((h) => !shown.has(h.itemId))
      .flatMap((h) => {
        const item = db.items.find((i) => i.id === h.itemId)
        if (!item) return []
        return [{ key: `t-${h.itemId}`, group: 'Im Inhalt gefunden', label: item.title, snippet: h.snippet, hint: moduleName(item.moduleId), icon: <Search />, view: { type: 'item', id: item.id } }]
      })

    return q ? [...modules, ...folders, ...items, ...fullText, ...commands] : [...items, ...commands, ...modules]
  }, [db, query, hits])

  useEffect(() => {
    setSelected(0)
  }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const run = (result: Result | undefined, newPane: boolean) => {
    if (!result) return
    hide()
    if (result.run) result.run()
    else if (result.view) (newPane ? openInNewPane : openView)(result.view)
  }

  let lastGroup = ''
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && hide()}>
      <div className="palette" role="dialog" aria-label="Suche">
        <div className="palette-input">
          <Search />
          <input
            autoFocus
            className="input-bare"
            placeholder="Suchen oder Befehl eingeben …"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') hide()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((i) => Math.min(i + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(results[selected], e.metaKey || e.ctrlKey)
              }
            }}
          />
        </div>
        <div className="palette-results" ref={listRef}>
          {results.length === 0 && <div className="empty small">Nichts gefunden.</div>}
          {results.map((r, i) => {
            const heading = r.group !== lastGroup ? <div className="palette-group">{r.group}</div> : null
            lastGroup = r.group
            return (
              <div key={r.key}>
                {heading}
                <button
                  type="button"
                  className="palette-item"
                  aria-selected={i === selected}
                  onMouseMove={() => setSelected(i)}
                  onClick={(e) => run(r, e.metaKey || e.ctrlKey)}
                >
                  {r.icon}
                  <span style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ display: 'block' }}>{r.label}</span>
                    {r.snippet && <span className="snippet truncate">{r.snippet}</span>}
                  </span>
                  {r.hint && <span className="hint">{r.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-footer">
          <span>↑↓ auswählen</span>
          <span>↵ öffnen</span>
          <span>{modKey} ↵ nebeneinander öffnen</span>
          <span>esc schließen</span>
        </div>
      </div>
    </div>
  )
}

export function CommandPalette() {
  const open = usePalette((s) => s.open)
  if (!open) return null
  return createPortal(<Palette />, document.body)
}
