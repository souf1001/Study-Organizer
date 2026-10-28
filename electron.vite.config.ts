import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared'), '@backend': resolve('src/backend') }
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

// The Content Security Policy blocks Vite's hot-reload script in dev mode,
// so it only applies to the production build.
const stripCspInDev: Plugin = {
  name: 'strip-csp-in-dev',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
}

// The desktop renderer never talks to the internet itself (the main process does), so its CSP
// forbids it. In the Android app the backend runs inside the WebView and must reach Moodle,
// calendar feeds and AI providers: `--mode android` allows remote connections.
function allowRemoteConnectionsOnAndroid(): Plugin {
  let isAndroid = false
  return {
    name: 'allow-remote-connections-on-android',
    configResolved: (config) => {
      isAndroid = config.mode === 'android'
    },
    transformIndexHtml: (html) =>
      isAndroid ? html.replace("connect-src 'self'", "connect-src 'self' https: http:") : html,
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      // Sandboxed preload scripts must be CommonJS
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } },
    plugins: [react(), stripCspInDev, allowRemoteConnectionsOnAndroid()],
    define: { __APP_VERSION__: JSON.stringify(version) },
  },
})
