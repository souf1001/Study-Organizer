// Standardwerte und Fabrikfunktionen für neue Datensätze.
import type {
  CalendarEvent,
  Db,
  Folder,
  ID,
  Item,
  Module,
  ModuleColor,
  NoteDoc,
  ScheduleSlot,
  Settings,
  Task,
} from './types'

export const newId = (): ID => crypto.randomUUID()
const now = (): string => new Date().toISOString()

export const MODULE_COLORS: ModuleColor[] = [
  'blue',
  'green',
  'orange',
  'purple',
  'pink',
  'yellow',
  'red',
  'brown',
  'gray',
]

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: 'system', accent: 'indigo', zoom: 1, compact: false, reduceMotion: false },
  editor: {
    font: 'inter',
    fontSize: 16,
    paper: 'plain',
    paperColor: 'auto',
    wide: false,
    spellcheck: true,
    penOnly: false,
    penColor: 'ink',
    penSize: 3,
  },
  study: {
    semesterModel: 'uni',
    askForNewSemester: true,
    sessionFolderName: '{kind} {n} · {date}',
  },
  calendar: { startHour: 8, endHour: 20, showWeekends: false, defaultView: 'week', syncIntervalHours: 6 },
  ai: { enabled: false, provider: 'groq', model: '', baseUrl: '', language: 'de', maxContextChars: 60_000 },
  moodle: { url: '', siteName: '', userId: null, courseMap: {}, syncFiles: false, lastSync: null },
}

export function createDefaultDb(): Db {
  return {
    version: 1,
    onboarded: false,
    activeSemesterId: null,
    profile: {
      name: '',
      university: '',
      institutionType: 'uni',
      program: '',
      degree: 'Bachelor',
      studySemester: 1,
    },
    settings: structuredClone(DEFAULT_SETTINGS),
    semesters: [],
    modules: [],
    folders: [],
    items: [],
    events: [],
    tasks: [],
    subscriptions: [],
  }
}

/** Ergänzt fehlende Felder (z. B. nach einem Update mit neuen Einstellungen) */
export function normalizeDb(raw: Partial<Db> | null | undefined): Db {
  const base = createDefaultDb()
  if (!raw || typeof raw !== 'object') return base
  const settings = { ...base.settings } as Settings
  for (const key of Object.keys(base.settings) as (keyof Settings)[]) {
    Object.assign(settings, { [key]: { ...base.settings[key], ...(raw.settings?.[key] ?? {}) } })
  }
  return {
    ...base,
    ...raw,
    version: 1,
    profile: { ...base.profile, ...(raw.profile ?? {}) },
    settings,
    semesters: raw.semesters ?? [],
    modules: raw.modules ?? [],
    folders: raw.folders ?? [],
    items: raw.items ?? [],
    events: raw.events ?? [],
    tasks: raw.tasks ?? [],
    subscriptions: (raw.subscriptions ?? []).map((sub) => ({ ...sub, kind: sub.kind ?? 'url' })),
  }
}

export function newSlot(partial: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id: newId(),
    kind: 'lecture',
    weekday: 1,
    start: '10:00',
    end: '11:30',
    room: '',
    everyTwoWeeks: false,
    firstDate: null,
    skip: [],
    ...partial,
  }
}

export function newModule(semesterId: ID, partial: Partial<Module> = {}): Module {
  return {
    id: newId(),
    semesterId,
    name: '',
    code: '',
    lecturer: '',
    color: 'blue',
    ects: null,
    schedule: [],
    info: '',
    order: Date.now(),
    createdAt: now(),
    ...partial,
  }
}

export function newFolder(moduleId: ID, partial: Partial<Folder> = {}): Folder {
  return {
    id: newId(),
    moduleId,
    parentId: null,
    name: 'Neuer Ordner',
    kind: 'general',
    sessionKind: null,
    date: null,
    room: '',
    done: false,
    order: Date.now(),
    createdAt: now(),
    ...partial,
  }
}

export function newNoteItem(moduleId: ID, folderId: ID | null, title = 'Unbenannte Notiz'): Item {
  return {
    id: newId(),
    moduleId,
    folderId,
    kind: 'note',
    title,
    fileType: null,
    fileName: null,
    mime: null,
    size: null,
    attachedTo: null,
    source: null,
    externalId: null,
    createdAt: now(),
    updatedAt: now(),
  }
}

export function newEvent(partial: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 90 * 60_000)
  return {
    id: newId(),
    title: '',
    kind: 'other',
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: false,
    moduleId: null,
    location: '',
    notes: '',
    subscriptionId: null,
    externalId: null,
    ...partial,
  }
}

export function newTask(partial: Partial<Task> = {}): Task {
  return {
    id: newId(),
    title: '',
    kind: 'assignment',
    moduleId: null,
    due: null,
    done: false,
    notes: '',
    source: null,
    externalId: null,
    createdAt: now(),
    ...partial,
  }
}

export function emptyNote(settings: Settings['editor']): NoteDoc {
  return {
    content: null,
    strokes: [],
    paper: settings.paper,
    paperColor: settings.paperColor,
    font: settings.font,
    height: 1100,
    text: '',
  }
}
