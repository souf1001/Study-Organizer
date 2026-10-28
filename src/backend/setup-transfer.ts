// Creates and applies setup files (see shared/setup-bundle.ts). Runs unchanged in the desktop
// main process and in the Android WebView, because it only talks to the DataStore and Secrets
// abstractions.
import { AI_PROVIDERS } from '../shared/ai-providers'
import { normalizeDb } from '../shared/defaults'
import {
  SETUP_FORMAT,
  SETUP_VERSION,
  base64ToBytes,
  bytesToBase64,
  encryptSetupBundle,
  openSetupFile,
  type SetupBundle,
  type SetupContent,
  type SetupExportOptions,
  type SetupFile,
  type SetupImportResult,
  type SetupStudyData,
} from '../shared/setup-bundle'
import type { Db } from '../shared/types'
import type { DataStore } from './data-store'
import type { Secrets } from './secrets'

/** Names of all secrets that belong to the current setup */
function secretNames(db: Db): string[] {
  return [
    'moodle',
    ...AI_PROVIDERS.map((provider) => `ai:${provider.id}`),
    ...db.subscriptions.filter((s) => s.kind === 'url').map((s) => `ics:${s.id}`),
  ]
}

async function readCredentials(db: Db, secrets: Secrets): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {}
  for (const name of secretNames(db)) {
    const value = await secrets.get(name).catch(() => null)
    if (value) credentials[name] = value
  }
  return credentials
}

function studyData(db: Db, includeItems: boolean): SetupStudyData {
  return {
    activeSemesterId: db.activeSemesterId,
    semesters: db.semesters,
    modules: db.modules,
    folders: db.folders,
    events: db.events,
    tasks: db.tasks,
    chats: db.chats,
    moodleDiscussions: db.moodleDiscussions,
    ...(includeItems ? { items: db.items } : {}),
  }
}

async function readContent(db: Db, store: DataStore): Promise<SetupContent> {
  const content: SetupContent = { notes: {}, annotations: {}, texts: {}, files: {} }
  for (const item of db.items) {
    if (item.kind === 'note') {
      const note = await store.readNote(item.id)
      if (note) content.notes[item.id] = note
      continue
    }
    const annotations = await store.readAnnotations(item.id)
    if (annotations) content.annotations[item.id] = annotations
    const text = await store.readText(item.id)
    if (text) content.texts[item.id] = text
    if (item.fileName) {
      const bytes = await store.readFile(item.fileName)
      if (bytes) content.files[item.fileName] = bytesToBase64(bytes)
    }
  }
  return content
}

export async function createSetupFile(
  store: DataStore,
  secrets: Secrets,
  options: SetupExportOptions,
  source: string,
): Promise<SetupFile> {
  await store.flush()
  const db = store.get()
  const bundle: SetupBundle = {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    scope: options.scope,
    exportedAt: new Date().toISOString(),
    source,
    profile: db.profile,
    settings: db.settings,
    subscriptions: db.subscriptions,
  }
  if (options.includeCredentials) bundle.credentials = await readCredentials(db, secrets)
  if (options.scope !== 'settings') bundle.data = studyData(db, options.scope === 'everything')
  if (options.scope === 'everything') bundle.content = await readContent(db, store)

  return options.password ? encryptSetupBundle(bundle, options.password) : bundle
}

/**
 * Settings only: keeps all local study data and merges in settings, profile and
 * calendar subscriptions. A local Moodle connection survives if the file brings none.
 */
async function applySettings(store: DataStore, bundle: SetupBundle): Promise<void> {
  const db = store.get()
  const hasMoodleCredential = Boolean(bundle.credentials?.moodle)
  const settings = normalizeDb({ settings: bundle.settings }).settings
  store.update({
    onboarded: true,
    profile: { ...db.profile, ...bundle.profile },
    settings: hasMoodleCredential ? settings : { ...settings, moodle: db.settings.moodle },
  })
  const importedIds = new Set(bundle.subscriptions.map((s) => s.id))
  store.replaceMany('subscriptions', (s) => importedIds.has(s.id), bundle.subscriptions)
}

/** Study data: replaces everything on this device with the content of the file */
async function applyStudyData(
  store: DataStore,
  bundle: SetupBundle,
  data: SetupStudyData,
): Promise<void> {
  await store.reset()
  const fresh = store.get()
  await store.replaceDb({
    ...fresh,
    ...data,
    items: data.items ?? [],
    onboarded: true,
    profile: bundle.profile,
    settings: bundle.settings,
    subscriptions: bundle.subscriptions,
  })
  const content = bundle.content
  if (!content) return
  for (const [id, note] of Object.entries(content.notes)) await store.writeNote(id, note)
  for (const [id, annotations] of Object.entries(content.annotations)) {
    await store.writeAnnotations(id, annotations)
  }
  for (const [id, text] of Object.entries(content.texts)) await store.writeText(id, text)
  for (const [fileName, base64] of Object.entries(content.files)) {
    await store.writeFile(fileName, base64ToBytes(base64))
  }
}

export async function applySetupFile(
  store: DataStore,
  secrets: Secrets,
  text: string,
  password?: string,
): Promise<SetupImportResult> {
  const bundle = await openSetupFile(text, password)

  if (bundle.data) await applyStudyData(store, bundle, bundle.data)
  else await applySettings(store, bundle)

  const credentials = Object.entries(bundle.credentials ?? {})
  for (const [name, value] of credentials) await secrets.set(name, value)
  await store.flush()

  const db = store.get()
  return {
    scope: bundle.scope,
    credentials: credentials.length,
    modules: db.modules.length,
    events: db.events.length,
    items: db.items.length,
  }
}
