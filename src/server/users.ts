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

/** Größe eines Ordners; der tmp-Ordner laufender Uploads zählt über `pending` */
async function folderSize(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'tmp') total += await folderSize(full)
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
  /** Gemessene Ordnergröße, kurz zwischengespeichert */
  private measured = new Map<string, { bytes: number; at: number }>()
  /** Bytes, die gerade geschrieben werden (Uploads, Moodle-Downloads …) */
  private pending = new Map<string, number>()

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
        const service = createService(store, secrets, {
          fetchImpl: safeFetch,
          reserveSpace: (bytes) => this.reserve(userId, bytes),
        })
        return { dir, store, service }
      })()
      this.spaces.set(userId, space)
      // Fehlgeschlagen (z. B. Platte voll)? Beim nächsten Aufruf neu versuchen.
      space.catch(() => this.spaces.get(userId) === space && this.spaces.delete(userId))
    }
    return space
  }

  /** Belegter Speicher inklusive der gerade laufenden Schreibvorgänge */
  async usage(userId: string): Promise<number> {
    let cached = this.measured.get(userId)
    if (!cached || Date.now() - cached.at > 5_000) {
      cached = { bytes: await folderSize(this.dir(userId)), at: Date.now() }
      this.measured.set(userId, cached)
    }
    return cached.bytes + (this.pending.get(userId) ?? 0)
  }

  /**
   * Hält `bytes` im Speicherlimit frei, bis die zurückgegebene Funktion aufgerufen wird.
   * Die Bytes werden vor der Prüfung angerechnet – so können parallele Anfragen das Limit
   * nicht gemeinsam überschreiten.
   */
  async reserve(userId: string, bytes: number): Promise<() => void> {
    const change = (delta: number) => this.pending.set(userId, (this.pending.get(userId) ?? 0) + delta)
    change(bytes)
    let used: number
    try {
      used = await this.usage(userId)
    } catch (error) {
      change(-bytes)
      throw error
    }
    if (used > config.quotaBytes) {
      change(-bytes)
      throw new QuotaError(used - bytes, config.quotaBytes)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      change(-bytes)
      // Bis zur nächsten Messung mitzählen, was gerade geschrieben wurde
      const cached = this.measured.get(userId)
      if (cached) cached.bytes += bytes
    }
  }

  /** Führt `work` nur aus, wenn `bytes` noch ins Limit passen */
  async withQuota<T>(userId: string, bytes: number, work: () => Promise<T> | T): Promise<T> {
    const release = await this.reserve(userId, bytes)
    try {
      return await work()
    } finally {
      release()
    }
  }

  /** Nach dem Löschen: beim nächsten Mal neu messen */
  forgetUsage(userId: string): void {
    this.measured.delete(userId)
  }

  async remove(userId: string): Promise<void> {
    const space = await this.spaces.get(userId)?.catch(() => undefined)
    await space?.store.flush().catch(() => undefined)
    this.spaces.delete(userId)
    this.measured.delete(userId)
    await fs.rm(this.dir(userId), { recursive: true, force: true })
  }
}
