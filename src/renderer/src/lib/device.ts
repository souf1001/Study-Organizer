// Layout class of the device: phone (single pane, bottom navigation), tablet or desktop.
//
// On Android the class is decided by the *screen* size, never by the window size. When the
// on-screen keyboard opens, the WebView shrinks. Classifying by window height used to switch a
// tablet into the phone layout while typing; the whole view was remounted and the text field
// lost focus ("kicked out" right after tapping it).
import { create } from 'zustand'
import { isAndroid } from './platform'

export type DeviceType = 'phone' | 'tablet' | 'desktop'

/** Android's own threshold: devices whose short side has at least 600dp are tablets */
const TABLET_MIN_SHORT_SIDE = 600
/** Desktop windows narrower than this use the phone layout */
const DESKTOP_MIN_WIDTH = 768

function detectDeviceType(): DeviceType {
  if (isAndroid) {
    const shortSide = Math.min(window.screen.width, window.screen.height)
    return shortSide >= TABLET_MIN_SHORT_SIDE ? 'tablet' : 'phone'
  }
  // Only the width matters: desktop has no on-screen keyboard that changes the height
  return window.innerWidth < DESKTOP_MIN_WIDTH ? 'phone' : 'desktop'
}

interface DeviceState {
  device: DeviceType
  isPhone: boolean
}

const stateFor = (device: DeviceType): DeviceState => ({ device, isPhone: device === 'phone' })

export const useDevice = create<DeviceState>(() => stateFor(detectDeviceType()))

/** Keeps `useDevice` and the `data-device`/`data-platform` attributes on <html> up to date */
export function watchDevice(): void {
  const root = document.documentElement
  root.dataset.platform = isAndroid
    ? 'android'
    : navigator.userAgent.includes('Mac')
      ? 'mac'
      : 'other'
  const sync = () => {
    const device = detectDeviceType()
    root.dataset.device = device
    if (useDevice.getState().device !== device) useDevice.setState(stateFor(device))
  }
  sync()
  window.addEventListener('resize', sync)
}
