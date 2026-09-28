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

document.documentElement.dataset.platform = navigator.userAgent.includes('Mac') ? 'mac' : 'other'

createRoot(document.getElementById('root')!).render(<App />)
