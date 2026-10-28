// File format for moving a complete setup (settings, connections and optionally all study
// data) from one device to another, e.g. from the desktop app to an Android tablet.
//
// A setup file is JSON. It is either a plain `SetupBundle` or, when the user chose a password,
// an `EncryptedSetupFile` whose payload is the AES-GCM encrypted bundle.
import type {
  Annotations,
  ChatSession,
  CalendarEvent,
  Folder,
  Item,
  Module,
  MoodleDiscussion,
  NoteDoc,
  Profile,
  Semester,
  Settings,
  Subscription,
  Task,
} from './types'

export const SETUP_FORMAT = 'study-organizer-setup'
export const SETUP_VERSION = 1
export const SETUP_FILE_EXTENSION = '.studysetup'

/**
 * How much a setup file contains:
 * - `settings`: profile, settings, calendar subscriptions and (optionally) credentials
 * - `study`: additionally semesters, modules, folders, calendar, tasks, chats and Moodle forums
 * - `everything`: additionally all notes, PDF annotations and files
 */
export type SetupScope = 'settings' | 'study' | 'everything'

export interface SetupExportOptions {
  scope: SetupScope
  /** Include the Moodle token, AI keys and private calendar feed addresses */
  includeCredentials: boolean
  /** Encrypts the file when set. Strongly recommended when credentials are included. */
  password?: string
}

export interface SetupStudyData {
  activeSemesterId: string | null
  semesters: Semester[]
  modules: Module[]
  folders: Folder[]
  events: CalendarEvent[]
  tasks: Task[]
  chats: ChatSession[]
  moodleDiscussions: MoodleDiscussion[]
  /** Only present for scope `everything` */
  items?: Item[]
}

export interface SetupContent {
  notes: Record<string, NoteDoc>
  annotations: Record<string, Annotations>
  texts: Record<string, string>
  /** File name in the data folder -> base64 encoded file content */
  files: Record<string, string>
}

export interface SetupBundle {
  format: typeof SETUP_FORMAT
  version: typeof SETUP_VERSION
  scope: SetupScope
  exportedAt: string
  /** Platform the file was created on, e.g. 'desktop' */
  source: string
  profile: Profile
  settings: Settings
  subscriptions: Subscription[]
  /** Raw secret values by name ('moodle', 'ai:<provider>', 'ics:<subscription id>') */
  credentials?: Record<string, string>
  data?: SetupStudyData
  content?: SetupContent
}

export interface EncryptedSetupFile {
  format: typeof SETUP_FORMAT
  version: typeof SETUP_VERSION
  encryption: {
    algorithm: 'AES-GCM'
    keyDerivation: 'PBKDF2-SHA256'
    iterations: number
    salt: string
    iv: string
  }
  /** Base64 encoded ciphertext of the JSON `SetupBundle` */
  payload: string
}

export type SetupFile = SetupBundle | EncryptedSetupFile

export interface SetupImportResult {
  scope: SetupScope
  credentials: number
  modules: number
  events: number
  items: number
}

/** What the import dialog shows before the user confirms */
export interface SetupFileSummary {
  encrypted: boolean
  /** Unknown until the file is decrypted */
  scope: SetupScope | null
  exportedAt: string | null
}

const PBKDF2_ITERATIONS = 250_000

export function isEncryptedSetupFile(file: SetupFile): file is EncryptedSetupFile {
  return 'encryption' in file
}

/** Parses the text of a setup file and checks that it is one */
export function parseSetupFile(text: string): SetupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Die Datei ist keine Study-Organizer-Einrichtungsdatei.')
  }
  const file = parsed as Partial<SetupFile> | null
  if (!file || file.format !== SETUP_FORMAT) {
    throw new Error('Die Datei ist keine Study-Organizer-Einrichtungsdatei.')
  }
  if (file.version !== SETUP_VERSION) {
    throw new Error(
      'Diese Einrichtungsdatei stammt aus einer neueren Version. Bitte die App aktualisieren.',
    )
  }
  return file as SetupFile
}

export function summarizeSetupFile(text: string): SetupFileSummary {
  const file = parseSetupFile(text)
  if (isEncryptedSetupFile(file)) return { encrypted: true, scope: null, exportedAt: null }
  return { encrypted: false, scope: file.scope, exportedAt: file.exportedAt }
}

// ---- Base64 (works in Node and in the browser) ----

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---- Encryption (Web Crypto, available in Node, Electron and Android WebView) ----

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptSetupBundle(
  bundle: SetupBundle,
  password: string,
): Promise<EncryptedSetupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS)
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    encryption: {
      algorithm: 'AES-GCM',
      keyDerivation: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptSetupFile(
  file: EncryptedSetupFile,
  password: string,
): Promise<SetupBundle> {
  const { salt, iv, iterations } = file.encryption
  const key = await deriveKey(password, base64ToBytes(salt), iterations)
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(iv) as BufferSource },
      key,
      base64ToBytes(file.payload) as BufferSource,
    )
  } catch {
    throw new Error('Falsches Passwort oder beschädigte Datei.')
  }
  const bundle = parseSetupFile(new TextDecoder().decode(plaintext))
  if (isEncryptedSetupFile(bundle)) throw new Error('Die Datei ist beschädigt.')
  return bundle
}

/** Returns the plain bundle of a setup file, decrypting it if necessary */
export async function openSetupFile(text: string, password?: string): Promise<SetupBundle> {
  const file = parseSetupFile(text)
  if (!isEncryptedSetupFile(file)) return file
  if (!password) throw new Error('Diese Datei ist mit einem Passwort geschützt.')
  return decryptSetupFile(file, password)
}

/** Suggested file name, e.g. "Study-Organizer-Einrichtung-2026-10-28.studysetup" */
export function setupFileName(date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10)
  return `Study-Organizer-Einrichtung-${day}${SETUP_FILE_EXTENSION}`
}
