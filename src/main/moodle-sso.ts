// Desktop Moodle SSO: shows Moodle's launch page in a separate window and catches the final
// moodlemobile:// redirect before the operating system tries to handle it.
import { BrowserWindow, session } from 'electron'
import {
  MOODLE_LAUNCH_SCHEME,
  createPassport,
  moodleLaunchUrl,
  parseLaunchToken,
} from '../shared/moodle-launch'

export { parseLaunchToken }

export function moodleSsoLogin(site: string, parent: BrowserWindow | null): Promise<string> {
  const passport = createPassport()

  // Third-party login pages get no permissions (camera, microphone, notifications …)
  session
    .fromPartition('moodle-sso')
    .setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent ?? undefined,
      modal: Boolean(parent),
      title: 'Moodle-Anmeldung',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'moodle-sso',
      },
    })
    let settled = false
    const finish = (error: Error | null, token?: string) => {
      if (settled) return
      settled = true
      if (!window.isDestroyed()) window.close()
      if (error) reject(error)
      else resolve(token!)
    }
    const check = (event: { preventDefault: () => void }, url: string) => {
      if (!url.startsWith(MOODLE_LAUNCH_SCHEME)) return
      event.preventDefault()
      try {
        const token = parseLaunchToken(url, site, passport)
        if (token) finish(null, token)
      } catch (error) {
        finish(error as Error)
      }
    }
    window.webContents.on('will-redirect', check)
    window.webContents.on('will-navigate', check)
    window.webContents.on('did-fail-load', (_e, _code, _desc, url) => {
      if (url.startsWith(MOODLE_LAUNCH_SCHEME)) check({ preventDefault: () => undefined }, url)
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      check({ preventDefault: () => undefined }, url)
      return { action: 'deny' }
    })
    window.on('closed', () => finish(new Error('Anmeldung abgebrochen.')))
    void window.loadURL(moodleLaunchUrl(site, passport))
  })
}
