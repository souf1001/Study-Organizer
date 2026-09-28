// Alle Anbieter mit OpenAI-kompatibler Schnittstelle (Groq, Hugging Face, Gemini, OpenAI, Mistral, Ollama …).
import OpenAI from 'openai'
import type { AiRequest } from '../shared/types'

function client(baseURL: string, apiKey: string, fetchImpl?: typeof fetch): OpenAI {
  // Lokale Server (Ollama, LM Studio) brauchen keinen Key, das SDK aber einen Wert.
  return new OpenAI({ baseURL, apiKey: apiKey || 'not-needed', fetch: fetchImpl })
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
  const stream = await client(baseUrl, apiKey, fetchImpl).chat.completions.create(
    {
      model,
      stream: true,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
    },
    { signal },
  )
  let text = ''
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
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
