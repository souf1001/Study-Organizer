# Architecture

Study Organizer is an Electron app written in TypeScript with a React UI. The UI text is German; code, comments and documentation are English.

## Processes

| Layer | Folder | Responsibility |
|---|---|---|
| Main process | `src/main/` | App lifecycle, window, IPC, file protocol, OS keychain, login windows, background sync |
| Preload | `src/preload/index.ts` | Exposes `window.studyApi` (the `Api` interface from `src/shared/api.ts`) via `contextBridge` and forwards calls over IPC |
| Renderer | `src/renderer/` | React UI, sandboxed without Node.js access (`contextIsolation`, `sandbox`, strict CSP) |
| Backend | `src/backend/` | Business logic and storage; runs in Node.js in the main process |
| Shared | `src/shared/` | Types and pure logic with no platform dependencies, used by all layers |

The renderer only talks to data through `Api` (`src/renderer/src/lib/api.ts`). `lib/db.ts` keeps a copy of all metadata in a zustand store, applies changes optimistically and reloads from the backend on failure. Because the UI only knows the `Api` interface, the same UI can run against other backends (e.g. HTTP in the `webapp` branch).

### Main process (`src/main/`)

- `index.ts`: creates the `Store`, the secrets store and the service; registers the `studyfile://` protocol; runs `service.syncAll()` at startup and periodically; flushes the store before quitting. `STUDY_ORGANIZER_DATA` overrides the data folder (used by the e2e tests).
- `ipc.ts`: maps IPC channels to service methods. Every handler checks that the request comes from the app's own UI. Also hosts the native dialogs (e.g. the save dialog for exported `.studysetup` files).
- `protocol.ts`: serves stored files to the renderer as `studyfile://files/<name>`, with range requests for video seeking.
- `secrets.ts`: implements the backend `Secrets` interface with a `secrets.json` file whose values are encrypted with Electron `safeStorage` (Keychain, DPAPI, libsecret).
- `moodle-sso.ts` and `tucan-session.ts`: login windows, see below.

## Shared types (`src/shared/`)

- `types.ts`: the data model. `Db` holds the profile, settings and the collections (`semesters`, `modules`, `folders`, `items`, `events`, `tasks`, `subscriptions`, `chats`, …) plus `moodleDiscussions`. Note content (`NoteDoc`), PDF annotations and files are stored separately from `Db`.
- `api.ts`: the `Api` interface between UI and backend.
- `defaults.ts`: default database, `normalizeDb()` for loading older or partial data, ID and record factories.
- `semester.ts`, `schedule.ts`, `dates.ts`: semester models (university, HAW/FH, h_da), weekly schedules and session dates.
- `ai-providers.ts`, `agent.ts`, `markdown.ts`: AI provider catalog and helpers for the AI chat.
- `course-matching.ts`: matches Moodle courses to modules.
- `moodle-launch.ts`, `md5.ts`: Moodle SSO token handling.
- `setup-bundle.ts`: the `.studysetup` file format.

## Backend (`src/backend/`)

### Service and storage

`service.ts` exports `createService(store, secrets, options)`. It contains all backend operations (CRUD, file import, AI, calendar, Moodle, setup transfer, `syncAll`). The IPC layer and other clients only call into the service, so the business logic exists once.

The service depends on two interfaces instead of concrete storage:

- `DataStore` (`data-store.ts`): metadata access (`get`, `put`, `replaceMany`, `update`, `remove`, `replaceDb`), note/annotation/text/file content, search, `flush` and `reset`.
- `Secrets` (`secrets.ts`): `get`/`set`/`remove` for secret values kept outside the database.

The platform-independent part (in-memory `Db`, delayed saving, cascading deletes, search) lives in the abstract `RecordStore` (`record-store.ts`). Subclasses only implement persistence. On desktop that is `store.ts`:

```
<dir>/db.json               metadata (semesters, modules, folders, items, events, tasks, settings, ...)
<dir>/notes/<id>.json       note content (text + drawings)
<dir>/files/<id>.<ext>      uploaded files
<dir>/text/<id>.txt         text extracted from PDFs (search, AI)
<dir>/annotations/<id>.json drawings on PDF pages
```

Writes are debounced and atomic (write to a temp file, then rename). `files.ts` detects file types and validates IDs and file names against path traversal.

### Secrets bound to their target

Secrets are named `moodle`, `ai:<provider>` and `ics:<subscriptionId>`. The Moodle token and AI keys are stored as `{ value, target }`, where `target` is the Moodle site or the AI base URL. `readBound()` refuses to return a secret when the configured address no longer matches, so changing a setting can never send a key or token to a different server. Calendar feed URLs contain their own key; the database only keeps a masked version (`maskCalendarUrl`), the full URL lives in the secret.

### AI

`ai.ts` is the single entry point. It resolves provider, base URL and model, then delegates to `ai-openai.ts` (OpenAI-compatible APIs, including Ollama and LM Studio) or `ai-anthropic.ts`. Responses are streamed to the renderer.

### Moodle

- `moodle.ts`: `MoodleClient` for the Moodle web services (the ones the official mobile app uses), `moodleSiteInfo()` (detects password vs. SSO login), `connectMoodle()` and `syncMoodle()`. A sync turns assignments into tasks, other events (quizzes, deadlines) into calendar events, syncs forum discussions, and optionally downloads course files.
- `moodle-threads.ts`: reading and replying to forum threads. Replies need the root post ID, which is resolved lazily and stored once found.
- SSO: `shared/moodle-launch.ts` builds the `launch.php` URL with a random passport and verifies the `moodlemobile://token=…` redirect (`md5(wwwroot + passport)`). `main/moodle-sso.ts` shows the login page in a separate window with its own session partition (no permissions granted) and intercepts the redirect.

See [integrations.md](integrations.md) for the Moodle API details.

### Calendar and ICS (`ics.ts`)

- Decoding of UTF-8 and UTF-16 (LE/BE, with or without BOM), since TUCaN and other systems export UTF-16.
- Parsing with `ical.js`, including RRULE expansion and `RECURRENCE-ID` exceptions.
- `classifyEvent()`: maps German and English keywords to `EventKind` (lecture, exercise, lab, exam, deadline, other).
- `matchModule()`: assigns events to modules by code (with suffixes like `-vl` stripped), name and Roman numeral normalization; unmatched courses can create modules in the active semester.
- Subscriptions: `normalizeCalendarUrl()` (also `webcal://`), `fetchCalendar()`, and `mergeSubscriptionEvents()`, which keeps older events that drop out of a feed's rolling window. File imports replace the previous snapshot of the same file.

### TUCaN wizard (`main/tucan-session.ts`)

TU Darmstadt's TUCaN offers no subscription, only per-month `.ics` exports. `startTucanWizard()` opens TUCaN in a sandboxed window with an isolated session partition, guides the user to the export, intercepts the downloads (`will-download`), combines them (`combineIcs`) and imports the result through `service.calendarImportFile`. A fallback crawler can step through the months automatically.

### Setup transfer

- `shared/setup-bundle.ts` defines the `.studysetup` format: a JSON `SetupBundle` with a scope (`settings`, `study`, `everything`), optional credentials, study data and content (notes, annotations, extracted texts, base64 files). With a password, the bundle is encrypted with AES-256-GCM using a PBKDF2-SHA256 key (250,000 iterations) via WebCrypto.
- `backend/setup-transfer.ts` creates and applies these files using only `DataStore` and `Secrets`, so it runs unchanged on every platform. Scope `settings` merges into the existing data; `study` and `everything` reset the store and replace its data. Credentials are written back into `Secrets`. After import, the service re-matches events and Moodle discussions to modules.
- UI: `renderer/src/views/settings/SetupTransfer.tsx` (settings section „Geräte-Übertragung“) and the import button on the onboarding screen.

## Tests

- **Unit tests** (Vitest, `npm test`): `tests/**/*.test.ts`, run in Node. They cover the shared logic and the backend directly, e.g. `ics.test.ts`, `moodle*.test.ts`, `moodle-sso.test.ts`, `service.test.ts`, `store.test.ts`, `setup-transfer.test.ts`, `semester.test.ts`, `schedule.test.ts`, plus calendar, TUCaN and stress/edge-case suites.
- **End-to-end tests** (Playwright, `npm run test:e2e`): `tests/e2e/*.spec.ts` launch the built Electron app (`out/main/index.js`, or a packaged build via `STUDY_E2E_EXECUTABLE`) with a temporary data folder. `mock-server.ts` provides an OpenAI-compatible AI API and an iCal feed. Run `npm run build` first; on Linux without a display use `xvfb-run -a npm run test:e2e`.
- `npm run typecheck` and `npm run lint` complete the checks; CI runs them in `.github/workflows/ci.yml`.

## Android app (branch `mobile-android`)

The Android app wraps the same renderer with [Capacitor](https://capacitorjs.com). There is no
main process: the backend service runs inside the WebView.

- `renderer/src/lib/api.ts`: `initApi()` uses `window.studyApi` from the preload script on
  desktop and otherwise loads `renderer/src/mobile/mobile-api.ts`.
- Storage: `backend/browser-store.ts` (`BrowserStore extends RecordStore`) on top of the small
  `KeyValueStore` in `backend/key-value.ts` (IndexedDB in the app, in-memory in tests).
  Files are Blobs shown through object URLs. Secrets live in the app's private IndexedDB.
- Network: Capacitor's native HTTP replaces `fetch`, so there are no CORS restrictions.
- Logins: `android/.../WebLoginPlugin.java` is a full-screen in-app browser
  (`renderer/src/mobile/web-login.ts`). It ends on a redirect prefix (Moodle SSO,
  `moodlemobile://token=…`) or captures downloads with the session cookies (TUCaN `.ics` export).
- Layout: `renderer/src/lib/device.ts` classifies phone/tablet by the *screen* size, so the
  on-screen keyboard cannot switch layouts while typing. Phones get a bottom navigation
  (`shell/MobileNav.tsx`) and a sidebar drawer.
- Back button: `renderer/src/lib/back-stack.ts` lets open layers (dialogs, menus, drawer) register
  a handler; `renderer/src/mobile/android.ts` closes the top layer, then navigates back.
- Background sync uses the same `backend/background-sync.ts` as the desktop main process.
- The APK is built by `.github/workflows/android.yml` (`npm run build:android` + `scripts/build-android.mjs`).
