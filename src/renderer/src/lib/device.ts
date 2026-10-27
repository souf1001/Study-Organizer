import { create } from 'zustand'

export type DeviceType = 'phone' | 'tablet' | 'desktop'
export type PlatformType = 'android' | 'mac' | 'other'

export interface DeviceState {
  platform: PlatformType
  device: DeviceType
  isPhone: boolean
  isTablet: boolean
  isDesktop: boolean
  isAndroid: boolean
  width: number
  height: number
}

export function detectDevice(): DeviceState {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
  const isCapacitorAndroid =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { Capacitor?: { getPlatform: () => string } }).Capacitor?.getPlatform() === 'android')
  const isAndroid = ua.includes('android') || isCapacitorAndroid
  const platform: PlatformType = isAndroid ? 'android' : ua.includes('mac') ? 'mac' : 'other'

  const width = typeof window !== 'undefined' ? window.innerWidth : 1024
  const height = typeof window !== 'undefined' ? window.innerHeight : 768
  const minDim = Math.min(width, height)
  const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0))

  let device: DeviceType = 'desktop'
  if (isAndroid) {
    // Android device: tablets have minDim >= 600dp and portrait width >= 600dp (standard Android tablet breakpoint)
    if (minDim < 600 || (width < 768 && height > width)) {
      device = 'phone'
    } else {
      device = 'tablet'
    }
  } else if (isTouch) {
    if (minDim < 600 || width < 768) {
      device = 'phone'
    } else {
      device = 'tablet'
    }
  } else {
    // Non-touch (desktop / responsive tester)
    if (width < 768) {
      device = 'phone'
    } else {
      device = 'desktop'
    }
  }

  return {
    platform,
    device,
    isPhone: device === 'phone',
    isTablet: device === 'tablet',
    isDesktop: device === 'desktop',
    isAndroid,
    width,
    height,
  }
}

export const useDevice = create<DeviceState>(() => detectDevice())

export function syncDeviceAttributes(): DeviceState {
  const state = detectDevice()
  useDevice.setState(state)
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.platform = state.platform
    document.documentElement.dataset.device = state.device
  }
  return state
}
