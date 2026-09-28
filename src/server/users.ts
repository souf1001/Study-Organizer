// Datenbereich pro Konto: eigener Ordner, eigener Speicher und Speicherlimit.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createService, type Service } from '../backend/service'
import { Store } from '../backend/store'
import { assertId } from '../backend/files'
import { config } from './config'
import { safeFetch } from './net-guard'
import { createServerSecrets } from './secrets'

export interface UserSpace {
  dir: string
  store: Store
  service: Service
}

async function folderSize(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await folderSize(full)
    else if (entry.isFile()) total += (await fs.stat(full)).size
  }
  return total
}

export class QuotaError extends Error {
  constructor(used: number, quota: number) {
    const mb = (n: number) => Math.round(n / 1024 / 1024)
    super(`Speicher voll: ${mb(used)} von ${mb(quota)} MB belegt. Lösche nicht mehr benötigte Dateien.`)
  }
}

export class Users {
  private spaces = new Map<string, Promise<UserSpace>>()
  private usageCache = new Map<string, { bytes: number; at: number }>()

  constructor(private readonly root: string) {}

  dir(userId: string): string {
    assertId(userId)
    return path.join(this.root, 'users', userId)
  }

  get(userId: string): Promise<UserSpace> {
    let space = this.spaces.get(userId)
    if (!space) {
      space = (async () => {
        const dir = this.dir(userId)
        const store = await Store.open(path.join(dir, 'data'))
        const secrets = createServerSecrets(path.join(dir, 'secrets.json'), config.secretKey)
        const service = createService(store, secrets, { fetchImpl: safeFetch })
        return { dir, store, service }
      })()
      this.spaces.set(userId, space)
    }
    return space
  }

  async usage(userId: string): Promise<number> {
    const cached = this.usageCache.get(userId)
    if (cached && Date.now() - cached.at < 5_000) return cached.bytes
    const bytes = await folderSize(this.dir(userId))
    this.usageCache.set(userId, { bytes, at: Date.now() })
    return bytes
  }

  /** Wirft, wenn `incoming` Bytes nicht mehr ins Limit passen */
  async reserve(userId: string, incoming: number): Promise<void> {
    const used = await this.usage(userId)
    if (used + incoming > config.quotaBytes) throw new QuotaError(used, config.quotaBytes)
    this.usageCache.set(userId, { bytes: used + incoming, at: Date.now() })
  }

  forgetUsage(userId: string): void {
    this.usageCache.delete(userId)
  }

  async remove(userId: string): Promise<void> {
    const space = await this.spaces.get(userId)
    await space?.store.flush().catch(() => undefined)
    this.spaces.delete(userId)
    this.usageCache.delete(userId)
    await fs.rm(this.dir(userId), { recursive: true, force: true })
  }
}
