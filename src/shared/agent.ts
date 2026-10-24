import type { Db } from './types'

export interface AgentAction {
  tool: 'cancel_event' | 'create_event' | 'create_note' | 'create_task' | 'complete_task' | 'create_folder'
  params: Record<string, unknown>
}

export interface ActionResult {
  success: boolean
  message: string
  action: AgentAction
  createdItemId?: string
}

/**
 * System-Prompt-Erweiterung für den autonomen Agenten-Modus.
 */
export function agentSystemPrompt(db: Db): string {
  const moduleSummary = db.modules
    .map((m) => `- Modul ID: "${m.id}", Name: "${m.name}", Code: "${m.code || ''}"`)
    .join('\n')

  return `
Du bist zusätzlich als autonomer KI-Agent im Study-Organizer autorisiert.
Wenn der Benutzer dich bittet, Aktionen auszuführen (z. B. Termine streichen, Termine eintragen, Aufgaben erstellen/erledigen, Notizen/Zusammenfassungen oder Ordner anlegen), formuliere deine Antwort und hänge am Ende einen eindeutigen Aktions-Block in folgendem JSON-Format an:

\`\`\`action
{
  "tool": "cancel_event" | "create_event" | "create_note" | "create_task" | "complete_task" | "create_folder",
  "params": { ... }
}
\`\`\`

Verfügbare Tools und Parameter:
1. "cancel_event": Streicht oder sagt einen Vorlesungs-/Übungs- oder Kalendertermin ab.
   Params: { "query": "Suchtext/Name des Termins oder Moduls", "date": "YYYY-MM-DD" }
2. "create_event": Trägt einen neuen Termin ein.
   Params: { "title": string, "date": "YYYY-MM-DD", "startTime": "HH:MM", "endTime": "HH:MM", "moduleId"?: string, "location"?: string, "kind"?: "lecture"|"exercise"|"exam"|"deadline"|"lab"|"other" }
3. "create_note": Erstellt eine Notiz/Zusammenfassung/Lernzettel direkt im Modulverzeichnis mit Markdown/LaTeX.
   Params: { "title": string, "content": string, "moduleId"?: string, "folderId"?: string }
4. "create_task": Erstellt eine neue Aufgabe/Abgabe.
   Params: { "title": string, "dueDate"?: "YYYY-MM-DD", "moduleId"?: string }
5. "complete_task": Markiert eine Aufgabe als erledigt.
   Params: { "query": "Suchtext/Titel der Aufgabe" }
6. "create_folder": Erstellt einen Ordner im Modul.
   Params: { "name": string, "moduleId": string }

Aktuell registrierte Module des Benutzers:
${moduleSummary || '(Keine Module angelegt)'}

Wichtig: Führe die gewünschte Aktion direkt und präzise aus. Verwende nachvollziehbare, gut strukturierte Inhalte.
`
}

/**
 * Parst Aktionsblöcke aus der Antwort des KI-Modells.
 */
export function extractAgentActions(text: string): { cleanText: string; actions: AgentAction[] } {
  const actions: AgentAction[] = []
  const actionRegex = /```(?:action|json\s+action)\s*([\s\S]*?)```/gi

  let match: RegExpExecArray | null
  while ((match = actionRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as AgentAction
      if (parsed && parsed.tool && parsed.params) {
        actions.push(parsed)
      }
    } catch {
      // Ignoriere fehlerhaftes JSON
    }
  }

  const cleanText = text.replace(actionRegex, '').trim()
  return { cleanText, actions }
}
