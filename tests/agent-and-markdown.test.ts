import { describe, expect, it } from 'vitest'
import { repairMarkdown } from '@shared/markdown'
import { extractAgentActions, agentSystemPrompt } from '@shared/agent'
import { newModule, normalizeDb } from '@shared/defaults'

import { extractValidTokenLimit, streamOpenAi } from '../src/backend/ai-openai'

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

describe('streamOpenAi auto-continuation', () => {
  it('setzt die Textgenerierung nahtlos fort, wenn finish_reason === "length"', async () => {
    let callCount = 0
    const receivedBodies: any[] = []

    const fakeFetch: typeof fetch = (async (_url: any, init: any) => {
      callCount++
      const body = JSON.parse(init.body)
      receivedBodies.push(body)

      let sse = ''
      if (callCount === 1) {
        sse = [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Teil 1 ' }, finish_reason: 'length' }] }),
          'data: [DONE]',
          '',
        ].join('\n\n')
      } else {
        sse = [
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Teil 2 abgeschlossen.' }, finish_reason: 'stop' }] }),
          'data: [DONE]',
          '',
        ].join('\n\n')
      }

      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as any

    const streamedChunks: string[] = []
    const fullText = await streamOpenAi(
      'https://api.openai.com/v1',
      'key123',
      'gpt-4o',
      {
        system: 'System Prompt',
        messages: [{ role: 'user', content: 'Schreib einen Aufsatz.' }],
      },
      (chunk) => streamedChunks.push(chunk),
      new AbortController().signal,
      fakeFetch,
    )

    expect(callCount).toBe(2)
    expect(fullText).toBe('Teil 1 Teil 2 abgeschlossen.')
    expect(streamedChunks).toEqual(['Teil 1 ', 'Teil 2 abgeschlossen.'])

    // In Iteration 2 wurde die bisherige Antwort als Assistant-Nachricht plus Fortsetzungs-Prompt angefügt
    expect(receivedBodies[1].messages).toEqual([
      { role: 'system', content: 'System Prompt' },
      { role: 'user', content: 'Schreib einen Aufsatz.' },
      { role: 'assistant', content: 'Teil 1 ' },
      {
        role: 'user',
        content:
          'Bitte fahre genau an der Stelle fort, an der deine vorherige Antwort abgeschnitten wurde. Wiederhole nichts vom bisherigen Text, sondern schreibe direkt das nächste Wort weiter.',
      },
    ])
  })
})

