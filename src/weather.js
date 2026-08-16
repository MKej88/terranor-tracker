const SMHI_BASE = "https://opendata-download-metobs.smhi.se/api/version/1.0";

const SMHI_PARAMETERS = [
  { key: "airTemp", id: 1, column: "air_temp_c" },
  { key: "wind", id: 4, column: "wind_ms" },
  { key: "humidity", id: 6, column: "humidity_pct" },
  { key: "precipitation", id: 7, column: "precipitation_mm" },
];

// Proxy anchors are deliberately coarse. They are used only to select nearby public
// meteorological stations until exact contract geometries / VViS points are available.
const WEATHER_ANCHORS = [
  { country: "Sweden", contract: "Skellefteå Norra", label: "Skellefteå Norra proxy", lat: 64.86, lon: 20.95, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Umeå Södra", label: "Umeå Södra proxy", lat: 63.72, lon: 20.25, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Kungsbacka", label: "Kungsbacka proxy", lat: 57.49, lon: 12.08, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Kungälv", label: "Kungälv proxy", lat: 57.89, lon: 11.97, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Södra Skaraborg", label: "Södra Skaraborg proxy", lat: 58.17, lon: 13.55, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Mjölby", label: "Mjölby proxy", lat: 58.33, lon: 15.13, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Norrköping område 3", label: "Norrköping proxy", lat: 58.59, lon: 16.19, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Stockholm road maintenance", label: "Stockholm proxy", lat: 59.33, lon: 18.07, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Helsingborg – Byar Söder & Centrum Norr", label: "Helsingborg proxy", lat: 56.05, lon: 12.69, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Falun område A", label: "Falun A proxy", lat: 60.58, lon: 15.64, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Skellefteå Södra", label: "Skellefteå Södra proxy", lat: 64.62, lon: 20.95, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Malmö", label: "Malmö proxy", lat: 55.61, lon: 13.00, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Vännäs", label: "Vännäs proxy", lat: 63.91, lon: 19.76, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Väsby", label: "Väsby proxy", lat: 59.52, lon: 17.91, confidence: "proxy-city-centre" },
  { country: "Sweden", contract: "Sydöstra Värmland", label: "Sydöstra Värmland proxy", lat: 59.31, lon: 14.11, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Falun område Norr", label: "Falun Norr proxy", lat: 60.72, lon: 15.64, confidence: "proxy-area-centre" },
  { country: "Sweden", contract: "Borås municipality urban O&M", label: "Borås proxy", lat: 57.72, lon: 12.94, confidence: "proxy-city-centre" },
];

const WEATHER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS weather_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    confidence TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id, label),
    FOREIGN KEY (contract_id) REFERENCES contracts(id)
  )`,
  `CREATE TABLE IF NOT EXISTS weather_station_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    anchor_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    station_id TEXT NOT NULL,
    station_name TEXT,
    latitude REAL,
    longitude REAL,
    distance_km REAL,
    completeness INTEGER,
    rank_no INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(anchor_id, source, station_id),
    FOREIGN KEY (contract_id) REFERENCES contracts(id),
    FOREIGN KEY (anchor_id) REFERENCES weather_anchors(id)
  )`,
  `CREATE TABLE IF NOT EXISTS weather_collection_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    stations_fetched INTEGER DEFAULT 0,
    observations_written INTEGER DEFAULT 0,
    links_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_weather_links_contract ON weather_station_links(contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_weather_links_station ON weather_station_links(source, station_id)`,
  `CREATE INDEX IF NOT EXISTS idx_weather_runs_source_time ON weather_collection_runs(source, started_at)`,
];

export async function ensureWeatherSchema(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await db.batch(WEATHER_SCHEMA.map((sql) => db.prepare(sql)));
}

export async function seedWeatherAnchors(db) {
  await ensureWeatherSchema(db);
  const contracts = await db.prepare("SELECT id, country, name FROM contracts").all();
  const contractMap = new Map((contracts?.results || []).map((c) => [`${c.country}|${c.name}`, c.id]));
  const statements = [];

  for (const anchor of WEATHER_ANCHORS) {
    const contractId = contractMap.get(`${anchor.country}|${anchor.contract}`);
    if (!contractId) continue;
    statements.push(
      db.prepare(`INSERT INTO weather_anchors (
        contract_id, label, latitude, longitude, confidence, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(contract_id, label) DO UPDATE SET
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        confidence=excluded.confidence,
        active=1,
        updated_at=CURRENT_TIMESTAMP`)
        .bind(contractId, anchor.label, anchor.lat, anchor.lon, anchor.confidence),
    );
  }
  if (statements.length) await db.batch(statements);
  return statements.length;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (x) => (x * Math.PI) / 180;
  const r = 6371;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function parseLatestValue(station) {
  const raw = station?.value;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!values.length) return null;
  const value = values[values.length - 1];
  const numeric = Number(value?.value);
  if (!Number.isFinite(numeric)) return null;
  let date = value?.date;
  if (typeof date === "number") date = new Date(date).toISOString();
  else if (typeof date === "string" && /^\d+$/.test(date)) date = new Date(Number(date)).toISOString();
  else if (date) date = new Date(date).toISOString();
  return { value: numeric, date: date || null, quality: value?.quality || null };
}

async function fetchSmhiParameter(parameter) {
  const url = `${SMHI_BASE}/parameter/${parameter.id}/station-set/all/period/latest-hour/data.json?measuringStations=all`;
  const response = await fetch(url, { headers: { "user-agent": "terranor-tracker/0.1" } });
  if (!response.ok) throw new Error(`SMHI parameter ${parameter.id} failed: ${response.status}`);
  const payload = await response.json();
  return { parameter, payload, url };
}

function mergeSmhiStations(datasets) {
  const map = new Map();
  for (const { parameter, payload } of datasets) {
    const stations = Array.isArray(payload?.station) ? payload.station : [];
    for (const station of stations) {
      const id = String(station?.key ?? "");
      const lat = Number(station?.latitude);
      const lon = Number(station?.longitude);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const entry = map.get(id) || {
        id,
        name: station?.name || id,
        lat,
        lon,
        values: {},
        dates: {},
        qualities: {},
      };
      const latest = parseLatestValue(station);
      if (latest) {
        entry.values[parameter.column] = latest.value;
        entry.dates[parameter.column] = latest.date;
        entry.qualities[parameter.column] = latest.quality;
      }
      map.set(id, entry);
    }
  }
  return map;
}

function completeness(station) {
  return ["air_temp_c", "wind_ms", "humidity_pct", "precipitation_mm"]
    .filter((field) => Number.isFinite(station?.values?.[field])).length;
}

function observationTime(station) {
  const timestamps = Object.values(station?.dates || {})
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  const ts = Math.max(...timestamps);
  const rounded = Math.floor(ts / 3600000) * 3600000;
  return new Date(rounded).toISOString();
}

async function linkNearestStations(db, stationMap) {
  const anchorsResult = await db.prepare(`SELECT a.id AS anchor_id, a.contract_id, a.label,
    a.latitude, a.longitude
    FROM weather_anchors a
    JOIN contracts c ON c.id=a.contract_id
    WHERE a.active=1 AND c.country='Sweden'`).all();
  const anchors = anchorsResult?.results || [];
  const stations = [...stationMap.values()].map((s) => ({ ...s, completeness: completeness(s) }));
  let linksWritten = 0;

  for (const anchor of anchors) {
    const ranked = stations
      .map((station) => {
        const distance = haversineKm(Number(anchor.latitude), Number(anchor.longitude), station.lat, station.lon);
        const penalty = (4 - station.completeness) * 20;
        return { station, distance, score: distance + penalty };
      })
      .filter((x) => x.station.completeness >= 2 && x.distance <= 150)
      .sort((a, b) => a.score - b.score)
      .slice(0, 2);

    await db.prepare("UPDATE weather_station_links SET active=0 WHERE anchor_id=? AND source='SMHI'")
      .bind(anchor.anchor_id).run();

    for (let i = 0; i < ranked.length; i += 1) {
      const { station, distance } = ranked[i];
      await db.prepare(`INSERT INTO weather_station_links (
        contract_id, anchor_id, source, station_id, station_name, latitude, longitude,
        distance_km, completeness, rank_no, active, linked_at
      ) VALUES (?, ?, 'SMHI', ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(anchor_id, source, station_id) DO UPDATE SET
        station_name=excluded.station_name,
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        distance_km=excluded.distance_km,
        completeness=excluded.completeness,
        rank_no=excluded.rank_no,
        active=1,
        linked_at=CURRENT_TIMESTAMP`)
        .bind(
          anchor.contract_id,
          anchor.anchor_id,
          station.id,
          station.name,
          station.lat,
          station.lon,
          Math.round(distance * 10) / 10,
          station.completeness,
          i + 1,
        ).run();
      linksWritten += 1;
    }
  }
  return linksWritten;
}

async function writeSmhiObservations(db, stationMap) {
  const links = await db.prepare("SELECT DISTINCT station_id FROM weather_station_links WHERE source='SMHI' AND active=1").all();
  const wanted = new Set((links?.results || []).map((r) => String(r.station_id)));
  let written = 0;

  for (const stationId of wanted) {
    const station = stationMap.get(stationId);
    if (!station) continue;
    const observedAt = observationTime(station);
    if (!observedAt) continue;
    const raw = JSON.stringify({
      stationName: station.name,
      latitude: station.lat,
      longitude: station.lon,
      dates: station.dates,
      qualities: station.qualities,
    });
    await db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES (NULL, 'SMHI', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      air_temp_c=excluded.air_temp_c,
      precipitation_mm=excluded.precipitation_mm,
      wind_ms=excluded.wind_ms,
      humidity_pct=excluded.humidity_pct,
      raw_json=excluded.raw_json`)
      .bind(
        station.id,
        observedAt,
        station.values.air_temp_c ?? null,
        station.values.precipitation_mm ?? null,
        station.values.wind_ms ?? null,
        station.values.humidity_pct ?? null,
        raw,
      ).run();
    written += 1;
  }
  return written;
}

export async function collectSmhiWeather(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureWeatherSchema(db);
  await seedWeatherAnchors(db);
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO weather_collection_runs (source, started_at, status)
    VALUES ('SMHI', ?, 'running') RETURNING id`).bind(startedAt).first();
  const runId = run?.id;

  try {
    const datasets = await Promise.all(SMHI_PARAMETERS.map(fetchSmhiParameter));
    const stationMap = mergeSmhiStations(datasets);
    const linksWritten = await linkNearestStations(db, stationMap);
    const observationsWritten = await writeSmhiObservations(db, stationMap);
    const finishedAt = new Date().toISOString();
    if (runId) {
      await db.prepare(`UPDATE weather_collection_runs SET finished_at=?, status='ok', stations_fetched=?,
        observations_written=?, links_written=? WHERE id=?`)
        .bind(finishedAt, stationMap.size, observationsWritten, linksWritten, runId).run();
    }
    return {
      ok: true,
      source: "SMHI",
      startedAt,
      finishedAt,
      stationsFetched: stationMap.size,
      linksWritten,
      observationsWritten,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (runId) {
      await db.prepare(`UPDATE weather_collection_runs SET finished_at=?, status='error', error_text=? WHERE id=?`)
        .bind(finishedAt, String(error?.message || error), runId).run();
    }
    throw error;
  }
}

export async function getWeatherStatus(db) {
  if (!db) return { configured: false };
  await ensureWeatherSchema(db);
  const [anchors, links, observations, latest, run] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM weather_anchors WHERE active=1").first(),
    db.prepare("SELECT COUNT(*) AS count FROM weather_station_links WHERE active=1").first(),
    db.prepare("SELECT COUNT(*) AS count FROM weather_observations WHERE source='SMHI'").first(),
    db.prepare("SELECT MAX(observed_at) AS observed_at FROM weather_observations WHERE source='SMHI'").first(),
    db.prepare("SELECT source, started_at, finished_at, status, stations_fetched, observations_written, links_written, error_text FROM weather_collection_runs ORDER BY id DESC LIMIT 1").first(),
  ]);
  return {
    configured: true,
    anchors: Number(anchors?.count || 0),
    activeStationLinks: Number(links?.count || 0),
    observations: Number(observations?.count || 0),
    latestObservation: latest?.observed_at || null,
    latestRun: run || null,
  };
}

export async function listWeatherContracts(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureWeatherSchema(db);
  const result = await db.prepare(`SELECT
      c.id AS contract_id,
      c.name AS contract_name,
      c.start_date,
      a.label AS anchor_label,
      a.latitude AS anchor_latitude,
      a.longitude AS anchor_longitude,
      l.station_id,
      l.station_name,
      l.distance_km,
      l.completeness,
      l.rank_no,
      MAX(w.observed_at) AS latest_observation,
      ROUND(AVG(CASE WHEN w.observed_at >= datetime('now','-24 hours') THEN w.air_temp_c END), 1) AS avg_temp_24h,
      ROUND(SUM(CASE WHEN w.observed_at >= datetime('now','-24 hours') THEN COALESCE(w.precipitation_mm,0) ELSE 0 END), 1) AS precipitation_24h,
      ROUND(AVG(CASE WHEN w.observed_at >= datetime('now','-24 hours') THEN w.wind_ms END), 1) AS avg_wind_24h,
      COUNT(CASE WHEN w.observed_at >= datetime('now','-24 hours') THEN 1 END) AS observations_24h
    FROM weather_station_links l
    JOIN contracts c ON c.id=l.contract_id
    JOIN weather_anchors a ON a.id=l.anchor_id
    LEFT JOIN weather_observations w ON w.source=l.source AND w.station_id=l.station_id
    WHERE l.source='SMHI' AND l.active=1
    GROUP BY c.id, c.name, c.start_date, a.label, a.latitude, a.longitude,
      l.station_id, l.station_name, l.distance_km, l.completeness, l.rank_no
    ORDER BY c.name, l.rank_no`).all();
  return result?.results || [];
}
