import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4'
import '@fontsource-variable/literata'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/caveat/400.css'
import '@fontsource/caveat/600.css'
import '@fontsource/atkinson-hyperlegible/400.css'
import '@fontsource/atkinson-hyperlegible/700.css'
import './styles/tokens.css'
import './styles/base.css'
import './ui/ui.css'
import './shell/shell.css'
import { App } from './App'

function detectEnvironment(): { platform: 'android' | 'mac' | 'other'; device: 'phone' | 'tablet' | 'desktop' } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
  const isCapacitorAndroid =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { Capacitor?: { getPlatform: () => string } }).Capacitor?.getPlatform() === 'android')
  const isAndroid = ua.includes('android') || isCapacitorAndroid
  const platform = isAndroid ? 'android' : ua.includes('mac') ? 'mac' : 'other'

  const width = typeof window !== 'undefined' ? window.innerWidth : 1024
  const height = typeof window !== 'undefined' ? window.innerHeight : 768
  const minDim = Math.min(width, height)
  const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

  const isPhone = (isTouch && (minDim < 600 || width < 768)) || (!isTouch && width < 600)
  const isTablet = isTouch && !isPhone
  const device = isPhone ? 'phone' : isTablet ? 'tablet' : 'desktop'

  return { platform, device }
}

function applyDeviceAttributes() {
  const { platform, device } = detectEnvironment()
  document.documentElement.dataset.platform = platform
  document.documentElement.dataset.device = device
}

applyDeviceAttributes()
if (typeof window !== 'undefined') {
  window.addEventListener('resize', applyDeviceAttributes)
}

createRoot(document.getElementById('root')!).render(<App />)
