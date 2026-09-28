# Web-Version (Server mit Benutzerkonten)

Die Web-Version bietet die gleiche Oberfläche wie die Desktop-App, läuft aber auf einem Server im Browser – mit **Benutzerkonten**, **getrennten Daten pro Konto** und **begrenztem Speicher pro Konto**.

## So funktioniert es

```
Browser ──HTTPS──▶ Caddy (Zertifikat) ──▶ Node-Server (src/server)
                                            ├─ Konten & Sitzungen   data/accounts.json
                                            └─ pro Konto            data/users/<id>/
                                                                      ├─ data/     (wie Desktop: db.json, Notizen, Dateien)
                                                                      └─ secrets.json (API-Keys, AES-256-GCM)
```

- **Dieselbe Oberfläche**: Die Oberfläche erkennt, ob sie in der Desktop-App oder im Browser läuft (`src/renderer/src/lib/api.ts`). Im Browser spricht sie per HTTP mit dem Server (`web-api.ts`).
- **Dieselbe Logik**: Der Server nutzt dieselben Backend-Funktionen wie die Desktop-App (`src/backend/service.ts`), nur je Konto in einem eigenen Ordner.
- **Konten**: E-Mail und Passwort. Passwörter werden mit scrypt gehasht, das Sitzungs-Cookie ist `HttpOnly`, `SameSite=Strict` und hinter HTTPS `Secure`.
- **Speicherlimit**: `USER_QUOTA_MB` pro Konto (Standard 500 MB). Uploads über dem Limit lehnt der Server ab. Unter Einstellungen → Konto & Speicher sieht man die Belegung.
- **Sicherheit**:
  - Schutz vor Cross-Site-Anfragen (eigener Header plus Herkunftsprüfung).
  - Strenge Content-Security-Policy.
  - Dateien werden mit `sandbox` ausgeliefert, unbekannte Typen nur als Download.
  - Bremse gegen Passwort-Raten.
  - **Schutz vor Zugriffen auf interne Netze**: Kalender-Abos, Moodle und KI-Anbieter dürfen keine privaten oder lokalen Adressen aufrufen, auch nicht über Weiterleitungen oder DNS-Tricks.
- **Unterschiede zur Desktop-App**:
  - Moodle-Anmeldung per Hochschul-Login (SSO) gibt es nur in der Desktop-App. Im Browser gehen Passwort, Sicherheitsschlüssel oder Kalender-Abo.
  - Lokale KI (Ollama, LM Studio) ist nicht erreichbar.
  - „Mit Standard-App öffnen“ heißt hier „Herunterladen“.

## Lokal ausprobieren

```bash
npm install
npm run web:dev
```

Dann <http://localhost:3000> öffnen, Konto erstellen, fertig. Änderungen an der Oberfläche laden sofort neu. Die Daten landen im Ordner `./data`.

## Auf einem eigenen Server betreiben (Schritt für Schritt)

Du brauchst einen kleinen Linux-Server, z. B. einen Cloud-Server mit Ubuntu (2 GB RAM reichen), und eine Domain oder Subdomain.

1. **Domain auf den Server zeigen lassen**: Beim Domain-Anbieter einen DNS-Eintrag vom Typ `A` für z. B. `study.deine-domain.de` mit der IP-Adresse des Servers anlegen.
2. **Auf dem Server anmelden**:
   ```bash
   ssh root@<server-ip>
   ```
3. **Docker installieren**:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. **Code holen**:
   ```bash
   git clone https://github.com/souf1001/Study-Organizer.git
   cd Study-Organizer
   git checkout webapp
   ```
5. **Einstellungen anlegen**:
   ```bash
   cp .env.example .env
   openssl rand -hex 32        # Ausgabe kopieren
   nano .env                   # DOMAIN und SECRET_KEY eintragen, speichern mit Strg+O, beenden mit Strg+X
   ```
   Den `SECRET_KEY` gut aufheben: Ohne ihn lassen sich gespeicherte API-Keys nicht mehr entschlüsseln.
6. **Starten**:
   ```bash
   docker compose up -d --build
   ```
   Caddy holt automatisch ein HTTPS-Zertifikat. Nach ein bis zwei Minuten ist die App unter `https://study.deine-domain.de` erreichbar.
7. **Konto erstellen**: Seite öffnen → Registrieren. Soll sich niemand weiteres registrieren, in `.env` `ALLOW_REGISTRATION=false` setzen und `docker compose up -d` ausführen.

### Updates

```bash
cd Study-Organizer
git pull
docker compose up -d --build
```

### Backup

Alle Daten liegen im Docker-Volume `study-data`:

```bash
docker run --rm -v study-organizer_study-data:/data -v "$PWD":/backup busybox tar czf /backup/study-backup.tgz /data
```

### Verwaltung (Passwort vergessen, Konto löschen)

Es gibt keinen E-Mail-Versand. Passwörter setzt der Betreiber zurück:

```bash
docker compose exec app node out/server/admin.js list
docker compose exec app node out/server/admin.js reset-password anna@example.de NeuesSicheresPasswort
docker compose exec app node out/server/admin.js delete anna@example.de
```

## Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `SECRET_KEY` | – (Pflicht) | 64 Hex-Zeichen, verschlüsselt API-Keys und Moodle-Tokens |
| `USER_QUOTA_MB` | 500 | Speicher pro Konto |
| `MAX_UPLOAD_MB` | 200 | Größte einzelne Datei |
| `ALLOW_REGISTRATION` | true | Neue Konten erlauben |
| `SESSION_DAYS` | 30 | Wie lange man angemeldet bleibt |
| `COOKIE_SECURE` | true in Produktion | Cookie nur über HTTPS |
| `TRUST_PROXY` | false | Hinter Caddy/nginx auf `true` setzen (in `docker-compose.yml` schon gesetzt) |
| `ALLOW_PRIVATE_NETWORK` | false | Nur für private Installationen: interne Adressen erlauben, z. B. Ollama im Heimnetz |
| `PORT` / `DATA_DIR` | 3000 / ./data | Port und Datenordner |

## Grenzen

- Gedacht für einen Server-Prozess: kleine bis mittlere Gruppen, z. B. Lerngruppe, Fachschaft oder ein paar hundert Konten. Für sehr viele gleichzeitige Nutzer müsste die JSON-Ablage gegen eine Datenbank getauscht werden. Die Stelle dafür ist `src/backend/store.ts`, die Oberfläche bleibt gleich.
- Kein Passwort-Reset per E-Mail (siehe Verwaltung).
