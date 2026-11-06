# Wia schaugs aus?

Statische Webseite (GitHub Pages, erreichbar unter tolwind.bz.it) mit aktuellen
Wetterdaten für Piloten in Südtirol und Umgebung. Es gibt keinen Server und keine
Datenbank: Eine GitHub Action holt die Messwerte und schreibt sie als JSON-Dateien
ins Repository, die Seite liest diese Dateien direkt.

## Seiten

- **Föhndiagramm** – Luftdruckdifferenz Bozen ↔ Innsbruck und Meran ↔ Imst (Föhn-Indikator)
- **Live-Karte** – Wind an rund 190 Stationen (Pfeil, Ø-Wind, Böen, Verlauf, Detailansicht)
- **Ausgewählte Stationen** – Auswahl der wichtigsten Startplätze und Stationen
- **Föhnprognose**
- **Live-Tracking** – Links zu XContest und Burnair

## Aufbau

| Datei / Ordner | Zweck |
|---|---|
| `index.html` | Die gesamte Webseite (HTML, CSS und JavaScript in einer Datei) |
| `scripts/fetch-weather.mjs` | Holt die Messwerte aller Quellen und aktualisiert die Datendateien |
| `.github/workflows/fetch-weather.yml` | GitHub Action, die das Skript ausführt und die Daten committet |
| `data/history.json` | Verlauf für das Föhndiagramm (wird automatisch geschrieben) |
| `data/wind.json` | Windwerte aller Stationen der Live-Karte (wird automatisch geschrieben) |
| `manifest.json`, `icon-*.png`, `favicon.ico`, `splash-paraglider.png` | App-Installation auf dem Startbildschirm (PWA) |
| `logo.png`, `logo-flieger.png`, `logo-xcontest.png`, `logo-burnair.png` | Bilder der Seite |
| `CNAME` | Eigene Domain (tolwind.bz.it) für GitHub Pages |

**Wichtig:** Der Ordner `data/` wird von der Action laufend überschrieben. Beim
Einspielen einer neuen `index.html` diesen Ordner nicht anfassen.

## Datenquellen

- **Südtirol** (97 Stationen, Wind und Luftdruck): [Bürgernetz Südtirol](https://daten.buergernetz.bz.it/)
- **Innsbruck, Imst und weitere Stationen in Österreich:** [GeoSphere Austria](https://data.hub.geosphere.at/)
- **Schweiz:** MeteoSchweiz
- **Schweiz (Schnee- und Lawinenstationen):** SLF (IMIS)
- **Tirol:** lawinen.report (LWD Tirol)
- **Trentino:** Meteotrentino

Die Quelle, die Messintervalle und die Definition der Böen stehen auf der Seite
selbst (Quellen unter der Karte und in der Detailansicht einer Station).

## Wie die Daten aktualisiert werden

1. **cron-job.org** ruft alle 5 Minuten den `workflow_dispatch`-Endpunkt der GitHub-API
   auf. Der eigene `schedule`-Trigger von GitHub ist unzuverlässig und läuft nur als
   Fallback mit.
2. Die Action führt `scripts/fetch-weather.mjs` aus, das alle Quellen abfragt.
3. Die Action committet `data/history.json` und `data/wind.json`; GitHub Pages
   liefert die neuen Dateien aus.

Das Skript holt ausgefallene Zeitpunkte automatisch nach. Läuft ein Lauf zu lange,
wird er beim nächsten Trigger abgebrochen (`concurrency`-Gruppe `fetch-weather`,
Zeitlimit 5 Minuten).

### Zugriffsschlüssel für cron-job.org

cron-job.org braucht einen GitHub-Token (fine-grained, nur für dieses Repository,
nur Recht „Actions: Read and write"). Er steht **ausschließlich** im Header des
Cronjobs bei cron-job.org (`Authorization: Bearer <token>`) und gehört nie in den
Code, ins Repository oder in einen Chat. Läuft der Token ab, bleiben die Daten
stehen, bis ein neuer eingetragen ist.

## Anzeige-Regeln der Live-Karte

- **Verzögerung:** Ab 35 Minuten ohne neuen Wert bekommt eine Station einen gelben Ring,
  ab 65 Minuten einen roten. Gleichzeitig wird das Symbol blasser (60 % / 45 % / 30 % ab
  35 / 65 / 120 Minuten) und rückt hinter aktuelle Stationen.
- **Blinken der Windwerte:** gelb bei 10–12 km/h, orange bei 13–14, rot ab 30 km/h
  (Ø oder Böe) oder bei einem Unterschied Böe − Ø von 15 km/h oder mehr.
- **Inaktive Stationen:** Liefert eine Station 30 Tage lang keinen Wert, wird sie
  ausgeblendet. Die Daten werden weiter abgerufen, und die Station erscheint wieder,
  sobald Werte zurückkommen.

## Anpassen

- **Schwellenwerte „Föhn möglich":** `TABLE_PRE`, `TABLE_SOFT`, `TABLE_HARD` sowie
  `CHART_LINE_SOFT`, `CHART_LINE_HARD` in `index.html`.
- **Vorzeichen der Druckdifferenz:** Süden minus Norden (Bozen − Innsbruck,
  Meran − Imst); siehe Kommentare in `scripts/fetch-weather.mjs`.
- **Länge des Verlaufs:** `MAX_ROWS` (Föhndiagramm, 96 Werte = 16 Stunden) und
  `MAX_WIND_ROWS` (Windkarte, 40 Werte, rund 6,5 Stunden) in `scripts/fetch-weather.mjs`.
- **Verzögerungsgrenzen und Deckkraft:** `staleLimits` und `staleOpacity` in `index.html`.
- **Neue Station aus den Zusatzquellen:** in `scripts/fetch-weather.mjs` zur jeweiligen
  Stationsliste (z. B. `EXTRA_GEOSPHERE`) hinzufügen.

## Lokal testen

```bash
node scripts/fetch-weather.mjs   # aktualisiert data/history.json und data/wind.json
python3 -m http.server 8000      # oder ein beliebiger lokaler Webserver
# dann im Browser: http://localhost:8000
```

## Neu aufsetzen (falls das Repository neu erstellt werden muss)

1. Ordner in ein öffentliches GitHub-Repository pushen (Actions und Pages bleiben so kostenlos).
2. Settings → Actions → General → „Workflow permissions" → **Read and write permissions**.
3. Settings → Pages → Source: *Deploy from a branch*, Branch `main` / `/ (root)`.
4. Eigene Domain: Datei `CNAME` im Hauptverzeichnis und die Domain bei Settings → Pages eintragen.
5. Actions → „Wetterdaten abrufen" → *Run workflow*, um die ersten Daten zu erzeugen.
6. Den Cronjob bei cron-job.org einrichten (siehe oben).
