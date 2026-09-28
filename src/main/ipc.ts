// Verbindet die Oberfläche (Preload) mit den Backend-Funktionen.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { AiRequest, FileInput, FileTarget } from '../shared/types'
import { toISODate } from '../shared/dates'
import type { Service } from '../backend/service'
import type { Store } from '../backend/store'
import { moodleSsoLogin } from './moodle-sso'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown

/** Nur Anfragen aus der eigenen Oberfläche annehmen */
function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const trusted = url.startsWith('file://') || (devUrl !== undefined && url.startsWith(devUrl))
  if (!trusted) throw new Error('Nicht erlaubt')
}

export function openExternalSafely(url: string): Promise<void> {
  const protocol = new URL(url).protocol
  if (!['https:', 'http:', 'mailto:'].includes(protocol)) throw new Error('Link nicht erlaubt')
  return shell.openExternal(url)
}

export function registerIpc(service: Service, store: Store): void {
  const handlers: Record<string, Handler> = {
    'db:load': service.loadDb,
    'db:put': service.put,
    'db:remove': service.remove,
    'db:update': service.update,
    'note:read': service.readNote,
    'note:write': service.writeNote,
    'annotations:read': service.readAnnotations,
    'annotations:write': service.writeAnnotations,
    'text:read': service.readText,
    'text:write': service.writeText,
    search: service.search,
    'files:add': async (target: FileTarget, inputs: FileInput[]) => {
      const items = []
      for (const input of inputs) items.push(await service.addFile(target, input))
      return items
    },
    'files:open': async (fileName: string) => {
      const error = await shell.openPath(store.filePath(fileName))
      if (error) throw new Error(error)
    },
    'ai:setKey': service.aiSetKey,
    'ai:hasKey': service.aiHasKey,
    'ai:listModels': service.aiListModels,
    'calendar:subscribe': service.calendarSubscribe,
    'calendar:unsubscribe': service.calendarUnsubscribe,
    'calendar:sync': service.calendarSync,
    'calendar:importFile': service.calendarImportFile,
    'moodle:siteInfo': service.moodleSiteInfo,
    'moodle:connect': service.moodleConnect,
    'moodle:connectSso': async (url: string) => {
      const { url: site } = await service.moodleSiteInfo(url)
      const token = await moodleSsoLogin(site, BrowserWindow.getFocusedWindow())
      return service.moodleConnect({ url: site, token })
    },
    'moodle:courses': service.moodleCourses,
    'moodle:sync': service.moodleSync,
    'moodle:disconnect': service.moodleDisconnect,
    'app:openExternal': openExternalSafely,
    'app:dataDir': () => store.dir,
    'app:revealDataDir': async () => {
      await shell.openPath(store.dir)
    },
    'app:backup': async () => {
      const window = BrowserWindow.getFocusedWindow()
      const options = { title: 'Speicherort für das Backup wählen', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      await store.flush()
      const target = path.join(result.filePaths[0], `Study-Organizer-Backup-${toISODate(new Date())}`)
      await fs.cp(store.dir, target, { recursive: true })
      return target
    },
    'app:reset': () => store.reset(),
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event)
      return handler(...args)
    })
  }

  // KI-Antworten werden Stück für Stück an die Oberfläche geschickt.
  const running = new Map<string, AbortController>()
  ipcMain.handle('ai:stream', async (event, requestId: string, request: AiRequest) => {
    assertTrustedSender(event)
    const controller = new AbortController()
    running.set(requestId, controller)
    try {
      return await service.aiStream(
        request,
        (chunk) => {
          if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', requestId, chunk)
        },
        controller.signal,
      )
    } finally {
      running.delete(requestId)
    }
  })
  ipcMain.on('ai:cancel', (event, requestId: string) => {
    assertTrustedSender(event)
    running.get(requestId)?.abort()
  })
}
