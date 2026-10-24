import { describe, expect, it } from 'vitest'
import { repairMarkdown } from '@shared/markdown'
import { extractAgentActions, agentSystemPrompt } from '@shared/agent'
import { newModule, normalizeDb } from '@shared/defaults'

import { extractValidTokenLimit } from '../src/backend/ai-openai'

describe('repairMarkdown', () => {
  it('schließt unvollständige Codeblöcke bei Token-Cut-Off', () => {
    const broken = '# Test\n```typescript\nconst x = 42;'
    const fixed = repairMarkdown(broken)
    expect(fixed).toBe('# Test\n```typescript\nconst x = 42;\n```')
  })

  it('lässt bereits geschlossene Codeblöcke unverändert', () => {
    const valid = '# Test\n```typescript\nconst x = 42;\n```'
    const fixed = repairMarkdown(valid)
    expect(fixed).toBe(valid)
  })

  it('schließt unvollständige KaTeX/LaTeX Blöcke', () => {
    const broken = 'Formel:\n$$\\int_0^1 x dx'
    const fixed = repairMarkdown(broken)
    expect(fixed).toBe('Formel:\n$$\\int_0^1 x dx\n$$')
  })

  it('schließt unvollständigen Inline-Code, Inline-Math und Fett-Formatierung', () => {
    expect(repairMarkdown('Hier ist `Code')).toBe('Hier ist `Code`')
    expect(repairMarkdown('Formel $E = mc^2')).toBe('Formel $E = mc^2$')
    expect(repairMarkdown('Wichtig: **Kernaussage')).toBe('Wichtig: **Kernaussage**')
    expect(repairMarkdown('Link: [Webseite](https://example.com/api')).toBe('Link: [Webseite](https://example.com/api)')
  })
})

describe('extractValidTokenLimit', () => {
  it('parst die Obergrenze bei Groq zwischen 1 und 8192 korrekt (nicht 1)', () => {
    const groqMsg = "'max_tokens' must be an integer between 1 and 8192, but got 16384"
    expect(extractValidTokenLimit(groqMsg, 16384)).toBe(8192)
  })

  it('parst Obergrenze bei 4096 Modellen', () => {
    const msg = 'max_tokens must be between 1 and 4096'
    expect(extractValidTokenLimit(msg, 8192)).toBe(4096)
  })

  it('ignoriert Zahlen größer oder gleich dem angefragten Limit', () => {
    const msg = 'Limit 16384'
    expect(extractValidTokenLimit(msg, 16384)).toBeNull()
  })
})

describe('extractAgentActions', () => {
  it('extrahiert Aktionsblöcke und bereinigt den Text', () => {
    const aiResponse = `Ich habe den Termin für dich gestrichen.

\`\`\`action
{
  "tool": "cancel_event",
  "params": {
    "query": "Mathe",
    "date": "2026-10-30"
  }
}
\`\`\`

Lass mich wissen, ob du noch etwas brauchst!`

    const { cleanText, actions } = extractAgentActions(aiResponse)
    expect(actions).toHaveLength(1)
    expect(actions[0].tool).toBe('cancel_event')
    expect(actions[0].params.query).toBe('Mathe')
    expect(cleanText).not.toContain('```action')
    expect(cleanText).toContain('Ich habe den Termin für dich gestrichen.')
    expect(cleanText).toContain('Lass mich wissen, ob du noch etwas brauchst!')
  })

  it('ignoriert fehlerhaftes JSON ohne Absturz', () => {
    const brokenResponse = `Hier ist eine unvollständige Aktion:
\`\`\`action
{ "tool": "create_task", "params":
\`\`\``
    const { cleanText, actions } = extractAgentActions(brokenResponse)
    expect(actions).toHaveLength(0)
    expect(cleanText).toBe('Hier ist eine unvollständige Aktion:')
  })
})

describe('agentSystemPrompt', () => {
  it('generiert System-Prompt mit Modul-Übersicht', () => {
    const db = normalizeDb({
      modules: [
        newModule('sem1', {
          id: 'mod1',
          name: 'Lineare Algebra',
          code: 'LA1',
        }),
      ],
    })
    const prompt = agentSystemPrompt(db)
    expect(prompt).toContain('Lineare Algebra')
    expect(prompt).toContain('mod1')
    expect(prompt).toContain('cancel_event')
    expect(prompt).toContain('create_note')
  })
})
