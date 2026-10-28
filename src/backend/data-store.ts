// The storage contract the backend service relies on. The desktop app implements it with
// files on disk (store.ts); the Android app implements it with IndexedDB.
import type {
  Annotations,
  CollectionName,
  Db,
  DbPatch,
  FileInput,
  FileTarget,
  Item,
  NoteDoc,
  RecordOf,
  SearchHit,
} from '../shared/types'

export interface DataStore {
  /** Human readable location of the data, shown in the settings */
  readonly dir: string

  get(): Db
  put<C extends CollectionName>(collection: C, record: RecordOf<C>): void
  /** Replaces all records matching `match` with `records` (e.g. the events of one subscription) */
  replaceMany<C extends CollectionName>(
    collection: C,
    match: (record: RecordOf<C>) => boolean,
    records: RecordOf<C>[],
  ): void
  update(patch: DbPatch): void
  /** Deletes a record together with everything that depends on it */
  remove(collection: CollectionName, id: string): Promise<void>
  /** Replaces the whole database, e.g. when importing a setup file */
  replaceDb(db: Db): Promise<void>

  readNote(id: string): Promise<NoteDoc | null>
  writeNote(id: string, doc: NoteDoc): Promise<void>
  readAnnotations(id: string): Promise<Annotations | null>
  writeAnnotations(id: string, annotations: Annotations): Promise<void>
  readText(id: string): Promise<string | null>
  writeText(id: string, text: string): Promise<void>

  addFile(target: FileTarget, input: FileInput): Promise<Item>
  readFile(fileName: string): Promise<Uint8Array | null>
  writeFile(fileName: string, bytes: Uint8Array): Promise<void>

  search(query: string): Promise<SearchHit[]>
  /** Writes pending changes immediately */
  flush(): Promise<void>
  /** Deletes all data */
  reset(): Promise<void>
}
