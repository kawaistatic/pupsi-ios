# In 3 Minuten auf GitHub

Du bist in **Brave** angemeldet — mach das dort. Der OpenCode-Browser ist ein anderer Browser, dort gilt deine Anmeldung nicht.

## Vorbereitung (schon erledigt)

Auf deinem Desktop liegt **`pupsi-ios-github.zip`**.

1. Rechtsklick → **Alle extrahieren…** → entpacken.
2. Du hast jetzt einen Ordner `pupsi-ios` mit allen Dateien.

## Upload

1. In **Brave** → **github.com** → oben rechts auf das **+** → **New repository**.
2. Bei **Repository name** eingeben: `pupsi-ios`
3. Bei **Description** (optional): `Pupsi v1 iOS App - Cloud Build`
4. **Public** auswählen (oder Private — beides geht für Actions).
5. **WICHTIG:** Bei "*Initialize this repository with:*" **NICHTS** anhaken — keine README, keine .gitignore, keine License.
6. **Create repository** klicken.
7. Auf der nächsten Seite steht "*…or upload an existing file*" → diesen Link klicken.
8. Den **entpackten Ordner `pupsi-ios`** mit der Maus in die graue Fläche ziehen (oder klicken und alle Dateien + Unterordner auswählen).
9. Unten bei **Commit changes** den Text lassen und auf **Commit changes** klicken.

## Build starten

1. Oben auf **Actions** klicken.
2. Links **Build Pupsi IPA** auswählen.
3. Rechts **Run workflow** → **Run workflow** (grüner Button).
4. 5–10 Minuten warten.
5. Bei **Artifacts** → **PupsiChess-ipa** → ZIP herunterladen.
6. ZIP entpacken → **`PupsiChess.ipa`** haben.

Damit weiter zu **`build-ipa-cloud.md`** → Sideloadly auf Windows.

---

## Falls GitHub meckert

- **"This repository already exists"** → anderen Namen wählen, z. B. `pupsi-ios-app`.
- **Dateien fehlen nach Upload** → Der Ordner muss komplett rein, inkl. `.github` (versteckter Ordner). Im Windows-Explorer bei *Ansicht → Elemente anzeigen → Ausgeblendete Elemente* anhaken, sonst siehst du `.github` nicht.
- **Actions zeigt keinen Workflow** → Prüfen, ob `.github/workflows/build-ipa.yml` im Repo liegt. Falls nicht: GitHub Web-UI → **Add file → Create new file** → als Pfad `.github/workflows/build-ipa.yml` eingeben → Inhalt aus der lokalen Datei `pupsi-ios\.github\workflows\build-ipa.yml` kopieren → **Commit new file**.
