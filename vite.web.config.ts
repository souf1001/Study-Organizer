// Build der Oberfläche für die Web-Version (wird vom Server unter / ausgeliefert).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

// Die CSP kommt in der Web-Version als HTTP-Header vom Server
const stripCspMeta: Plugin = {
  name: 'strip-csp-meta',
  transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
}

export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  plugins: [react(), stripCspMeta],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: resolve('out/web'), emptyOutDir: true },
})
