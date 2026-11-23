# Pupsi aufs iPhone — ohne Mac

Apple erlaubt keine App-Installation direkt am iPhone. Irgendwo muss immer **signiert** werden. Wir verlegen das in die Cloud — du brauchst nur einen **Windows-PC** und deine **Apple ID**.

## Ablauf

1. GitHub baut die App in der Cloud (macOS-Runner, kostenlos).
2. Du lädst die `.ipa` herunter.
3. **Sideloadly** (Windows, kostenlos) signiert sie mit deiner Apple ID und spielt sie aufs iPhone.

---

## Schritt 1 — GitHub-Konto

Falls noch nicht vorhanden: **github.com** → kostenlos anmelden.

## Schritt 2 — Projekt hochladen

1. Auf GitHub auf **+** → **New repository**.
2. Name: `pupsi-ios` (beliebig), **Public** oder **Private** — beides geht.
3. **Create repository** klicken.
4. Den Ordner `pupsi-ios` von deinem PC in das Repository hochladen:
   - Auf der Repo-Seite **Add file → Upload files**
   - Alle Dateien aus `pupsi-ios/` auswählen (inkl. `app/`, `tweak/`, `.github/`)
   - **Commit changes** klicken

## Schritt 3 — Build in der Cloud starten

1. Oben im Repo auf den Reiter **Actions** klicken.
2. Links **Build Pupsi IPA** auswählen.
3. Rechts **Run workflow** → grünen Button **Run workflow** klicken.
4. Warten (~5–10 Minuten). Der Job läuft auf einem echten Mac bei GitHub.
5. Wenn er fertig ist: unten bei **Artifacts** auf **PupsiChess-ipa** klicken → ZIP herunterladen.
6. ZIP entpacken → du hast **`PupsiChess.ipa`**.

## Schritt 4 — Sideloadly (Windows)

1. Auf **sideloadly.io** → **Download for Windows** holen und installieren.
2. iPhone per USB anschließen.
3. Sideloadly öffnen.
4. Bei **IPA** deine `PupsiChess.ipa` auswählen.
5. Bei **Apple ID** deine normale Apple ID eingeben (Passwort: kein echtes Passwort, sondern ein **App-spezifisches Passwort** von `appleid.apple.com` → *App-Specific Passwords* erzeugen).
6. Gerät oben auswählen → **Start** klicken.
7. Warten. Auf dem iPhone evt. **Vertrauen** bestätigen:
   Einstellungen → Allgemein → VPN & Geräteverwaltung → deine Apple ID → **Vertrauen**.

## Schritt 5 — Benutzen

**Pupsi Chess** öffnen → chess.com lädt → **Zahnrad antippen** → Menü. Fertig.

---

## Wichtig: Nach 7 Tagen

Mit einer **kostenlosen** Apple ID läuft die Signatur nach 7 Tagen ab. Die App startet dann nicht mehr.

**Lösung:** Schritt 3 + 4 wiederholen (neue .ipa laden, neu signieren). Oder:
- **TrollStore** nutzen (permanent, aber nur auf bestimmten iOS-Versionen — z. B. iOS 14.0–16.6.1; funktioniert direkt am iPhone ohne PC, wenn deine Version passt).
- Apple Developer Account (~99 €/Jahr) → 1 Jahr gültig.

---

## Kurzfassung

**GitHub Actions → .ipa herunterladen → Sideloadly auf Windows → Apple ID + App-Passwort → Start → Vertrauen → App öffnen.**

Kein Mac nötig. Nur GitHub, Windows und deine Apple ID.
