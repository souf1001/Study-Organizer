// AI chat tab of the module page: searchable list of the module's chats.
import { useState } from 'react'
import {
  MessageCircle,
  MessageSquare,
  Pencil,
  Plus,
  SplitSquareHorizontal,
  Trash2,
} from 'lucide-react'
import type { Module } from '@shared/types'
import { deleteChat, renameChat } from '@/lib/actions'
import { useDb } from '@/lib/db'
import { formatDateTime } from '@/lib/format'
import { openInNewPane, openView } from '@/lib/workspace'
import { Button, IconButton } from '@/ui/Button'
import { Empty } from '@/ui/Empty'

export function ModuleChats({ module }: { module: Module }) {
  const db = useDb()
  const [search, setSearch] = useState('')
  const chats = (db.chats ?? [])
    .filter((c) => c.moduleId === module.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const q = search.trim().toLowerCase()
  const filtered = q
    ? chats.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    : chats

  return (
    <div className="module-chats">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 650, margin: 0 }}>
            KI-Chats zu {module.name}
          </h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Bisherige Unterhaltungen und Fragen zur Vorlesung und Übung
          </p>
        </div>
        <Button icon={<Plus />} onClick={(e) => openView({ type: 'chat', moduleId: module.id }, e)}>
          Neuer Chat
        </Button>
      </div>

      {chats.length > 0 && (
        <input
          type="search"
          className="chat-sidebar-search"
          style={{ maxWidth: 360, marginBottom: 8 }}
          placeholder="Chats in diesem Modul durchsuchen …"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {chats.length === 0 ? (
        <Empty
          icon={<MessageCircle />}
          title={`Noch keine Chats zu ${module.name}`}
          action={
            <Button
              icon={<Plus />}
              onClick={(e) => openView({ type: 'chat', moduleId: module.id }, e)}
            >
              Chat starten
            </Button>
          }
        >
          Frag die KI nach Erklärungen zu deinen Vorlesungsfolien, Formeln oder erstelle
          Übungsaufgaben für dieses Modul.
        </Empty>
      ) : filtered.length === 0 ? (
        <div className="muted small" style={{ padding: '32px 0', textAlign: 'center' }}>
          Keine Chats zu „{search}“ in diesem Modul gefunden.
        </div>
      ) : (
        <div className="module-chat-list">
          {filtered.map((c) => {
            const lastMessage = c.messages.at(-1)?.content ?? ''
            // Strip Markdown markers for a plain-text preview
            const preview = lastMessage.replace(/[#*`_~[\]]/g, '').slice(0, 140)
            return (
              <div
                key={c.id}
                className="module-chat-card clickable"
                onClick={(e) => openView({ type: 'chat', chatId: c.id, moduleId: module.id }, e)}
              >
                <div className="module-chat-card-top">
                  <div className="module-chat-card-title">
                    <MessageSquare size={16} className="faint" />
                    <span>{c.title}</span>
                  </div>
                  <span className="small muted">{formatDateTime(c.updatedAt)}</span>
                </div>
                {preview && <p className="module-chat-card-snippet">{preview}</p>}
                <div className="module-chat-card-bottom">
                  <span className="badge small faint">
                    {c.messages.length} {c.messages.length === 1 ? 'Nachricht' : 'Nachrichten'}
                  </span>
                  <span className="spacer" />
                  <div className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <IconButton
                      small
                      label="In neuem Bereich öffnen"
                      onClick={() =>
                        openInNewPane({ type: 'chat', chatId: c.id, moduleId: module.id })
                      }
                    >
                      <SplitSquareHorizontal size={14} />
                    </IconButton>
                    <IconButton small label="Umbenennen" onClick={() => void renameChat(c)}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton small label="Löschen" onClick={() => void deleteChat(c)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
