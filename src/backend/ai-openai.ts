// Alle Anbieter mit OpenAI-kompatibler Schnittstelle (Groq, Hugging Face, Gemini, OpenAI, Mistral, Ollama …).
import OpenAI from 'openai'
import type { AiRequest } from '../shared/types'

function client(baseURL: string, apiKey: string, fetchImpl?: typeof fetch): OpenAI {
  // Lokale Server (Ollama, LM Studio) brauchen keinen Key, das SDK aber einen Wert.
  return new OpenAI({ baseURL, apiKey: apiKey || 'not-needed', fetch: fetchImpl })
}

export function extractValidTokenLimit(errorMessage: string, requestedTokens: number): number | null {
  const betweenMatch = errorMessage.match(/between\s+\d+\s+and\s+(\d+)/i)
  if (betweenMatch) {
    const val = Number(betweenMatch[1])
    if (val > 0) return val
  }
  const maxMatch = errorMessage.match(/(?:max(?:imum)?|up\s+to|less\s+than\s+or\s+equal\s+to|<=)\s*[:=]?\s*(\d{3,6})/i)
  if (maxMatch) {
    const val = Number(maxMatch[1])
    if (val > 0) return val
  }
  const numbers = (errorMessage.match(/\b\d{3,6}\b/g) ?? []).map(Number)
  const valid = numbers.filter((n) => n >= 256 && n < requestedTokens)
  if (valid.length > 0) {
    return Math.max(...valid)
  }
  return null
}

export async function streamOpenAi(
  baseUrl: string,
  apiKey: string,
  model: string,
  request: AiRequest,
  onText: (chunk: string) => void,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const isReasoning = /^(?:o1|o3|o4)\b/i.test(model)
  const defaultTokens = 8_192
  let tokenLimit = request.maxTokens ?? defaultTokens
  const openAiClient = client(baseUrl, apiKey, fetchImpl)

  const createParams = (tokens: number, msgs: typeof request.messages) => ({
    model,
    stream: true as const,
    messages: [{ role: 'system' as const, content: request.system }, ...msgs],
    ...(isReasoning ? { max_completion_tokens: tokens } : { max_tokens: tokens }),
  })

  let totalText = ''
  let continuations = 0
  const maxContinuations = 4

  while (continuations <= maxContinuations) {
    if (signal.aborted) break

    const messagesToSend =
      totalText.length > 0
        ? [
            ...request.messages,
            { role: 'assistant' as const, content: totalText },
            {
              role: 'user' as const,
              content:
                'Bitte fahre genau an der Stelle fort, an der deine vorherige Antwort abgeschnitten wurde. Wiederhole nichts vom bisherigen Text, sondern schreibe direkt das nächste Wort weiter.',
            },
          ]
        : request.messages

    let stream
    try {
      stream = await openAiClient.chat.completions.create(
        createParams(tokenLimit, messagesToSend),
        { signal },
      )
    } catch (err: unknown) {
      if (signal.aborted) break
      const msg = err instanceof Error ? err.message : String(err)
      const validLimit = extractValidTokenLimit(msg, tokenLimit)
      if (validLimit && validLimit > 0) {
        tokenLimit = validLimit
        stream = await openAiClient.chat.completions.create(
          createParams(tokenLimit, messagesToSend),
          { signal },
        )
      } else if (tokenLimit > 8_192) {
        tokenLimit = 8_192
        try {
          stream = await openAiClient.chat.completions.create(
            createParams(tokenLimit, messagesToSend),
            { signal },
          )
        } catch {
          tokenLimit = 4_096
          try {
            stream = await openAiClient.chat.completions.create(
              createParams(tokenLimit, messagesToSend),
              { signal },
            )
          } catch {
            stream = await openAiClient.chat.completions.create(
              {
                model,
                stream: true,
                messages: [{ role: 'system', content: request.system }, ...messagesToSend],
              },
              { signal },
            )
          }
        }
      } else if (tokenLimit > 4_096) {
        tokenLimit = 4_096
        try {
          stream = await openAiClient.chat.completions.create(
            createParams(tokenLimit, messagesToSend),
            { signal },
          )
        } catch {
          stream = await openAiClient.chat.completions.create(
            {
              model,
              stream: true,
              messages: [{ role: 'system', content: request.system }, ...messagesToSend],
            },
            { signal },
          )
        }
      } else {
        // Fallback without explicit token limit if rejected by a custom provider
        stream = await openAiClient.chat.completions.create(
          {
            model,
            stream: true,
            messages: [{ role: 'system', content: request.system }, ...messagesToSend],
          },
          { signal },
        )
      }
    }

    let finishReason: string | null = null
    let iterText = ''

    for await (const chunk of stream) {
      if (signal.aborted) break
      const choice = chunk.choices[0]
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason
      }
      const delta = choice?.delta?.content
      if (delta) {
        iterText += delta
        totalText += delta
        onText(delta)
      }
    }

    // Wenn Token-Limit erreicht wurde ('length'), automatisch nahtlos fortsetzen
    if (finishReason === 'length' && iterText.length > 0 && !signal.aborted) {
      continuations++
    } else {
      break
    }
  }

  return totalText
}

export async function listOpenAiModels(baseUrl: string, apiKey: string, fetchImpl?: typeof fetch): Promise<string[]> {
  const ids: string[] = []
  for await (const model of client(baseUrl, apiKey, fetchImpl).models.list()) ids.push(model.id)
  return ids.sort()
}

export function describeOpenAiError(error: unknown): string | null {
  if (error instanceof OpenAI.AuthenticationError) return 'API-Key ungültig.'
  if (error instanceof OpenAI.PermissionDeniedError) return 'Kein Zugriff auf dieses Modell.'
  if (error instanceof OpenAI.NotFoundError) return 'Modell oder Adresse nicht gefunden.'
  if (error instanceof OpenAI.RateLimitError) return 'Limit erreicht – bitte kurz warten.'
  if (error instanceof OpenAI.APIConnectionError) return 'Keine Verbindung zum Anbieter.'
  if (error instanceof OpenAI.APIError) return `Fehler ${error.status ?? ''}: ${error.message}`
  return null
}
