# Schnittstellen zu Hochschulsystemen

Recherche-Stand: 27.09.2026. Ziel: Stundenplan, Abgaben, Prüfungen und Materialien möglichst automatisch in den Study Organizer bekommen.

> Die Angaben zu Moodle stammen direkt aus dem Moodle-Quellcode (4.5 bis 5.3). Die Angaben zur h_da und zu anderen Hochschulsystemen stammen aus deren Dokumentation und aus Suchergebnissen. Bitte im Zweifel mit den offiziellen Seiten deiner Hochschule abgleichen.

## Was die App umsetzt

| Quelle | Weg | Was ankommt |
|---|---|---|
| **Moodle** (z. B. lernen.h-da.de) | Web-Services wie die Moodle-App (Passwort oder Hochschul-Login/SSO) | Abgaben als abhakbare Aufgaben, Tests/Kurstermine im Kalender, optional Kursdateien in einem Ordner „Moodle“ pro Modul |
| **Moodle** | Kalender-Export als iCal-Abo | alle Kalendertermine, regelmäßig abgeglichen |
| **Stud.IP, ILIAS, OBS (h_da Informatik), LSF** | iCal-Abo | Stundenplan- bzw. Kalendertermine |
| **my h_da / HISinOne, TUCaN** | .ics-Datei importieren | Stundenplan als Momentaufnahme (bei Änderungen neu importieren) |

Abo-Adressen enthalten meist einen persönlichen Schlüssel. Sie werden deshalb verschlüsselt gespeichert; in der App ist nur eine gekürzte Adresse sichtbar.

## Moodle

### Kalender exportieren (iCal-Abo)

1. Kalender öffnen (Block „Kalender“ → „Vollständiger Kalender“ oder `/calendar/view.php`).
2. Unten **„Import und Export“** (ältere Versionen: „Abonnements verwalten“) → **„Kalender exportieren“**.
3. „Zu exportierende Termine“: **Alle Termine**. „Zeitdauer“: **Eigener Bereich** (wenn angeboten, sonst „Vergangene und nachfolgende 60 Tage“).
4. **„Kalender-URL abfragen“** → URL kopieren und in der App einfügen.

Die URL hat die Form `https://<moodle>/calendar/export_execute.php?userid=…&authtoken=…&preset_what=all&preset_time=custom`. Sie läuft nicht ab. Ungültig wird sie, wenn sich das Moodle-Passwort ändert oder der Export deaktiviert wird. Das Zeitfenster „rolliert“ mit (z. B. 5 Tage zurück bis 365 Tage voraus). Die App behält deshalb ältere Termine, die aus dem Fenster herausfallen.

### Web-Services (Moodle-Anbindung in der App)

- Die App fragt zuerst ohne Anmeldung `tool_mobile_get_public_config` ab und erkennt so, ob ein Login-Formular (`typeoflogin = 1`) oder der Hochschul-Login (SSO, `typeoflogin = 2/3`) nötig ist.
- **Passwort-Login:** `POST /login/token.php` mit `service=moodle_mobile_app`. Das Passwort wird nicht gespeichert, nur der Token (Standard-Gültigkeit 12 Wochen). Funktioniert nicht bei reinem Shibboleth/SAML/OAuth2.
- **Hochschul-Login (SSO):** Wie bei der offiziellen Moodle-App öffnet sich `admin/tool/mobile/launch.php` in einem eigenen Fenster. Nach dem Login leitet Moodle auf `moodlemobile://token=…` weiter. Die App fängt das ab und prüft die Signatur `md5(wwwroot + passport)`.
- **Sicherheitsschlüssel:** Unter Einstellungen → Sicherheitsschlüssel. Für Studierende meist nicht freigeschaltet.
- Genutzte Funktionen:
  - `core_webservice_get_site_info`
  - `core_enrol_get_users_courses`
  - `mod_assign_get_assignments` (vollständige Abgabetermine)
  - `core_calendar_get_calendar_events` (Kurstermine, Tests)
  - `core_course_get_contents` (Dateien; Download über `fileurl` + `token`)

## Hochschule Darmstadt (h_da)

- **my h_da** (https://my.h-da.de) basiert auf HISinOne. Der persönliche Stundenplan lässt sich über „Daten für Kalender (ics) exportieren“ als Datei herunterladen. Ein Abo ist dort nicht belegt, deshalb gibt es den Datei-Import.
- **Moodle:** https://lernen.h-da.de. Ob Passwort-Login oder SSO nötig ist, erkennt die App automatisch.
- **FB Informatik – OBS:** Der persönliche Terminplan lässt sich als Internetkalender abonnieren: `https://obs.fbi.h-da.de/obs/index.php?action=getTerminplan&lfkey=…`.
- **Semestertermine** (in der App als Modell „Hochschule Darmstadt“ hinterlegt):

| Semester | Semesterzeitraum | Vorlesungszeit |
|---|---|---|
| WiSe 2025/26 | 01.10.2025–31.03.2026 | 06.10.2025–30.01.2026 |
| SoSe 2026 | 01.04.–30.09.2026 | 13.04.–24.07.2026 |
| WiSe 2026/27 | 01.10.2026–31.03.2027 | 12.10.2026–05.02.2027, Weihnachtspause 21.12.2026–08.01.2027 |

## Andere Systeme

- **HISinOne** (viele Unis): „Mein Stundenplan“ → „Daten für Kalender (ics) exportieren“ liefert eine Datei.
- **Stud.IP:** Planer → Terminkalender → „Kalender teilen“ → „Adresse generieren“ ergibt eine Abo-Adresse (`…/dispatch.php/ical/index/<key>`). Eine JSON-API gibt es zusätzlich, falls die Hochschule sie freischaltet.
- **ILIAS:** Kalender → „Abonnieren“ → „iCal-URL“ (`…/calendar.php?client_id=…&token=…`).
- **TUCaN (TU Darmstadt):** Stundenplan → „Export“ liefert je Monat eine Datei. Ein Abo gibt es nicht.
- **LSF/QIS:** Im Stundenplan „iCal Export“. Teilweise lässt sich der Link als Abo nutzen.

## Semesterzeiten allgemein

- **Universitäten:** WiSe 1.10.–31.3., SoSe 1.4.–30.9. Vorlesungen von Mitte Oktober bis Anfang Februar bzw. von Mitte April bis Mitte Juli. Beispiel NRW: WiSe 2026/27 12.10.2026–05.02.2027.
- **HAW/FH** (z. B. NRW): WiSe 1.9.–28.2., SoSe 1.3.–31.8. Beispiel: Vorlesungen WiSe 2026/27 28.09.2026–12.02.2027, SoSe 2027 29.03.–23.07.2027.
- In Bayern legt seit 2023 jede Hochschule ihre Zeiten selbst fest. In der App lassen sich alle Termine beim Anlegen eines Semesters anpassen.

## Quellen (Auswahl)

- Moodle-Quellcode: `calendar/export_execute.php`, `login/token.php`, `admin/tool/mobile/launch.php`, `admin/tool/mobile/classes/external.php`, `mod/assign/externallib.php`, `calendar/externallib.php` (github.com/moodle/moodle)
- Moodle-App: github.com/moodlehq/moodleapp (`login-helper.ts`)
- h_da: h-da.de/termine, Merkblätter WiSe 26/27 und SoSe 26, my.h-da.de, lernen.h-da.de, obs.fbi.h-da.de
- HISinOne: wiki.uni-freiburg.de/campusmanagement
- Stud.IP: docs.gitlab.studip.de, hilfe.studip.de
- ILIAS: github.com/ILIAS-eLearning/ILIAS (`calendar.php`)
- TUCaN: tu-darmstadt.de (Hilfe & FAQ)
- Semesterzeiten: mkw.nrw/service/vorlesungszeiten, hrk.de
