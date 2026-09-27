// KI-Anbieter. Fast alle sprechen das OpenAI-kompatible Chat-Format,
// Anthropic wird über das offizielle SDK angesprochen.

export type AiApiKind = 'openai' | 'anthropic'

export interface AiProvider {
  id: string
  name: string
  api: AiApiKind
  baseUrl: string
  defaultModel: string
  /** Seite, auf der man einen API-Key erstellt */
  keyUrl: string
  note: string
  free: boolean
  keyOptional?: boolean
  /** Basis-URL darf geändert werden (lokale oder eigene Server) */
  customBaseUrl?: boolean
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'groq',
    name: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    note: 'Kostenloser Zugang mit Limits, sehr schnell.',
    free: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    api: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://huggingface.co/settings/tokens',
    note: 'Kostenloses Kontingent pro Monat. Token mit Berechtigung „Inference Providers“.',
    free: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    api: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Kostenloser Zugang über Google AI Studio.',
    free: true,
  },
  {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Kostenpflichtig, Abrechnung nach Nutzung.',
    free: false,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Kostenpflichtig, Abrechnung nach Nutzung.',
    free: false,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    api: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: 'Kostenloser Experimentier-Tarif verfügbar. Server in der EU.',
    free: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Viele Modelle über einen Key, einige davon kostenlos (Endung „:free“).',
    free: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Günstig, Abrechnung nach Nutzung.',
    free: false,
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    api: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: '',
    keyUrl: 'https://console.x.ai',
    note: 'Kostenpflichtig. Modell über „Modelle laden“ auswählen.',
    free: false,
  },
  {
    id: 'ollama',
    name: 'Ollama (lokal)',
    api: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    keyUrl: 'https://ollama.com/download',
    note: 'Läuft komplett auf deinem Rechner, kein Key nötig.',
    free: true,
    keyOptional: true,
    customBaseUrl: true,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (lokal)',
    api: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    keyUrl: 'https://lmstudio.ai',
    note: 'Lokaler Server von LM Studio, kein Key nötig.',
    free: true,
    keyOptional: true,
    customBaseUrl: true,
  },
  {
    id: 'custom',
    name: 'Anderer Anbieter (OpenAI-kompatibel)',
    api: 'openai',
    baseUrl: '',
    defaultModel: '',
    keyUrl: '',
    note: 'Jeder Dienst mit OpenAI-kompatibler Schnittstelle (z. B. Together, Fireworks, eigene Server).',
    free: false,
    keyOptional: true,
    customBaseUrl: true,
  },
]

export function getProvider(id: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0]
}
