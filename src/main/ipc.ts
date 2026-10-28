// Connects the UI (preload script) to the backend service.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import {
  setupFileName,
  SETUP_FILE_EXTENSION,
  type SetupExportOptions,
} from '../shared/setup-bundle'
import type { AiRequest, FileInput, FileTarget } from '../shared/types'
import { toISODate } from '../shared/dates'
import { isSafeToOpen } from '../backend/files'
import type { Service } from '../backend/service'
import type { Store } from '../backend/store'
import { moodleSsoLogin } from './moodle-sso'
import { startTucanWizard } from './tucan-session'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown

/** Only accept requests from our own UI */
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

/** Lets the user pick a location and writes the setup file there */
async function exportSetup(service: Service, options: SetupExportOptions): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow()
  const dialogOptions = {
    title: 'Einrichtung exportieren',
    defaultPath: setupFileName(),
    filters: [{ name: 'Study-Organizer-Einrichtung', extensions: [SETUP_FILE_EXTENSION.slice(1)] }],
  }
  const result = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (result.canceled || !result.filePath) return null
  const file = await service.setupExport(options)
  await fs.writeFile(result.filePath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
  return result.filePath
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
      const file = store.filePath(fileName)
      if (!isSafeToOpen(fileName)) {
        const item = store.get().items.find((i) => i.fileName === fileName)
        const window = BrowserWindow.getFocusedWindow()
        const options = {
          type: 'warning' as const,
          buttons: ['Abbrechen', 'Im Ordner zeigen', 'Trotzdem öffnen'],
          defaultId: 0,
          cancelId: 0,
          title: 'Datei öffnen?',
          message: `„${item?.title ?? fileName}“ ist kein Dokument, sondern möglicherweise ein Programm oder Skript (.${fileName.split('.').pop()}).`,
          detail: 'Öffne solche Dateien nur, wenn du ihrer Herkunft vertraust.',
        }
        const { response } = window
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options)
        if (response === 0) return
        if (response === 1) return shell.showItemInFolder(file)
      }
      const error = await shell.openPath(file)
      if (error) throw new Error(error)
    },
    'ai:setKey': service.aiSetKey,
    'ai:hasKey': service.aiHasKey,
    'ai:listModels': service.aiListModels,
    'calendar:subscribe': service.calendarSubscribe,
    'calendar:unsubscribe': service.calendarUnsubscribe,
    'calendar:removeSubscription': service.calendarUnsubscribe,
    'calendar:sync': service.calendarSync,
    'calendar:importFile': service.calendarImportFile,
    'calendar:rematchEvents': service.calendarRematchEvents,
    'tucan:startWizard': () => startTucanWizard(service, BrowserWindow.getFocusedWindow()),
    'moodle:siteInfo': service.moodleSiteInfo,
    'moodle:connect': service.moodleConnect,
    'moodle:connectSso': async (url: string) => {
      const { url: site } = await service.moodleSiteInfo(url)
      const token = await moodleSsoLogin(site, BrowserWindow.getFocusedWindow())
      return service.moodleConnect({ url: site, token })
    },
    'moodle:courses': service.moodleCourses,
    'moodle:sync': service.moodleSync,
    'moodle:posts': (_e: unknown, discussionId: number) => service.moodlePosts(discussionId),
    'moodle:reply': (_e: unknown, postId: number, subject: string, message: string) =>
      service.moodleReply(postId, subject, message),
    'moodle:disconnect': service.moodleDisconnect,
    'app:openExternal': openExternalSafely,
    'app:dataDir': () => store.dir,
    'app:revealDataDir': async () => {
      await shell.openPath(store.dir)
    },
    'app:documentsDir': () => store.documentsDir,
    'app:revealDocuments': async (target?: { moduleId: string; folderId?: string | null }) => {
      const dir = target ? await store.directoryOf(target) : store.documentsDir
      await fs.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
    },
    'app:revealDocument': async (itemId: string) => {
      const file = store.documentPath(itemId)
      if (!file) throw new Error('Die Datei liegt noch nicht im Dokumente-Ordner.')
      shell.showItemInFolder(file)
    },
    'app:chooseDocumentsDir': async () => {
      const window = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Neuen Ordner für deine Unterlagen wählen',
        defaultPath: path.dirname(store.documentsDir),
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      const picked = result.filePaths[0]
      await store.setDocumentsDir(
        path.basename(picked) === 'Study Organizer' ? picked : path.join(picked, 'Study Organizer'),
      )
      return store.documentsDir
    },
    'app:backup': async () => {
      const window = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Speicherort für das Backup wählen',
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      await store.flush()
      const target = path.join(
        result.filePaths[0],
        `Study-Organizer-Backup-${toISODate(new Date())}`,
      )
      await store.syncDocuments()
      await fs.cp(store.dir, path.join(target, 'App-Daten'), { recursive: true })
      await fs.cp(store.documentsDir, path.join(target, 'Dokumente'), { recursive: true })
      return target
    },
    'app:reset': () => store.reset(),
    'setup:export': (options: SetupExportOptions) => exportSetup(service, options),
    'setup:import': (content: string, password?: string) => service.setupImport(content, password),
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event)
      return handler(...args)
    })
  }

  // AI answers are streamed to the UI chunk by chunk.
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
