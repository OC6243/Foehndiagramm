# Wia schaugs aus?

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

- **Logo**: `logo.png` im Hauptverzeichnis - ersetzen, um ein anderes Logo zu verwenden (quadratisch, wird per CSS rund zugeschnitten).
- **Schwellenwert für "Föhn möglich"**: `TABLE_PRE`/`TABLE_SOFT`/`TABLE_HARD` bzw. `CHART_LINE_SOFT`/`CHART_LINE_HARD` in `index.html` (aktuell -2,5 / -3 / -6 hPa, abgeglichen mit dem offiziellen Beschreibungstext).
- **Vorzeichen der Differenz**: aktuell Süden minus Norden (Bozen − Innsbruck,
  Meran − Imst), siehe Kommentare in `scripts/fetch-weather.mjs`. Falls euer
  altes Sheet das andersherum berechnet hat, dort das Vorzeichen tauschen.
- **Anzahl gespeicherter Messpunkte**: `MAX_ROWS` in `scripts/fetch-weather.mjs` (aktuell 96 = 16 Stunden bei 10-Minuten-Takt).
- **Abruf-Zeitpunkt**: primär gesteuert über einen externen Cron-Dienst (cron-job.org), der alle 10 Minuten den `workflow_dispatch`-Endpunkt der GitHub-API aufruft (GitHub's eigener `schedule`-Trigger ist nachweislich unzuverlässig - siehe Kommentar in `fetch-weather.yml`). Der `cron`-Eintrag in `.github/workflows/fetch-weather.yml` läuft nur noch als fauler Fallback mit.
- **Zeitstempel-Synchronisation**: Statt "aktuelle" Werte beider Quellen zu vergleichen (die zu leicht unterschiedlichen Momenten aktuell sein könnten), fragt das Skript beide Quellen gezielt für denselben, festen Zeitpunkt ab: `TARGET_LAG_MINUTES` (Standard 20) Minuten vor dem Trigger, abgerundet auf den 10-Minuten-Takt. Bozen/Meran nutzen dafür den `/timeseries`-Endpunkt der Bürgernetz-API, Innsbruck/Imst den `historical`-Modus von GeoSphere.

## Lokal testen

```bash
node scripts/fetch-weather.mjs   # aktualisiert data/history.json und data/wind.json
python3 -m http.server 8000      # oder ein beliebiger lokaler Webserver
# dann im Browser: http://localhost:8000
```
