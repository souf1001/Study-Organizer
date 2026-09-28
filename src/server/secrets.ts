// API-Keys und Tokens pro Konto, verschlüsselt mit AES-256-GCM (Schlüssel aus SECRET_KEY).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Secrets } from '../backend/service'
import { writeAtomic } from '../backend/store'

function encrypt(key: Buffer, value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

function decrypt(key: Buffer, stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function createServerSecrets(file: string, key: Buffer): Secrets {
  let cache: Record<string, string> | null = null
  const load = async () => {
    if (!cache) {
      try {
        cache = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>
      } catch {
        cache = {}
      }
    }
    return cache
  }
  const save = async (all: Record<string, string>) => writeAtomic(file, JSON.stringify(all), 0o600)
  return {
    async get(name) {
      const stored = (await load())[name]
      if (!stored) return null
      try {
        return decrypt(key, stored)
      } catch {
        return null
      }
    },
    async set(name, value) {
      const all = await load()
      all[name] = encrypt(key, value)
      await save(all)
    },
    async remove(name) {
      const all = await load()
      delete all[name]
      await save(all)
    },
  }
}
