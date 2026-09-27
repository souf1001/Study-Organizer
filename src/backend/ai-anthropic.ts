// Anthropic über das offizielle SDK.
import Anthropic from '@anthropic-ai/sdk'
import type { AiRequest } from '../shared/types'

// Für diese Modelle springt bei einer Ablehnung serverseitig ein anderes Modell ein.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1'])

export async function streamAnthropic(
  apiKey: string,
  model: string,
  request: AiRequest,
  onText: (chunk: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const client = new Anthropic({ apiKey })
  const useFallback = FALLBACK_MODELS.has(model)
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: request.maxTokens ?? 16_000,
      system: request.system,
      messages: request.messages,
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    },
    { signal },
  )
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onText(event.delta.text)
    }
  }
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    throw new Error('Das Modell hat diese Anfrage abgelehnt.')
  }
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey })
  const ids: string[] = []
  for await (const model of client.models.list()) ids.push(model.id)
  return ids
}

export function describeAnthropicError(error: unknown): string | null {
  if (error instanceof Anthropic.AuthenticationError) return 'API-Key ungültig.'
  if (error instanceof Anthropic.PermissionDeniedError) return 'Kein Zugriff auf dieses Modell.'
  if (error instanceof Anthropic.NotFoundError) return 'Modell nicht gefunden.'
  if (error instanceof Anthropic.RateLimitError) return 'Zu viele Anfragen – bitte kurz warten.'
  if (error instanceof Anthropic.APIConnectionError) return 'Keine Verbindung zu Anthropic.'
  if (error instanceof Anthropic.APIError) return `Anthropic-Fehler ${error.status ?? ''}: ${error.message}`
  return null
}
