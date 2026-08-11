# Föhndiagramm Tirol / Südtirol

Statisches Dashboard, das stündlich Luftdruckwerte abruft und die Differenz
zwischen Bozen↔Innsbruck sowie Meran↔Imst anzeigt (Föhn-Indikator).

Datenquellen:
- Bozen, Meran: [Bürgernetz Südtirol](https://daten.buergernetz.bz.it/)
- Innsbruck-Flughafen, Imst: [GeoSphere Austria Data Hub](https://data.hub.geosphere.at/)

## Setup

1. **Repository erstellen**: Diesen Ordner in ein neues GitHub-Repository pushen
   (öffentlich, damit Actions & Pages kostenlos bleiben).

2. **Workflow-Rechte aktivieren**: Settings → Actions → General →
   „Workflow permissions" → **Read and write permissions** auswählen und speichern.
   (Ohne das darf der Workflow die aktualisierte `data/history.json` nicht zurückcommitten.)

3. **GitHub Pages aktivieren**: Settings → Pages → „Build and deployment" →
   Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
   Ihr bekommt eine URL wie `https://<dein-account>.github.io/<repo-name>/`.

4. **Ersten Datenabruf auslösen**: Tab „Actions" → Workflow „Wetterdaten abrufen" →
   „Run workflow" (manuell, über `workflow_dispatch`). Danach sollte
   `data/history.json` im Repo befüllt sein und die Seite zeigt Werte an.

5. Ab da läuft der Workflow automatisch jede Stunde (`cron: "15 * * * *"`,
   UTC-Zeit) und committet die aktualisierten Werte von selbst.

## Anpassen

- **Schwellenwert für "Föhn möglich"**: `FOEHN_THRESHOLD` in `index.html` (aktuell 2.5 hPa, Platzhalter).
- **Vorzeichen der Differenz**: aktuell Süden minus Norden (Bozen − Innsbruck,
  Meran − Imst), siehe Kommentare in `scripts/fetch-weather.mjs`. Falls euer
  altes Sheet das andersherum berechnet hat, dort das Vorzeichen tauschen.
- **Anzahl gespeicherter Messpunkte**: `MAX_ROWS` in `scripts/fetch-weather.mjs` (aktuell 144 = 24 Stunden bei 10-Minuten-Takt).
- **Abruf-Zeitpunkt**: `cron` in `.github/workflows/fetch-weather.yml` (aktuell alle 10 Minuten, passend zum Messtakt der Stationen).
- **Zeitstempel-Synchronisation**: Das Skript speichert ein Wertepaar nur, wenn beide Quellen (Bürgernetz, GeoSphere) Messwerte aus demselben 10-Minuten-Fenster liefern - sonst wird bis zu 4 Minuten gewartet und erneut geprüft (`MAX_WAIT_MS`, `POLL_INTERVAL_MS` in `scripts/fetch-weather.mjs`).

## Lokal testen

```bash
node scripts/fetch-weather.mjs   # aktualisiert data/history.json
python3 -m http.server 8000      # oder ein beliebiger lokaler Webserver
# dann im Browser: http://localhost:8000
```
