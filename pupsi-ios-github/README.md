# Pupsi v1 — iPhone

Es gibt auf iOS **keinen Weg**, ohne Jailbreak Code in die Chess.com-App zu injizieren. iOS sandboxt Apps. Deshalb zwei Varianten:

| Variante | Läuft wo | Jailbreak | Aufwand |
|---|---|---|---|
| **Pupsi Chess App** | Eigene App, zeigt chess.com in WebView | nein | Mac + Xcode **oder** Cloud-Build + Windows |
| **Pupsi Tweak** | **Direkt in der Chess.com App** | ja | Mac + Theos + jailbroken iPhone |

**Kein Mac?** Siehe [`build-ipa-cloud.md`](build-ipa-cloud.md) — GitHub baut die `.ipa` in der Cloud, du installierst mit Sideloadly auf Windows.

Beide nutzen dieselbe Engine aus `../chess-cheat/`.

---

## Variante 1: Pupsi Chess App (kein Jailbreak)

Eine eigene App, die chess.com in einer `WKWebView` lädt und die Engine injiziert. Sieht aus wie chess.com, läuft aber in deiner App.

**Voraussetzungen:** Mac mit Xcode, `brew install xcodegen`, Apple Developer Account fürs echte Gerät.

```bash
cd "pfad/zu/chess.com cheat/pupsi-ios"
chmod +x build-ios.sh sync.sh
./build-ios.sh
```

Das Skript synchronisiert die Engine, erzeugt `PupsiChess.xcodeproj` und öffnet Xcode.

**In Xcode:** Team wählen → iPhone anschließen → Scheme `PupsiChess` → Run.

**Auf dem iPhone:** App öffnen → chess.com lädt → **Zahnrad antippen** → Menü (Farben, Pfeile, Gambits).

**Wie es technisch funktioniert:**
- `pupsi-shim.js` bildet `chrome.storage.sync` auf `localStorage` ab und `chrome.runtime.getURL()` auf `pupsi://local/…`
- `PupsiSchemeHandler.swift` liefert Stockfish + Engine aus dem App-Bundle aus (inkl. `application/wasm`)
- `WebViewHost.swift` injiziert Shim → CSS → `content.js` in die Seite

---

## Variante 2: Pupsi Tweak (wirklich IN der Chess.com App)

**Nur mit jailbroken iPhone.** Der Tweak hookt `WKWebView` im Chess.com-Prozess und injiziert dieselbe Engine. Du bleibst in der offiziellen App.

**Voraussetzungen:** Mac mit Theos, jailbroken iPhone (rootless z. B. Dopamine empfohlen), ChezSchemes/TrollStore oder dpkg.

```bash
cd "pfad/zu/chess.com cheat/pupsi-ios"
./sync.sh                      # Engine nach tweak/layout/... kopieren
cd tweak
make package                   # erzeugt .deb
# .deb aufs iPhone übertragen und installieren:
#   dpkg -i com.static.pupsi.tweak_1.0_iphoneos-arm64.deb
# oder über TrollStore / Sileo
killall -9 Chess               # Chess.com neu starten
```

Danach: Chess.com-App öffnen → Zahnrad antippen → Menü.

**Rootful statt rootless?** In `tweak/Makefile` die Zeile `THEOS_PACKAGE_SCHEME := rootless` entfernen. Der Tweak findet beide Pfade automatisch (`/var/jb/…` und `/Library/…`).

**Falls die App den Zahnrad-Overlay verdeckt:** Die Chess.com-App rendert Board und UI teils nativ. Der Tweak injiziert in alle `WKWebView`s — wenn das Board in einer WebView liegt, erscheinen Pfeile und Menü wie in Safari. Falls nicht, bleibt nur Variante 1.

---

## Struktur

```text
pupsi-ios/
├── build-ios.sh           # XcodeGen + Xcode öffnen
├── sync.sh                # Engine in beide Ziele kopieren
├── project.yml            # XcodeGen-Spezifikation
├── app/PupsiChess/
│   ├── *.swift            # App, WebView, Scheme-Handler
│   └── Resources/         # Engine + pupsi-shim.js
└── tweak/
    ├── Tweak.xm           # WKWebView-Hook
    ├── PupsiSchemeHandler.{h,m}
    ├── Makefile
    └── layout/…/Pupsi/    # Engine fürs iPhone
```

## Empfehlung

Kein Jailbreak → **Variante 1**. Jailbreak vorhanden und du willst zwingend die Original-App → **Variante 2**.

Hinweis: Beide Varianten verstoßen sehr wahrscheinlich gegen die Fair-Play-Regeln von Chess.com. Account-Sperre möglich.
