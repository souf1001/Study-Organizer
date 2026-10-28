// Which shell the UI runs in: the Electron desktop app or the Capacitor Android app.
import { Capacitor } from '@capacitor/core'

export const isAndroid = Capacitor.getPlatform() === 'android'
