// Web-Version: liefert die Oberfläche aus und stellt die API bereit.
import { existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { Accounts } from './accounts'
import { config } from './config'
import { apiRouter } from './routes'
import { Users } from './users'

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

type ClientMode = 'vite' | 'static' | 'none'

/** client: 'vite' = Entwicklung mit Hot-Reload, 'static' = fertiger Build aus out/web, 'none' = nur API (Tests) */
export async function createApp(client: ClientMode = config.production ? 'static' : 'vite'): Promise<express.Express> {
  const accounts = await Accounts.open(config.dataDir)
  const users = new Users(config.dataDir)
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', 1)

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    next()
  })

  app.use('/api', apiRouter(accounts, users))

  if (client === 'vite') {
    // Entwicklung: Vite liefert die Oberfläche mit Hot-Reload aus
    const { createServer } = await import('vite')
    const vite = await createServer({ configFile: 'vite.web.config.ts', server: { middlewareMode: true }, appType: 'spa' })
    app.use(vite.middlewares)
  } else if (client === 'static') {
    const web = path.resolve('out/web')
    if (!existsSync(web)) throw new Error('out/web fehlt – zuerst `npm run web:build` ausführen.')
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', CSP)
      next()
    })
    app.use(express.static(web, { index: false, maxAge: '7d', immutable: true }))
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(path.join(web, 'index.html'))
    })
  }
  return app
}

if (process.env.NODE_ENV !== 'test') {
  const app = await createApp()
  // Entwicklung nur auf diesem Rechner erreichbar, in Produktion (Docker) für den Reverse-Proxy
  const host = config.production ? '0.0.0.0' : '127.0.0.1'
  app.listen(config.port, host, () => console.log(`Study Organizer läuft auf http://localhost:${config.port}`))
}
