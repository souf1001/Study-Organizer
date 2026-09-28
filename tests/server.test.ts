// Web-Server: Anmeldung, Trennung der Konten, Speicherlimit, CSRF- und SSRF-Schutz.
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'server-'))
process.env.SECRET_KEY = randomBytes(32).toString('hex')
process.env.USER_QUOTA_MB = '1'
process.env.COOKIE_SECURE = 'false'

const { createApp } = await import('../src/server/index')
const { isBlockedAddress, assertAllowedUrl } = await import('../src/server/net-guard')

let server: Server
let base: string

beforeAll(async () => {
  const app = await createApp('none')
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'StudyOrganizer' }

async function register(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: 'sehr-geheim-123', name: 'Test' }),
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';')[0]
}

const call = (cookie: string, method: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}${url}`, {
    method,
    headers: { ...headers, cookie, ...extra },
    body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
  })

describe('Anmeldung', () => {
  it('lehnt Anfragen ohne Schutz-Header ab (CSRF)', async () => {
    const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(403)
  })

  it('lehnt fremde Herkunft ab', async () => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { ...headers, Origin: 'https://boese.example' }, body: '{}' })
    expect(response.status).toBe(403)
  })

  it('verlangt ein sicheres Passwort', async () => {
    const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers, body: JSON.stringify({ email: 'x@y.de', password: 'kurz' }) })
    expect(response.status).toBe(400)
  })

  it('registriert, meldet an und schützt die Daten', async () => {
    const cookie = await register('anna@uni.de')
    expect(cookie).toMatch(/^sid=/)
    expect((await fetch(`${base}/api/db`)).status).toBe(401)
    const db = await (await call(cookie, 'GET', '/api/db')).json()
    expect(db.onboarded).toBe(false)

    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'anna@uni.de', password: 'falsch-falsch' }) })
    expect(wrong.status).toBe(401)
    const right = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'ANNA@uni.de', password: 'sehr-geheim-123' }) })
    expect(right.status).toBe(200)
  })

  it('beendet die Sitzung beim Abmelden', async () => {
    const cookie = await register('logout@uni.de')
    await call(cookie, 'POST', '/api/auth/logout')
    expect((await call(cookie, 'GET', '/api/db')).status).toBe(401)
  })
})

describe('Konten sind getrennt', () => {
  it('Konto B sieht weder Notizen noch Dateien von Konto A', async () => {
    const a = await register('a@uni.de')
    const b = await register('b@uni.de')
    await call(a, 'PUT', '/api/notes/n1', { content: null, strokes: [], paper: 'plain', paperColor: 'auto', font: 'inter', height: 1000, text: 'Geheime Notiz' })
    const upload = await call(a, 'POST', '/api/files?moduleId=m1&name=folie.pdf', new Uint8Array([37, 80, 68, 70]), { 'Content-Type': 'application/pdf' })
    const item = await upload.json()

    expect(await (await call(b, 'GET', '/api/notes/n1')).json()).toBeNull()
    expect((await call(b, 'GET', `/api/files/${item.fileName}`)).status).toBe(404)
    expect((await call(a, 'GET', `/api/files/${item.fileName}`)).status).toBe(200)
    expect(await (await call(b, 'GET', '/api/search?q=Geheime')).json()).toEqual([])
  })

  it('verhindert Pfad-Tricks', async () => {
    const a = await register('pfad@uni.de')
    expect((await call(a, 'GET', '/api/files/..%2F..%2Faccounts.json')).status).toBe(404)
    expect((await call(a, 'GET', '/api/notes/..%2F..%2Faccounts')).status).toBe(400)
  })

  it('liefert unbekannte Dateitypen nur als Download und mit Sandbox-CSP aus', async () => {
    const a = await register('html@uni.de')
    const html = new TextEncoder().encode('<script>alert(1)</script>')
    const item = await (await call(a, 'POST', '/api/files?moduleId=m1&name=seite.html', html, { 'Content-Type': 'text/html' })).json()
    const response = await call(a, 'GET', `/api/files/${item.fileName}`)
    expect(response.headers.get('content-type')).toContain('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
  })
})

describe('Speicherlimit', () => {
  it('lehnt Dateien ab, die nicht mehr ins Kontingent passen', async () => {
    const a = await register('voll@uni.de')
    const big = new Uint8Array(1_200_000)
    const response = await call(a, 'POST', '/api/files?moduleId=m1&name=gross.pdf', big, { 'Content-Type': 'application/pdf' })
    expect(response.status).toBe(413)
    expect((await response.json()).error).toContain('Speicher voll')
    const usage = await (await call(a, 'GET', '/api/account/usage')).json()
    expect(usage.quota).toBe(1024 * 1024)
  })
})

describe('Schutz vor internen Adressen (SSRF)', () => {
  it('erkennt private und lokale Adressen', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
    for (const ip of ['8.8.8.8', '141.100.1.1', '2a00:1450:4001::1']) expect(isBlockedAddress(ip)).toBe(false)
  })

  it('lehnt interne Ziele und andere Protokolle ab', () => {
    expect(() => assertAllowedUrl(new URL('http://localhost:3000/'))).toThrow()
    expect(() => assertAllowedUrl(new URL('http://[::1]/'))).toThrow()
    expect(() => assertAllowedUrl(new URL('file:///etc/passwd'))).toThrow()
    expect(() => assertAllowedUrl(new URL('https://lernen.h-da.de/'))).not.toThrow()
  })

  it('Kalender-Abos auf interne Adressen schlagen fehl', async () => {
    const a = await register('ssrf@uni.de')
    const sub = await (await call(a, 'POST', '/api/calendar/subscribe', { name: 'x', url: 'http://127.0.0.1:22/' })).json()
    expect(sub.lastError).toContain('Interne Adressen')
  })
})
