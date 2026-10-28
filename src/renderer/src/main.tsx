import './lib/polyfills'
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
import { initApi } from './lib/api'
import { useDevice, watchDevice } from './lib/device'
import { isAndroid } from './lib/platform'
import { useWorkspace } from './lib/workspace'
import { setupAndroid } from './mobile/android'

watchDevice()
if (isAndroid) setupAndroid()
// Phones start with the content; the sidebar is a drawer opened from the bottom navigation
if (useDevice.getState().isPhone) useWorkspace.setState({ sidebarOpen: false })

void initApi().then(() => createRoot(document.getElementById('root')!).render(<App />))
