// Holt Luftdruckwerte für den aktuellsten verfügbaren Zeitpunkt (gerundet auf
// den 10-Minuten-Messtakt der Stationen, kein künstlicher Verzug mehr) aus
// beiden Quellen und aktualisiert die rollierende Historie (letzte MAX_ROWS
// Messungen) in data/history.json.
//
// Warum trotzdem ein fester Zielzeitpunkt statt einfach "die letzte Zeile"?
// Bürgernetz und GeoSphere könnten zu leicht unterschiedlichen Momenten
// "aktuell" sein - das würde die Druckdifferenz verfälschen. Stattdessen
// fragen wir beide Quellen gezielt nach demselben Zeitstempel (dem aktuell
// spätestmöglichen :00/:20/:40-Raster-Zeitpunkt). Ist der allerneueste Wert
// bei einer Quelle noch nicht veröffentlicht, greift automatisch das
// Suchfenster (WINDOW_MINUTES) bzw. im nächsten Lauf die Nachhol-Logik.
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
const TARGET_LAG_MINUTES = 0;        // Zielzeitpunkt = jetzt (auf 10-Minuten-Raster abgerundet), nicht mehr fest verzögert
const WINDOW_MINUTES = 25;           // Suchfenster um den Zielzeitpunkt (± Minuten) - die Bürgernetz-API veröffentlicht Werte nachweislich mit ca. 20 Min. Verzögerung (Wert von :00 erscheint erst um :20), 25 Min. Toleranz fängt das mit etwas Marge in einem einzigen Durchlauf ab, statt erst über die Nachhol-Logik eine Runde später
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

async function withRetry(fn, label, maxAttempts, baseDelayMs) {
  const delay = baseDelayMs || RETRY_DELAY_MS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`${label}: Versuch ${attempt}/${maxAttempts} fehlgeschlagen (${err.message})`);
      if (attempt < maxAttempts) {
        // Bei Ratenbegrenzung (429) deutlich länger warten und mit jedem
        // Versuch weiter erhöhen (exponentiell), statt der normalen Pause.
        const isRateLimited = /HTTP 429/.test(err.message);
        const wait = isRateLimited ? delay * Math.pow(2, attempt) : delay;
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// Staffelt zusätzlich zur Konkurrenzbegrenzung auch den START jeder neuen
// Anfrage zeitlich, damit nie mehrere Anfragen im selben Sekundenbruchteil
// starten (manche APIs limitieren nicht nur gleichzeitige Verbindungen,
// sondern auch die Anfragerate pro Zeitfenster).

// Verarbeitet eine Liste mit maximal `limit` gleichzeitigen Aufrufen von fn,
// statt alle auf einmal loszuschicken (vermeidet HTTP 429 Ratenbegrenzung
// bei APIs, die viele gleichzeitige Anfragen von derselben IP ablehnen).
async function mapWithConcurrencyLimit(items, limit, fn, staggerMs) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let nextAllowedStart = Date.now(); // wird synchron reserviert, keine Wettlaufbedingung zwischen Workern
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      if (staggerMs) {
        const myStart = Math.max(Date.now(), nextAllowedStart);
        nextAllowedStart = myStart + staggerMs; // sofort reserviert, bevor "await" die Kontrolle abgibt
        const wait = myStart - Date.now();
        if (wait > 0) await sleep(wait);
      }
      results[current] = await fn(items[current], current);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
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
    `https://geoservices.buergernetz.bz.it/services/meteo/v1/timeseries` +
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
// Namen, Codes und Koordinaten verifiziert gegen die offizielle Quelle
// (wetter.provinz.bz.it + geoservices.buergernetz.bz.it), Stand 15.08.2026.
// Hinweis: die vorherige Domain "daten.buergernetz.bz.it" wurde am 01.09.2026
// abgekündigt und durch "geoservices.buergernetz.bz.it" ersetzt (gleicher
// Pfad, gleiche Struktur - nur die Subdomain hat sich geändert).
// Alle 97 Stationen Südtirols vollständig verifiziert (57 Tal + 40 Berg).
// Jetzt mit rollierendem Verlauf pro Station (nicht mehr nur der letzte Wert),
// damit Geschwindigkeits- und Richtungsverlauf der letzten 6h angezeigt werden
// können. Läuft serverseitig, weil die Bürgernetz-API keine CORS-Header setzt
// und Browser-seitige Abrufe deshalb blockiert werden.
const WIND_STATION_PATH = path.join(__dirname, "..", "data", "wind.json");
const MAX_WIND_ROWS = 40; // ~6,5h bei 10-Minuten-Takt (6h Anzeige + etwas Puffer)
const WIND_STATION_CODES = [
  "37100MS", "20500MS", "19300MS", "80300MS", "50500MS", "34500MS", "56900MS", "54500MS",
  "09700MS", "82200MS", "88820MS", "59700MS", "85120MS", "83200MS", "86900MS", "39100MS",
  "08200MS", "23200MS", "47400MS", "86600MS", "37700MS", "74900MS", "89190MS", "22210MS",
  "25900MS", "73500MS", "68600MS", "02200MS", "41000MS", "75600MS", "62600MS", "11400MS",
  "02500MS", "33500MS", "44500MS", "06400MS", "65600MS", "24400MS", "43200MS", "78305MS",
  "56500MS", "42700MS", "15800MS", "65350MS", "82910MS", "27100MS", "85700MS", "87300MS",
  "66500MS", "20910MS", "31410MS", "78110MS", "61300MS", "01110MS", "71510MS", "79300MS",
  "91510MS", "82500WS", "00390SF", "31810SF", "69900MS", "06040WS", "24300SF", "24170WS",
  "15050WS", "61690SF", "61720WS", "62270SF", "78480SF", "90200MS", "00700WS", "45200SF",
  "45100WS", "35100WS", "01080SF", "80100SF", "20690SF", "20720WS", "66000WS", "66100SF",
  "42830SF", "50400WS", "50360SF", "90005SF", "35205SF", "54100SF", "02700SF", "15590SF",
  "15000SF", "74200MS", "91180SF", "34200WS", "06090SF", "20050SF", "91210WS", "07740WS",
  "53200SF"
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

const WIND_FETCH_CONCURRENCY = 3;   // max. gleichzeitige Anfragen - deutlich vorsichtiger, da 6 bei der API immer noch 429 auslöste
const WIND_FETCH_STAGGER_MS = 350;  // Mindestabstand zwischen dem Start je zweier Anfragen (über alle Worker hinweg)
const WIND_RETRY_BASE_DELAY_MS = 10 * 1000; // Basis-Wartezeit bei Fehlschlag, wird bei HTTP 429 zusätzlich exponentiell erhöht

async function fetchWindStations(windData) {
  await mapWithConcurrencyLimit(WIND_STATION_CODES, WIND_FETCH_CONCURRENCY, async (code) => {
    try {
      const url = `https://geoservices.buergernetz.bz.it/services/meteo/v1/sensors?station_code=${code}`;
      const data = await withRetry(
        () => fetchJson(url, { headers: { Accept: "application/json", "User-Agent": "foehndiagramm-web/1.0" } }),
        `Windstation ${code}`,
        RETRY_COUNT,
        WIND_RETRY_BASE_DELAY_MS
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
  }, WIND_FETCH_STAGGER_MS);
  return windData;
}

/******************** Zusatzstationen aus weiteren Quellen ********************/
// Landen im selben Format wie die Südtirol-Stationen in data/wind.json
// (instantUTC, time, avgKmh, gustKmh, dirDeg, tempC, humidityPct), zusätzlich
// mit einem "meta"-Block pro Station (Name, Quelle, Koordinaten, Höhe), damit
// die Karte die Stationen platzieren kann. Fehlt ein Wert in der Quelle,
// steht null in der Zeile (die Karte zeigt dort "–").
//
// ZEITEN: intern und in der Datei immer als echter UTC-Zeitpunkt (instantUTC);
// das Feld "time" ist nur die Anzeige und wird über Europe/Berlin formatiert,
// folgt also automatisch Sommer-/Winterzeit.
//
//  - MeteoSchweiz: OGD-CSV (data.geo.admin.ch), 10-Min-Werte, Zeit in UTC
//  - SLF/IMIS:     measurement-api.slf.ch, 30-Min-Mittel, Zeit in UTC
//  - Tirol:        static.avalanche.report/weather_stations/stations.geojson
//                  (eine Datei, nur der jeweils letzte Wert pro Station;
//                  Windwerte dort in km/h, Datumsfeld mit Offset)
//  - Meteotrentino: dati.meteotrentino.it ultimiDatiStazione, 15-Min-Werte,
//                  Zeitstempel OHNE Zonenangabe = fester Offset UTC+1 (auch im
//                  Sommer KEINE Sommerzeit). Am 07.10.2026 (Sommerzeit)
//                  gegengeprüft: Abruf 23:56 Ortszeit, letzter Stempel 22:45
//                  -> nur mit UTC+1 ergibt sich ein plausibles Alter (11 Min.).
//  - GeoSphere Austria: TAWES-10-Minuten-Daten (Data Hub), Zeit in UTC
//
// Weitere Stationen: einfach einen Eintrag in EXTRA_STATIONS (bzw.
// EXTRA_GEOSPHERE) ergänzen.

const EXTRA_WINDOW_MINUTES = MAX_WIND_ROWS * 10; // gleiches Zeitfenster wie Südtirol (~6,5 h)
const MCH_BASE = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn";
const SLF_BASE = "https://measurement-api.slf.ch/public/api/imis";
const TIROL_GEOJSON_URL = "https://static.avalanche.report/weather_stations/stations.geojson";
const TRENTINO_BASE = "https://dati.meteotrentino.it/service.asmx";
const GEOSPHERE_TAWES_URL = "https://dataset.api.hub.geosphere.at/v1/station/historical/tawes-v1-10min";
const EXTRA_HEADERS = { "User-Agent": "foehndiagramm-web/1.0" };

// Schonend zu den Fremdservern: pro Quelle nur wenige gleichzeitige Anfragen mit
// zeitlichem Abstand, kürzere Wiederholung als bei den Südtirol-Stationen und
// eine Gesamt-Frist, damit ein langsamer oder gesperrter Fremdserver den Lauf
// (Zeitlimit des Workflows: 5 Min. inkl. 40 s Vorlauf) nie ausbremsen kann.
const EXTRA_RETRY_COUNT = 2;
const EXTRA_DEADLINE_MS = 150 * 1000;       // danach werden keine neuen Anfragen mehr gestartet
const EXTRA_GROUP_LIMITS = {                 // { gleichzeitige Anfragen, Mindestabstand ms }
  mch: { limit: 2, stagger: 300 },
  slf: { limit: 2, stagger: 300 },
  tirol: { limit: 1, stagger: 0 },           // eine einzige Datei, vom ersten Abruf zwischengespeichert
  trentino: { limit: 3, stagger: 400 }       // ca. 130 KB XML pro Station
};
const EXTRA_MAX_STALE_MS = 3 * 24 * 3600 * 1000; // der jüngste Wert wird bis zu 3 Tage alt noch gespeichert (Karte zeigt ihn als veraltet)

const SLF_ATTR = "Quelle: WSL-Institut für Schnee- und Lawinenforschung SLF (www.slf.ch)";
const TIROL_ATTR = "Quelle: Lawinenwarndienst Tirol / lawinen.report";
const TRENTINO_ATTR = "Quelle: Provincia autonoma di Trento - Meteotrentino";
const GEOSPHERE_ATTR = "Quelle: GeoSphere Austria";

// "type" (tal/berg) bestimmt die Farbe des Windsacks auf der Karte (orange = Tal,
// rot = Berg) und folgt der Einstufung der Südtiroler Stationen: Dort gelten
// Orts-/Talstationen bis ca. 1900 m als "tal" (z. B. Sulden 1902 m, Karerpass
// 1713 m), freie Lagen (Gipfel, Grat, Gletscher, Alm, Skigebiet) ab ca. 1800 m
// als "berg" (Gantkofel 1860 m). Hier ebenso nach Lage UND Höhe eingestuft:
// Ortschaften und Täler = tal (auch Obergurgl 1941 m, Brenner, Passo Mendola),
// alles Hochalpine ohne Siedlung = berg. Sämtliche SLF- und Tiroler
// lawinen.report-Stationen liegen auf Grat/Gipfel (2098-3499 m) = berg.
// Koordinaten/Höhe sind Rückfallwerte; wo die Quelle sie selbst liefert
// (SLF-Stationsliste, Tirol-Datei, MeteoSchweiz-Meta-CSV), werden sie beim
// Lauf überschrieben.
const EXTRA_STATIONS = {
  // ---- MeteoSchweiz (SwissMetNet) ----
  MCH_SMM: { adapter: "mch", id: "smm", name: "Sta. Maria Val Müstair", source: "MeteoSchweiz", attribution: "Quelle: MeteoSchweiz", lat: 46.602256, lon: 10.426314, elevationM: 1386, type: "tal", intervalMin: 10 },
  MCH_BUF: { adapter: "mch", id: "buf", name: "Buffalora", source: "MeteoSchweiz", attribution: "Quelle: MeteoSchweiz", lat: 46.648408, lon: 10.2672, elevationM: 1971, type: "berg", intervalMin: 10 },
  MCH_SCU: { adapter: "mch", id: "scu", name: "Scuol", source: "MeteoSchweiz", attribution: "Quelle: MeteoSchweiz", lat: 46.793275, lon: 10.283267, elevationM: 1304, type: "tal", intervalMin: 10 },
  MCH_NAS: { adapter: "mch", id: "nas", name: "Naluns / Schlivera", source: "MeteoSchweiz", attribution: "Quelle: MeteoSchweiz", lat: 46.817164, lon: 10.2614, elevationM: 2380, type: "berg", intervalMin: 10 },
  // ---- SLF / whiterisk.ch (IMIS) ----
  SLF_OFE1: { adapter: "slf", id: "OFE1", name: "Piz Dora", source: "SLF (IMIS)", attribution: SLF_ATTR, lat: 46.605056, lon: 10.306127, elevationM: 2949, type: "berg", intervalMin: 30 },
  SLF_OFE2: { adapter: "slf", id: "OFE2", name: "Murtaröl", source: "SLF (IMIS)", attribution: SLF_ATTR, lat: 46.631706, lon: 10.289051, elevationM: 2359, type: "berg", intervalMin: 30 },
  SLF_VSC1: { adapter: "slf", id: "VSC1", name: "Piz San Jon Dadaint", source: "SLF (IMIS)", attribution: SLF_ATTR, lat: 46.753260, lon: 10.339132, elevationM: 3092, type: "berg", intervalMin: 30 },
  SLF_VIN1: { adapter: "slf", id: "VIN1", name: "Piz Alpetta", source: "SLF (IMIS)", attribution: SLF_ATTR, lat: 46.928788, lon: 10.449316, elevationM: 2975, type: "berg", intervalMin: 30 },
  SLF_LAV1: { adapter: "slf", id: "LAV1", name: "Gonda Cotschna", source: "SLF (IMIS)", attribution: SLF_ATTR, lat: 46.784326, lon: 10.112328, elevationM: 2405, type: "berg", intervalMin: 30 },
  // ---- Tirol (lawinen.report, stations.geojson) ----
  TIROL_valdafur: { adapter: "tirol", plot: "valdafur", id: "Tscheyegg", name: "Tscheyegg", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.889031, lon: 10.570519, elevationM: 2668, type: "berg", intervalMin: 10 },
  TIROL_gamoarbach: { adapter: "tirol", plot: "gamoarbach", id: "Schartlkopf", name: "Schartlkopf", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.899630, lon: 10.561746, elevationM: 2800, type: "berg", intervalMin: 10 },
  TIROL_nachtweide: { adapter: "tirol", plot: "nachtweide", id: "Palinkopf", name: "Palinkopf", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.950206, lon: 10.309403, elevationM: 2864, type: "berg", intervalMin: 10 },
  TIROL_jamtalhuette_gamshorn: { adapter: "tirol", plot: "jamtalhuette_gamshorn", id: "Westliches Gamshorn", name: "Westliches Gamshorn", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.896034, lon: 10.190435, elevationM: 2997, type: "berg", intervalMin: 10 },
  TIROL_serfaus: { adapter: "tirol", plot: "serfaus", id: "Serfaus Masnerkopf", name: "Serfaus Masnerkopf", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.012741, lon: 10.472944, elevationM: 2824, type: "berg", intervalMin: 10 },
  TIROL_plojen: { adapter: "tirol", plot: "plojen", id: "Planskopf", name: "Planskopf", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.052584, lon: 10.545645, elevationM: 2660, type: "berg", intervalMin: 10 },
  TIROL_falkaunsalpe: { adapter: "tirol", plot: "falkaunsalpe", id: "Roter Schrofen", name: "Roter Schrofen", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.040000, lon: 10.718100, elevationM: 2700, type: "berg", intervalMin: 10 },
  TIROL_rifflsee: { adapter: "tirol", plot: "rifflsee", id: "Rifflsee Muttenkopf", name: "Rifflsee Muttenkopf", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.963654, lon: 10.855198, elevationM: 2293, type: "berg", intervalMin: 10 },
  TIROL_seirloecherkogel: { adapter: "tirol", plot: "seirloecherkogel", id: "Seirlöcher Kogel", name: "Seirlöcher Kogel", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.033900, lon: 10.852800, elevationM: 2410, type: "berg", intervalMin: 10 },
  TIROL_agetwoad: { adapter: "tirol", plot: "agetwoad", id: "Agetwoad", name: "Agetwoad", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.069889, lon: 10.862306, elevationM: 2330, type: "berg", intervalMin: 10 },
  TIROL_burgbach: { adapter: "tirol", plot: "burgbach", id: "Burgbach Brechgrad", name: "Burgbach Brechgrad", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.094400, lon: 10.796000, elevationM: 2359, type: "berg", intervalMin: 10 },
  TIROL_rettenbach: { adapter: "tirol", plot: "rettenbach", id: "Schwarze Schneid", name: "Schwarze Schneid", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.923988, lon: 10.928658, elevationM: 3370, type: "berg", intervalMin: 10 },
  TIROL_IGF_weissseespitze: { adapter: "tirol", plot: "IGF_weissseespitze", id: "Weißseespitze", name: "Weißseespitze", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.846250, lon: 10.717989, elevationM: 3499, type: "berg", intervalMin: 10 },
  TIROL_UIBK_latschbloder: { adapter: "tirol", plot: "UIBK_latschbloder", id: "Latschbloder", name: "Latschbloder", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.798656, lon: 10.806594, elevationM: 2910, type: "berg", intervalMin: 10 },
  TIROL_hintereis: { adapter: "tirol", plot: "hintereis", id: "Hintereis", name: "Hintereis", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.798896, lon: 10.760373, elevationM: 3031, type: "berg", intervalMin: 10 },
  TIROL_soelden_kreuzspitze: { adapter: "tirol", plot: "soelden_kreuzspitze", id: "Sölden Kreuzspitze", name: "Sölden Kreuzspitze", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.816395, lon: 10.870003, elevationM: 3453, type: "berg", intervalMin: 10 },
  TIROL_vorderegg: { adapter: "tirol", plot: "vorderegg", id: "Marchkofel", name: "Marchkofel", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.891720, lon: 10.938071, elevationM: 2540, type: "berg", intervalMin: 10 },
  TIROL_obergurgl_sonn: { adapter: "tirol", plot: "obergurgl_sonn", id: "Zirmkogel Windstation", name: "Zirmkogel Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.881386, lon: 10.988783, elevationM: 3274, type: "berg", intervalMin: 10 },
  TIROL_rosskar: { adapter: "tirol", plot: "rosskar", id: "Festkogel", name: "Festkogel", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.853977, lon: 11.051768, elevationM: 3035, type: "berg", intervalMin: 10 },
  TIROL_schaufeljoch: { adapter: "tirol", plot: "schaufeljoch", id: "Schaufeljoch", name: "Schaufeljoch", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.977200, lon: 11.110900, elevationM: 3160, type: "berg", intervalMin: 10 },
  TIROL_stubaiergletscher_eisgrat: { adapter: "tirol", plot: "stubaiergletscher_eisgrat", id: "Rotadl", name: "Rotadl", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.987323, lon: 11.106927, elevationM: 3010, type: "berg", intervalMin: 10 },
  TIROL_breiter_grieskogel: { adapter: "tirol", plot: "breiter_grieskogel", id: "Breiter Grieskogel Windstation", name: "Breiter Grieskogel Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.101056, lon: 11.023039, elevationM: 3282, type: "berg", intervalMin: 10 },
  TIROL_laengental: { adapter: "tirol", plot: "laengental", id: "Kühtai Hochalter", name: "Kühtai Hochalter", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.231557, lon: 11.030122, elevationM: 2678, type: "berg", intervalMin: 10 },
  TIROL_lampsenspitze: { adapter: "tirol", plot: "lampsenspitze", id: "Lampsenspitze Windstation", name: "Lampsenspitze Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.156075, lon: 11.095642, elevationM: 2870, type: "berg", intervalMin: 10 },
  TIROL_franz_senn_huette: { adapter: "tirol", plot: "franz_senn_huette", id: "Franz-Senn-Hütte Horntaler Spitzl", name: "Franz-Senn-Hütte Horntaler Spitzl", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.099611, lon: 11.155417, elevationM: 2846, type: "berg", intervalMin: 10 },
  TIROL_nockwand: { adapter: "tirol", plot: "nockwand", id: "Nockwand Wind", name: "Nockwand Wind", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.036842, lon: 11.174653, elevationM: 3092, type: "berg", intervalMin: 10 },
  TIROL_gallreideschrofen: { adapter: "tirol", plot: "gallreideschrofen", id: "Kalkwand", name: "Kalkwand", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.053101, lon: 11.325632, elevationM: 2444, type: "berg", intervalMin: 10 },
  TIROL_elferspitze: { adapter: "tirol", plot: "elferspitze", id: "Elferspitze Windstation", name: "Elferspitze Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.082711, lon: 11.313464, elevationM: 2440, type: "berg", intervalMin: 10 },
  TIROL_schlickeralm: { adapter: "tirol", plot: "schlickeralm", id: "Sennjoch", name: "Sennjoch", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.137671, lon: 11.296132, elevationM: 2230, type: "berg", intervalMin: 10 },
  TIROL_axamer_lizum: { adapter: "tirol", plot: "axamer_lizum", id: "Axams Hoadlsattel", name: "Axams Hoadlsattel", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.178144, lon: 11.282456, elevationM: 2275, type: "berg", intervalMin: 10 },
  TIROL_birgitzkoepfl: { adapter: "tirol", plot: "birgitzkoepfl", id: "Birgitzköpfl", name: "Birgitzköpfl", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.194818, lon: 11.316349, elevationM: 2098, type: "berg", intervalMin: 10 },
  TIROL_seegrube: { adapter: "tirol", plot: "seegrube", id: "Hafelekar", name: "Hafelekar", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.312079, lon: 11.383623, elevationM: 2270, type: "berg", intervalMin: 10 },
  TIROL_sonntagskoepfl: { adapter: "tirol", plot: "sonntagskoepfl", id: "Sonntagsköpfl Windstation", name: "Sonntagsköpfl Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.271989, lon: 11.755802, elevationM: 2244, type: "berg", intervalMin: 10 },
  TIROL_laemmerbichlalm: { adapter: "tirol", plot: "laemmerbichlalm", id: "Rastkogel Windstation", name: "Rastkogel Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.192132, lon: 11.767481, elevationM: 2538, type: "berg", intervalMin: 10 },
  TIROL_tuxerjoch: { adapter: "tirol", plot: "tuxerjoch", id: "Tuxerjoch Windstation", name: "Tuxerjoch Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.089717, lon: 11.648987, elevationM: 2518, type: "berg", intervalMin: 10 },
  TIROL_wandspitze: { adapter: "tirol", plot: "wandspitze", id: "Wandspitze Windstation", name: "Wandspitze Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.120752, lon: 11.658062, elevationM: 2580, type: "berg", intervalMin: 10 },
  TIROL_eselruecken: { adapter: "tirol", plot: "eselruecken", id: "Kreuzspitze", name: "Kreuzspitze", source: "lawinen.report", attribution: TIROL_ATTR, lat: 47.046708, lon: 12.358958, elevationM: 3155, type: "berg", intervalMin: 10 },
  TIROL_stveit_zischke: { adapter: "tirol", plot: "stveit_zischke", id: "St Veit Speikboden", name: "St Veit Speikboden", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.945841, lon: 12.415529, elevationM: 2630, type: "berg", intervalMin: 10 },
  TIROL_mosesgipfel: { adapter: "tirol", plot: "mosesgipfel", id: "Mosesgipfel Windstation", name: "Mosesgipfel Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.820923, lon: 12.336998, elevationM: 2550, type: "berg", intervalMin: 10 },
  TIROL_thurntaler: { adapter: "tirol", plot: "thurntaler", id: "Thurntaler Windstation", name: "Thurntaler Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.775000, lon: 12.383600, elevationM: 2408, type: "berg", intervalMin: 10 },
  TIROL_raucheggen: { adapter: "tirol", plot: "raucheggen", id: "Raucheggen Windstation", name: "Raucheggen Windstation", source: "lawinen.report", attribution: TIROL_ATTR, lat: 46.803372, lon: 12.479020, elevationM: 2484, type: "berg", intervalMin: 10 },
  // ---- Meteotrentino ----
  TN_T0372: { adapter: "trentino", id: "T0372", name: "Peio (Crozzi Taviela)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.384176, lon: 10.631957, elevationM: 2960, type: "berg", intervalMin: 15 },
  TN_T0473: { adapter: "trentino", id: "T0473", name: "Ghiacciaio Del Careser", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.451278, lon: 10.718272, elevationM: 3093, type: "berg", intervalMin: 15 },
  TN_T0066: { adapter: "trentino", id: "T0066", name: "Cima Cavaion", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.42302263, lon: 10.7150282, elevationM: 2895, type: "berg", intervalMin: 15 },
  TN_T0065: { adapter: "trentino", id: "T0065", name: "Careser (Diga)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.422585, lon: 10.699111, elevationM: 2600, type: "berg", intervalMin: 15 },
  TN_T0076: { adapter: "trentino", id: "T0076", name: "Rabbi (San Bernardo)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.401374, lon: 10.849515, elevationM: 1132, type: "tal", intervalMin: 15 },
  TN_T0415: { adapter: "trentino", id: "T0415", name: "Bresimo (Malga Bordolona)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.433136, lon: 10.889328, elevationM: 1815, type: "berg", intervalMin: 15 },
  TN_T0417: { adapter: "trentino", id: "T0417", name: "Rumo (Lanza)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.45391, lon: 11.008531, elevationM: 1100, type: "tal", intervalMin: 15 },
  TN_T0399: { adapter: "trentino", id: "T0399", name: "Fondo", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.437705, lon: 11.129627, elevationM: 910, type: "tal", intervalMin: 15 },
  TN_T0418: { adapter: "trentino", id: "T0418", name: "Castelfondo (Malga Castrin)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.510001, lon: 11.043574, elevationM: 1815, type: "berg", intervalMin: 15 },
  TN_T0082: { adapter: "trentino", id: "T0082", name: "Passo Mendola", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.419179, lon: 11.189336, elevationM: 1315, type: "tal", intervalMin: 15 },
  TN_T0431: { adapter: "trentino", id: "T0431", name: "Capriana", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.263079, lon: 11.33633, elevationM: 1055, type: "tal", intervalMin: 15 },
  TN_T0367: { adapter: "trentino", id: "T0367", name: "Cavalese", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.284782, lon: 11.451713, elevationM: 958, type: "tal", intervalMin: 15 },
  TN_T0227: { adapter: "trentino", id: "T0227", name: "Cermis (Casere)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.250369, lon: 11.491486, elevationM: 1900, type: "berg", intervalMin: 15 },
  TN_T0229: { adapter: "trentino", id: "T0229", name: "Campitello (Malga Do Col D'Aura)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.490938, lon: 11.65755, elevationM: 2050, type: "berg", intervalMin: 15 },
  TN_T0437: { adapter: "trentino", id: "T0437", name: "Canazei (Gries)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.478318, lon: 11.766852, elevationM: 1465, type: "tal", intervalMin: 15 },
  TN_T0403: { adapter: "trentino", id: "T0403", name: "Canazei (Ciampac)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.445989, lon: 11.769081, elevationM: 2150, type: "berg", intervalMin: 15 },
  TN_T0015: { adapter: "trentino", id: "T0015", name: "Bieno", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.081097, lon: 11.557174, elevationM: 843, type: "tal", intervalMin: 15 },
  TN_T0421: { adapter: "trentino", id: "T0421", name: "Caoria", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.192017, lon: 11.683911, elevationM: 803, type: "tal", intervalMin: 15 },
  TN_T0030: { adapter: "trentino", id: "T0030", name: "Canal San Bovo", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.14956, lon: 11.734845, elevationM: 750, type: "tal", intervalMin: 15 },
  TN_T0469: { adapter: "trentino", id: "T0469", name: "Castello Tesino (Le Parti)", source: "Meteotrentino", attribution: TRENTINO_ATTR, lat: 46.056924, lon: 11.629929, elevationM: 801, type: "tal", intervalMin: 15 },
};

// GeoSphere Austria (TAWES): alle Stationen in EINER Anfrage. IDs, Namen,
// Koordinaten und Höhen stammen aus der Stationsliste der API
// (.../tawes-v1-10min/metadata, Stand 29.10.2026, alle Stationen aktiv).
const EXTRA_GEOSPHERE = [
  { key: "GS_11113", id: "11113", name: "Nauders", lat: 46.891111, lon: 10.496944, type: "tal", elevationM: 1330 },
  { key: "GS_11313", id: "11313", name: "Prutz", lat: 47.068611, lon: 10.664722, type: "tal", elevationM: 871 },
  { key: "GS_11112", id: "11112", name: "Landeck", lat: 47.140278, lon: 10.563611, type: "tal", elevationM: 796 },
  { key: "GS_11318", id: "11318", name: "Brunnenkogel / Ötztaler Alpen", lat: 46.912778, lon: 10.861667, type: "berg", elevationM: 3437 },
  { key: "GS_11316", id: "11316", name: "Pitztaler Gletscher", lat: 46.926944, lon: 10.879167, type: "berg", elevationM: 2864 },
  { key: "GS_11317", id: "11317", name: "St. Leonhard / Pitztal", lat: 47.027222, lon: 10.865556, type: "tal", elevationM: 1454 },
  { key: "GS_11115", id: "11115", name: "Imst", lat: 47.236944, lon: 10.742222, type: "tal", elevationM: 773 },
  { key: "GS_11309", id: "11309", name: "Haiming", lat: 47.259722, lon: 10.889444, type: "tal", elevationM: 659 },
  { key: "GS_11119", id: "11119", name: "Seefeld", lat: 47.324722, lon: 11.175556, type: "tal", elevationM: 1182 },
  { key: "GS_11324", id: "11324", name: "Neustift / Milders", lat: 47.102778, lon: 11.291944, type: "tal", elevationM: 1007 },
  { key: "GS_11129", id: "11129", name: "Brenner", lat: 47.007222, lon: 11.510833, type: "tal", elevationM: 1412 },
  { key: "GS_11329", id: "11329", name: "Steinach am Brenner", lat: 47.098333, lon: 11.466111, type: "tal", elevationM: 1036 },
  { key: "GS_11126", id: "11126", name: "Patscherkofel", lat: 47.208889, lon: 11.462222, type: "berg", elevationM: 2251 },
  { key: "GS_11123", id: "11123", name: "Rinn", lat: 47.249167, lon: 11.503889, type: "tal", elevationM: 924 },
  { key: "GS_8989037", id: "8989037", name: "Innsbruck Hauptbahnhof", lat: 47.260556, lon: 11.405000, type: "tal", elevationM: 611 },
  { key: "GS_11121", id: "11121", name: "Innsbruck Flughafen", lat: 47.260000, lon: 11.356667, type: "tal", elevationM: 578 },
  { key: "GS_11320", id: "11320", name: "Innsbruck Universität", lat: 47.260000, lon: 11.384167, type: "tal", elevationM: 578 },
  { key: "GS_11117", id: "11117", name: "Umhausen", lat: 47.139167, lon: 10.928889, type: "tal", elevationM: 1035 },
  { key: "GS_11127", id: "11127", name: "Obergurgl", lat: 46.866944, lon: 11.024444, type: "tal", elevationM: 1941 },
  { key: "GS_11326", id: "11326", name: "Schmirn", lat: 47.087222, lon: 11.580278, type: "tal", elevationM: 1464 },
  { key: "GS_11250", id: "11250", name: "Hintertux / Zillertal", lat: 47.106389, lon: 11.675000, type: "tal", elevationM: 1505 },
  { key: "GS_11330", id: "11330", name: "Mayrhofen", lat: 47.162500, lon: 11.851667, type: "tal", elevationM: 640 },
  { key: "GS_11136", id: "11136", name: "Krimml", lat: 47.229167, lon: 12.181944, type: "tal", elevationM: 1009 },
  { key: "GS_11073", id: "11073", name: "Mittersill", lat: 47.279167, lon: 12.495833, type: "tal", elevationM: 783 },
  { key: "GS_11252", id: "11252", name: "Virgen", lat: 47.002778, lon: 12.455833, type: "tal", elevationM: 1212 },
  { key: "GS_11300", id: "11300", name: "St. Jakob / Defereggen", lat: 46.916944, lon: 12.353889, type: "tal", elevationM: 1383 },
  { key: "GS_11201", id: "11201", name: "Sillian", lat: 46.746389, lon: 12.423611, type: "tal", elevationM: 1081 },
];
// Parameter-Codes laut Metadaten der API (alle Wind in m/s): FFAM arithmetisches
// Mittel der Windgeschwindigkeit über 10 Min. (Rückfall: FF, 10-Min-Wert),
// FFX Windspitze, DD Windrichtung, TL Lufttemperatur °C, RF rel. Feuchte %.
const GEOSPHERE_PARAMS = { avg: "FFAM", avgFallback: "FF", gust: "FFX", dir: "DD", temp: "TL", hum: "RF" };

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function kmhFromMs(v) {
  const n = num(v);
  return n === null ? null : round1(n * 3.6);
}

function clampPct(v) {
  const n = num(v);
  return n === null ? null : Math.min(100, Math.max(0, round1(n))); // manche Sensoren melden bis ~104 %
}

// Gemeinsames Zeilenformat (identisch zu den Südtirol-Zeilen in fetchWindStations)
//
// Plausibilitätsprüfung: Fremdquellen liefern gelegentlich Sensorfehler. Typisch
// ist "Feuchte exakt 0 %" zusammen mit einer absurd niedrigen Temperatur (z. B.
// -39,7 °C im Oktober an einer Tiroler Station) - dann werden beide Werte
// verworfen statt angezeigt. Windwerte über 300 km/h und Richtungen außerhalb
// von 0-360° gelten ebenfalls als ungültig.
function buildWindRow(instant, v) {
  let tempC = v.tempC ?? null;
  let humidityPct = v.humidityPct ?? null;
  if (humidityPct === 0) {
    humidityPct = null;
    if (tempC !== null && tempC < -30) tempC = null;
  }
  if (tempC !== null && (tempC < -60 || tempC > 60)) tempC = null;
  const speed = (x) => (x === null || x === undefined || x < 0 || x > 300 ? null : x);
  const dir = v.dirDeg ?? null;
  return {
    instantUTC: instant.toISOString(),
    time: fmtTime(instant),
    avgKmh: speed(v.avgKmh ?? null),
    gustKmh: speed(v.gustKmh ?? null),
    dirDeg: dir !== null && (dir < 0 || dir > 360) ? null : dir,
    tempC,
    humidityPct
  };
}

// Fügt Zeilen ein (Duplikate über instantUTC vermeiden) und kürzt auf
// MAX_WIND_ROWS. Mehrere Zeilen pro Lauf möglich -> füllt den Verlauf sofort.
function upsertWindRows(windData, key, rows, meta) {
  if (!windData.stations) windData.stations = {};
  if (!windData.stations[key]) windData.stations[key] = { rows: [] };
  const st = windData.stations[key];
  if (meta) st.meta = { ...(st.meta || {}), ...meta };
  const known = new Set(st.rows.map((r) => r.instantUTC));
  let added = 0;
  for (const r of rows) {
    if (known.has(r.instantUTC)) continue;
    known.add(r.instantUTC);
    st.rows.push(r);
    added++;
  }
  st.rows.sort((a, b) => new Date(a.instantUTC) - new Date(b.instantUTC));
  if (st.rows.length > MAX_WIND_ROWS) st.rows = st.rows.slice(st.rows.length - MAX_WIND_ROWS);
  return added;
}

async function fetchText(url, options, encoding) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder(encoding || "utf-8").decode(buf);
}

/* ---------- MeteoSchweiz (SwissMetNet, OGD-CSV) ---------- */

// "07.10.2026 20:20" (UTC) oder ISO. ISO ohne Zonenangabe wird als UTC gelesen.
export function parseMchTimestamp(s) {
  const t = String(s).trim();
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]));
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(t) ? t.replace(" ", "T") + "Z" : t;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

// Spalten (MeteoSchweiz-Parameter, 10-Minuten-Werte):
//  tre200s0 Lufttemperatur °C | ure200s0 relative Feuchte % |
//  fkl010z0 Windgeschwindigkeit 10-Min-Mittel m/s | fkl010z1 Böenspitze (1 s) m/s |
//  dkl010z0 Windrichtung 10-Min-Mittel °
// Die Zuordnung stammt aus den Spaltencodes und stimmt mit den km/h-Spalten
// (fu3010z0 = fkl010z0 x 3,6) überein; die Parameter-Meta-CSV wurde nicht geprüft.
export function parseMchCsv(text, stationAbbr) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("MeteoSchweiz-CSV leer");
  const header = lines[0].split(";").map((h) => h.trim().replace(/^"|"$/g, ""));
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const need = ["station_abbr", "reference_timestamp", "tre200s0", "ure200s0", "fkl010z0", "fkl010z1", "dkl010z0"];
  const missing = need.filter((k) => !(k in idx));
  if (missing.length) throw new Error(`MeteoSchweiz-CSV: Spalte(n) fehlen: ${missing.join(", ")}`);

  const abbr = stationAbbr.toUpperCase();
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(";");
    if ((c[idx.station_abbr] || "").trim().toUpperCase() !== abbr) continue;
    const instant = parseMchTimestamp(c[idx.reference_timestamp] || "");
    if (!instant) continue;
    rows.push({
      instant,
      avgKmh: kmhFromMs(c[idx.fkl010z0]),
      gustKmh: kmhFromMs(c[idx.fkl010z1]),
      dirDeg: num(c[idx.dkl010z0]),
      tempC: num(c[idx.tre200s0]),
      humidityPct: clampPct(c[idx.ure200s0])
    });
  }
  return rows;
}

// Höhe/Koordinaten aus ogd-smn_meta_stations.csv. Die genauen Spaltennamen
// habe ich nicht gesehen -> Suche über Namensbestandteile; klappt das nicht,
// bleiben die Rückfallwerte aus EXTRA_STATIONS.
export function parseMchMeta(text, stationAbbr) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0].split(";").map((h) => h.trim().replace(/^"|"$/g, ""));
  const find = (re, not) => header.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const iAbbr = header.findIndex((h) => /^station_abbr$/i.test(h));
  const iHeight = find(/height/i, /baro/i);
  const iLat = find(/wgs84.*lat|lat.*wgs84/i);
  const iLon = find(/wgs84.*lon|lon.*wgs84/i);
  if (iAbbr < 0) return null;
  const line = lines.slice(1).find((l) => (l.split(";")[iAbbr] || "").replace(/"/g, "").trim().toUpperCase() === stationAbbr.toUpperCase());
  if (!line) return null;
  const c = line.split(";").map((x) => x.replace(/"/g, "").trim());
  const out = {};
  if (iHeight >= 0 && num(c[iHeight]) !== null) out.elevationM = num(c[iHeight]);
  if (iLat >= 0 && num(c[iLat]) !== null) out.lat = num(c[iLat]);
  if (iLon >= 0 && num(c[iLon]) !== null) out.lon = num(c[iLon]);
  return Object.keys(out).length ? out : null;
}

// Metadatei nur einmal pro Lauf laden (nicht einmal pro Station).
let mchMetaPromise = null;
function loadMchMeta() {
  if (!mchMetaPromise) {
    mchMetaPromise = fetchText(`${MCH_BASE}/ogd-smn_meta_stations.csv`, { headers: EXTRA_HEADERS }, "windows-1252");
  }
  return mchMetaPromise;
}

async function fetchMchStation(cfg) {
  const url = `${MCH_BASE}/${cfg.id}/ogd-smn_${cfg.id}_t_now.csv`;
  const text = await withRetry(() => fetchText(url, { headers: EXTRA_HEADERS }, "windows-1252"), `MeteoSchweiz ${cfg.id}`, EXTRA_RETRY_COUNT);
  const rows = parseMchCsv(text, cfg.id);
  let geo = null;
  try {
    const metaText = await loadMchMeta();
    geo = parseMchMeta(metaText, cfg.id);
    if (!geo) console.warn(`MeteoSchweiz ${cfg.id}: Metadaten nicht auswertbar, Rückfallwerte für Koordinaten/Höhe.`);
  } catch (err) {
    console.warn(`MeteoSchweiz ${cfg.id}: Metadaten-Abruf fehlgeschlagen (${err.message}), Rückfallwerte.`);
  }
  return { rows, geo };
}

/* ---------- SLF / IMIS ---------- */

// 30-Minuten-Werte. VW = Windgeschwindigkeit (Vektormittel) m/s,
// VW_30MIN_MAX = höchster 5-s-Wert der 30 Minuten (-> Böe), DW = Richtung.
export function parseSlfMeasurements(arr) {
  if (!Array.isArray(arr)) throw new Error("SLF: unerwartete Antwort (kein Array)");
  return arr
    .map((m) => ({
      instant: new Date(m.measure_date),
      avgKmh: kmhFromMs(m.VW_30MIN_MEAN),
      gustKmh: kmhFromMs(m.VW_30MIN_MAX),
      dirDeg: num(m.DW_30MIN_MEAN) === null ? null : round1(num(m.DW_30MIN_MEAN)),
      tempC: num(m.TA_30MIN_MEAN) === null ? null : round1(num(m.TA_30MIN_MEAN)), // SLF liefert z.B. -1.153
      humidityPct: clampPct(m.RH_30MIN_MEAN)
    }))
    .filter((r) => !isNaN(r.instant));
}

let slfListPromise = null; // Stationsliste nur einmal pro Lauf laden
function loadSlfList() {
  if (!slfListPromise) {
    slfListPromise = fetchJson(`${SLF_BASE}/stations`, { headers: { Accept: "application/json", ...EXTRA_HEADERS } });
  }
  return slfListPromise;
}

async function fetchSlfStation(cfg) {
  const url = `${SLF_BASE}/station/${cfg.id}/measurements?period_in_days=1`;
  const data = await withRetry(() => fetchJson(url, { headers: { Accept: "application/json", ...EXTRA_HEADERS } }), `SLF ${cfg.id}`, EXTRA_RETRY_COUNT);
  const rows = parseSlfMeasurements(data);
  let geo = null;
  try {
    const list = await loadSlfList();
    const s = Array.isArray(list) ? list.find((x) => x.code === cfg.id) : null;
    if (s) geo = { lat: s.lat, lon: s.lon, elevationM: s.elevation, name: s.label };
  } catch (err) {
    console.warn(`SLF ${cfg.id}: Stationsliste nicht abrufbar (${err.message}), Rückfallwerte.`);
  }
  return { rows, geo };
}

/* ---------- Tirol (stations.geojson von lawinen.report) ---------- */

// Eine Datei mit allen Stationen, je Station nur der letzte Wert.
// WG = mittlerer Wind, WG_BOE = Böe (beide km/h: Patscherkofel zeigt dort 75 bzw.
// 105 - in m/s unmöglich), WR = Richtung, LT = Temperatur, RH = Feuchte (nicht
// bei jeder Station vorhanden). "plot" ist nicht eindeutig (mehrere Stationen
// teilen sich eine Grafik), deshalb zusätzlich über den Namen filtern.
const cleanName = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export function parseTirolFeature(geojson, plot, name) {
  // Namen in der Datei haben teils Leerzeichen am Ende -> vor dem Vergleich bereinigen
  const f = (geojson.features || []).find((x) => x.properties?.plot === plot && cleanName(x.properties?.name) === cleanName(name));
  if (!f) return null;
  const p = f.properties;
  const instant = new Date(p.date);
  if (isNaN(instant)) return null;
  const [lon, lat, ele] = f.geometry?.coordinates || [];
  return {
    rows: [{
      instant,
      avgKmh: num(p.WG) === null ? null : round1(num(p.WG)),
      gustKmh: num(p.WG_BOE) === null ? null : round1(num(p.WG_BOE)),
      dirDeg: num(p.WR) === null ? null : round1(num(p.WR)),
      tempC: num(p.LT) === null ? null : round1(num(p.LT)),
      humidityPct: clampPct(p.RH)
    }],
    geo: { lat, lon, elevationM: ele, operator: p.operator || null }
  };
}

let tirolGeojsonPromise = null; // pro Lauf nur einmal laden, falls später mehr Tirol-Stationen dazukommen
function loadTirolGeojson() {
  if (!tirolGeojsonPromise) {
    tirolGeojsonPromise = withRetry(() => fetchJson(TIROL_GEOJSON_URL, { headers: EXTRA_HEADERS }), "Tirol stations.geojson", EXTRA_RETRY_COUNT);
  }
  return tirolGeojsonPromise;
}

async function fetchTirolStation(cfg) {
  const geojson = await loadTirolGeojson();
  const res = parseTirolFeature(geojson, cfg.plot, cfg.id);
  if (!res) throw new Error(`Station ${cfg.id} (${cfg.plot}) nicht in stations.geojson`);
  return res;
}

/* ---------- Meteotrentino ---------- */

// XML ohne Bibliothek: pro Parameter eine Liste von Einträgen mit Attributen
// (z. B. <vento_al_suolo UM_VV="m/s" ...>); der gleichnamige Container ohne
// Attribute wird dadurch nicht mitgefangen. Zeitstempel ohne Zone = UTC+1.
export function parseTrentinoXml(xml) {
  const entries = (tag) =>
    [...xml.matchAll(new RegExp(`<${tag}\\s[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
  const val = (block, t) => {
    const m = new RegExp(`<${t}>([^<]*)</${t}>`).exec(block);
    return m ? m[1].trim() : null;
  };
  const byTime = new Map();
  const slot = (d) => {
    if (!byTime.has(d)) byTime.set(d, {});
    return byTime.get(d);
  };
  for (const b of entries("temperatura_aria")) {
    const d = val(b, "data");
    if (d) slot(d).tempC = num(val(b, "temperatura"));
  }
  for (const b of entries("vento_al_suolo")) {
    const d = val(b, "data");
    if (!d) continue;
    const o = slot(d);
    o.avgKmh = kmhFromMs(val(b, "v"));
    o.gustKmh = kmhFromMs(val(b, "vmax"));
    o.dirDeg = num(val(b, "d"));
  }
  for (const b of entries("umidita_relativa")) {
    const d = val(b, "data");
    if (d) slot(d).humidityPct = clampPct(val(b, "rh"));
  }
  const rows = [];
  for (const [d, v] of byTime) {
    const instant = new Date(`${d}+01:00`);
    if (isNaN(instant)) continue;
    rows.push({ instant, ...v });
  }
  rows.sort((a, b) => a.instant - b.instant);
  return rows;
}

async function fetchTrentinoStation(cfg) {
  const url = `${TRENTINO_BASE}/ultimiDatiStazione?codice=${cfg.id}`;
  const xml = await withRetry(() => fetchText(url, { headers: { Accept: "application/xml,text/xml", ...EXTRA_HEADERS } }), `Meteotrentino ${cfg.id}`, EXTRA_RETRY_COUNT);
  const rows = parseTrentinoXml(xml);
  if (!rows.length) throw new Error(`Meteotrentino ${cfg.id}: keine Messwerte in der Antwort`);
  return { rows, geo: null };
}

/* ---------- Zusammenführen ---------- */

const EXTRA_FETCHERS = { mch: fetchMchStation, slf: fetchSlfStation, tirol: fetchTirolStation, trentino: fetchTrentinoStation };

async function processExtraStation(windData, key, cfg, now) {
  const cutoff = addMinutes(now, -EXTRA_WINDOW_MINUTES).getTime();
  const { rows: raw, geo } = await EXTRA_FETCHERS[cfg.adapter](cfg);
  // nur das gleiche Zeitfenster wie bei Südtirol übernehmen, keine Zukunftswerte
  let fresh = raw.filter((r) => r.instant.getTime() >= cutoff && r.instant.getTime() <= now.getTime() + 5 * 60000);
  // Liefert eine Station nur einen älteren Wert (z. B. Sensor ausgefallen), den
  // jüngsten trotzdem übernehmen - die Karte zeigt ihn dann als "verzögert" an
  // statt die Station einfach verschwinden zu lassen.
  if (!fresh.length && raw.length) {
    const newest = raw.reduce((a, b) => (b.instant > a.instant ? b : a));
    if (now.getTime() - newest.instant.getTime() <= EXTRA_MAX_STALE_MS && newest.instant.getTime() <= now.getTime() + 5 * 60000) fresh = [newest];
  }
  const rows = fresh.map((r) => buildWindRow(r.instant, r));
  const meta = {
    name: cfg.name, source: cfg.source,
    attribution: geo?.operator ? `Quelle: ${geo.operator} (lawinen.report)` : cfg.attribution,
    stationId: cfg.adapter === "mch" ? cfg.id.toUpperCase() : cfg.id,
    lat: geo?.lat ?? cfg.lat, lon: geo?.lon ?? cfg.lon, elevationM: geo?.elevationM ?? cfg.elevationM,
    intervalMin: cfg.intervalMin, type: cfg.type
  };
  const added = upsertWindRows(windData, key, rows, meta);
  // alte Zeilen außerhalb des Zeitfensters entfernen (30-Min-Quellen würden sonst
  // über 40 Zeilen weit mehr als 6,5 h anhäufen) - die jüngste bleibt immer erhalten
  const st = windData.stations[key];
  if (st.rows.length > 1) {
    const newestRow = st.rows[st.rows.length - 1];
    st.rows = st.rows.filter((r) => r === newestRow || new Date(r.instantUTC).getTime() >= cutoff);
  }
  if (!rows.length) {
    console.warn(`${key}: keine Werte (jüngster Wert der Quelle: ${raw.length ? raw[raw.length - 1].instant.toISOString() : "keiner"}).`);
    return true;
  }
  const last = rows[rows.length - 1];
  const hasWind = rows.some((r) => r.avgKmh !== null || r.gustKmh !== null);
  console.log(`${key} (${cfg.name}) @ ${last.time}: ${last.avgKmh ?? "–"}/${last.gustKmh ?? "–"} km/h, ${last.dirDeg ?? "–"}°, ${last.tempC ?? "–"} °C (+${added} neu)${hasWind ? "" : " [KEIN WIND in den Daten]"}`);
  return true;
}

// GeoSphere Austria (TAWES): alle Stationen in einer einzigen Anfrage
async function fetchGeosphereExtras(windData, now) {
  if (!EXTRA_GEOSPHERE.length) return;
  const ids = EXTRA_GEOSPHERE.map((s) => s.id).join(",");
  const params = Object.values(GEOSPHERE_PARAMS).join(",");
  const start = fmtIsoMinuteUTC(addMinutes(now, -EXTRA_WINDOW_MINUTES));
  const end = fmtIsoMinuteUTC(now);
  const url = `${GEOSPHERE_TAWES_URL}?parameters=${params}&station_ids=${ids}&start=${start}&end=${end}`;
  const data = await withRetry(() => fetchJson(url, { headers: EXTRA_HEADERS }), "GeoSphere TAWES", EXTRA_RETRY_COUNT);
  const timestamps = (data.timestamps || []).map((x) => new Date(x));
  for (const s of EXTRA_GEOSPHERE) {
    try {
      const feat = (data.features || []).find((f) => String(f.properties?.station) === String(s.id));
      const series = (name) => feat?.properties?.parameters?.[name]?.data || [];
      const avgMain = series(GEOSPHERE_PARAMS.avg), avgAlt = series(GEOSPHERE_PARAMS.avgFallback);
      const avg = Array.from({ length: Math.max(avgMain.length, avgAlt.length) }, (_, i) => avgMain[i] ?? avgAlt[i] ?? null);
      const gust = series(GEOSPHERE_PARAMS.gust), dir = series(GEOSPHERE_PARAMS.dir);
      const temp = series(GEOSPHERE_PARAMS.temp), hum = series(GEOSPHERE_PARAMS.hum);
      const rows = [];
      timestamps.forEach((instant, i) => {
        if (isNaN(instant) || instant.getTime() > now.getTime() + 5 * 60000) return;
        const r = {
          avgKmh: kmhFromMs(avg[i]), gustKmh: kmhFromMs(gust[i]), dirDeg: num(dir[i]),
          tempC: num(temp[i]), humidityPct: clampPct(hum[i])
        };
        // Zeilen ganz ohne Messwerte (noch nicht veröffentlichte Zeitpunkte) überspringen
        if (Object.values(r).every((v) => v === null)) return;
        rows.push(buildWindRow(instant, r));
      });
      const meta = {
        name: s.name, source: "GeoSphere Austria", attribution: GEOSPHERE_ATTR, stationId: String(s.id),
        lat: s.lat, lon: s.lon, elevationM: s.elevationM, intervalMin: 10, type: s.type
      };
      const added = upsertWindRows(windData, s.key, rows, meta);
      const st = windData.stations[s.key];
      const cutoff = addMinutes(now, -EXTRA_WINDOW_MINUTES).getTime();
      if (st.rows.length > 1) {
        const newestRow = st.rows[st.rows.length - 1];
        st.rows = st.rows.filter((r) => r === newestRow || new Date(r.instantUTC).getTime() >= cutoff);
      }
      const last = rows[rows.length - 1];
      console.log(`${s.key} (${s.name}) @ ${last ? last.time : "–"}: ${last ? `${last.avgKmh ?? "–"}/${last.gustKmh ?? "–"} km/h` : "keine Werte"} (+${added} neu)`);
    } catch (err) {
      console.warn(`${s.key} (${s.name}) fehlgeschlagen: ${err.message}`);
    }
  }
}

export async function fetchExtraStations(windData, now = new Date()) {
  const started = Date.now();
  // Quellen laufen parallel zueinander, innerhalb einer Quelle gedrosselt.
  const groups = {};
  for (const [key, cfg] of Object.entries(EXTRA_STATIONS)) (groups[cfg.adapter] ||= []).push([key, cfg]);

  const groupJobs = Object.entries(groups).map(async ([adapter, items]) => {
    const { limit, stagger } = EXTRA_GROUP_LIMITS[adapter] || { limit: 1, stagger: 0 };
    let okCount = 0, failCount = 0, aborted = false;
    await mapWithConcurrencyLimit(items, limit, async ([key, cfg]) => {
      if (aborted) return;
      if (Date.now() - started > EXTRA_DEADLINE_MS) {
        console.warn(`${key} (${cfg.name}) übersprungen: Zeitbudget für Zusatzstationen aufgebraucht.`);
        return;
      }
      try {
        await processExtraStation(windData, key, cfg, now);
        okCount++;
      } catch (err) {
        failCount++;
        console.warn(`${key} (${cfg.name}) fehlgeschlagen: ${err.message}`);
        // Server offenbar gesperrt/ausgefallen: nicht jede weitere Station einzeln
        // gegen die Wand laufen lassen (und den Server nicht unnötig belasten).
        if (okCount === 0 && failCount >= 3 && !aborted) {
          aborted = true;
          console.warn(`Quelle "${adapter}": ${failCount} Fehler ohne einen Erfolg - restliche Stationen dieser Quelle werden in diesem Lauf übersprungen.`);
        }
      }
    }, stagger);
  });
  groupJobs.push(fetchGeosphereExtras(windData, now).catch((err) => console.warn(`GeoSphere Zusatzstationen fehlgeschlagen: ${err.message}`)));
  await Promise.all(groupJobs);
  return windData;
}

async function main() {
  // Kurzer Puffer, bevor überhaupt irgendwas abgerufen wird: die Quelle
  // braucht nach dem 10-Minuten-Messtakt noch etwas Verarbeitungszeit, bis
  // ein neuer Wert tatsächlich abrufbar ist (empirisch für die aktuell
  // verwendete geoservices-Domain gemessen: ca. 600-620 Sekunden nach dem
  // Raster-Zeitpunkt). Bewusst VOR der now-Erfassung platziert, damit die
  // anschließende Zielzeitpunkt-Berechnung die verstrichene Wartezeit korrekt
  // mit einbezieht.
  await new Promise((resolve) => setTimeout(resolve, 40 * 1000));

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
    fetchWindStations(windHistory),
    // Zusatzstationen anderer Datenquellen (eigene Hosts, daher parallel
    // unkritisch; jede Quelle fängt ihre Fehler selbst ab - ein Ausfall bei
    // einer Quelle verhindert nie das Speichern der übrigen Daten).
    fetchExtraStations(windHistory, now)
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

// Nur starten, wenn die Datei direkt aufgerufen wird (nicht beim Import in
// einem Test - die Parser oben sind dafür exportiert).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Unerwarteter Fehler:", err);
    process.exit(1);
  });
}
