// Data types shared by the backend and the UI.
// Dates: ISODate = 'YYYY-MM-DD' (local date); points in time are ISO strings with a time zone.

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
  /** 1 = Monday … 7 = Sunday */
  weekday: number
  /** 'HH:MM' */
  start: string
  end: string
  room: string
  everyTwoWeeks: boolean
  /** First session (optional, e.g. when a lab starts later in the semester) */
  firstDate: ISODate | null
  /** Cancelled dates */
  skip: ISODate[]
}

export type ModuleColor =
  'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red'

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
  /** Lab: attestation passed / done */
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
  /** File name in the data folder (id + extension) */
  fileName: string | null
  mime: string | null
  size: number | null
  /** Image pasted into a note (not shown in lists) */
  attachedTo: ID | null
  source: 'moodle' | 'ai' | null
  externalId: string | null
  createdAt: string
  updatedAt: string
}

export type EventKind = 'exam' | 'deadline' | 'lab' | 'lecture' | 'exercise' | 'other'

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
  /** 'url' = subscription (the address is stored encrypted with the secrets), 'file' = one-time .ics import */
  kind: 'url' | 'file'
  /** For display only, without secret parameters */
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
    /** UI scale factor, 0.9 – 1.2 */
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
    /** Only the pen draws; fingers scroll */
    penOnly: boolean
    penColor: string
    penSize: number
  }
  study: {
    semesterModel: SemesterModelId
    askForNewSemester: boolean
    /** Template for session folder names, e.g. '{kind} {n} · {date}' */
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
    agentEnabled?: boolean
  }
  moodle: {
    url: string
    siteName: string
    userId: number | null
    courseMap: Record<string, ID>
    syncFiles: boolean
    syncIntervalMinutes?: number
    lastSync: string | null
  }
}

export interface MoodleDiscussion {
  id: number
  discussionId: number
  firstPostId?: number
  forumId: number
  courseId: number
  moduleId: string | null
  forumName: string
  subject: string
  message: string
  userFullName: string
  userPictureUrl?: string
  timeCreated: string
  timeModified: string
  numReplies: number
  pinned: boolean
  isAnnouncement: boolean
}

export interface MoodlePost {
  id: number
  discussionId: number
  parentId: number
  subject: string
  message: string
  userFullName: string
  userPictureUrl?: string
  timeCreated: string
  canReply?: boolean
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
  moodleDiscussions: MoodleDiscussion[]
  chats: ChatSession[]
}

export const COLLECTIONS = [
  'semesters',
  'modules',
  'folders',
  'items',
  'events',
  'tasks',
  'subscriptions',
  'chats',
] as const

export type CollectionName = (typeof COLLECTIONS)[number]
export type RecordOf<C extends CollectionName> = Db[C][number]

/** Top-level fields that may be overwritten directly */
export type DbPatch = Partial<
  Pick<Db, 'onboarded' | 'activeSemesterId' | 'profile' | 'settings' | 'moodleDiscussions'>
>

// ---- Notes ----

export type StrokeTool = 'pen' | 'marker'

export interface Stroke {
  id: ID
  tool: StrokeTool
  /** Hex color or 'ink' (follows the theme) */
  color: string
  size: number
  /** Flat list: x, y, pressure, x, y, pressure, … */
  points: number[]
}

export interface NoteDoc {
  /** TipTap-/ProseMirror-JSON */
  content: Record<string, unknown> | null
  strokes: Stroke[]
  paper: PaperId
  paperColor: PaperColorId
  font: FontId
  /** Minimum page height in px (room for drawing) */
  height: number
  /** Plain text for search and AI */
  text: string
}

/** Drawings on PDF pages, keyed by page number (starting at 1) */
export interface Annotations {
  pages: Record<string, Stroke[]>
}

// ---- AI ----

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiRequest {
  system: string
  messages: AiMessage[]
  maxTokens?: number
}

export interface ChatSession {
  id: ID
  moduleId: ID | null
  title: string
  messages: AiMessage[]
  createdAt: string
  updatedAt: string
}

// ---- Integrations ----

export interface SyncResult {
  count: number
  error: string | null
  newModules?: number
}

export interface MoodleCourse {
  id: number
  fullname: string
  shortname: string
}

export interface MoodleSiteInfo {
  siteName: string
  /** Canonical address of the Moodle site */
  url: string
  /** Sign-in is only possible through the university login (SSO) */
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
  discussions?: number
  errors: string[]
}

export interface SearchHit {
  itemId: ID
  snippet: string
}

export interface FileInput {
  name: string
  type: string
  /** Path on disk (desktop) */
  path?: string
  /** Content when there is no path (e.g. a pasted image) */
  bytes?: Uint8Array
  /** Downloaded from the internet (Windows then applies its SmartScreen checks when opening it) */
  fromInternet?: boolean
}

export interface FileTarget {
  moduleId: ID
  folderId: ID | null
  attachedTo?: ID | null
}
