# Integrations with university systems

Research as of 2026-09-27. Goal: get timetables, assignments, exams and course material into Study Organizer as automatically as possible.

> The Moodle details come directly from the Moodle source code (4.5 to 5.3). The details on h_da and other university systems come from their documentation and from search results. When in doubt, check against your university's official pages.

Moodle and the university systems have German interfaces; their labels are quoted as they appear, with an English translation in parentheses.

## What the app implements

| Source | Method | What arrives |
|---|---|---|
| **Moodle** (e.g. lernen.h-da.de) | Web services, like the Moodle mobile app (password or university login/SSO) | Assignments as checkable tasks, quizzes/course events in the calendar, optionally course files in a „Moodle“ folder per module |
| **Moodle** | Calendar export as an iCal subscription | All calendar events, synced regularly |
| **Stud.IP, ILIAS, OBS (h_da computer science), LSF** | iCal subscription | Timetable or calendar events |
| **my h_da / HISinOne, TUCaN** | Import an .ics file | Timetable as a snapshot (re-import after changes). For TUCaN, the app also offers a guided wizard that captures the export automatically. |

Subscription addresses usually contain a personal key. They are therefore stored encrypted; the app only shows a shortened address.

## Moodle

### Exporting the calendar (iCal subscription)

1. Open the calendar (block „Kalender“ → „Vollständiger Kalender“ (full calendar), or `/calendar/view.php`).
2. At the bottom, **„Import und Export“** (import and export; older versions: „Abonnements verwalten“, manage subscriptions) → **„Kalender exportieren“** (export calendar).
3. „Zu exportierende Termine“ (events to export): **Alle Termine** (all events). „Zeitdauer“ (time period): **Eigener Bereich** (custom range) if offered, otherwise „Vergangene und nachfolgende 60 Tage“ (recent and next 60 days).
4. **„Kalender-URL abfragen“** (get calendar URL) → copy the URL and paste it into the app.

The URL has the form `https://<moodle>/calendar/export_execute.php?userid=…&authtoken=…&preset_what=all&preset_time=custom`. It does not expire. It becomes invalid when the Moodle password changes or the export is disabled. The time window rolls forward (e.g. 5 days back to 365 days ahead), so the app keeps older events that drop out of the window.

### Web services (Moodle integration in the app)

- The app first calls `tool_mobile_get_public_config` without signing in, and uses it to detect whether a login form (`typeoflogin = 1`) or the university login (SSO, `typeoflogin = 2/3`) is required.
- **Password login:** `POST /login/token.php` with `service=moodle_mobile_app`. The password is not stored, only the token (valid for 12 weeks by default). Does not work with pure Shibboleth/SAML/OAuth2.
- **University login (SSO):** As in the official Moodle app, `admin/tool/mobile/launch.php` opens in a separate window. After login, Moodle redirects to `moodlemobile://token=…`. The app intercepts this and checks the signature `md5(wwwroot + passport)`.
- **Security key:** under Preferences → Security keys. Usually not enabled for students.
- Functions used:
  - `core_webservice_get_site_info`
  - `core_enrol_get_users_courses`
  - `mod_assign_get_assignments` (complete due dates)
  - `core_calendar_get_calendar_events` (course events, quizzes)
  - `core_course_get_contents` (files; downloaded via `fileurl` + `token`)

## Hochschule Darmstadt (h_da)

- **my h_da** (https://my.h-da.de) is based on HISinOne. The personal timetable can be downloaded as a file via „Daten für Kalender (ics) exportieren“ (export calendar data). A subscription is not documented there, hence the file import.
- **Moodle:** https://lernen.h-da.de. The app detects automatically whether password login or SSO is required.
- **Computer science department – OBS:** The personal schedule can be subscribed to as an internet calendar: `https://obs.fbi.h-da.de/obs/index.php?action=getTerminplan&lfkey=…`.
- **Semester dates** (built into the app as the „Hochschule Darmstadt“ model):

| Semester | Semester period | Lecture period |
|---|---|---|
| Winter 2025/26 | 2025-10-01 – 2026-03-31 | 2025-10-06 – 2026-01-30 |
| Summer 2026 | 2026-04-01 – 2026-09-30 | 2026-04-13 – 2026-07-24 |
| Winter 2026/27 | 2026-10-01 – 2027-03-31 | 2026-10-12 – 2027-02-05, Christmas break 2026-12-21 – 2027-01-08 |

## Other systems

- **HISinOne** (many universities): „Mein Stundenplan“ (my timetable) → „Daten für Kalender (ics) exportieren“ yields a file.
- **Stud.IP:** Planer → Terminkalender → „Kalender teilen“ → „Adresse generieren“ (planner → calendar → share calendar → generate address) yields a subscription address (`…/dispatch.php/ical/index/<key>`). There is also a JSON API if the university enables it.
- **ILIAS:** Calendar → „Abonnieren“ (subscribe) → „iCal-URL“ (`…/calendar.php?client_id=…&token=…`).
- **TUCaN (TU Darmstadt):** Timetable → „Export“ yields one file per month. There is no subscription. The app's TUCaN wizard (Settings → Moodle & Kalender-Abos) opens TUCaN in a separate window, captures the downloaded files and imports them.
- **LSF/QIS:** „iCal Export“ in the timetable. In some cases the link can be used as a subscription.

## Semester dates in general

- **Universities:** winter semester Oct 1 – Mar 31, summer semester Apr 1 – Sep 30. Lectures from mid-October to early February and from mid-April to mid-July. Example NRW: winter 2026/27 lectures 2026-10-12 – 2027-02-05.
- **Universities of applied sciences (HAW/FH)** (e.g. NRW): winter semester Sep 1 – Feb 28, summer semester Mar 1 – Aug 31. Example: lectures winter 2026/27 2026-09-28 – 2027-02-12, summer 2027 2027-03-29 – 2027-07-23.
- In Bavaria, each university has set its own dates since 2023. In the app, all dates can be adjusted when creating a semester.

## Sources (selection)

- Moodle source code: `calendar/export_execute.php`, `login/token.php`, `admin/tool/mobile/launch.php`, `admin/tool/mobile/classes/external.php`, `mod/assign/externallib.php`, `calendar/externallib.php` (github.com/moodle/moodle)
- Moodle app: github.com/moodlehq/moodleapp (`login-helper.ts`)
- h_da: h-da.de/termine, information sheets for winter 26/27 and summer 26, my.h-da.de, lernen.h-da.de, obs.fbi.h-da.de
- HISinOne: wiki.uni-freiburg.de/campusmanagement
- Stud.IP: docs.gitlab.studip.de, hilfe.studip.de
- ILIAS: github.com/ILIAS-eLearning/ILIAS (`calendar.php`)
- TUCaN: tu-darmstadt.de (help & FAQ)
- Semester dates: mkw.nrw/service/vorlesungszeiten, hrk.de
