# Frontlinie

Echtzeitstrategie im Browser (deutschsprachig), als statische Web-App ohne Build-Schritt.
Über eine Capacitor-Hülle läuft das Spiel auch als Android-App.

## Ordneraufbau

- `www/` – die Web-App (`index.html`, `css/`, `src/*.js`, `vendor/three.js`, `assets/`)
  - `src/native.js` – nur unter Capacitor aktiv (Zurück-Taste: Pause umschalten bzw. App minimieren)
  - `manifest.webmanifest`, `icon-192.png`, `icon-512.png` – Web-App-Metadaten und Icons
- `android/` – Android-Projekt (Capacitor, Gradle)
- `capacitor.config.json` – App-ID `de.andiwand.frontlinie`, Web-Verzeichnis `www`
- `.github/workflows/android.yml` – baut die Debug-APK
- `docs/`, `tools/` – Dokumentation und Hilfswerkzeuge

## Lokal starten (Browser)

```sh
npx serve www
```

Dann die ausgegebene Adresse im Browser öffnen.

## Android-APK bauen

Voraussetzungen: Node 22, JDK 21, Android SDK (`ANDROID_HOME` gesetzt).

```sh
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug
```

Die APK liegt danach unter `android/app/build/outputs/apk/debug/app-debug.apk`.

### Über GitHub Actions

Der Workflow „Android Debug-APK“ läuft bei jedem Push und manuell (Actions → Workflow auswählen → „Run workflow“).
Die APK steht nach dem Lauf auf der Seite des Workflow-Laufs unter **Artifacts** als `Frontlinie-debug-apk`
(ZIP herunterladen, `app-debug.apk` entpacken und auf dem Gerät installieren; „Installation aus unbekannten Quellen“ muss erlaubt sein).

## Credits

Musik und Stimmen stammen aus CC0- und CC-BY-Quellen (OpenGameArt). Die Namensnennung steht im Spiel unter Hilfe → „Musik und Stimmen: Quellen" und in `www/src/audio.js` unter `CREDITS`:

- „The Settlement of the Frontier (Loop)" – TAD – CC-BY 3.0 (gekürzt, Lautheit angepasst)
- „Unforgiving Lands" – HorrorPen – CC-BY 3.0 (Lautheit angepasst)
- „Wasteland Showdown" und „Dream Raid" – Matthew Pablo (www.matthewpablo.com) – CC-BY 3.0 (Lautheit angepasst)
- „Epic Endgame Cinematic" – cynicmusic – CC0
