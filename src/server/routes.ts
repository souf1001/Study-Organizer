// HTTP-Schnittstelle. Jede Route arbeitet nur im Datenbereich des angemeldeten Kontos.
import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import express, { type NextFunction, type Request, type Response, type Router } from 'express'
import { COLLECTIONS, type CollectionName } from '../shared/types'
import { detectFile, mimeForFileName } from '../backend/files'
import { Accounts, publicUser, validateCredentials, verifyPassword, type User } from './accounts'
import { config } from './config'
import { QuotaError, Users, type UserSpace } from './users'

const SESSION_COOKIE = 'sid'
const JSON_LIMIT = '20mb'

declare module 'express-serve-static-core' {
  interface Request {
    user?: User
    space?: UserSpace
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return undefined
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionDays * 86_400_000,
  })
}

/** Async-Handler mit einheitlicher Fehlerbehandlung */
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res))
      .then((result) => {
        // undefined = Aktion ohne Rückgabe; null bleibt null (z. B. Notiz existiert noch nicht)
        if (!res.headersSent) res.json(result === undefined ? { ok: true } : result)
      })
      .catch(next)
  }

/** Einfache Bremse gegen Passwort-Raten: 10 Fehlversuche pro 15 Minuten und IP */
const failures = new Map<string, { count: number; until: number }>()
function checkThrottle(ip: string): void {
  const entry = failures.get(ip)
  if (entry && entry.until > Date.now() && entry.count >= 10) {
    throw Object.assign(new Error('Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.'), { status: 429 })
  }
}
function recordFailure(ip: string): void {
  const entry = failures.get(ip)
  const fresh = !entry || entry.until < Date.now()
  failures.set(ip, { count: fresh ? 1 : entry.count + 1, until: fresh ? Date.now() + 15 * 60_000 : entry.until })
}

const str = (value: unknown, max = 10_000): string => {
  if (typeof value !== 'string') throw Object.assign(new Error('Ungültige Eingabe'), { status: 400 })
  return value.slice(0, max)
}

export function apiRouter(accounts: Accounts, users: Users): Router {
  const api = express.Router()
  api.use(express.json({ limit: JSON_LIMIT }))

  // Schutz vor Cross-Site-Anfragen: eigener Header (erzwingt CORS-Preflight) + passende Herkunft
  api.use((req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next()
    const origin = req.headers.origin
    const host = req.headers.host
    if (req.headers['x-requested-with'] !== 'StudyOrganizer' || (origin && host && new URL(origin).host !== host)) {
      return next(Object.assign(new Error('Anfrage nicht erlaubt'), { status: 403 }))
    }
    next()
  })

  // ---- Anmeldung ----
  api.get('/auth/status', (req, res) => {
    const user = accounts.userForToken(readCookie(req, SESSION_COOKIE))
    res.json({ user: user ? publicUser(user) : null, allowRegistration: config.allowRegistration })
  })

  api.post(
    '/auth/register',
    handle(async (req, res) => {
      if (!config.allowRegistration) throw Object.assign(new Error('Registrierung ist deaktiviert.'), { status: 403 })
      const email = str(req.body.email, 200)
      const password = str(req.body.password, 500)
      const problem = validateCredentials(email, password)
      if (problem) throw Object.assign(new Error(problem), { status: 400 })
      const user = await accounts.create(email, password, str(req.body.name ?? '', 100))
      setSessionCookie(res, await accounts.createSession(user.id, config.sessionDays))
      return { user: publicUser(user) }
    }),
  )

  api.post(
    '/auth/login',
    handle(async (req, res) => {
      const ip = req.ip ?? 'unknown'
      checkThrottle(ip)
      const user = accounts.findByEmail(str(req.body.email, 200))
      const ok = user ? await verifyPassword(str(req.body.password, 500), user.passwordHash) : false
      if (!user || !ok) {
        recordFailure(ip)
        throw Object.assign(new Error('E-Mail oder Passwort ist falsch.'), { status: 401 })
      }
      setSessionCookie(res, await accounts.createSession(user.id, config.sessionDays))
      return { user: publicUser(user) }
    }),
  )

  api.post(
    '/auth/logout',
    handle(async (req, res) => {
      await accounts.endSession(readCookie(req, SESSION_COOKIE))
      res.clearCookie(SESSION_COOKIE, { path: '/' })
      return { ok: true }
    }),
  )

  // Ab hier nur mit gültiger Sitzung
  api.use((req, _res, next) => {
    const user = accounts.userForToken(readCookie(req, SESSION_COOKIE))
    if (!user) return next(Object.assign(new Error('Bitte anmelden.'), { status: 401 }))
    req.user = user
    users
      .get(user.id)
      .then((space) => {
        req.space = space
        next()
      })
      .catch(next)
  })

  const service = (req: Request) => req.space!.service
  const userId = (req: Request) => req.user!.id

  api.post(
    '/auth/password',
    handle(async (req, res) => {
      const next = str(req.body.next, 500)
      if (!(await verifyPassword(str(req.body.current, 500), req.user!.passwordHash))) {
        throw Object.assign(new Error('Aktuelles Passwort ist falsch.'), { status: 400 })
      }
      const problem = validateCredentials(req.user!.email, next)
      if (problem) throw Object.assign(new Error(problem), { status: 400 })
      await accounts.changePassword(userId(req), next)
      setSessionCookie(res, await accounts.createSession(userId(req), config.sessionDays))
      return { ok: true }
    }),
  )

  api.post(
    '/auth/delete',
    handle(async (req, res) => {
      if (!(await verifyPassword(str(req.body.password, 500), req.user!.passwordHash))) {
        throw Object.assign(new Error('Passwort ist falsch.'), { status: 400 })
      }
      await users.remove(userId(req))
      await accounts.remove(userId(req))
      res.clearCookie(SESSION_COOKIE, { path: '/' })
      return { ok: true }
    }),
  )

  api.get(
    '/account/usage',
    handle(async (req) => ({ used: await users.usage(userId(req)), quota: config.quotaBytes, email: req.user!.email })),
  )

  // ---- Daten ----
  const collection = (value: string): CollectionName => {
    if (!(COLLECTIONS as readonly string[]).includes(value)) throw Object.assign(new Error('Unbekannte Sammlung'), { status: 400 })
    return value as CollectionName
  }
  const jsonSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null))

  api.get('/db', handle((req) => service(req).loadDb()))
  api.put(
    '/records/:collection',
    handle(async (req) => {
      await users.reserve(userId(req), jsonSize(req.body))
      service(req).put(collection(String(req.params.collection)), req.body)
    }),
  )
  api.delete(
    '/records/:collection/:id',
    handle(async (req) => {
      await service(req).remove(collection(String(req.params.collection)), String(req.params.id))
      users.forgetUsage(userId(req))
    }),
  )
  api.patch('/db', handle((req) => service(req).update(req.body)))

  api.get('/notes/:id', handle((req) => service(req).readNote(String(req.params.id))))
  api.put(
    '/notes/:id',
    handle(async (req) => {
      await users.reserve(userId(req), jsonSize(req.body))
      await service(req).writeNote(String(req.params.id), req.body)
    }),
  )
  api.get('/annotations/:id', handle((req) => service(req).readAnnotations(String(req.params.id))))
  api.put(
    '/annotations/:id',
    handle(async (req) => {
      await users.reserve(userId(req), jsonSize(req.body))
      await service(req).writeAnnotations(String(req.params.id), req.body)
    }),
  )
  api.get('/text/:id', handle(async (req) => ({ text: await service(req).readText(String(req.params.id)) })))
  api.put(
    '/text/:id',
    handle(async (req) => {
      const text = str(req.body.text, 5_000_000)
      await users.reserve(userId(req), Buffer.byteLength(text))
      await service(req).writeText(String(req.params.id), text)
    }),
  )
  api.get('/search', handle((req) => service(req).search(String(req.query.q ?? ''))))

  // ---- Dateien ----
  api.post(
    '/files',
    handle(async (req) => {
      const length = Number(req.headers['content-length'] ?? 0)
      if (!length) throw Object.assign(new Error('Leere Datei'), { status: 411 })
      if (length > config.maxUploadBytes) {
        throw Object.assign(new Error(`Datei zu groß (höchstens ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB).`), { status: 413 })
      }
      await users.reserve(userId(req), length)
      const tmpDir = path.join(req.space!.dir, 'tmp')
      await fs.mkdir(tmpDir, { recursive: true })
      const tmp = path.join(tmpDir, randomUUID())
      let received = 0
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          callback(received > length ? new Error('Datei größer als angegeben') : null, chunk)
        },
      })
      try {
        await pipeline(req, limit, createWriteStream(tmp))
        const q = req.query as Record<string, string | undefined>
        return await service(req).addFile(
          { moduleId: str(q.moduleId, 64), folderId: q.folderId || null, attachedTo: q.attachedTo || null },
          { name: str(q.name ?? 'Datei', 255), type: str(req.headers['content-type'] ?? '', 200), path: tmp },
        )
      } finally {
        await fs.rm(tmp, { force: true })
        users.forgetUsage(userId(req))
      }
    }),
  )

  api.get('/files/:name', (req, res, next) => {
    let file: string
    try {
      file = req.space!.store.filePath(String(req.params.name))
    } catch {
      return res.status(404).end()
    }
    const { fileType } = detectFile(file)
    const inline = fileType !== 'other' && req.query.download === undefined
    res.setHeader('Content-Type', mimeForFileName(file))
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
    res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment')
    res.setHeader('Cache-Control', 'private, max-age=0')
    res.sendFile(file, { dotfiles: 'deny', acceptRanges: true }, (error) => {
      if (error && !res.headersSent) next(Object.assign(error, { status: 404 }))
    })
  })

  // ---- KI (Antwort wird als Text gestreamt) ----
  api.post('/ai/key', handle((req) => service(req).aiSetKey(str(req.body.provider, 50), str(req.body.key ?? '', 1000))))
  api.get('/ai/key/:provider', handle(async (req) => ({ hasKey: await service(req).aiHasKey(String(req.params.provider)) })))
  api.get('/ai/models', handle((req) => service(req).aiListModels()))
  api.post('/ai/stream', async (req, res) => {
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    try {
      await service(req).aiStream(
        req.body,
        (chunk) => {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('X-Accel-Buffering', 'no')
          }
          res.write(chunk)
        },
        controller.signal,
      )
      res.end()
    } catch (error) {
      const message = (error as Error).message
      if (!res.headersSent) res.status(400).json({ error: message })
      else res.end(`\u0000${JSON.stringify({ error: message })}`)
    }
  })

  // ---- Kalender & Moodle ----
  api.post('/calendar/subscribe', handle((req) => service(req).calendarSubscribe(str(req.body.name ?? '', 200), str(req.body.url, 2000))))
  api.delete('/calendar/:id', handle((req) => service(req).calendarUnsubscribe(String(req.params.id))))
  api.post('/calendar/:id/sync', handle((req) => service(req).calendarSync(String(req.params.id))))
  api.post(
    '/calendar/import',
    handle(async (req) => {
      const text = str(req.body.text, 10_000_000)
      await users.reserve(userId(req), Buffer.byteLength(text) / 4)
      return service(req).calendarImportFile(str(req.body.name, 255), text)
    }),
  )
  api.post('/moodle/site-info', handle((req) => service(req).moodleSiteInfo(str(req.body.url, 500))))
  api.post('/moodle/connect', handle((req) => service(req).moodleConnect(req.body)))
  api.get('/moodle/courses', handle((req) => service(req).moodleCourses()))
  api.post(
    '/moodle/sync',
    handle(async (req) => {
      const result = await service(req).moodleSync()
      users.forgetUsage(userId(req))
      return result
    }),
  )
  api.post('/moodle/disconnect', handle((req) => service(req).moodleDisconnect()))

  // ---- Daten exportieren / zurücksetzen ----
  api.get(
    '/export',
    handle(async (req, res) => {
      const db = service(req).loadDb()
      const notes: Record<string, unknown> = {}
      for (const item of db.items.filter((i) => i.kind === 'note')) notes[item.id] = await service(req).readNote(item.id)
      res.setHeader('Content-Disposition', `attachment; filename="study-organizer-export-${new Date().toISOString().slice(0, 10)}.json"`)
      return { exportedAt: new Date().toISOString(), db, notes }
    }),
  )
  api.post(
    '/reset',
    handle(async (req) => {
      await req.space!.store.reset()
      users.forgetUsage(userId(req))
    }),
  )

  // Fehler als JSON
  api.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    void _next
    const status = error instanceof QuotaError ? 413 : error.type === 'entity.too.large' ? 413 : (error.status ?? 400)
    if (status >= 500) console.error(error)
    res.status(status).json({ error: error.message })
  })

  return api
}
