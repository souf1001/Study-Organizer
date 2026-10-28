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
  MoodlePost,
  MoodleSiteInfo,
  MoodleSyncResult,
  NoteDoc,
  RecordOf,
  SearchHit,
  Subscription,
  SyncResult,
  FileTarget,
} from './types'
import type { SetupExportOptions, SetupImportResult } from './setup-bundle'

/**
 * Interface between the UI and the data layer.
 * Desktop: implemented in the preload script (IPC to the Electron main process).
 * Android: implemented in the WebView on top of IndexedDB.
 */
export interface Api {
  platform: 'desktop' | 'web' | 'android'

  loadDb(): Promise<Db>
  put<C extends CollectionName>(collection: C, record: RecordOf<C>): Promise<void>
  remove(collection: CollectionName, id: ID): Promise<void>
  update(patch: DbPatch): Promise<void>

  readNote(id: ID): Promise<NoteDoc | null>
  writeNote(id: ID, doc: NoteDoc): Promise<void>
  readAnnotations(id: ID): Promise<Annotations | null>
  writeAnnotations(id: ID, annotations: Annotations): Promise<void>
  /** Text extracted from PDFs (for search and AI) */
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

  calendar: CalendarApi
  tucan: TucanApi

  moodle: {
    siteInfo(url: string): Promise<MoodleSiteInfo>
    connect(input: MoodleConnectInput): Promise<MoodleCourse[]>
    /** Sign in through the university's single sign-on page (not available everywhere) */
    connectSso?(url: string): Promise<MoodleCourse[]>
    courses(): Promise<MoodleCourse[]>
    sync(): Promise<MoodleSyncResult>
    posts(discussionId: number): Promise<MoodlePost[]>
    reply(postId: number, subject: string, message: string): Promise<{ postId: number }>
    disconnect(): Promise<void>
  }

  /** Called when the backend changed data on its own (e.g. a calendar sync) */
  onChange(listener: () => void): () => void

  openExternal(url: string): Promise<void>
  dataDir(): Promise<string>
  revealDataDir(): Promise<void>
  backup(): Promise<string | null>
  resetAll(): Promise<void>

  setup: SetupApi
}

/** Moving settings, connections and data to another device */
export interface SetupApi {
  /** Creates a setup file and lets the user save it; resolves to where it went, or null if cancelled */
  export(options: SetupExportOptions): Promise<string | null>
  /** Applies the content of a setup file picked by the user */
  import(fileContent: string, password?: string): Promise<SetupImportResult>
}

export interface AiStream {
  done: Promise<string>
  cancel(): void
}

export interface CalendarApi {
  /** Adds a calendar subscription (iCal address from Moodle, Stud.IP, ILIAS, OBS …) and syncs it right away */
  subscribe(name: string, url: string): Promise<Subscription>
  unsubscribe(id: ID): Promise<void>
  removeSubscription(id: ID): Promise<void>
  sync(id: ID): Promise<SyncResult>
  /** One-time import of an .ics file (e.g. the timetable from my h_da / HISinOne) */
  importFile(name: string, text: string): Promise<SyncResult>
  /** Assigns events without a module by matching module names and codes */
  rematchEvents?(): Promise<number>
}

export interface TucanWizardResult {
  success: boolean
  count?: number
  error?: string
}

export interface TucanApi {
  startWizard(): Promise<TucanWizardResult>
}
