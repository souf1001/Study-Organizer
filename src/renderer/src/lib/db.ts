// The UI keeps a copy of all metadata. Changes are applied locally right away
// and sent to the backend in parallel (reloading from the backend on failure).
import { create } from 'zustand'
import type { CollectionName, Db, DbPatch, RecordOf, Settings } from '@shared/types'
import { toastError } from '@/ui/Toast'
import { api } from './api'

interface DbState {
  db: Db | null
}

export const useDbStore = create<DbState>(() => ({ db: null }))

/** Current data snapshot (only available after `loadDb()`). */
export function useDb(): Db {
  const db = useDbStore((s) => s.db)
  if (!db) throw new Error('Daten noch nicht geladen')
  return db
}

export function getDb(): Db {
  const db = useDbStore.getState().db
  if (!db) throw new Error('Daten noch nicht geladen')
  return db
}

export async function loadDb(): Promise<void> {
  useDbStore.setState({ db: await api.loadDb() })
}

function setDb(fn: (db: Db) => Db): void {
  useDbStore.setState((s) => (s.db ? { db: fn(s.db) } : s))
}

const reloadOnError = (error: unknown) => {
  toastError(error)
  void loadDb()
}

export function putRecord<C extends CollectionName>(collection: C, record: RecordOf<C>): void {
  setDb((db) => {
    const list = db[collection] as RecordOf<C>[]
    const exists = list.some((r) => r.id === record.id)
    const next = exists ? list.map((r) => (r.id === record.id ? record : r)) : [...list, record]
    return { ...db, [collection]: next }
  })
  api.put(collection, record).catch(reloadOnError)
}

/** Deletes in the backend (including dependent records), then reloads. */
export async function removeRecord(collection: CollectionName, id: string): Promise<void> {
  try {
    await api.remove(collection, id)
  } catch (error) {
    toastError(error)
  }
  await loadDb()
}

export function updateDb(patch: DbPatch): void {
  setDb((db) => ({ ...db, ...patch }))
  api.update(patch).catch(reloadOnError)
}

/** Updates one settings section, e.g. `updateSettings('editor', { font: 'serif' })`. */
export function updateSettings<K extends keyof Settings>(
  section: K,
  values: Partial<Settings[K]>,
): void {
  const settings = getDb().settings
  updateDb({ settings: { ...settings, [section]: { ...settings[section], ...values } } })
}
