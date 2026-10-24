// Autonomer KI-Agent (Experimentell) für Aktionen im Study-Organizer.
import type { EventKind, ID } from '@shared/types'
import { toISODate } from '@shared/dates'
import { newEvent, newFolder, newTask } from '@shared/defaults'
import { getDb, putRecord, removeRecord } from './db'
import { createNoteFromMarkdown } from './ai'

import type { AgentAction, ActionResult } from '@shared/agent'
export type { AgentAction, ActionResult }
export { agentSystemPrompt, extractAgentActions } from '@shared/agent'

/**
 * Führt eine vom Agenten generierte Aktion im Store / Backend aus.
 */
export async function executeAgentAction(action: AgentAction): Promise<ActionResult> {
  const db = getDb()
  const { tool, params } = action

  switch (tool) {
    case 'cancel_event': {
      const query = String(params.query || '').trim().toLowerCase()
      const date = String(params.date || toISODate(new Date())).trim()

      // 1. Suche in Modul-Slots
      let slotFound = false
      for (const m of db.modules) {
        if (!query || m.name.toLowerCase().includes(query) || (m.code && m.code.toLowerCase().includes(query))) {
          let updated = false
          const newSchedule = m.schedule.map((s) => {
            if (!s.skip.includes(date)) {
              updated = true
              slotFound = true
              return { ...s, skip: [...s.skip, date] }
            }
            return s
          })
          if (updated) {
            putRecord('modules', { ...m, schedule: newSchedule })
          }
        }
      }

      // 2. Suche in Kalender-Events
      let eventCancelled = false
      for (const e of db.events) {
        if (
          e.start.startsWith(date) &&
          (!query || e.title.toLowerCase().includes(query))
        ) {
          removeRecord('events', e.id)
          eventCancelled = true
        }
      }

      if (slotFound || eventCancelled) {
        return {
          success: true,
          message: `Termin (${query || 'Termin'}) am ${date} wurde gestrichen/abgesagt.`,
          action,
        }
      }
      return {
        success: false,
        message: `Kein passender Termin für „${query}“ am ${date} gefunden.`,
        action,
      }
    }

    case 'create_event': {
      const title = String(params.title || 'Neuer Termin').trim()
      const date = String(params.date || toISODate(new Date())).trim()
      const startTime = String(params.startTime || '10:00').trim()
      const endTime = String(params.endTime || '12:00').trim()
      const moduleId = params.moduleId ? String(params.moduleId) : null
      const location = String(params.location || '').trim()
      const kind = (params.kind as EventKind) || 'other'

      const start = `${date}T${startTime}:00`
      const end = `${date}T${endTime}:00`

      const ev = newEvent({
        title,
        start,
        end,
        moduleId,
        location,
        kind,
      })
      putRecord('events', ev)
      return {
        success: true,
        message: `Termin „${title}“ am ${date} (${startTime}–${endTime}) angelegt.`,
        action,
      }
    }

    case 'create_note': {
      const title = String(params.title || 'Neue Zusammenfassung').trim()
      const content = String(params.content || '').trim()
      const activeSemId = db.activeSemesterId ?? db.semesters[0]?.id
      const defaultModId = db.modules.find((m) => m.semesterId === activeSemId)?.id ?? db.modules[0]?.id ?? ''
      const moduleId: ID = (params.moduleId ? String(params.moduleId) : defaultModId) as ID
      const folderId: ID | null = (params.folderId ? String(params.folderId) : null) as ID | null

      if (!moduleId) {
        return {
          success: false,
          message: 'Notiz konnte nicht angelegt werden: Kein Modul vorhanden.',
          action,
        }
      }

      const item = await createNoteFromMarkdown(title, content, moduleId, folderId)
      return {
        success: true,
        message: `Notiz „${title}“ erfolgreich im Modulverzeichnis angelegt!`,
        action,
        createdItemId: item.id,
      }
    }

    case 'create_task': {
      const title = String(params.title || 'Neue Aufgabe').trim()
      const dueDate = params.dueDate ? String(params.dueDate).trim() : null
      const moduleId: ID | null = params.moduleId ? (String(params.moduleId) as ID) : null

      const t = newTask({
        title,
        moduleId,
        due: dueDate ? `${dueDate}T23:59:00` : null,
      })
      putRecord('tasks', t)
      return {
        success: true,
        message: `Aufgabe „${title}“ ${dueDate ? `(fällig am ${dueDate})` : ''} erstellt.`,
        action,
      }
    }

    case 'complete_task': {
      const query = String(params.query || '').trim().toLowerCase()
      const task = db.tasks.find(
        (t) => !t.done && (!query || t.title.toLowerCase().includes(query)),
      )
      if (task) {
        putRecord('tasks', { ...task, done: true })
        return {
          success: true,
          message: `Aufgabe „${task.title}“ wurde als erledigt markiert.`,
          action,
        }
      }
      return {
        success: false,
        message: `Keine offene Aufgabe für „${query}“ gefunden.`,
        action,
      }
    }

    case 'create_folder': {
      const name = String(params.name || 'Neuer Ordner').trim()
      const moduleId: ID = String(params.moduleId || db.modules[0]?.id || '') as ID
      if (!moduleId) {
        return {
          success: false,
          message: 'Ordner konnte nicht angelegt werden: Kein Modul vorhanden.',
          action,
        }
      }
      const folder = newFolder(moduleId, { name })
      putRecord('folders', folder)
      return {
        success: true,
        message: `Ordner „${name}“ im Modul angelegt.`,
        action,
      }
    }
  }
}
