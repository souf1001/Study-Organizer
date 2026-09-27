// Einheitlicher Einstieg für alle KI-Anbieter.
import { getProvider } from '../shared/ai-providers'
import type { AiRequest, Settings } from '../shared/types'
import { describeAnthropicError, listAnthropicModels, streamAnthropic } from './ai-anthropic'
import { describeOpenAiError, listOpenAiModels, streamOpenAi } from './ai-openai'

type AiSettings = Settings['ai']

function target(settings: AiSettings): { api: 'openai' | 'anthropic'; baseUrl: string; model: string } {
  const provider = getProvider(settings.provider)
  const baseUrl = (provider.customBaseUrl && settings.baseUrl.trim()) || provider.baseUrl
  const model = settings.model.trim() || provider.defaultModel
  if (!baseUrl) throw new Error('Bitte eine Basis-URL für den Anbieter eintragen.')
  if (!model) throw new Error('Bitte ein Modell auswählen.')
  return { api: provider.api, baseUrl, model }
}

export function checkKey(settings: AiSettings, apiKey: string | null): string {
  if (apiKey) return apiKey
  if (getProvider(settings.provider).keyOptional) return ''
  throw new Error('Kein API-Key hinterlegt. Bitte in den Einstellungen unter „KI“ eintragen.')
}

export async function streamChat(
  settings: AiSettings,
  apiKey: string,
  request: AiRequest,
  onText: (chunk: string) => void,
  signal: AbortSignal,
): Promise<string> {
  if (!settings.enabled) throw new Error('KI ist in den Einstellungen deaktiviert.')
  const t = target(settings)
  try {
    return t.api === 'anthropic'
      ? await streamAnthropic(apiKey, t.model, request, onText, signal)
      : await streamOpenAi(t.baseUrl, apiKey, t.model, request, onText, signal)
  } catch (error) {
    throw new Error(describeAiError(error))
  }
}

export async function listModels(settings: AiSettings, apiKey: string): Promise<string[]> {
  const t = target({ ...settings, model: settings.model || 'placeholder' })
  try {
    return t.api === 'anthropic'
      ? await listAnthropicModels(apiKey)
      : await listOpenAiModels(t.baseUrl, apiKey)
  } catch (error) {
    throw new Error(describeAiError(error))
  }
}

export function describeAiError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Abgebrochen.'
  return (
    describeAnthropicError(error) ??
    describeOpenAiError(error) ??
    (error instanceof Error ? error.message : String(error))
  )
}
