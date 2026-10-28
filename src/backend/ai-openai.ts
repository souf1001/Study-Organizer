// All providers with an OpenAI-compatible API (Groq, Hugging Face, Gemini, OpenAI, Mistral, Ollama, ...).
import OpenAI from 'openai'
import type { AiRequest } from '../shared/types'

function client(baseURL: string, apiKey: string, fetchImpl?: typeof fetch): OpenAI {
  // Local servers (Ollama, LM Studio) need no key, but the SDK requires a value.
  // dangerouslyAllowBrowser: on Android this runs in the WebView with the user's own key.
  return new OpenAI({
    baseURL,
    apiKey: apiKey || 'not-needed',
    fetch: fetchImpl,
    dangerouslyAllowBrowser: true,
  })
}

/** Reads the maximum allowed token count from a provider's "max_tokens too large" error message */
export function extractValidTokenLimit(
  errorMessage: string,
  requestedTokens: number,
): number | null {
  const betweenMatch = errorMessage.match(/between\s+\d+\s+and\s+(\d+)/i)
  if (betweenMatch) {
    const limit = Number(betweenMatch[1])
    if (limit > 0) return limit
  }
  const maxMatch = errorMessage.match(
    /(?:max(?:imum)?|up\s+to|less\s+than\s+or\s+equal\s+to|<=)\s*[:=]?\s*(\d{3,6})/i,
  )
  if (maxMatch) {
    const limit = Number(maxMatch[1])
    if (limit > 0) return limit
  }
  // Otherwise take the largest plausible number below the requested amount
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

  /** `tokens: null` sends no explicit limit (some custom providers reject the parameter) */
  const createStream = (tokens: number | null, msgs: typeof request.messages) =>
    openAiClient.chat.completions.create(
      {
        model,
        stream: true as const,
        messages: [{ role: 'system' as const, content: request.system }, ...msgs],
        ...(tokens === null
          ? {}
          : isReasoning
            ? { max_completion_tokens: tokens }
            : { max_tokens: tokens }),
      },
      { signal },
    )

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
      stream = await createStream(tokenLimit, messagesToSend)
    } catch (err: unknown) {
      if (signal.aborted) break
      const validLimit = extractValidTokenLimit(
        err instanceof Error ? err.message : String(err),
        tokenLimit,
      )
      if (validLimit && validLimit > 0) {
        tokenLimit = validLimit
        stream = await createStream(tokenLimit, messagesToSend)
      } else {
        // Step down through common limits, finally without any explicit limit
        const fallbackLimits = [8_192, 4_096].filter((limit) => limit < tokenLimit)
        stream = null
        for (const limit of fallbackLimits) {
          tokenLimit = limit
          try {
            stream = await createStream(tokenLimit, messagesToSend)
            break
          } catch {
            // Try the next smaller limit
          }
        }
        stream ??= await createStream(null, messagesToSend)
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

    // The answer was cut off by the token limit: ask the model to continue seamlessly
    if (finishReason === 'length' && iterText.length > 0 && !signal.aborted) {
      continuations++
    } else {
      break
    }
  }

  return totalText
}

export async function listOpenAiModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<string[]> {
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
