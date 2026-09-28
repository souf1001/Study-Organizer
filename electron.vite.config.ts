import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared') }
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

// Die Content-Security-Policy blockiert im Dev-Modus das Hot-Reload-Skript von Vite.
// Sie gilt deshalb nur im fertigen Build.
const stripCspInDev: Plugin = {
  name: 'strip-csp-in-dev',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
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
      // Preload-Skripte in einer Sandbox müssen CommonJS sein
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } },
    plugins: [react(), stripCspInDev],
    define: { __APP_VERSION__: JSON.stringify(version) },
  },
})
