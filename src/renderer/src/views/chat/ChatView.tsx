// KI-Chat mit Unterlagen als Kontext (offene Bereiche, Modul, Ordner oder Auswahl).
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Copy, FilePlus, MessageCircle, RotateCcw, Settings, Square } from 'lucide-react'
import type { AiMessage, Db, ID, Item } from '@shared/types'
import { api } from '@/lib/api'
import { activeSemester, semesterModules } from '@/lib/actions'
import { buildContext, collectDocs, createNoteFromMarkdown, markdownToHtml, systemPrompt } from '@/lib/ai'
import { useDb } from '@/lib/db'
import { openView, useWorkspace, type View } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { Select } from '@/ui/Field'
import { toast, toastError } from '@/ui/Toast'
import './chat.css'

type Context = { kind: 'panes' } | { kind: 'module'; id: ID } | { kind: 'folder'; id: ID } | { kind: 'items'; ids: ID[] } | { kind: 'none' }

// Verlauf pro Bereich, damit er beim Hin- und Herwechseln erhalten bleibt
const histories = new Map<string, AiMessage[]>()

const SUGGESTIONS = [
  'Fasse die wichtigsten Punkte zusammen.',
  'Erstelle 5 Prüfungsfragen mit Musterlösungen.',
  'Erkläre den schwierigsten Begriff so einfach wie möglich.',
  'Welche Formeln und Definitionen muss ich kennen?',
]

function initialContext(view: Extract<View, { type: 'chat' }>): Context {
  if (view.itemIds?.length) return { kind: 'items', ids: view.itemIds }
  if (view.folderId) return { kind: 'folder', id: view.folderId }
  if (view.moduleId) return { kind: 'module', id: view.moduleId }
  return { kind: 'panes' }
}

function contextItems(db: Db, context: Context, paneId: string): Item[] {
  const visible = (i: Item) => !i.attachedTo
  const inFolders = (ids: Set<ID>) => db.items.filter((i) => i.folderId && ids.has(i.folderId) && visible(i))
  switch (context.kind) {
    case 'none':
      return []
    case 'items':
      return db.items.filter((i) => context.ids.includes(i.id))
    case 'module':
      return db.items.filter((i) => i.moduleId === context.id && visible(i))
    case 'folder': {
      const ids = new Set([context.id, ...db.folders.filter((f) => f.parentId === context.id).map((f) => f.id)])
      return inFolders(ids)
    }
    case 'panes': {
      const views = useWorkspace.getState().panes.filter((p) => p.id !== paneId).map((p) => p.view)
      const itemIds = new Set(views.flatMap((v) => (v.type === 'item' ? [v.id] : [])))
      const folderIds = new Set(views.flatMap((v) => (v.type === 'folder' ? [v.id] : [])))
      return [...db.items.filter((i) => itemIds.has(i.id)), ...inFolders(folderIds)]
    }
  }
}

function contextKey(context: Context): string {
  return JSON.stringify(context)
}

function Message({ message, onSave }: { message: AiMessage; onSave?: () => void }) {
  const html = useMemo(() => (message.role === 'assistant' ? markdownToHtml(message.content) : ''), [message])
  if (message.role === 'user') return <div className="chat-user selectable">{message.content}</div>
  return (
    <div className="chat-assistant">
      <div className="chat-markdown selectable" dangerouslySetInnerHTML={{ __html: html }} />
      {onSave && (
        <div className="chat-actions">
          <IconButton small label="Kopieren" onClick={() => void navigator.clipboard.writeText(message.content).then(() => toast('Kopiert'))}>
            <Copy />
          </IconButton>
          <IconButton small label="Als Notiz speichern" onClick={onSave}>
            <FilePlus />
          </IconButton>
        </div>
      )}
    </div>
  )
}

export default function ChatView({ view, paneId }: { view: Extract<View, { type: 'chat' }>; paneId: string }) {
  const db = useDb()
  const [context, setContext] = useState<Context>(() => initialContext(view))
  const [messages, setMessages] = useState<AiMessage[]>(() => histories.get(paneId) ?? [])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<{ text: string; cancel: () => void } | null>(null)
  const cache = useRef<{ key: string; text: string; count: number; truncated: boolean } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    histories.set(paneId, messages)
  }, [paneId, messages])
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages, streaming?.text])

  if (!db.settings.ai.enabled) {
    return (
      <Empty
        icon={<MessageCircle />}
        title="KI ist nicht aktiviert"
        action={
          <Button icon={<Settings />} onClick={() => openView({ type: 'settings', section: 'ai' })}>
            KI einrichten
          </Button>
        }
      >
        Hinterlege in den Einstellungen einen API-Key – z. B. kostenlos bei Groq, Google Gemini oder Hugging Face.
      </Empty>
    )
  }

  const items = contextItems(db, context, paneId)
  const modules = semesterModules(db, activeSemester(db)?.id)
  const folder = view.folderId ? db.folders.find((f) => f.id === view.folderId) : undefined
  const saveTarget = items[0] ?? null

  const loadContext = async () => {
    const key = contextKey(context) + items.map((i) => i.id + i.updatedAt).join()
    if (cache.current?.key === key) return cache.current
    const docs = await collectDocs(items)
    const built = buildContext(docs, db.settings.ai.maxContextChars)
    cache.current = { key, text: built.text, count: docs.length, truncated: built.truncated }
    return cache.current
  }

  const send = async (text = input) => {
    const question = text.trim()
    if (!question || streaming) return
    const next: AiMessage[] = [...messages, { role: 'user', content: question }]
    setMessages(next)
    setInput('')
    setStreaming({ text: '', cancel: () => undefined })
    try {
      const ctx = await loadContext()
      let answer = ''
      const stream = api.ai.stream({ system: systemPrompt(ctx.text), messages: next }, (chunk) => {
        answer += chunk
        setStreaming((s) => (s ? { ...s, text: answer } : s))
      })
      setStreaming({ text: '', cancel: stream.cancel })
      const final = await stream.done
      setMessages([...next, { role: 'assistant', content: final || answer }])
    } catch (error) {
      toastError(error)
    } finally {
      setStreaming(null)
    }
  }

  const saveAsNote = (content: string) => {
    const moduleId = saveTarget?.moduleId ?? (context.kind === 'module' ? context.id : modules[0]?.id)
    if (!moduleId) return toastError(new Error('Leg zuerst ein Modul an.'))
    void createNoteFromMarkdown(`KI-Chat – ${messages.find((m) => m.role === 'user')?.content.slice(0, 40) ?? 'Notiz'}`, content, moduleId, saveTarget?.folderId ?? null)
  }

  const contextValue = context.kind === 'module' || context.kind === 'folder' ? `${context.kind}:${context.id}` : context.kind
  const contextOptions = [
    { value: 'panes', label: 'Offene Bereiche' },
    ...(folder ? [{ value: `folder:${folder.id}`, label: `Ordner: ${folder.name}` }] : []),
    ...(view.itemIds?.length ? [{ value: 'items', label: `Auswahl (${view.itemIds.length})` }] : []),
    ...modules.map((m) => ({ value: `module:${m.id}`, label: `Modul: ${m.name}` })),
    { value: 'none', label: 'Ohne Unterlagen' },
  ]

  return (
    <div className="chat">
      <div className="chat-context">
        <span className="small muted">Kontext</span>
        <Select
          value={contextValue}
          options={contextOptions}
          onChange={(value) => {
            cache.current = null
            if (value === 'items') setContext({ kind: 'items', ids: view.itemIds ?? [] })
            else if (value === 'panes' || value === 'none') setContext({ kind: value })
            else {
              const [kind, id] = value.split(':')
              setContext({ kind: kind as 'module' | 'folder', id })
            }
          }}
        />
        <span className="small faint">{items.length} Unterlagen</span>
        <span className="spacer" />
        {messages.length > 0 && (
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => setMessages([])}>
            Neuer Chat
          </Button>
        )}
      </div>

      <div className="chat-scroll">
        <div className="chat-inner">
          {messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <h2>Frag deine Unterlagen</h2>
              <p className="muted small">
                {context.kind === 'panes'
                  ? 'Öffne Folien oder Notizen nebeneinander – der Chat liest mit, was in den anderen Bereichen offen ist.'
                  : 'Die KI antwortet auf Basis der gewählten Unterlagen.'}
              </p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chat-suggestion" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <Message key={i} message={m} onSave={m.role === 'assistant' ? () => saveAsNote(m.content) : undefined} />
          ))}
          {streaming && (
            <div className="chat-assistant">
              {streaming.text ? (
                <div className="chat-markdown selectable" dangerouslySetInnerHTML={{ __html: markdownToHtml(streaming.text) }} />
              ) : (
                <span className="row small muted">
                  <span className="spinner" /> Unterlagen werden gelesen …
                </span>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="chat-composer">
        <textarea
          className="chat-input"
          rows={1}
          placeholder="Frage stellen … (Umschalt + Enter für neue Zeile)"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {streaming ? (
          <IconButton label="Stoppen" onClick={streaming.cancel}>
            <Square />
          </IconButton>
        ) : (
          <IconButton label="Senden" disabled={!input.trim()} onClick={() => void send()}>
            <ArrowUp />
          </IconButton>
        )}
      </div>
    </div>
  )
}
