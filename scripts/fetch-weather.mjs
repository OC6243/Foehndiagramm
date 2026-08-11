// Holt Luftdruckwerte für einen FESTEN Zielzeitpunkt (TARGET_LAG_MINUTES in der
// Vergangenheit, gerundet auf den 10-Minuten-Messtakt) aus beiden Quellen und
// aktualisiert die rollierende Historie (letzte MAX_ROWS Messungen) in
// data/history.json.
//
// Warum ein fester Zielzeitpunkt statt "aktuell"?
// Bürgernetz und GeoSphere könnten zu leicht unterschiedlichen Momenten
// "aktuell" sein - das würde die Druckdifferenz verfälschen. Stattdessen
// fragen wir beide Quellen gezielt nach demselben Zeitstempel (z.B. bei
// Trigger um 20:00 -> Zielzeitpunkt 19:40). 20 Minuten Puffer sind mehr als
// genug, damit beide Quellen diesen Messwert längst veröffentlicht haben.
// Als zusätzliches Sicherheitsnetz wird jede Abfrage bis zu RETRY_COUNT-mal
// wiederholt, falls der Zielwert doch noch nicht verfügbar ist.
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

const MAX_ROWS = 144; // 144 x 10 Minuten = 24 Stunden Verlauf
const TIMEZONE = "Europe/Berlin"; // Bozen/Meran/Innsbruck/Imst liegen alle hier (CET/CEST)

const SLOT_MINUTES = 10;        // Messtakt der Stationen
const TARGET_LAG_MINUTES = 20;  // wie weit der Zielzeitpunkt in der Vergangenheit liegt
const WINDOW_MINUTES = 5;       // Suchfenster um den Zielzeitpunkt (± Minuten)
const RETRY_COUNT = 5;          // Sicherheitsnetz, falls der Zielwert kurz nach
const RETRY_DELAY_MS = 30 * 1000; // der 20-Min.-Marke noch nicht verfügbar ist (max. ~2,5 Min. Geduld pro Quelle)

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
function floorToSlot(date) {
  const slotMs = SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(date.getTime() / slotMs) * slotMs);
}

// Ziel-Zeitpunkt: aktueller Trigger, abgerundet auf den 10-Minuten-Takt,
// minus TARGET_LAG_MINUTES. Beispiel: Trigger 20:03 -> Slot 20:00 -> Ziel 19:40.
function computeTargetSlot(now) {
  return addMinutes(floorToSlot(now), -TARGET_LAG_MINUTES);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} bei ${url}`);
  }
  return res.json();
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`${label}: Versuch ${attempt}/${RETRY_COUNT} fehlgeschlagen (${err.message})`);
      if (attempt < RETRY_COUNT) await sleep(RETRY_DELAY_MS);
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
  // Duplikate vermeiden, falls der Trigger mal etwas früher/später als geplant läuft
  // und denselben Zielzeitpunkt zweimal treffen würde.
  const last = pair.rows[pair.rows.length - 1];
  if (last && last.zeitLeft === row.zeitLeft && last.datumLeft === row.datumLeft) return;

  pair.rows.push(row);
  if (pair.rows.length > MAX_ROWS) {
    pair.rows = pair.rows.slice(pair.rows.length - MAX_ROWS);
  }
}

/******************** Hauptlogik ********************/

async function main() {
  const history = await loadHistory();
  const now = new Date();
  const targetSlot = computeTargetSlot(now);
  console.log(`Ziel-Zeitpunkt: ${targetSlot.toISOString()} UTC (= ${fmtTime(targetSlot)} Ortszeit, ${TARGET_LAG_MINUTES} Min. Verzögerung zum Trigger)`);

  const results = await Promise.allSettled([
    withRetry(() => fetchBuergernetzAtSlot("83200MS", "Bozen", targetSlot), "Bozen"),
    withRetry(() => fetchBuergernetzAtSlot("23200MS", "Meran", targetSlot), "Meran"),
    withRetry(() => fetchGeosphereAtSlot(targetSlot), "GeoSphere")
  ]);

  const bozen = results[0].status === "fulfilled" ? results[0].value : null;
  const meran = results[1].status === "fulfilled" ? results[1].value : null;
  const geo = results[2].status === "fulfilled" ? results[2].value : null;
  if (results[0].status === "rejected") console.warn("Bozen fehlgeschlagen:", results[0].reason.message);
  if (results[1].status === "rejected") console.warn("Meran fehlgeschlagen:", results[1].reason.message);
  if (results[2].status === "rejected") console.warn("GeoSphere fehlgeschlagen:", results[2].reason.message);

  const innsbruck = geo?.innsbruck || null;
  const imst = geo?.imst || null;

  if (bozen && innsbruck) {
    const delta = round1(bozen.value - innsbruck.value);
    pushRow(history.bozenInnsbruck, {
      datumLeft: fmtDate(bozen.instant), zeitLeft: fmtTime(bozen.instant), wertLeft: bozen.value,
      datumRight: fmtDate(innsbruck.instant), zeitRight: fmtTime(innsbruck.instant), wertRight: innsbruck.value,
      delta
    });
    console.log(`Bozen-Innsbruck @ ${fmtTime(bozen.instant)}: ${bozen.value} / ${innsbruck.value} hPa -> Δ ${delta}`);
  } else {
    console.warn("Bozen-Innsbruck: Datensatz übersprungen (fehlende Daten).");
  }

  if (meran && imst) {
    const delta = round1(meran.value - imst.value);
    pushRow(history.imstMeran, {
      datumLeft: fmtDate(meran.instant), zeitLeft: fmtTime(meran.instant), wertLeft: meran.value,
      datumRight: fmtDate(imst.instant), zeitRight: fmtTime(imst.instant), wertRight: imst.value,
      delta
    });
    console.log(`Meran-Imst @ ${fmtTime(meran.instant)}: ${meran.value} / ${imst.value} hPa -> Δ ${delta}`);
  } else {
    console.warn("Meran-Imst: Datensatz übersprungen (fehlende Daten).");
  }

  history.generatedAt = new Intl.DateTimeFormat("de-DE", {
    timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date());

  await writeFile(DATA_PATH, JSON.stringify(history, null, 2) + "\n", "utf-8");
  console.log("data/history.json aktualisiert.");
}

main().catch((err) => {
  console.error("Unerwarteter Fehler:", err);
  process.exit(1);
});
