// Holt Luftdruckwerte für feste Zielzeitpunkte (TARGET_LAG_MINUTES in der
// Vergangenheit, gerundet auf den 10-Minuten-Messtakt der Stationen) aus
// beiden Quellen und aktualisiert die rollierende Historie (letzte MAX_ROWS
// Messungen) in data/history.json.
//
// Warum ein fester Zielzeitpunkt statt "aktuell"?
// Bürgernetz und GeoSphere könnten zu leicht unterschiedlichen Momenten
// "aktuell" sein - das würde die Druckdifferenz verfälschen. Stattdessen
// fragen wir beide Quellen gezielt nach demselben Zeitstempel (z.B. bei
// Trigger um 20:00 -> Zielzeitpunkt 19:40).
//
// Warum eine Nachhol-Logik (Backfill)?
// GitHub-Actions-Cron ist nicht exakt punktgenau - gerade um runde Uhrzeiten
// (z.B. Mitternacht UTC) kann ein Lauf um mehrere Minuten verzögert starten.
// Der Zielzeitpunkt wird deshalb IMMER auf das feste :00/:20/:40-Raster
// gerundet (nicht nur auf 10 Minuten) - so bleibt er auch bei Verzögerungen
// bis zu 19 Minuten exakt korrekt, statt auf :10/:30/:50 "abzudriften".
// Zusätzlich merkt sich das Skript pro Stationspaar den letzten gespeicherten
// Zeitpunkt und holt ALLE fehlenden Raster-Schritte bis zum aktuell
// spätestmöglichen Zielzeitpunkt nach (mit Selbstkorrektur, falls ein alter
// Wert doch mal nicht exakt auf dem Raster lag).
//
// Quellen:
//  - Bozen, Meran:      Bürgernetz Südtirol API, /timeseries-Endpunkt
//  - Innsbruck, Imst:   GeoSphere Austria Data Hub, /historical-Modus
//
// Aufruf: node scripts/fetch-weather.mjs

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "history.json");

const MAX_ROWS = 96; // 96 x 10 Minuten = 16 Stunden Verlauf
const TIMEZONE = "Europe/Berlin"; // Bozen/Meran/Innsbruck/Imst liegen alle hier (CET/CEST)

const SLOT_MINUTES = 10;             // Messtakt der Stationen (zum Runden)
const SAMPLING_INTERVAL_MINUTES = 10; // wie oft ein neuer Wert erzeugt wird (= Trigger-Takt, jetzt über externen Cron alle 10 Min.)
const TARGET_LAG_MINUTES = 20;       // wie weit der Zielzeitpunkt in der Vergangenheit liegt (unverändert)
const WINDOW_MINUTES = 5;            // Suchfenster um den Zielzeitpunkt (± Minuten)
const MAX_BACKFILL_SLOTS = 12;       // Sicherheitsnetz: max. so viele fehlende Slots pro Lauf nachholen (= 2h, wie zuvor)

// WICHTIG: Diese Werte bewusst klein halten. Frühere Version hatte hier
// 5 Versuche x 30s = bis zu 2,5 Min. PRO Slot, sequenziell, zweimal (BI/IM) -
// bei mehreren fehlenden Slots konnte ein Lauf dadurch sehr lange dauern und
// blockierte (per Concurrency-Regel) alle nachfolgenden geplanten Läufe, was
// sich zu großen Verzögerungen aufschaukelte. Jetzt: alle Slots UND beide
// Stationspaare laufen parallel (Promise.all), nicht mehr nacheinander -
// die Laufzeit ist dadurch durch den langsamsten EINZELNEN Abruf begrenzt,
// nicht durch die Summe aller Abrufe.
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 8 * 1000;

// GeoSphere Austria Stations-IDs (TAWES, tawes-v1-10min)
const GEOSPHERE_STATIONS = {
  innsbruck: "11121", // INNSBRUCK-FLUGHAFEN (AUTOMAT)
  imst: "11115"       // IMST
};

/******************** Allgemeine Helper ********************/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addMinutes(date, mins) {
  return new Date(date.getTime() + mins * 60000);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fmtDate(date) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric"
  }).format(date);
}

function fmtTime(date) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(date);
}

// Rundet einen Zeitpunkt auf den Beginn seines 10-Minuten-Fensters ab (UTC).
// Wird für das Suchfenster in den APIs gebraucht (Stationstakt), NICHT für
// das :00/:20/:40-Anzeigeraster - dafür siehe floorToGrid/ceilToGrid unten.
function floorToSlot(date) {
  const slotMs = SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(date.getTime() / slotMs) * slotMs);
}

// Rundet auf das :00/:20/:40-Raster (oder allgemein: Vielfache von
// intervalMinutes seit Mitternacht UTC) ab bzw. auf.
function floorToGrid(date, intervalMinutes) {
  const ms = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}
function ceilToGrid(date, intervalMinutes) {
  const ms = intervalMinutes * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}

// Spätestmöglicher Ziel-Zeitpunkt: aktueller Trigger, abgerundet auf das
// :00/:20/:40-Raster (NICHT nur 10 Minuten - sonst könnte der Zielzeitpunkt
// bei Verzögerungen auf :10/:30/:50 "abdriften" und dauerhaft falsch bleiben).
// Beispiel: Trigger 20:03 -> Raster 20:00 -> Ziel 19:40. Trigger 20:47 (späte
// Ausführung) -> Raster 20:40 -> Ziel 20:20 (weiterhin korrekt).
function computeLatestTargetSlot(now) {
  return addMinutes(floorToGrid(now, SAMPLING_INTERVAL_MINUTES), -TARGET_LAG_MINUTES);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} bei ${url}`);
  }
  return res.json();
}

async function withRetry(fn, label, maxAttempts) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`${label}: Versuch ${attempt}/${maxAttempts} fehlgeschlagen (${err.message})`);
      if (attempt < maxAttempts) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Wählt aus einer Liste von {instant, value} den Eintrag, der zeitlich am
// nächsten am Zielzeitpunkt liegt.
function closestTo(entries, targetSlot) {
  let best = null, bestDiff = Infinity;
  for (const e of entries) {
    if (!e.instant || isNaN(e.instant)) continue;
    const diff = Math.abs(e.instant.getTime() - targetSlot.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

/******************** Nachhol-Logik (Backfill) ********************/

// Letzter bekannter Zeitpunkt eines Stationspaars, aus dem gespeicherten
// instantUTC-Feld rekonstruiert. Fehlt es (z.B. bei sehr alten Einträgen vor
// diesem Update), wird null zurückgegeben - dann startet die Nachhol-Logik
// einfach beim aktuellen Zielzeitpunkt statt zu versuchen, unbegrenzt weit
// zurückzugehen.
function lastSlotOf(pair) {
  const rows = pair.rows || [];
  const last = rows[rows.length - 1];
  if (!last || !last.instantUTC) return null;
  const d = new Date(last.instantUTC);
  return isNaN(d) ? null : floorToSlot(d);
}

// Liste aller :00/:20/:40-Raster-Zeitpunkte zwischen lastSlot (exklusiv) und
// latestTarget (inklusiv) - das sind die "fehlenden" Slots, die nachgeholt
// werden müssen. Ohne bekannten lastSlot (erster Lauf) wird nur der aktuelle
// Zielzeitpunkt zurückgegeben. ceilToGrid richtet den Start-Slot selbst dann
// korrekt auf das Raster aus, wenn lastSlot (z.B. durch alte Daten vor diesem
// Update) nicht exakt darauf liegt - ab da bleibt alles automatisch im Raster.
function computeNeededSlots(lastSlot, latestTarget) {
  if (!lastSlot) return [latestTarget];
  if (lastSlot.getTime() >= latestTarget.getTime()) return [];
  const slots = [];
  let s = ceilToGrid(addMinutes(lastSlot, 1), SAMPLING_INTERVAL_MINUTES);
  while (s.getTime() <= latestTarget.getTime() && slots.length < MAX_BACKFILL_SLOTS) {
    slots.push(s);
    s = addMinutes(s, SAMPLING_INTERVAL_MINUTES);
  }
  return slots;
}

/******************** Bozen / Meran (Bürgernetz Südtirol) ********************/

// Die Bürgernetz-API liefert Zeitstempel wie "2026-08-11T15:10:00CEST".
// new Date() auf so einen String OHNE Zeitzone würde die System-Zeitzone
// der Laufzeitumgebung annehmen (auf GitHub-Actions-Servern: UTC) - das
// verfälscht die Uhrzeit um 1-2 Stunden. Deshalb hier CEST/CET explizit
// durch den korrekten UTC-Offset ersetzen.
function parseBuergernetzDate(dateStr) {
  if (dateStr.endsWith("CEST")) return new Date(dateStr.slice(0, -4) + "+02:00");
  if (dateStr.endsWith("CET")) return new Date(dateStr.slice(0, -3) + "+01:00");
  return new Date(dateStr);
}

// Formatiert einen Zeitpunkt als YYYYMMDDHHmm in Bozener Ortszeit - so
// erwartet es der date_from/date_to-Parameter der Bürgernetz-API.
function fmtBuergernetzParam(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}`;
}

async function fetchBuergernetzAtSlot(stationCode, label, targetSlot) {
  const from = fmtBuergernetzParam(addMinutes(targetSlot, -WINDOW_MINUTES));
  const to = fmtBuergernetzParam(addMinutes(targetSlot, WINDOW_MINUTES));
  const url =
    `https://daten.buergernetz.bz.it/services/meteo/v1/timeseries` +
    `?station_code=${stationCode}&sensor_code=LD.RED&output_format=JSON` +
    `&date_from=${from}&date_to=${to}`;

  const data = await fetchJson(url, {
    headers: { Accept: "application/json", "User-Agent": "foehndiagramm-web/1.0" }
  });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Keine Daten für ${label} im Zielfenster (${from}-${to})`);
  }

  const entries = data
    .filter((e) => typeof e.VALUE === "number" && e.DATE)
    .map((e) => ({ value: round1(e.VALUE), instant: parseBuergernetzDate(String(e.DATE)) }));

  const best = closestTo(entries, targetSlot);
  if (!best) throw new Error(`Kein passender LD.RED-Wert für ${label}`);
  return best;
}

/******************** Innsbruck / Imst (GeoSphere Austria, historical) ********************/

function fmtIsoMinuteUTC(date) {
  return date.toISOString().slice(0, 16); // "2026-08-11T13:10"
}

async function fetchGeosphereAtSlot(targetSlot) {
  const ids = Object.values(GEOSPHERE_STATIONS).join(",");
  const start = fmtIsoMinuteUTC(addMinutes(targetSlot, -WINDOW_MINUTES));
  const end = fmtIsoMinuteUTC(addMinutes(targetSlot, WINDOW_MINUTES));
  const url =
    `https://dataset.api.hub.geosphere.at/v1/station/historical/tawes-v1-10min` +
    `?parameters=PRED&station_ids=${ids}&start=${start}&end=${end}`;

  const data = await fetchJson(url, { headers: { "User-Agent": "foehndiagramm-web/1.0" } });

  const timestamps = (data.timestamps || []).map((t) => new Date(t));
  if (!timestamps.length) throw new Error("Keine GeoSphere-Zeitstempel im Zielfenster");

  let bestIdx = -1, bestDiff = Infinity;
  timestamps.forEach((t, i) => {
    const diff = Math.abs(t.getTime() - targetSlot.getTime());
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });

  const result = {};
  for (const feature of data.features || []) {
    const stationId = feature.properties?.station;
    const values = feature.properties?.parameters?.PRED?.data;
    if (Array.isArray(values) && typeof values[bestIdx] === "number") {
      for (const [key, id] of Object.entries(GEOSPHERE_STATIONS)) {
        if (id === stationId) {
          result[key] = { value: round1(values[bestIdx]), instant: timestamps[bestIdx] };
        }
      }
    }
  }
  return result;
}

/******************** Historie lesen/schreiben ********************/

async function loadHistory() {
  try {
    const raw = await readFile(DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      bozenInnsbruck: { leftLabel: "Bozen", rightLabel: "Innsbruck", rows: [] },
      imstMeran: { leftLabel: "Meran", rightLabel: "Imst", rows: [] },
      generatedAt: null
    };
  }
}

function pushRow(pair, row) {
  // Duplikate vermeiden (Vergleich über den echten UTC-Zeitpunkt, nicht die
  // formatierten Anzeige-Strings - robuster bei Tages-/Zeitzonenwechseln).
  const last = pair.rows[pair.rows.length - 1];
  if (last && last.instantUTC === row.instantUTC) return;

  pair.rows.push(row);
  pair.rows.sort((a, b) => new Date(a.instantUTC) - new Date(b.instantUTC));
  if (pair.rows.length > MAX_ROWS) {
    pair.rows = pair.rows.slice(pair.rows.length - MAX_ROWS);
  }
}

function buildRow(left, right) {
  const delta = round1(left.value - right.value);
  return {
    instantUTC: left.instant.toISOString(),
    datumLeft: fmtDate(left.instant), zeitLeft: fmtTime(left.instant), wertLeft: left.value,
    datumRight: fmtDate(right.instant), zeitRight: fmtTime(right.instant), wertRight: right.value,
    delta
  };
}

/******************** Hauptlogik ********************/

async function fillPair(history, pairKey, stationCode, stationLabel, geosphereKey, geosphereCache, now) {
  const pair = history[pairKey];
  const latestTarget = computeLatestTargetSlot(now);
  const lastSlot = lastSlotOf(pair);
  const neededSlots = computeNeededSlots(lastSlot, latestTarget);

  if (!neededSlots.length) {
    console.log(`${pairKey}: bereits aktuell, nichts nachzuholen.`);
    return;
  }
  if (lastSlot) {
    console.log(`${pairKey}: ${neededSlots.length} fehlende(r) Slot(s) werden parallel nachgeholt (letzter bekannter Wert: ${lastSlot.toISOString()}).`);
  }

  // Alle fehlenden Slots PARALLEL abfragen (nicht mehr nacheinander) - die
  // Laufzeit ist dadurch durch den langsamsten einzelnen Abruf begrenzt, nicht
  // durch die Summe aller Abrufe. Der geosphereCache kann dabei in seltenen
  // Fällen einen Slot doppelt abfragen (Race zwischen parallelen Prüfungen) -
  // das ist unkritisch, kostet höchstens einen zusätzlichen API-Call.
  const results = await Promise.all(neededSlots.map(async (slot) => {
    const slotIso = slot.toISOString();
    try {
      const stationValue = await withRetry(
        () => fetchBuergernetzAtSlot(stationCode, stationLabel, slot),
        `${stationLabel} @ ${slotIso}`,
        RETRY_COUNT
      );

      if (!(slotIso in geosphereCache)) {
        geosphereCache[slotIso] = withRetry(
          () => fetchGeosphereAtSlot(slot),
          `GeoSphere @ ${slotIso}`,
          RETRY_COUNT
        ).catch((err) => {
          console.warn(`GeoSphere @ ${slotIso} fehlgeschlagen: ${err.message}`);
          return null;
        });
      }
      const geo = await geosphereCache[slotIso];
      const otherValue = geo && geo[geosphereKey];

      if (!otherValue) {
        console.warn(`${pairKey}: kein GeoSphere-Wert für ${slotIso}, übersprungen.`);
        return null;
      }
      return buildRow(stationValue, otherValue);
    } catch (err) {
      console.warn(`${pairKey}: ${stationLabel} @ ${slotIso} fehlgeschlagen: ${err.message}`);
      return null;
    }
  }));

  results.filter(Boolean).forEach((row) => {
    pushRow(pair, row);
    console.log(`${pairKey} @ ${row.zeitLeft}: ${row.wertLeft} / ${row.wertRight} hPa -> Δ ${row.delta}`);
  });
}

/******************** Live-Windwerte (Südtirol-Stationskarte) ********************/
// Jetzt mit rollierendem Verlauf pro Station (nicht mehr nur der letzte Wert),
// damit Geschwindigkeits- und Richtungsverlauf der letzten 6h angezeigt werden
// können. Läuft serverseitig, weil die Bürgernetz-API keine CORS-Header setzt
// und Browser-seitige Abrufe deshalb blockiert werden.
const WIND_STATION_PATH = path.join(__dirname, "..", "data", "wind.json");
const MAX_WIND_ROWS = 40; // ~6,5h bei 10-Minuten-Takt (6h Anzeige + etwas Puffer)
const WIND_STATION_CODES = [
  "85600MS", "82300MS", "52150MS", "86100MS", "70200MS", "83200MS", "86200MS", "68200MS",
  "57300MS", "24200MS", "63600MS", "85120MS", "83800MS", "69200MS", "34100MS", "25200MS",
  "58800MS", "60200MS", "84100MS", "74200MS", "56200MS", "70100MS", "83600MS", "08200MS",
  "24400MS", "16100MS", "83400MS", "69100MS", "04600MS", "11200MS", "23200MS", "81200MS",
  "86700MS", "82100MS", "19100MS", "86400MS", "59200MS", "57900MS", "21200MS", "21700MS",
  "21500MS", "20910MS", "06600MS", "53200MS", "52100MS", "54500MS", "01100MS", "22200MS",
  "88820MS", "54100MS", "80200MS", "80500MS", "62600MS", "24100MS", "09700MS", "07200MS",
  "91510MS", "31200MS", "06100MS", "05100MS", "82200MS", "76200MS", "59500MS", "87200MS",
  "68300MS", "65300MS", "75600MS", "58400MS", "85200MS", "64600MS",
  "31900WS", "15050WS", "00390SF", "62800MS", "22600WS", "85800MS", "74400SF", "23600SF",
  "31810SF", "85400WS", "06080WS", "02500MS", "23400MS", "20600MS", "69900MS", "01600MS",
  "82500WS", "31400WS", "80800WS", "75400MS", "54800WS", "06000MS", "06040WS", "24300SF",
  "24170WS", "04400MS", "33200WS"
];

async function loadWindHistory() {
  try {
    const raw = await readFile(WIND_STATION_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.stations) parsed.stations = {};
    return parsed;
  } catch {
    return { stations: {} };
  }
}

async function fetchWindStations(windData) {
  await Promise.all(WIND_STATION_CODES.map(async (code) => {
    try {
      const url = `https://daten.buergernetz.bz.it/services/meteo/v1/sensors?station_code=${code}`;
      const data = await withRetry(
        () => fetchJson(url, { headers: { Accept: "application/json", "User-Agent": "foehndiagramm-web/1.0" } }),
        `Windstation ${code}`,
        RETRY_COUNT
      );
      const get = (type) => {
        const e = Array.isArray(data) ? data.find((d) => d.TYPE === type) : null;
        return e ? e.VALUE : null;
      };
      const dateEntry = Array.isArray(data) ? data.find((d) => d.DATE) : null;
      const instant = dateEntry ? parseBuergernetzDate(String(dateEntry.DATE)) : new Date();

      const row = {
        instantUTC: instant.toISOString(),
        time: fmtTime(instant),
        avgKmh: get("WG") !== null ? round1(get("WG") * 3.6) : null,
        gustKmh: get("WG.BOE") !== null ? round1(get("WG.BOE") * 3.6) : null,
        dirDeg: get("WR"),
        tempC: get("LT"),
        humidityPct: get("LF")
      };

      if (!windData.stations[code]) windData.stations[code] = { rows: [] };
      const pair = windData.stations[code];
      const last = pair.rows[pair.rows.length - 1];
      if (!last || last.instantUTC !== row.instantUTC) {
        pair.rows.push(row);
        pair.rows.sort((a, b) => new Date(a.instantUTC) - new Date(b.instantUTC));
        if (pair.rows.length > MAX_WIND_ROWS) {
          pair.rows = pair.rows.slice(pair.rows.length - MAX_WIND_ROWS);
        }
      }
    } catch (err) {
      console.warn(`Windstation ${code} fehlgeschlagen: ${err.message}`);
    }
  }));
  return windData;
}

async function main() {
  const history = await loadHistory();
  const windHistory = await loadWindHistory();
  const now = new Date();
  const geosphereCache = {}; // slotISO -> {innsbruck, imst} | null - vermeidet doppelte GeoSphere-Abrufe

  console.log(`Lauf gestartet um ${now.toISOString()} UTC.`);

  const [, windData] = await Promise.all([
    Promise.all([
      fillPair(history, "bozenInnsbruck", "83200MS", "Bozen", "innsbruck", geosphereCache, now),
      fillPair(history, "imstMeran", "23200MS", "Meran", "imst", geosphereCache, now)
    ]),
    fetchWindStations(windHistory)
  ]);

  history.generatedAt = new Intl.DateTimeFormat("de-DE", {
    timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date());

  await writeFile(DATA_PATH, JSON.stringify(history, null, 2) + "\n", "utf-8");
  console.log("data/history.json aktualisiert.");

  windData.generatedAt = history.generatedAt;
  await writeFile(WIND_STATION_PATH, JSON.stringify(windData, null, 2) + "\n", "utf-8");
  console.log("data/wind.json aktualisiert.");
}

main().catch((err) => {
  console.error("Unerwarteter Fehler:", err);
  process.exit(1);
});
