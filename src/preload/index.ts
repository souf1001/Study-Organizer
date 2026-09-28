// Brücke zwischen Oberfläche und Hauptprozess. Stellt window.studyApi bereit (siehe shared/api.ts).
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api } from '../shared/api'
import type { FileInput } from '../shared/types'

/** Entfernt das technische Präfix, das Electron vor Fehlermeldungen setzt */
function cleanError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (error) {
    throw cleanError(error)
  }
}

async function toInput(file: File): Promise<FileInput> {
  const path = webUtils.getPathForFile(file)
  if (path) return { name: file.name, type: file.type, path }
  return { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
}

const api: Api = {
  platform: 'desktop',

  loadDb: () => invoke('db:load'),
  put: (collection, record) => invoke('db:put', collection, record),
  remove: (collection, id) => invoke('db:remove', collection, id),
  update: (patch) => invoke('db:update', patch),

  readNote: (id) => invoke('note:read', id),
  writeNote: (id, doc) => invoke('note:write', id, doc),
  readAnnotations: (id) => invoke('annotations:read', id),
  writeAnnotations: (id, annotations) => invoke('annotations:write', id, annotations),
  readText: (id) => invoke('text:read', id),
  writeText: (id, text) => invoke('text:write', id, text),

  addFiles: async (target, files) => invoke('files:add', target, await Promise.all(files.map(toInput))),
  fileUrl: (item) => `studyfile://files/${item.fileName}`,
  openFile: (item) => invoke('files:open', item.fileName),

  search: (query) => invoke('search', query),

  ai: {
    setKey: (provider, key) => invoke('ai:setKey', provider, key),
    hasKey: (provider) => invoke('ai:hasKey', provider),
    listModels: () => invoke('ai:listModels'),
    stream(request, onText) {
      const requestId = crypto.randomUUID()
      const listener = (_event: unknown, id: string, chunk: string): void => {
        if (id === requestId) onText(chunk)
      }
      ipcRenderer.on('ai:chunk', listener)
      const done = invoke<string>('ai:stream', requestId, request).finally(() =>
        ipcRenderer.removeListener('ai:chunk', listener),
      )
      return { done, cancel: () => ipcRenderer.send('ai:cancel', requestId) }
    },
  },

  calendar: {
    subscribe: (name, url) => invoke('calendar:subscribe', name, url),
    unsubscribe: (id) => invoke('calendar:unsubscribe', id),
    sync: (id) => invoke('calendar:sync', id),
    importFile: (name, text) => invoke('calendar:importFile', name, text),
  },

  moodle: {
    siteInfo: (url) => invoke('moodle:siteInfo', url),
    connect: (input) => invoke('moodle:connect', input),
    connectSso: (url) => invoke('moodle:connectSso', url),
    courses: () => invoke('moodle:courses'),
    sync: () => invoke('moodle:sync'),
    disconnect: () => invoke('moodle:disconnect'),
  },

  onChange(listener) {
    const wrapped = (): void => listener()
    ipcRenderer.on('db:changed', wrapped)
    return () => ipcRenderer.removeListener('db:changed', wrapped)
  },

  openExternal: (url) => invoke('app:openExternal', url),
  dataDir: () => invoke('app:dataDir'),
  revealDataDir: () => invoke('app:revealDataDir'),
  backup: () => invoke('app:backup'),
  resetAll: () => invoke('app:reset'),
}

contextBridge.exposeInMainWorld('studyApi', api)
