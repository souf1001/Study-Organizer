import { describe, expect, it } from 'vitest'
import { repairMarkdown } from '@shared/markdown'
import { extractAgentActions, agentSystemPrompt } from '@shared/agent'
import { newModule, normalizeDb } from '@shared/defaults'

import { extractValidTokenLimit, streamOpenAi } from '../src/backend/ai-openai'

describe('repairMarkdown', () => {
  it('closes unterminated code blocks on token cut-off', () => {
    const broken = '# Test\n```typescript\nconst x = 42;'
    const fixed = repairMarkdown(broken)
    expect(fixed).toBe('# Test\n```typescript\nconst x = 42;\n```')
  })

  it('leaves already closed code blocks unchanged', () => {
    const valid = '# Test\n```typescript\nconst x = 42;\n```'
    const fixed = repairMarkdown(valid)
    expect(fixed).toBe(valid)
  })

  it('closes unterminated KaTeX/LaTeX blocks', () => {
    const broken = 'Formel:\n$$\\int_0^1 x dx'
    const fixed = repairMarkdown(broken)
    expect(fixed).toBe('Formel:\n$$\\int_0^1 x dx\n$$')
  })

  it('closes unterminated inline code, inline math and bold formatting', () => {
    expect(repairMarkdown('Hier ist `Code')).toBe('Hier ist `Code`')
    expect(repairMarkdown('Formel $E = mc^2')).toBe('Formel $E = mc^2$')
    expect(repairMarkdown('Wichtig: **Kernaussage')).toBe('Wichtig: **Kernaussage**')
    expect(repairMarkdown('Link: [Webseite](https://example.com/api')).toBe(
      'Link: [Webseite](https://example.com/api)',
    )
  })
})

describe('extractValidTokenLimit', () => {
  it('parses the Groq upper bound between 1 and 8192 correctly (not 1)', () => {
    const groqMsg = "'max_tokens' must be an integer between 1 and 8192, but got 16384"
    expect(extractValidTokenLimit(groqMsg, 16384)).toBe(8192)
  })

  it('parses the upper bound for 4096-token models', () => {
    const msg = 'max_tokens must be between 1 and 4096'
    expect(extractValidTokenLimit(msg, 8192)).toBe(4096)
  })

  it('ignores numbers greater than or equal to the requested limit', () => {
    const msg = 'Limit 16384'
    expect(extractValidTokenLimit(msg, 16384)).toBeNull()
  })
})

describe('extractAgentActions', () => {
  it('extracts action blocks and cleans up the text', () => {
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

  it('ignores malformed JSON without crashing', () => {
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
  it('generates a system prompt with a module overview', () => {
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
  it('seamlessly continues text generation when finish_reason === "length"', async () => {
    let callCount = 0
    const receivedBodies: { messages: unknown[] }[] = []

    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      const body = JSON.parse(String(init?.body))
      receivedBodies.push(body)

      let sse: string
      if (callCount === 1) {
        sse = [
          'data: ' +
            JSON.stringify({
              choices: [{ delta: { content: 'Teil 1 ' }, finish_reason: 'length' }],
            }),
          'data: [DONE]',
          '',
        ].join('\n\n')
      } else {
        sse = [
          'data: ' +
            JSON.stringify({
              choices: [{ delta: { content: 'Teil 2 abgeschlossen.' }, finish_reason: 'stop' }],
            }),
          'data: [DONE]',
          '',
        ].join('\n\n')
      }

      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

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

    // In iteration 2 the previous answer was appended as an assistant message plus a continuation prompt
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
