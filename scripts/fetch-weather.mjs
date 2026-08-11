// Holt aktuelle Luftdruckwerte und aktualisiert die rollierende Historie
// (letzte MAX_ROWS Messungen) in data/history.json.
//
// Quellen:
//  - Bozen, Meran:      Bürgernetz Südtirol API (daten.buergernetz.bz.it)
//  - Innsbruck, Imst:   GeoSphere Austria Data Hub (dataset.api.hub.geosphere.at)
//
// Wichtig: Bevor ein Wertepaar gespeichert wird, prüft das Skript, ob beide
// Quellen Messwerte aus demselben 10-Minuten-Fenster liefern (siehe
// fetchAllAligned/slotKey). Sonst würde man z.B. Bozen von 14:10 mit
// Innsbruck von 14:00 vergleichen - das würde die Druckdifferenz verfälschen,
// gerade wenn sich der Druck gerade schnell ändert.
//
// Aufruf: node scripts/fetch-weather.mjs

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "history.json");

const MAX_ROWS = 144; // 144 x 10 Minuten = 24 Stunden Verlauf
const TIMEZONE = "Europe/Berlin";

const SLOT_MINUTES = 10;         // Messtakt der Stationen
const MAX_WAIT_MS = 4 * 60 * 1000;   // maximal 4 Minuten auf synchrone Zeitstempel warten
const POLL_INTERVAL_MS = 20 * 1000;  // alle 20 Sekunden erneut prüfen

// GeoSphere Austria Stations-IDs (TAWES, tawes-v1-10min)
const GEOSPHERE_STATIONS = {
  innsbruck: "11121", // INNSBRUCK-FLUGHAFEN (AUTOMAT)
  imst: "11115"       // IMST
};

/******************** Helper ********************/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Rundet einen Zeitpunkt auf den Beginn seines 10-Minuten-Fensters ab (UTC) -
// zwei Zeitpunkte im selben Fenster ergeben denselben Schlüssel.
function slotKey(date) {
  const slotMs = SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(date.getTime() / slotMs) * slotMs).toISOString();
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} bei ${url}`);
  }
  return res.json();
}

// Die Bürgernetz-API liefert Zeitstempel wie "2026-08-11T15:10:00CEST".
// new Date() auf so einen String OHNE Zeitzone würde die System-Zeitzone
// der Laufzeitumgebung annehmen (auf GitHub-Actions-Servern: UTC) - das
// verfälscht die Uhrzeit um 1-2 Stunden. Deshalb hier CEST/CET explizit
// durch den korrekten UTC-Offset ersetzen.
function parseBuergernetzDate(dateStr) {
  if (dateStr.endsWith("CEST")) return new Date(dateStr.slice(0, -4) + "+02:00");
  if (dateStr.endsWith("CET")) return new Date(dateStr.slice(0, -3) + "+01:00");
  return new Date(dateStr); // Fallback, falls das Format mal abweicht
}

/******************** Bozen / Meran (Bürgernetz Südtirol) ********************/

async function fetchBuergernetzPressure(stationCode, label) {
  const url = `https://daten.buergernetz.bz.it/services/meteo/v1/sensors?station_code=${stationCode}`;
  const data = await fetchJson(url, {
    headers: { Accept: "application/json", "User-Agent": "foehndiagramm-web/1.0" }
  });

  if (!Array.isArray(data)) throw new Error(`Unerwartete Antwort für ${label}`);

  for (const s of data) {
    if (s.TYPE === "LD.RED" && typeof s.VALUE === "number" && s.DATE) {
      const instant = parseBuergernetzDate(String(s.DATE));
      if (instant && !isNaN(instant)) {
        return { value: round1(s.VALUE), instant };
      }
    }
  }
  throw new Error(`Kein LD.RED-Wert gefunden für ${label}`);
}

/******************** Innsbruck / Imst (GeoSphere Austria) ********************/

async function fetchGeosphereReducedPressure() {
  const ids = Object.values(GEOSPHERE_STATIONS).join(",");
  const url = `https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min?parameters=PRED&station_ids=${ids}`;
  const data = await fetchJson(url, { headers: { "User-Agent": "foehndiagramm-web/1.0" } });

  const obsTime = data.timestamps && data.timestamps[0] ? new Date(data.timestamps[0]) : new Date();
  const result = {};

  for (const feature of data.features || []) {
    const stationId = feature.properties?.station;
    const pred = feature.properties?.parameters?.PRED?.data?.[0];
    if (typeof pred === "number") {
      for (const [key, id] of Object.entries(GEOSPHERE_STATIONS)) {
        if (id === stationId) {
          result[key] = { value: round1(pred), instant: obsTime };
        }
      }
    }
  }
  return result;
}

/******************** Zeitstempel-synchronisierter Abruf ********************/

async function fetchAllAligned() {
  const start = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const [bozen, meran, geo] = await Promise.all([
        fetchBuergernetzPressure("83200MS", "Bozen"),
        fetchBuergernetzPressure("23200MS", "Meran"),
        fetchGeosphereReducedPressure()
      ]);
      const innsbruck = geo.innsbruck;
      const imst = geo.imst;

      const biAligned = !!innsbruck && slotKey(bozen.instant) === slotKey(innsbruck.instant);
      const imAligned = !!imst && slotKey(meran.instant) === slotKey(imst.instant);

      if ((biAligned && imAligned) || Date.now() - start > MAX_WAIT_MS) {
        return { bozen, meran, innsbruck, imst, biAligned, imAligned };
      }

      console.log(
        `Versuch ${attempt}: noch nicht synchron ` +
        `(Bozen ${slotKey(bozen.instant)} / Innsbruck ${innsbruck ? slotKey(innsbruck.instant) : "?"}, ` +
        `Meran ${slotKey(meran.instant)} / Imst ${imst ? slotKey(imst.instant) : "?"}) - warte ${POLL_INTERVAL_MS / 1000}s`
      );
    } catch (err) {
      console.warn(`Versuch ${attempt} fehlgeschlagen: ${err.message}`);
      if (Date.now() - start > MAX_WAIT_MS) {
        return { biAligned: false, imAligned: false };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
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
  pair.rows.push(row);
  if (pair.rows.length > MAX_ROWS) {
    pair.rows = pair.rows.slice(pair.rows.length - MAX_ROWS);
  }
}

/******************** Hauptlogik ********************/

async function main() {
  const history = await loadHistory();
  const state = await fetchAllAligned();

  if (state.biAligned) {
    const delta = round1(state.bozen.value - state.innsbruck.value);
    pushRow(history.bozenInnsbruck, {
      datumLeft: fmtDate(state.bozen.instant), zeitLeft: fmtTime(state.bozen.instant), wertLeft: state.bozen.value,
      datumRight: fmtDate(state.innsbruck.instant), zeitRight: fmtTime(state.innsbruck.instant), wertRight: state.innsbruck.value,
      delta
    });
    console.log(`Bozen-Innsbruck synchron @ ${fmtTime(state.bozen.instant)}: ${state.bozen.value} / ${state.innsbruck.value} hPa -> Δ ${delta}`);
  } else {
    console.warn("Bozen-Innsbruck: keine synchronen Zeitstempel erhalten, dieser Durchlauf wird übersprungen.");
  }

  if (state.imAligned) {
    const delta = round1(state.meran.value - state.imst.value);
    pushRow(history.imstMeran, {
      datumLeft: fmtDate(state.meran.instant), zeitLeft: fmtTime(state.meran.instant), wertLeft: state.meran.value,
      datumRight: fmtDate(state.imst.instant), zeitRight: fmtTime(state.imst.instant), wertRight: state.imst.value,
      delta
    });
    console.log(`Meran-Imst synchron @ ${fmtTime(state.meran.instant)}: ${state.meran.value} / ${state.imst.value} hPa -> Δ ${delta}`);
  } else {
    console.warn("Meran-Imst: keine synchronen Zeitstempel erhalten, dieser Durchlauf wird übersprungen.");
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
