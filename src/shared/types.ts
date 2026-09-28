// Gemeinsame Datentypen für Backend (Electron-Main / Server) und Oberfläche.
// Datumsangaben: ISODate = 'YYYY-MM-DD' (lokales Datum), Zeitpunkte = ISO-String mit Zeitzone.

export type ID = string
export type ISODate = string

export type InstitutionType = 'uni' | 'hochschule'

export interface Profile {
  name: string
  university: string
  institutionType: InstitutionType
  program: string
  degree: string
  studySemester: number
}

export type SemesterKind = 'winter' | 'summer'

export interface DateRange {
  start: ISODate
  end: ISODate
  label: string
}

export interface Semester {
  id: ID
  name: string
  kind: SemesterKind
  year: number
  start: ISODate
  end: ISODate
  lectureStart: ISODate
  lectureEnd: ISODate
  breaks: DateRange[]
  createdAt: string
}

export type SessionKind = 'lecture' | 'exercise' | 'lab' | 'seminar' | 'tutorial'

export interface ScheduleSlot {
  id: ID
  kind: SessionKind
  /** 1 = Montag … 7 = Sonntag */
  weekday: number
  /** 'HH:MM' */
  start: string
  end: string
  room: string
  everyTwoWeeks: boolean
  /** Erster Termin (optional, z. B. wenn ein Praktikum erst später beginnt) */
  firstDate: ISODate | null
  /** Ausgefallene Termine */
  skip: ISODate[]
}

export type ModuleColor =
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'

export interface Module {
  id: ID
  semesterId: ID
  name: string
  code: string
  lecturer: string
  color: ModuleColor
  ects: number | null
  schedule: ScheduleSlot[]
  info: string
  order: number
  createdAt: string
}

export type FolderKind = 'session' | 'general'

export interface Folder {
  id: ID
  moduleId: ID
  parentId: ID | null
  name: string
  kind: FolderKind
  sessionKind: SessionKind | null
  date: ISODate | null
  room: string
  /** Praktikum: Testat bestanden / erledigt */
  done: boolean
  order: number
  createdAt: string
}

export type ItemKind = 'note' | 'file'
export type FileType = 'pdf' | 'video' | 'audio' | 'image' | 'text' | 'other'

export interface Item {
  id: ID
  moduleId: ID
  folderId: ID | null
  kind: ItemKind
  title: string
  fileType: FileType | null
  /** Dateiname im Speicherordner (id + Endung) */
  fileName: string | null
  mime: string | null
  size: number | null
  /** Bild, das in eine Notiz eingefügt wurde (nicht in Listen anzeigen) */
  attachedTo: ID | null
  source: 'moodle' | 'ai' | null
  externalId: string | null
  createdAt: string
  updatedAt: string
}

export type EventKind = 'exam' | 'deadline' | 'lab' | 'lecture' | 'other'

export interface CalendarEvent {
  id: ID
  title: string
  kind: EventKind
  start: string
  end: string
  allDay: boolean
  moduleId: ID | null
  location: string
  notes: string
  subscriptionId: ID | null
  externalId: string | null
}

export type TaskKind = 'assignment' | 'lab' | 'study' | 'other'

export interface Task {
  id: ID
  title: string
  kind: TaskKind
  moduleId: ID | null
  due: string | null
  done: boolean
  notes: string
  source: 'moodle' | null
  externalId: string | null
  createdAt: string
}

export interface Subscription {
  id: ID
  name: string
  /** 'url' = Abo (Adresse liegt verschlüsselt im Schlüsselbund), 'file' = einmalig importierte .ics-Datei */
  kind: 'url' | 'file'
  /** Nur zur Anzeige, ohne geheime Parameter */
  url: string
  enabled: boolean
  lastSync: string | null
  lastError: string | null
}

export type ThemeSetting = 'system' | 'light' | 'dark'
export type AccentId = 'indigo' | 'blue' | 'green' | 'orange' | 'pink' | 'graphite'
export type FontId = 'inter' | 'serif' | 'literata' | 'mono' | 'hand' | 'atkinson'
export type PaperId = 'plain' | 'lined' | 'college' | 'grid' | 'dots' | 'millimeter' | 'cornell'
export type PaperColorId = 'auto' | 'white' | 'cream' | 'gray' | 'dark'
export type SemesterModelId = 'uni' | 'hochschule' | 'hda'
export type CalendarViewId = 'week' | 'month' | 'agenda'

export interface Settings {
  appearance: {
    theme: ThemeSetting
    accent: AccentId
    /** Skalierung der Oberfläche, 0.9 – 1.2 */
    zoom: number
    compact: boolean
    reduceMotion: boolean
  }
  editor: {
    font: FontId
    fontSize: number
    paper: PaperId
    paperColor: PaperColorId
    wide: boolean
    spellcheck: boolean
    /** Nur Stift zeichnet, Finger scrollt */
    penOnly: boolean
    penColor: string
    penSize: number
  }
  study: {
    semesterModel: SemesterModelId
    askForNewSemester: boolean
    /** Vorlage für Ordnernamen, z. B. '{kind} {n} · {date}' */
    sessionFolderName: string
  }
  calendar: {
    startHour: number
    endHour: number
    showWeekends: boolean
    defaultView: CalendarViewId
    syncIntervalHours: number
  }
  ai: {
    enabled: boolean
    provider: string
    model: string
    baseUrl: string
    language: 'de' | 'en'
    maxContextChars: number
  }
  moodle: {
    url: string
    siteName: string
    userId: number | null
    courseMap: Record<string, ID>
    syncFiles: boolean
    lastSync: string | null
  }
}

export interface Db {
  version: 1
  onboarded: boolean
  activeSemesterId: ID | null
  profile: Profile
  settings: Settings
  semesters: Semester[]
  modules: Module[]
  folders: Folder[]
  items: Item[]
  events: CalendarEvent[]
  tasks: Task[]
  subscriptions: Subscription[]
}

export const COLLECTIONS = [
  'semesters',
  'modules',
  'folders',
  'items',
  'events',
  'tasks',
  'subscriptions',
] as const

export type CollectionName = (typeof COLLECTIONS)[number]
export type RecordOf<C extends CollectionName> = Db[C][number]

/** Felder der Wurzel, die direkt überschrieben werden dürfen */
export type DbPatch = Partial<Pick<Db, 'onboarded' | 'activeSemesterId' | 'profile' | 'settings'>>

// ---- Notizen ----

export type StrokeTool = 'pen' | 'marker'

export interface Stroke {
  id: ID
  tool: StrokeTool
  /** Farbe als Hex oder 'ink' (passt sich dem Theme an) */
  color: string
  size: number
  /** Flache Liste: x, y, Druck, x, y, Druck, … */
  points: number[]
}

export interface NoteDoc {
  /** TipTap-/ProseMirror-JSON */
  content: Record<string, unknown> | null
  strokes: Stroke[]
  paper: PaperId
  paperColor: PaperColorId
  font: FontId
  /** Mindesthöhe der Seite in px (Platz zum Zeichnen) */
  height: number
  /** Reiner Text für Suche und KI */
  text: string
}

/** Markierungen auf PDF-Seiten, Schlüssel = Seitennummer (ab 1) */
export interface Annotations {
  pages: Record<string, Stroke[]>
}

// ---- KI ----

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiRequest {
  system: string
  messages: AiMessage[]
  maxTokens?: number
}

// ---- Integrationen ----

export interface SyncResult {
  count: number
  error: string | null
}

export interface MoodleCourse {
  id: number
  fullname: string
  shortname: string
}

export interface MoodleSiteInfo {
  siteName: string
  /** Offizielle Adresse der Moodle-Instanz */
  url: string
  /** Anmeldung nur über Hochschul-Login (SSO) möglich */
  ssoRequired: boolean
}

export interface MoodleConnectInput {
  url: string
  username?: string
  password?: string
  token?: string
}

export interface MoodleSyncResult {
  tasks: number
  events: number
  files: number
  errors: string[]
}

export interface SearchHit {
  itemId: ID
  snippet: string
}

export interface FileInput {
  name: string
  type: string
  /** Pfad auf der Festplatte (Desktop) */
  path?: string
  /** Inhalt, falls kein Pfad vorhanden ist (z. B. eingefügtes Bild) */
  bytes?: Uint8Array
}

export interface FileTarget {
  moduleId: ID
  folderId: ID | null
  attachedTo?: ID | null
}
