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

// `--mode android` builds the renderer for the Android app (see npm run build:android):
// - The desktop renderer never talks to the internet itself (the main process does), so its CSP
//   forbids it. On Android the backend runs inside the WebView and must reach Moodle, calendar
//   feeds and AI providers, so remote connections are allowed.
// - Electron always ships a current Chromium, but a tablet's WebView can be older: the Android
//   build is transpiled for an older engine.
const ANDROID_WEBVIEW_TARGET = 'chrome100'

function allowRemoteConnections(): Plugin {
  return {
    name: 'allow-remote-connections',
    transformIndexHtml: (html) =>
      html.replace("connect-src 'self'", "connect-src 'self' https: http:"),
  }
}

export default defineConfig(({ mode }) => {
  const isAndroid = mode === 'android'
  return {
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
      plugins: [react(), stripCspInDev, ...(isAndroid ? [allowRemoteConnections()] : [])],
      define: { __APP_VERSION__: JSON.stringify(version) },
      // The pdf.js worker is an ES module (see lib/pdf.ts)
      worker: { format: 'es' as const },
      ...(isAndroid ? { build: { target: ANDROID_WEBVIEW_TARGET } } : {}),
    },
  }
})
