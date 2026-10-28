// Electron main process: window, data store, file protocol and periodic background sync.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, nativeTheme, session, shell } from 'electron'
import { startBackgroundSync } from '../backend/background-sync'
import { createService } from '../backend/service'
import { Store } from '../backend/store'
import { registerIpc } from './ipc'
import { handleFileProtocol, registerSchemePrivileges } from './protocol'
import { createSecrets } from './secrets'

const here = path.dirname(fileURLToPath(import.meta.url))

// Custom data folder (e.g. for tests or a portable installation): the browser profile and the
// encrypted keys then live there as well instead of in the user profile.
const customDataDir = process.env.STUDY_ORGANIZER_DATA
if (customDataDir) app.setPath('userData', path.join(customDataDir, 'electron-profile'))

registerSchemePrivileges()
// German date and time inputs (DD.MM.YYYY, 24-hour clock)
app.commandLine.appendSwitch('lang', 'de-DE')

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Study Organizer',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Always open links in the browser, never inside the app window
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl)
  else void window.loadFile(path.join(here, '../renderer/index.html'))
  return window
}

function setupMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'Ansicht',
        submenu: [
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  await app.whenReady()

  const userData = app.getPath('userData')
  const store = await Store.open(customDataDir ?? path.join(userData, 'data'))
  const service = createService(store, createSecrets(path.join(userData, 'secrets.json')))

  handleFileProtocol(store)
  registerIpc(service, store)
  setupMenu()

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
  })
  if (process.platform !== 'darwin')
    session.defaultSession.setSpellCheckerLanguages(['de-DE', 'en-US'])

  mainWindow = createWindow()
  startBackgroundSync(service, store, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('db:changed')
  })

  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Write all pending changes to disk before quitting
  let flushed = false
  app.on('before-quit', (event) => {
    if (flushed) return
    event.preventDefault()
    void store.flush().finally(() => {
      flushed = true
      app.quit()
    })
  })
}

void main()
