// Benutzerkonten und Sitzungen. Passwörter mit scrypt gehasht, Sitzungs-Tokens nur als SHA-256 gespeichert.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { writeAtomic } from '../backend/store'

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export interface User {
  id: string
  email: string
  name: string
  passwordHash: string
  createdAt: string
}

interface Session {
  tokenHash: string
  userId: string
  expiresAt: string
}

interface AccountsFile {
  users: User[]
  sessions: Session[]
}

export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'createdAt'>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const publicUser = ({ id, email, name, createdAt }: User): PublicUser => ({ id, email, name, createdAt })

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(':')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(actual, expected)
}

// Für unbekannte E-Mails wird gegen diesen Hash geprüft, damit die Antwortzeit nicht verrät, ob es ein Konto gibt
const dummyHash = hashPassword(randomBytes(16).toString('hex'))

export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return 'Bitte eine gültige E-Mail-Adresse angeben.'
  if (password.length < 10) return 'Das Passwort muss mindestens 10 Zeichen lang sein.'
  if (password.length > 200) return 'Das Passwort ist zu lang.'
  return null
}

// Die Datei ist die Quelle der Wahrheit: Ändert sie jemand anderes (z. B. admin.js, während der
// Server läuft), wird sie vor dem nächsten Zugriff neu gelesen.
export class Accounts {
  private data: AccountsFile = { users: [], sessions: [] }
  private version = ''
  private saving = 0

  private constructor(private readonly file: string) {}

  static async open(dataDir: string): Promise<Accounts> {
    const accounts = new Accounts(path.join(dataDir, 'accounts.json'))
    accounts.reload()
    return accounts
  }

  private fileVersion(): string {
    try {
      const { mtimeMs, size } = statSync(this.file)
      return `${mtimeMs}:${size}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** Neu einlesen, falls sich die Datei seit dem letzten Lesen oder Schreiben geändert hat */
  private reload(): AccountsFile {
    const version = this.fileVersion()
    if (this.saving === 0 && version !== this.version) {
      this.data = version ? (JSON.parse(readFileSync(this.file, 'utf8')) as AccountsFile) : { users: [], sessions: [] }
      this.version = version
    }
    return this.data
  }

  /** Liest den aktuellen Stand, ändert ihn und speichert – ohne Pause dazwischen */
  private async change(apply: (data: AccountsFile) => void): Promise<void> {
    apply(this.reload())
    this.saving += 1
    try {
      await writeAtomic(this.file, JSON.stringify(this.data), 0o600)
    } finally {
      this.saving -= 1
      if (this.saving === 0) this.version = this.fileVersion()
    }
  }

  findByEmail(email: string): User | undefined {
    return this.reload().users.find((u) => u.email === email.trim().toLowerCase())
  }

  get(id: string): User | undefined {
    return this.reload().users.find((u) => u.id === id)
  }

  all(): User[] {
    return this.reload().users
  }

  /** Prüft E-Mail und Passwort */
  async verifyLogin(email: string, password: string): Promise<User | undefined> {
    const user = this.findByEmail(email)
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash))
    return user && ok ? user : undefined
  }

  async create(email: string, password: string, name: string): Promise<User> {
    const normalized = email.trim().toLowerCase()
    if (this.findByEmail(normalized)) throw new Error('Für diese E-Mail-Adresse gibt es schon ein Konto.')
    const user: User = {
      id: randomUUID(),
      email: normalized,
      name: name.trim().slice(0, 100),
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    await this.change((data) => {
      // Während des Hashens angelegt?
      if (data.users.some((u) => u.email === normalized)) throw new Error('Für diese E-Mail-Adresse gibt es schon ein Konto.')
      data.users.push(user)
    })
    return user
  }

  async changePassword(userId: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password)
    await this.change((data) => {
      const user = data.users.find((u) => u.id === userId)
      if (!user) throw new Error('Konto nicht gefunden')
      user.passwordHash = passwordHash
      // Alle Sitzungen beenden
      data.sessions = data.sessions.filter((s) => s.userId !== userId)
    })
  }

  async remove(userId: string): Promise<void> {
    await this.change((data) => {
      data.users = data.users.filter((u) => u.id !== userId)
      data.sessions = data.sessions.filter((s) => s.userId !== userId)
    })
  }

  /** Neue Sitzung; der Klartext-Token geht nur in das Cookie */
  async createSession(userId: string, days: number): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    await this.change((data) => {
      data.sessions = data.sessions.filter((s) => new Date(s.expiresAt).getTime() > now)
      data.sessions.push({ tokenHash: sha256(token), userId, expiresAt: new Date(now + days * 86_400_000).toISOString() })
    })
    return token
  }

  userForToken(token: string | undefined): User | undefined {
    if (!token) return undefined
    const hash = sha256(token)
    const session = this.reload().sessions.find((s) => s.tokenHash === hash)
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) return undefined
    return this.get(session.userId)
  }

  async endSession(token: string | undefined): Promise<void> {
    if (!token) return
    const hash = sha256(token)
    await this.change((data) => {
      data.sessions = data.sessions.filter((s) => s.tokenHash !== hash)
    })
  }
}
