# Project: Study Organizer - University Calendar & TUCaN Integration

## Architecture
Study Organizer is an Electron + React + TypeScript desktop application for student productivity.
- **Frontend (`src/renderer/`)**: React 19 UI with CSS variables, icons (Lucide), state store (`useDbStore`), and view components:
  - `CalendarView.tsx`: Displays week, month, and agenda calendar views; handles event scheduling, day navigation, and calendar-level actions.
  - `IntegrationSettings.tsx`: Settings view for configuring external integrations (Moodle, Calendar feeds, TUCaN).
- **Preload & Shared (`src/preload/`, `src/shared/`)**:
  - `types.ts`: Core data structures (`Db`, `CalendarEvent`, `EventKind`, `Subscription`, `Module`, `Semester`).
  - `api.ts`: Type-safe IPC API definitions exposed via `window.api`.
  - `defaults.ts`: Database normalization and default data structures.
- **Backend Service (`src/backend/`)**:
  - `store.ts`: Atomic JSON database persistence in `<userData>/db.json`.
  - `service.ts`: Backend service exposing business logic for calendar imports, sync, module management, and integrations.
  - `ics.ts`: iCalendar parsing (`ical.js`), recurrence expansion (RRULE), event classification (`classifyEvent`), module matching (`matchModule`), and deduplication (`mergeSubscriptionEvents`).
- **Main Process (`src/main/`)**:
  - `ipc.ts`: IPC handlers bridging renderer API calls to backend services.
  - `moodle-sso.ts` / `tucan-session.ts`: Electron `BrowserWindow` modals handling university authentication, SSO, and export downloads in isolated web partitions.
  - `index.ts`: Application lifecycle and background sync scheduler.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | UTF-16LE / UTF-16BE / UTF-8 BOM Decoding | Auto-detect BOM/encoding for TUCaN and university ICS exports | M1 | Survey / Spec Miner |
| 2 | `exercise` EventKind Support | Add `'exercise'` to `EventKind`, `EVENT_KINDS`, `KIND_COLOR`, and calendar styling | M1 | ORIGINAL_REQUEST §R2 |
| 3 | Expanded Academic Event Classification | Recognize German academic keywords (`Vorlesung`, `Übung`, `HÜ`, `GÜ`, `Praktikum`, `Klausur`, `Prüfung`, `Frist`, `Abgabe`, etc.) | M1 | ORIGINAL_REQUEST §R2 |
| 4 | Intelligent Module Recognition & Suffix Stripping | Match module codes (`20-00-0012-vl` -> `20-00-0012`), roman numerals (`Analysis I` vs `Analysis 1`), and categories | M1 | ORIGINAL_REQUEST §R2 |
| 5 | Module Auto-Creation for Active Semester | Automatically create missing modules with color assignment for unmatched events | M1 | ORIGINAL_REQUEST §R2 |
| 6 | Robust Duplicate & Snapshot Handling | Clean snapshot replacement via `subscriptionId`/`externalId`, plus download filename normalization (`schedule (1).ics` -> `schedule.ics`) | M1 | ORIGINAL_REQUEST §R4 |
| 7 | CalendarView Direct ICS Upload Button | Visible button in `CalendarView.tsx` toolbar to pick and import `.ics` files | M2 | ORIGINAL_REQUEST §R1 |
| 8 | CalendarView Drag-and-Drop Dropzone | Full calendar Drag & Drop area with visual drop indicator overlay across week/month/agenda | M2 | ORIGINAL_REQUEST §R1 |
| 9 | Calendar Event Refresh & Reactive UI Feedback | Immediate event rendering after import via `loadDb()` and informative toasts / error handling | M2 | ORIGINAL_REQUEST §R1 |
| 10 | Calendar-Level Subscription Management | Toolbar dialog/action in `CalendarView.tsx` to view, sync, and remove active subscriptions | M2 | ORIGINAL_REQUEST §R4 |
| 11 | TUCaN Guided Session / Export Wizard | Electron `BrowserWindow` wizard guiding user through TUCaN timetable export with automatic download interception | M3 | ORIGINAL_REQUEST §R3 |
| 12 | University WebCal & Direct Feed URL Sync | Support for live `webcal://` and `https://` feeds with periodic background sync and non-blocking error handling | M3 | ORIGINAL_REQUEST §R3, §R4 |
| 13 | Integration Settings UI for TUCaN & Feeds | Dedicated section in `IntegrationSettings.tsx` for TUCaN assistant, feed management, and status display | M3 | ORIGINAL_REQUEST §R3, §R4 |
| 14 | Comprehensive E2E Testing Suite (Tiers 1-4) | Requirements-driven test suite with >=50 test cases covering all features, boundary values, combinations, and workflows | M4 | ORIGINAL_REQUEST §Acceptance Criteria |
| 15 | Tier 5 Adversarial Coverage Hardening & Full Verification | White-box stress tests, full pass of `npm test`, `npm run typecheck`, and `npm run lint` | M4 | ORIGINAL_REQUEST §Acceptance Criteria |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core ICS, Encoding & Classification Engine | UTF-16/BOM decoding, EventKind `exercise` addition, academic regex rules, intelligent module matching, auto-creation in active semester, duplicate prevention | None | DONE |
| M2 | CalendarView ICS Upload & Drag-and-Drop UX | Upload button in toolbar, Drag & Drop dropzone on CalendarView, calendar subscription management UI, reactive state refresh and toasts | M1 | DONE |
| M3 | TUCaN & University Integration Wizard | Electron assisted TUCaN modal with download interception, webcal feed sync, integration settings section, non-blocking error handling | M1 | DONE |
| M4 | Comprehensive Testing, Tier 5 Hardening & Verification | Complete E2E testing pass (Tiers 1-4), Tier 5 adversarial hardening, `npm test`, `npm run typecheck`, `npm run lint` verification | M1, M2, M3 | DONE |

---

## Interface Contracts

### 1. `EventKind` & Classification Contract
- `src/shared/types.ts`:
  ```ts
  export type EventKind = 'exam' | 'deadline' | 'lab' | 'lecture' | 'exercise' | 'other'
  ```
- `src/backend/ics.ts`:
  ```ts
  export function decodeIcsText(bufferOrString: Buffer | Uint8Array | string): string
  export function classifyEvent(summary: string, description?: string, categories?: string[]): EventKind
  export function matchModule(
    summary: string,
    description: string,
    categories: string[],
    modules: Module[]
  ): Module | null
  export function eventsFromIcs(
    icsText: string,
    subscription: Subscription,
    modules: Module[],
    options?: { activeSemesterId?: ID | null; autoCreateModules?: boolean; onModuleCreated?: (mod: Module) => void }
  ): CalendarEvent[]
  ```

### 2. IPC & Preload Contract
- `src/shared/api.ts`:
  ```ts
  export interface CalendarApi {
    importFile(name: string, content: string | Uint8Array): Promise<{ count: number; newModules?: number }>
    subscribe(name: string, url: string): Promise<Subscription>
    sync(id: ID): Promise<{ count: number }>
    removeSubscription(id: ID): Promise<void>
  }
  export interface TucanApi {
    startWizard(): Promise<{ success: boolean; count?: number; error?: string }>
  }
  ```

### 3. CalendarView Drag-and-Drop & Toolbar Contract
- Root `.calendar` container handles:
  - `onDragOver`: checks `e.dataTransfer.types.includes('Files')` -> sets `dropping: true`
  - `onDragLeave`: clears `dropping: false` when leaving container
  - `onDrop`: reads `.ics` file(s), calls `api.calendar.importFile`, triggers `loadDb()`, displays `toast`

---

## Code Layout
- `src/shared/types.ts`: Core data models (`EventKind`, `CalendarEvent`, `Subscription`)
- `src/shared/api.ts`: API type definitions
- `src/backend/ics.ts`: ICS decoding, parsing, EventKind classification, module recognition
- `src/backend/service.ts`: Calendar subscription, import, and module auto-creation logic
- `src/main/ipc.ts`: IPC registration for calendar and TUCaN
- `src/main/tucan-session.ts`: Electron BrowserWindow TUCaN session wizard
- `src/renderer/src/views/calendar/CalendarView.tsx`: Calendar UI, upload button, drag-and-drop overlay, subscription manager
- `src/renderer/src/views/calendar/entries.ts`: EventKind color mapping and calendar entry projection
- `src/renderer/src/views/calendar/calendar.css`: Styles for drag-and-drop hints and new event kinds
- `src/renderer/src/views/settings/IntegrationSettings.tsx`: University & TUCaN settings UI
- `tests/ics.test.ts`: Unit tests for ICS decoding, classification, and module matching
- `tests/calendar-e2e.test.ts`: Comprehensive E2E test suite
