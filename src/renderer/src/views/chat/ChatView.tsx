import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import 'katex/dist/katex.min.css'
import {
  ArrowUp,
  Bot,
  ChevronsLeft,
  Copy,
  FilePlus,
  History,
  MessageCircle,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Square,
  Tag,
  Trash2,
} from 'lucide-react'
import type { AiMessage, ChatSession, Db, ID, Item } from '@shared/types'
import { toISODate, today, diffDays } from '@shared/dates'
import { api } from '@/lib/api'
import { activeSemester, deleteChat, renameChat, semesterModules } from '@/lib/actions'
import { agentSystemPrompt, executeAgentAction, extractAgentActions } from '@/lib/agent'
import { buildContext, collectDocs, createNoteFromMarkdown, markdownToHtml, renderMath, systemPrompt } from '@/lib/ai'
import { getDb, putRecord, useDb } from '@/lib/db'
import { formatDay, formatTime } from '@/lib/format'
import { openView, useWorkspace, type View } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'
import { Select } from '@/ui/Field'
import { showMenu } from '@/ui/Menu'
import { toast, toastError } from '@/ui/Toast'
import './chat.css'

type Context =
  | { kind: 'panes' }
  | { kind: 'module'; id: ID }
  | { kind: 'folder'; id: ID }
  | { kind: 'items'; ids: ID[] }
  | { kind: 'none' }

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

function chatTimeLabel(iso: string): string {
  try {
    const d = new Date(iso)
    const isod = toISODate(d)
    const t = today()
    if (isod === t) return formatTime(iso)
    if (diffDays(t, isod) === -1) return 'Gestern'
    return formatDay(isod)
  } catch {
    return ''
  }
}

/** Bereinigtes Markdown-HTML inklusive Formeln */
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => markdownToHtml(text), [text])
  useLayoutEffect(() => {
    if (ref.current) renderMath(ref.current)
  }, [html])
  return <div ref={ref} className="chat-markdown selectable" dangerouslySetInnerHTML={{ __html: html }} />
}

function Message({ message, onSave }: { message: AiMessage; onSave?: () => void }) {
  if (message.role === 'user') return <div className="chat-user selectable">{message.content}</div>
  return (
    <div className="chat-assistant">
      <Markdown text={message.content} />
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
  const semester = activeSemester(db)
  const modules = semesterModules(db, semester?.id)

  const [activeChatId, setActiveChatId] = useState<ID | null>(() => view.chatId ?? null)
  const [showHistory, setShowHistory] = useState(true)
  const [moduleFilter, setModuleFilter] = useState<string>(() => view.moduleId ?? 'all')
  const [historySearch, setHistorySearch] = useState('')

  const [context, setContext] = useState<Context>(() => initialContext(view))
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<{ text: string; cancel: () => void } | null>(null)
  const cache = useRef<{ key: string; text: string; count: number; truncated: boolean } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const cancelledRef = useRef(false)
  const activeChatIdRef = useRef<ID | null>(activeChatId)
  activeChatIdRef.current = activeChatId

  useEffect(() => {
    setActiveChatId(view.chatId ?? null)
  }, [view.chatId])

  useEffect(() => {
    if (view.moduleId) {
      setModuleFilter(view.moduleId)
      setContext({ kind: 'module', id: view.moduleId })
    } else if (view.chatId === undefined) {
      setModuleFilter('all')
      setContext(initialContext(view))
    }
  }, [view.moduleId, view.chatId])

  useEffect(() => {
    if (view.itemIds?.length) setContext({ kind: 'items', ids: view.itemIds })
    else if (view.folderId) setContext({ kind: 'folder', id: view.folderId })
  }, [view.itemIds, view.folderId])

  const activeChat = useMemo(() => {
    if (!activeChatId) return null
    return (db.chats ?? []).find((c) => c.id === activeChatId) ?? null
  }, [db.chats, activeChatId])

  useEffect(() => {
    if (activeChat?.moduleId && context.kind === 'panes') {
      setContext({ kind: 'module', id: activeChat.moduleId })
    }
  }, [activeChat?.moduleId])

  useEffect(() => {
    if (activeChatId && !activeChat) {
      if (streaming) {
        cancelledRef.current = true
        streaming.cancel()
        setStreaming(null)
      }
      setActiveChatId(null)
      useWorkspace.getState().replace(paneId, { ...view, chatId: undefined })
    }
  }, [activeChatId, activeChat, paneId, streaming, view])

  const messages: AiMessage[] = useMemo(() => {
    return activeChat?.messages ?? []
  }, [activeChat])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, streaming?.text])

  const suggestions = useMemo(() => {
    if (db.settings.ai.agentEnabled) {
      return [
        'Streiche den nächsten Vorlesungstermin.',
        'Erstelle eine Zusammenfassung als Notiz im Modul.',
        'Erstelle eine Aufgabe: Übungsblatt abgeben bis Freitag.',
        'Fasse die wichtigsten Punkte zusammen.',
      ]
    }
    return SUGGESTIONS
  }, [db.settings.ai.agentEnabled])

  const filteredChats = useMemo(() => {
    let list = [...(db.chats ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (moduleFilter === 'none') {
      list = list.filter((c) => !c.moduleId)
    } else if (moduleFilter !== 'all') {
      list = list.filter((c) => c.moduleId === moduleFilter)
    }
    const q = historySearch.trim().toLowerCase()
    if (q) {
      list = list.filter((c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    }
    return list
  }, [db.chats, moduleFilter, historySearch])

  const items = contextItems(db, context, paneId)
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

  const cancelStreaming = () => {
    if (streaming) {
      cancelledRef.current = true
      streaming.cancel()
      const currentId = activeChatIdRef.current
      if (streaming.text && currentId) {
        const fresh = (getDb().chats ?? []).find((c) => c.id === currentId)
        if (fresh) {
          putRecord('chats', {
            ...fresh,
            messages: [...fresh.messages, { role: 'assistant', content: streaming.text + ' (abgebrochen)' }],
            updatedAt: new Date().toISOString(),
          })
        }
      }
      setStreaming(null)
    }
  }

  const handleNewChat = () => {
    cancelStreaming()
    setActiveChatId(null)
    setInput('')
    if (moduleFilter !== 'all' && moduleFilter !== 'none') {
      setContext({ kind: 'module', id: moduleFilter })
      useWorkspace.getState().replace(paneId, { ...view, chatId: undefined, moduleId: moduleFilter })
    } else {
      setContext({ kind: 'panes' })
      useWorkspace.getState().replace(paneId, { ...view, chatId: undefined, moduleId: undefined })
    }
  }

  const handleSelectChat = (chat: ChatSession) => {
    if (chat.id === activeChatId) return
    cancelStreaming()
    setActiveChatId(chat.id)
    if (chat.moduleId) {
      setContext({ kind: 'module', id: chat.moduleId })
    } else {
      setContext({ kind: 'panes' })
    }
    useWorkspace.getState().replace(paneId, { ...view, chatId: chat.id, moduleId: chat.moduleId ?? undefined })
  }

  const handleDeleteChat = async (chat: ChatSession) => {
    const isCurrent = chat.id === activeChatId
    if (isCurrent) cancelStreaming()
    const ok = await deleteChat(chat)
    if (ok && isCurrent) {
      setActiveChatId(null)
      useWorkspace.getState().replace(paneId, { ...view, chatId: undefined })
    }
  }

  const handleFilterChange = (val: string) => {
    setModuleFilter(val)
    if (val !== 'all' && val !== 'none') {
      setContext({ kind: 'module', id: val })
      if (!activeChatId) {
        useWorkspace.getState().replace(paneId, { ...view, moduleId: val })
      }
    } else if (val === 'none') {
      if (context.kind === 'module') setContext({ kind: 'panes' })
      if (!activeChatId) {
        useWorkspace.getState().replace(paneId, { ...view, moduleId: undefined })
      }
    } else {
      if (!activeChatId) {
        useWorkspace.getState().replace(paneId, { ...view, moduleId: undefined })
      }
    }
  }

  const assignChatModuleMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!activeChat) return
    showMenu(e.currentTarget, [
      { heading: 'Modul zuweisen' },
      {
        label: 'Allgemein (ohne Modul)',
        icon: !activeChat.moduleId ? '✓' : <span style={{ width: 15 }} />,
        onClick: () => {
          putRecord('chats', { ...activeChat, moduleId: null, updatedAt: new Date().toISOString() })
          useWorkspace.getState().replace(paneId, { ...view, moduleId: undefined })
          toast('Modulzuordnung entfernt')
        },
      },
      ...modules.map((m) => ({
        label: m.name,
        icon: activeChat.moduleId === m.id ? '✓' : <span className={`dot color-${m.color}`} />,
        onClick: () => {
          putRecord('chats', { ...activeChat, moduleId: m.id, updatedAt: new Date().toISOString() })
          setContext({ kind: 'module', id: m.id })
          useWorkspace.getState().replace(paneId, { ...view, moduleId: m.id })
          toast(`Modul „${m.name}“ zugewiesen`)
        },
      })),
    ])
  }

  const send = async (text = input) => {
    const question = text.trim()
    if (!question || streaming) return

    cancelledRef.current = false
    let currentChatId = activeChatId
    let currentChat = activeChat
    const targetModuleId = (() => {
      if (currentChat) return currentChat.moduleId
      if (moduleFilter === 'none') return null
      if (moduleFilter !== 'all') return moduleFilter
      if (context.kind === 'module') return context.id
      if (context.kind === 'folder') return db.folders.find((f) => f.id === context.id)?.moduleId ?? null
      if (context.kind === 'items') return db.items.find((i) => context.ids.includes(i.id))?.moduleId ?? null
      return view.moduleId ?? null
    })()

    if (!currentChatId || !currentChat) {
      const newIdVal = crypto.randomUUID()
      const firstNonEmpty = question.split('\n').map((l) => l.trim()).find(Boolean) || question.trim()
      const firstLine = firstNonEmpty.replace(/^[#*`_\s-]+/, '').trim() || firstNonEmpty
      const title = firstLine.length > 45 ? firstLine.slice(0, 42) + '…' : firstLine
      const newSession: ChatSession = {
        id: newIdVal,
        moduleId: targetModuleId,
        title,
        messages: [{ role: 'user', content: question }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      putRecord('chats', newSession)
      currentChatId = newIdVal
      currentChat = newSession
      setActiveChatId(newIdVal)
      useWorkspace.getState().replace(paneId, { ...view, chatId: newIdVal, moduleId: targetModuleId ?? undefined })
    } else {
      const nextMessages: AiMessage[] = [...currentChat.messages, { role: 'user', content: question }]
      const updated: ChatSession = {
        ...currentChat,
        messages: nextMessages,
        updatedAt: new Date().toISOString(),
      }
      putRecord('chats', updated)
      currentChat = updated
    }

    const messagesToSend = currentChat.messages
    setInput('')
    setStreaming({ text: '', cancel: () => undefined })
    const isAgent = Boolean(db.settings.ai.agentEnabled)

    try {
      const ctx = await loadContext()
      const sysPrompt = isAgent
        ? `${systemPrompt(ctx.text)}\n\n${agentSystemPrompt(db)}`
        : systemPrompt(ctx.text)

      let answer = ''
      const stream = api.ai.stream({ system: sysPrompt, messages: messagesToSend, maxTokens: 16_384 }, (chunk) => {
        answer += chunk
        setStreaming((s) => (s ? { ...s, text: answer } : s))
      })
      setStreaming((s) => (s ? { ...s, cancel: stream.cancel } : { text: '', cancel: stream.cancel }))
      const final = await stream.done
      if (cancelledRef.current) return

      const fullResponse = final || answer

      let assistantText = fullResponse
      if (isAgent) {
        const { cleanText, actions } = extractAgentActions(fullResponse)
        let actionNotes = ''
        for (const action of actions) {
          const res = await executeAgentAction(action)
          toast(res.message)
          actionNotes += `\n\n> 🤖 **Agenten-Aktion:** ${res.message}`
        }
        assistantText = (cleanText + actionNotes).trim() || fullResponse
      }

      if (cancelledRef.current) return

      const dbNow = getDb()
      const freshChat = (dbNow.chats ?? []).find((c) => c.id === currentChatId)
      if (freshChat) {
        const finalMessages: AiMessage[] = [...freshChat.messages, { role: 'assistant', content: assistantText }]
        putRecord('chats', { ...freshChat, messages: finalMessages, updatedAt: new Date().toISOString() })
      }
    } catch (error) {
      if (!cancelledRef.current) {
        toastError(error)
      }
    } finally {
      setStreaming(null)
    }
  }

  const saveAsNote = (content: string) => {
    const moduleId =
      activeChat?.moduleId ??
      saveTarget?.moduleId ??
      (context.kind === 'module' ? context.id : modules[0]?.id)
    if (!moduleId) return toastError(new Error('Leg zuerst ein Modul an.'))
    createNoteFromMarkdown(
      `KI-Chat – ${activeChat?.title ?? messages.find((m) => m.role === 'user')?.content.slice(0, 40) ?? 'Notiz'}`,
      content,
      moduleId,
      saveTarget?.folderId ?? null,
    )
      .then(() => toast('Notiz gespeichert'))
      .catch(toastError)
  }

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

  const contextValue =
    context.kind === 'module' || context.kind === 'folder'
      ? `${context.kind}:${context.id}`
      : context.kind
  const contextOptions = [
    { value: 'panes', label: 'Offene Bereiche' },
    ...(folder ? [{ value: `folder:${folder.id}`, label: `Ordner: ${folder.name}` }] : []),
    ...(view.itemIds?.length ? [{ value: 'items', label: `Auswahl (${view.itemIds.length})` }] : []),
    ...modules.map((m) => ({ value: `module:${m.id}`, label: `Modul: ${m.name}` })),
    { value: 'none', label: 'Ohne Unterlagen' },
  ]

  const activeChatModule = activeChat?.moduleId
    ? db.modules.find((m) => m.id === activeChat.moduleId)
    : null

  return (
    <div className="chat">
      {/* Linke Leiste: Modulweiser Chat-Verlauf */}
      <aside className={`chat-sidebar ${!showHistory ? 'hidden' : ''}`}>
        <div className="chat-sidebar-header">
          <History size={16} />
          <span>Verlauf</span>
          <span className="spacer" />
          <IconButton small label="Neuer Chat" onClick={handleNewChat}>
            <Plus size={15} />
          </IconButton>
          <IconButton small label="Verlauf einklappen" onClick={() => setShowHistory(false)}>
            <ChevronsLeft size={15} />
          </IconButton>
        </div>

        <div className="chat-sidebar-tools">
          <Select
            value={moduleFilter}
            options={[
              { value: 'all', label: 'Alle Module' },
              { value: 'none', label: 'Ohne Modul (Allgemein)' },
              ...modules.map((m) => ({ value: m.id, label: `Modul: ${m.name}` })),
            ]}
            onChange={(val) => handleFilterChange(val)}
          />
          <input
            type="search"
            className="chat-sidebar-search"
            placeholder="Chats durchsuchen …"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
          />
        </div>

        <div className="chat-sidebar-list">
          {filteredChats.map((c) => {
            const chatMod = c.moduleId ? db.modules.find((m) => m.id === c.moduleId) : null
            return (
              <div
                key={c.id}
                className={`chat-item ${c.id === activeChatId ? 'active' : ''}`}
                onClick={() => handleSelectChat(c)}
              >
                <div className="chat-item-top">
                  {chatMod && <span className={`dot color-${chatMod.color}`} />}
                  <span className="chat-item-title" title={c.title}>
                    {c.title}
                  </span>
                  <div className="chat-item-actions" onClick={(e) => e.stopPropagation()}>
                    <IconButton small label="Umbenennen" onClick={() => void renameChat(c)}>
                      <Pencil size={12} />
                    </IconButton>
                    <IconButton small label="Löschen" onClick={() => void handleDeleteChat(c)}>
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                </div>
                <div className="chat-item-meta">
                  <span>{chatTimeLabel(c.updatedAt)}</span>
                  {chatMod && (
                    <span className="chat-item-module muted">
                      {chatMod.code || chatMod.name}
                    </span>
                  )}
                  <span className="spacer" />
                  <span className="faint">{c.messages.length}</span>
                </div>
              </div>
            )
          })}
          {filteredChats.length === 0 && (
            <div className="chat-item-empty">
              {historySearch
                ? 'Keine Treffer'
                : moduleFilter !== 'all'
                  ? 'Noch keine Chats in dieser Auswahl'
                  : 'Noch keine Chats vorhanden'}
            </div>
          )}
        </div>
      </aside>

      {/* Rechter Hauptbereich: Konversation */}
      <div className="chat-main">
        <div className="chat-context">
          {!showHistory && (
            <IconButton label="Chat-Verlauf einblenden" onClick={() => setShowHistory(true)}>
              <History size={16} />
            </IconButton>
          )}

          {activeChat && (
            <div className="chat-title-badge" title={activeChat.title}>
              <MessageSquare size={14} className="faint" />
              <span>{activeChat.title}</span>
              <IconButton small label="Chat umbenennen" onClick={() => void renameChat(activeChat)}>
                <Pencil size={12} />
              </IconButton>
              <IconButton small label="Modul zuweisen / ändern" onClick={assignChatModuleMenu}>
                <Tag size={12} />
              </IconButton>
              <IconButton small label="Chat löschen" onClick={() => void handleDeleteChat(activeChat)}>
                <Trash2 size={12} />
              </IconButton>
              {activeChatModule && (
                <span className={`badge color-${activeChatModule.color}`}>
                  {activeChatModule.name}
                </span>
              )}
            </div>
          )}

          <span className="small muted hide-narrow">Kontext</span>
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

          {db.settings.ai.agentEnabled && (
            <span className="badge color-purple row" style={{ gap: 4 }}>
              <Bot size={13} /> Autonomer Agent aktiv
            </span>
          )}

          <span className="spacer" />

          {activeChat && (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={handleNewChat}>
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
                    : context.kind === 'module'
                      ? `Die KI beantwortet deine Fragen auf Basis des Moduls „${modules.find((m) => m.id === context.id)?.name ?? ''}“.`
                      : 'Die KI antwortet auf Basis der gewählten Unterlagen.'}
                </p>
                <div className="chat-suggestions">
                  {suggestions.map((s) => (
                    <button key={s} type="button" className="chat-suggestion" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <Message
                key={i}
                message={m}
                onSave={m.role === 'assistant' ? () => saveAsNote(m.content) : undefined}
              />
            ))}
            {streaming && (
              <div className="chat-assistant">
                {streaming.text ? (
                  <Markdown text={streaming.text} />
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
            <IconButton label="Stoppen" onClick={cancelStreaming}>
              <Square />
            </IconButton>
          ) : (
            <IconButton label="Senden" disabled={!input.trim()} onClick={() => void send()}>
              <ArrowUp />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  )
}
