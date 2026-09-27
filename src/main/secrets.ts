// API-Keys und Tokens verschlüsselt ablegen (Schlüsselbund von macOS, DPAPI unter Windows, libsecret unter Linux).
import { promises as fs } from 'node:fs'
import { safeStorage } from 'electron'
import type { Secrets } from '../backend/service'

export function createSecrets(file: string): Secrets {
  let cache: Record<string, string> | null = null

  async function load(): Promise<Record<string, string>> {
    if (!cache) {
      try {
        cache = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>
      } catch {
        cache = {}
      }
    }
    return cache
  }

  async function save(all: Record<string, string>): Promise<void> {
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(all), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, file)
  }

  const encode = (value: string): string =>
    safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(value).toString('base64')}`
      : `raw:${value}`

  const decode = (stored: string): string =>
    stored.startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      : stored.slice(4)

  return {
    async get(name) {
      const stored = (await load())[name]
      if (!stored) return null
      try {
        return decode(stored)
      } catch {
        return null
      }
    },
    async set(name, value) {
      const all = await load()
      all[name] = encode(value)
      await save(all)
    },
    async remove(name) {
      const all = await load()
      delete all[name]
      await save(all)
    },
  }
}
