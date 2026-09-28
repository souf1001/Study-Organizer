// Web-Version: dieselbe Schnittstelle wie die Desktop-App, aber per HTTP gegen den Server.
import type { Api } from '@shared/api'
import type { Item, MoodleCourse } from '@shared/types'

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'StudyOrganizer',
      ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    signal: init.signal,
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null
    // 401 heißt „Sitzung ungültig“ – außer beim Anmelden selbst (falsches Passwort)
    if (response.status === 401 && url !== '/api/auth/login') window.dispatchEvent(new Event('study:logged-out'))
    throw new HttpError(data?.error ?? `Serverfehler (HTTP ${response.status})`, response.status)
  }
  return (await response.json()) as T
}

const get = <T>(url: string) => request<T>('GET', url)
const enc = encodeURIComponent

export const webApi: Api = {
  platform: 'web',

  loadDb: () => get('/api/db'),
  put: (collection, record) => request('PUT', `/api/records/${enc(collection)}`, record),
  remove: (collection, id) => request('DELETE', `/api/records/${enc(collection)}/${enc(id)}`),
  update: (patch) => request('PATCH', '/api/db', patch),

  readNote: (id) => get(`/api/notes/${enc(id)}`),
  writeNote: (id, doc) => request('PUT', `/api/notes/${enc(id)}`, doc),
  readAnnotations: (id) => get(`/api/annotations/${enc(id)}`),
  writeAnnotations: (id, annotations) => request('PUT', `/api/annotations/${enc(id)}`, annotations),
  readText: async (id) => (await get<{ text: string | null }>(`/api/text/${enc(id)}`)).text,
  writeText: (id, text) => request('PUT', `/api/text/${enc(id)}`, { text }),

  async addFiles(target, files) {
    const items: Item[] = []
    for (const file of files) {
      const query = new URLSearchParams({ moduleId: target.moduleId, name: file.name })
      if (target.folderId) query.set('folderId', target.folderId)
      if (target.attachedTo) query.set('attachedTo', target.attachedTo)
      items.push(await request<Item>('POST', `/api/files?${query}`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }))
    }
    return items
  },
  fileUrl: (item) => `/api/files/${enc(item.fileName ?? '')}`,
  openFile: async (item) => {
    window.open(`/api/files/${enc(item.fileName ?? '')}?download=1`, '_blank', 'noopener')
  },

  search: (query) => get(`/api/search?q=${enc(query)}`),

  ai: {
    setKey: (provider, key) => request('POST', '/api/ai/key', { provider, key }),
    hasKey: async (provider) => (await get<{ hasKey: boolean }>(`/api/ai/key/${enc(provider)}`)).hasKey,
    listModels: () => get('/api/ai/models'),
    stream(aiRequest, onText) {
      const controller = new AbortController()
      const done = (async () => {
        const response = await fetch('/api/ai/stream', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'StudyOrganizer' },
          body: JSON.stringify(aiRequest),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(data?.error ?? `KI-Anfrage fehlgeschlagen (HTTP ${response.status})`)
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let text = ''
        for (;;) {
          const { value, done: finished } = await reader.read()
          if (finished) break
          // Fehler mitten im Stream: Server hängt \u0000{"error": …} an
          const marker = value.indexOf('\u0000')
          if (marker !== -1) {
            if (marker > 0) onText(value.slice(0, marker))
            throw new Error((JSON.parse(value.slice(marker + 1)) as { error: string }).error)
          }
          text += value
          onText(value)
        }
        return text
      })()
      return { done, cancel: () => controller.abort() }
    },
  },

  calendar: {
    subscribe: (name, url) => request('POST', '/api/calendar/subscribe', { name, url }),
    unsubscribe: (id) => request('DELETE', `/api/calendar/${enc(id)}`),
    sync: (id) => request('POST', `/api/calendar/${enc(id)}/sync`),
    importFile: (name, text) => request('POST', '/api/calendar/import', { name, text }),
  },

  moodle: {
    siteInfo: (url) => request('POST', '/api/moodle/site-info', { url }),
    connect: (input) => request<MoodleCourse[]>('POST', '/api/moodle/connect', input),
    courses: () => get('/api/moodle/courses'),
    sync: () => request('POST', '/api/moodle/sync'),
    disconnect: () => request('POST', '/api/moodle/disconnect'),
  },

  onChange(listener) {
    // Beim Zurückkehren in den Tab neu laden (z. B. nach Änderungen auf einem anderen Gerät)
    const onFocus = () => listener()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  },

  openExternal: async (url) => {
    const protocol = new URL(url).protocol
    if (['https:', 'http:', 'mailto:'].includes(protocol)) window.open(url, '_blank', 'noopener,noreferrer')
  },
  dataDir: async () => 'Server',
  revealDataDir: async () => undefined,
  backup: async () => {
    window.location.href = '/api/export'
    return 'Download gestartet'
  },
  resetAll: () => request('POST', '/api/reset'),
}

// ---- Konto (nur Web) ----

export interface WebUser {
  id: string
  email: string
  name: string
  createdAt: string
}

export const account = {
  status: () => get<{ user: WebUser | null; allowRegistration: boolean }>('/api/auth/status'),
  login: (email: string, password: string) => request<{ user: WebUser }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, password: string, name: string) => request<{ user: WebUser }>('POST', '/api/auth/register', { email, password, name }),
  logout: () => request('POST', '/api/auth/logout'),
  usage: () => get<{ used: number; quota: number; email: string }>('/api/account/usage'),
  changePassword: (current: string, next: string) => request('POST', '/api/auth/password', { current, next }),
  deleteAccount: (password: string) => request('POST', '/api/auth/delete', { password }),
}
