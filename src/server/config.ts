// Einstellungen des Servers über Umgebungsvariablen (siehe .env.example).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const env = process.env
const production = env.NODE_ENV === 'production'
const dataDir = path.resolve(env.DATA_DIR ?? './data')
mkdirSync(dataDir, { recursive: true })

/** 32-Byte-Schlüssel für die Verschlüsselung von API-Keys. In Produktion Pflicht. */
function secretKey(): Buffer {
  if (env.SECRET_KEY) {
    const key = Buffer.from(env.SECRET_KEY, 'hex')
    if (key.length !== 32) throw new Error('SECRET_KEY muss 64 Hex-Zeichen lang sein (openssl rand -hex 32).')
    return key
  }
  if (production) throw new Error('SECRET_KEY fehlt. Erzeugen mit: openssl rand -hex 32')
  // Entwicklung: Schlüssel einmal erzeugen und im Datenordner merken
  const file = path.join(dataDir, '.dev-secret-key')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
}

export const config = {
  production,
  port: Number(env.PORT ?? 3000),
  dataDir,
  secretKey: secretKey(),
  /** Speicher pro Konto in Bytes */
  quotaBytes: Number(env.USER_QUOTA_MB ?? 500) * 1024 * 1024,
  /** Größte einzelne Datei in Bytes */
  maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024,
  allowRegistration: env.ALLOW_REGISTRATION !== 'false',
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
  /** Hinter einem Reverse-Proxy (Caddy, nginx) für die echte Client-IP */
  trustProxy: env.TRUST_PROXY === 'true',
  /**
   * Zugriffe auf interne Adressen erlauben (z. B. Ollama im Heimnetz). Nur für private
   * Installationen, bei denen allen Konten vertraut wird.
   */
  allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK === 'true',
}
