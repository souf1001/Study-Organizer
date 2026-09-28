import type {
  AiRequest,
  Annotations,
  CollectionName,
  Db,
  DbPatch,
  ID,
  Item,
  MoodleConnectInput,
  MoodleCourse,
  MoodleSiteInfo,
  MoodleSyncResult,
  NoteDoc,
  RecordOf,
  SearchHit,
  Subscription,
  SyncResult,
  FileTarget,
} from './types'

/**
 * Schnittstelle zwischen Oberfläche und Datenhaltung.
 * Desktop: Umsetzung im Preload-Skript (IPC zum Electron-Main-Prozess).
 * Web: Umsetzung per HTTP gegen den Server.
 */
export interface Api {
  platform: 'desktop' | 'web'

  loadDb(): Promise<Db>
  put<C extends CollectionName>(collection: C, record: RecordOf<C>): Promise<void>
  remove(collection: CollectionName, id: ID): Promise<void>
  update(patch: DbPatch): Promise<void>

  readNote(id: ID): Promise<NoteDoc | null>
  writeNote(id: ID, doc: NoteDoc): Promise<void>
  readAnnotations(id: ID): Promise<Annotations | null>
  writeAnnotations(id: ID, annotations: Annotations): Promise<void>
  /** Aus PDFs extrahierter Text (für Suche und KI) */
  readText(id: ID): Promise<string | null>
  writeText(id: ID, text: string): Promise<void>

  addFiles(target: FileTarget, files: File[]): Promise<Item[]>
  fileUrl(item: Item): string
  openFile(item: Item): Promise<void>

  search(query: string): Promise<SearchHit[]>

  ai: {
    setKey(provider: string, key: string): Promise<void>
    hasKey(provider: string): Promise<boolean>
    listModels(): Promise<string[]>
    stream(request: AiRequest, onText: (chunk: string) => void): AiStream
  }

  calendar: {
    /** Kalender-Abo anlegen (iCal-Adresse von Moodle, Stud.IP, ILIAS, OBS …) und sofort abgleichen */
    subscribe(name: string, url: string): Promise<Subscription>
    unsubscribe(id: ID): Promise<void>
    sync(id: ID): Promise<SyncResult>
    /** Einmaliger Import einer .ics-Datei (z. B. Stundenplan aus my h_da / HISinOne) */
    importFile(name: string, text: string): Promise<SyncResult>
  }

  moodle: {
    siteInfo(url: string): Promise<MoodleSiteInfo>
    connect(input: MoodleConnectInput): Promise<MoodleCourse[]>
    /** Anmeldung über den Hochschul-Login (nur Desktop) */
    connectSso?(url: string): Promise<MoodleCourse[]>
    courses(): Promise<MoodleCourse[]>
    sync(): Promise<MoodleSyncResult>
    disconnect(): Promise<void>
  }

  /** Wird aufgerufen, wenn das Backend Daten selbst geändert hat (z. B. Kalender-Abgleich) */
  onChange(listener: () => void): () => void

  openExternal(url: string): Promise<void>
  dataDir(): Promise<string>
  revealDataDir(): Promise<void>
  backup(): Promise<string | null>
  resetAll(): Promise<void>
}

export interface AiStream {
  done: Promise<string>
  cancel(): void
}
