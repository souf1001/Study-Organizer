// Minimal key-value persistence for the Android/browser store: IndexedDB in the app, an
// in-memory map in tests and in environments without IndexedDB.

export const TABLES = ['meta', 'notes', 'annotations', 'text', 'files', 'secrets'] as const
export type Table = (typeof TABLES)[number]

export interface KeyValueStore {
  get<T>(table: Table, key: string): Promise<T | null>
  put(table: Table, key: string, value: unknown): Promise<void>
  delete(table: Table, key: string): Promise<void>
  clear(table: Table): Promise<void>
  keys(table: Table): Promise<string[]>
}

const DB_NAME = 'study_organizer_storage'
const DB_VERSION = 1

/** Wraps an IndexedDB request in a promise */
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function openIndexedDb(): Promise<KeyValueStore> {
  const open = indexedDB.open(DB_NAME, DB_VERSION)
  open.onupgradeneeded = () => {
    for (const table of TABLES) {
      if (!open.result.objectStoreNames.contains(table)) open.result.createObjectStore(table)
    }
  }
  const db = await done(open)
  const store = (table: Table, mode: IDBTransactionMode) =>
    db.transaction(table, mode).objectStore(table)

  return {
    get: async <T>(table: Table, key: string) =>
      ((await done(store(table, 'readonly').get(key))) as T | undefined) ?? null,
    put: async (table, key, value) => void (await done(store(table, 'readwrite').put(value, key))),
    delete: async (table, key) => void (await done(store(table, 'readwrite').delete(key))),
    clear: async (table) => void (await done(store(table, 'readwrite').clear())),
    keys: async (table) => (await done(store(table, 'readonly').getAllKeys())).map(String),
  }
}

export function createMemoryKeyValueStore(): KeyValueStore {
  const tables = new Map<Table, Map<string, unknown>>(TABLES.map((table) => [table, new Map()]))
  const table = (name: Table) => tables.get(name)!
  return {
    get: async <T>(name: Table, key: string) => (table(name).get(key) as T | undefined) ?? null,
    put: async (name, key, value) => void table(name).set(key, structuredClone(value)),
    delete: async (name, key) => void table(name).delete(key),
    clear: async (name) => table(name).clear(),
    keys: async (name) => [...table(name).keys()],
  }
}
