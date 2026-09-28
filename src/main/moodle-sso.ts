// Moodle-Anmeldung über den Hochschul-Login (SSO/Shibboleth) – wie bei der offiziellen Moodle-App:
// Moodle leitet nach dem Login auf moodlemobile://token=<base64> weiter. Diese Weiterleitung
// fangen wir im Anmeldefenster ab, bevor das Betriebssystem sie verarbeitet.
import { createHash, randomBytes } from 'node:crypto'
import { BrowserWindow, session } from 'electron'

const md5 = (value: string) => createHash('md5').update(value).digest('hex')

/** Liest den Token aus der Weiterleitung und prüft die Signatur md5(wwwroot + passport) */
export function parseLaunchToken(url: string, site: string, passport: string): string | null {
  const match = /^moodlemobile:\/\/token=([A-Za-z0-9+/=_-]+)/.exec(url)
  if (!match) return null
  const [signature, token] = Buffer.from(match[1], 'base64').toString('utf8').split(':::')
  const variants = [site, site.replace(/^https:/, 'http:')]
  if (!token || !variants.some((v) => md5(v + passport) === signature)) {
    throw new Error('Die Antwort von Moodle konnte nicht bestätigt werden.')
  }
  return token
}

export function moodleSsoLogin(site: string, parent: BrowserWindow | null): Promise<string> {
  const passport = randomBytes(8).toString('hex')
  const launch = `${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`

  // Fremde Anmeldeseiten bekommen keine Berechtigungen (Kamera, Mikrofon, Benachrichtigungen …)
  session.fromPartition('moodle-sso').setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent ?? undefined,
      modal: Boolean(parent),
      title: 'Moodle-Anmeldung',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'moodle-sso' },
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
      if (!url.startsWith('moodlemobile://')) return
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
      if (url.startsWith('moodlemobile://')) check({ preventDefault: () => undefined }, url)
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      check({ preventDefault: () => undefined }, url)
      return { action: 'deny' }
    })
    window.on('closed', () => finish(new Error('Anmeldung abgebrochen.')))
    void window.loadURL(launch)
  })
}
