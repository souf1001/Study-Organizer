// Benutzerkonten und Sitzungen. Passwörter mit scrypt gehasht, Sitzungs-Tokens nur als SHA-256 gespeichert.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
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

export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return 'Bitte eine gültige E-Mail-Adresse angeben.'
  if (password.length < 10) return 'Das Passwort muss mindestens 10 Zeichen lang sein.'
  if (password.length > 200) return 'Das Passwort ist zu lang.'
  return null
}

export class Accounts {
  private data: AccountsFile = { users: [], sessions: [] }

  private constructor(private readonly file: string) {}

  static async open(dataDir: string): Promise<Accounts> {
    const accounts = new Accounts(path.join(dataDir, 'accounts.json'))
    try {
      accounts.data = JSON.parse(await fs.readFile(accounts.file, 'utf8')) as AccountsFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return accounts
  }

  private save(): Promise<void> {
    return writeAtomic(this.file, JSON.stringify(this.data), 0o600)
  }

  findByEmail(email: string): User | undefined {
    return this.data.users.find((u) => u.email === email.trim().toLowerCase())
  }

  get(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id)
  }

  all(): User[] {
    return this.data.users
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
    this.data.users.push(user)
    await this.save()
    return user
  }

  async changePassword(userId: string, password: string): Promise<void> {
    const user = this.get(userId)
    if (!user) throw new Error('Konto nicht gefunden')
    user.passwordHash = await hashPassword(password)
    // Alle anderen Sitzungen beenden
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId)
    await this.save()
  }

  async remove(userId: string): Promise<void> {
    this.data.users = this.data.users.filter((u) => u.id !== userId)
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId)
    await this.save()
  }

  /** Neue Sitzung; der Klartext-Token geht nur in das Cookie */
  async createSession(userId: string, days: number): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.data.sessions = this.data.sessions.filter((s) => new Date(s.expiresAt).getTime() > now)
    this.data.sessions.push({ tokenHash: sha256(token), userId, expiresAt: new Date(now + days * 86_400_000).toISOString() })
    await this.save()
    return token
  }

  userForToken(token: string | undefined): User | undefined {
    if (!token) return undefined
    const hash = sha256(token)
    const session = this.data.sessions.find((s) => s.tokenHash === hash)
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) return undefined
    return this.get(session.userId)
  }

  async endSession(token: string | undefined): Promise<void> {
    if (!token) return
    const hash = sha256(token)
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== hash)
    await this.save()
  }
}
