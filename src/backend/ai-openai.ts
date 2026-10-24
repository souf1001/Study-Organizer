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
  const tokenLimit = request.maxTokens ?? defaultTokens

  const createParams = (tokens: number) => ({
    model,
    stream: true as const,
    messages: [{ role: 'system' as const, content: request.system }, ...request.messages],
    ...(isReasoning ? { max_completion_tokens: tokens } : { max_tokens: tokens }),
  })

  let stream
  try {
    stream = await client(baseUrl, apiKey, fetchImpl).chat.completions.create(
      createParams(tokenLimit),
      { signal },
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const validLimit = extractValidTokenLimit(msg, tokenLimit)
    if (validLimit && validLimit > 0) {
      stream = await client(baseUrl, apiKey, fetchImpl).chat.completions.create(
        createParams(validLimit),
        { signal },
      )
    } else if (tokenLimit > 4_096) {
      try {
        stream = await client(baseUrl, apiKey, fetchImpl).chat.completions.create(
          createParams(4_096),
          { signal },
        )
      } catch {
        stream = await client(baseUrl, apiKey, fetchImpl).chat.completions.create(
          {
            model,
            stream: true,
            messages: [{ role: 'system', content: request.system }, ...request.messages],
          },
          { signal },
        )
      }
    } else {
      // Fallback without explicit token limit if rejected by a custom provider
      stream = await client(baseUrl, apiKey, fetchImpl).chat.completions.create(
        {
          model,
          stream: true,
          messages: [{ role: 'system', content: request.system }, ...request.messages],
        },
        { signal },
      )
    }
  }

  let text = ''
  for await (const chunk of stream) {
    const choice = chunk.choices[0]
    const delta = choice?.delta?.content
    if (delta) {
      text += delta
      onText(delta)
    }
  }
  return text
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
