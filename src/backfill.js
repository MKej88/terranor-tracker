import { TRACKER_CONFIG } from "./config.js";

const SMHI_BASE = "https://opendata-download-metobs.smhi.se/api/version/1.0";
const DEFAULT_DAYS = 60;
const DEFAULT_STATIONS_PER_RUN = 2;

const PARAMETERS = [
  { id: 1, field: "air_temp_c" },
  { id: 4, field: "wind_ms" },
  { id: 6, field: "humidity_pct" },
  { id: 7, field: "precipitation_mm" },
];
const CORE_FIELDS = ["air_temp_c", "wind_ms", "precipitation_mm"];

const BACKFILL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS backfill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    stations_attempted INTEGER DEFAULT 0,
    stations_completed INTEGER DEFAULT 0,
    observations_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_backfill_runs_source_time ON backfill_runs(source, started_at)`,
];

export async function ensureBackfillSchema(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await db.batch(BACKFILL_SCHEMA.map((sql) => db.prepare(sql)));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toIsoHour(value) {
  let ms = null;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) ms = Number(value);
  else if (value) ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 3600000) * 3600000).toISOString();
}

function numericOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchStationParameter(stationId, parameterId) {
  const url = `${SMHI_BASE}/parameter/${parameterId}/station/${encodeURIComponent(stationId)}/period/latest-months/data.json`;
  const response = await fetch(url, { headers: { "user-agent": "terranor-tracker/2.0" } });
  if (response.status === 404) return { values: [], url, unavailable: true };
  if (!response.ok) throw new Error(`SMHI station ${stationId} parameter ${parameterId} failed: ${response.status}`);
  const payload = await response.json();
  const values = Array.isArray(payload?.value) ? payload.value : [];
  return { values, url, unavailable: false };
}

async function primarySmhiStations(db) {
  const result = await db.prepare(`SELECT DISTINCT l.station_id, l.station_name
    FROM weather_station_links l
    JOIN contracts c ON c.id=l.contract_id
    WHERE l.source='SMHI' AND l.active=1 AND l.rank_no=1 AND c.country='Sweden'
    ORDER BY l.station_id`).all();
  return result?.results || [];
}

async function stationCoverage(db, stationId, days) {
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const row = await db.prepare(`SELECT
      COUNT(*) AS observations,
      MIN(observed_at) AS earliest,
      MAX(observed_at) AS latest,
      SUM(CASE WHEN air_temp_c IS NOT NULL THEN 1 ELSE 0 END) AS air_temp_hours,
      SUM(CASE WHEN wind_ms IS NOT NULL THEN 1 ELSE 0 END) AS wind_hours,
      SUM(CASE WHEN precipitation_mm IS NOT NULL THEN 1 ELSE 0 END) AS precipitation_hours,
      SUM(CASE WHEN humidity_pct IS NOT NULL THEN 1 ELSE 0 END) AS humidity_hours
    FROM weather_observations
    WHERE source='SMHI' AND station_id=? AND observed_at>=?`)
    .bind(String(stationId), sinceIso).first();
  const expectedHours = Math.max(1, days * 24);
  const counts = {
    air_temp_c: Number(row?.air_temp_hours || 0),
    wind_ms: Number(row?.wind_hours || 0),
    precipitation_mm: Number(row?.precipitation_hours || 0),
    humidity_pct: Number(row?.humidity_hours || 0),
  };
  const metricCoveragePct = Object.fromEntries(Object.entries(counts).map(([key, count]) => [
    key, Math.round(1000 * count / expectedHours) / 10,
  ]));
  const minimumCoreCoveragePct = Math.min(...CORE_FIELDS.map((field) => metricCoveragePct[field] || 0));
  return {
    observations: Number(row?.observations || 0),
    earliest: row?.earliest || null,
    latest: row?.latest || null,
    metricHours: counts,
    metricCoveragePct,
    minimumCoreCoveragePct,
    backfilled: minimumCoreCoveragePct >= TRACKER_CONFIG.weatherQuality.readyMetricCoveragePct,
  };
}

async function pickStations(db, days, limit) {
  const stations = await primarySmhiStations(db);
  const scored = [];
  for (const station of stations) scored.push({ ...station, ...(await stationCoverage(db, station.station_id, days)) });
  return scored
    .filter((row) => !row.backfilled)
    .sort((a, b) => a.minimumCoreCoveragePct - b.minimumCoreCoveragePct)
    .slice(0, limit);
}

async function writeStation(db, station, days) {
  const sinceMs = Date.now() - days * 86400000;
  const datasets = await Promise.all(PARAMETERS.map((p) => fetchStationParameter(station.station_id, p.id)));
  const rows = new Map();

  for (let i = 0; i < PARAMETERS.length; i += 1) {
    const parameter = PARAMETERS[i];
    const dataset = datasets[i];
    for (const item of dataset.values) {
      const observedAt = toIsoHour(item?.date);
      if (!observedAt) continue;
      const ts = Date.parse(observedAt);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const value = numericOrNull(item?.value);
      if (value === null) continue;
      const row = rows.get(observedAt) || {
        observed_at: observedAt,
        air_temp_c: null,
        precipitation_mm: null,
        wind_ms: null,
        humidity_pct: null,
        qualities: {},
      };
      row[parameter.field] = value;
      if (item?.quality !== undefined) row.qualities[parameter.field] = item.quality;
      rows.set(observedAt, row);
    }
  }

  const statements = [...rows.values()].map((row) => db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES (NULL, 'SMHI', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      air_temp_c=COALESCE(excluded.air_temp_c, weather_observations.air_temp_c),
      precipitation_mm=COALESCE(excluded.precipitation_mm, weather_observations.precipitation_mm),
      wind_ms=COALESCE(excluded.wind_ms, weather_observations.wind_ms),
      humidity_pct=COALESCE(excluded.humidity_pct, weather_observations.humidity_pct),
      raw_json=excluded.raw_json`)
    .bind(
      String(station.station_id), row.observed_at, row.air_temp_c, row.precipitation_mm,
      row.wind_ms, row.humidity_pct,
      JSON.stringify({ historicalBackfill: true, stationName: station.station_name, qualities: row.qualities }),
    ));

  const chunkSize = 50;
  for (let i = 0; i < statements.length; i += chunkSize) await db.batch(statements.slice(i, i + chunkSize));
  return rows.size;
}

export async function runSmhiBackfill(db, options = {}) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureBackfillSchema(db);
  const days = clampInt(options.days, DEFAULT_DAYS, 7, 120);
  const maxStations = clampInt(options.maxStations, DEFAULT_STATIONS_PER_RUN, 1, 3);
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO backfill_runs (source, started_at, status)
    VALUES ('SMHI', ?, 'running') RETURNING id`).bind(startedAt).first();
  const runId = run?.id;

  try {
    const stations = await pickStations(db, days, maxStations);
    let completed = 0;
    let written = 0;
    const details = [];
    for (const station of stations) {
      const count = await writeStation(db, station, days);
      completed += 1;
      written += count;
      details.push({ station_id: String(station.station_id), station_name: station.station_name, observations_written: count });
    }
    const finishedAt = new Date().toISOString();
    if (runId) await db.prepare(`UPDATE backfill_runs SET finished_at=?, status='ok', stations_attempted=?,
        stations_completed=?, observations_written=? WHERE id=?`)
      .bind(finishedAt, stations.length, completed, written, runId).run();
    return { ok: true, source: "SMHI", days, startedAt, finishedAt, stationsAttempted: stations.length, stationsCompleted: completed, observationsWritten: written, details };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (runId) await db.prepare(`UPDATE backfill_runs SET finished_at=?, status='error', error_text=? WHERE id=?`)
      .bind(finishedAt, String(error?.message || error).slice(0, 2000), runId).run();
    throw error;
  }
}

export async function getBackfillStatus(db, days = DEFAULT_DAYS) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureBackfillSchema(db);
  const windowDays = clampInt(days, DEFAULT_DAYS, 7, 120);
  const stations = await primarySmhiStations(db);
  const stationStatus = [];
  for (const station of stations) stationStatus.push({
    station_id: String(station.station_id),
    station_name: station.station_name,
    ...(await stationCoverage(db, station.station_id, windowDays)),
  });
  const latestRun = await db.prepare(`SELECT source, started_at, finished_at, status, stations_attempted,
    stations_completed, observations_written, error_text
    FROM backfill_runs WHERE source='SMHI' ORDER BY id DESC LIMIT 1`).first();
  return {
    source: "SMHI",
    days: windowDays,
    qualityVersion: "2.0",
    requiredCoreMetricCoveragePct: TRACKER_CONFIG.weatherQuality.readyMetricCoveragePct,
    stations: stationStatus.length,
    stationsBackfilled: stationStatus.filter((x) => x.backfilled).length,
    complete: stationStatus.length > 0 && stationStatus.every((x) => x.backfilled),
    latestRun: latestRun || null,
    stationStatus,
  };
}
