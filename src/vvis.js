const TRAFIKVERKET_ENDPOINT = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const SOURCE = "VVIS";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildQuery(apiKey, objectType, schemaVersion = "2.1", limit = 3) {
  return `<REQUEST>\n  <LOGIN authenticationkey="${xmlEscape(apiKey)}" />\n  <QUERY objecttype="${objectType}" schemaversion="${schemaVersion}" limit="${limit}" />\n</REQUEST>`;
}

async function postQuery(apiKey, objectType, schemaVersion = "2.1", limit = 3) {
  if (!apiKey) throw new Error("TRAFIKVERKET_API_KEY is missing");
  const response = await fetch(TRAFIKVERKET_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      accept: "application/json",
      "user-agent": "terranor-tracker/0.2",
    },
    body: buildQuery(apiKey, objectType, schemaVersion, limit),
  });

  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok) throw new Error(`Trafikverket ${objectType} HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (!payload) throw new Error(`Trafikverket ${objectType} returned non-JSON response: ${text.slice(0, 500)}`);
  const apiError = findApiError(payload);
  if (apiError) throw new Error(`Trafikverket ${objectType} API error: ${apiError}`);
  return payload;
}

function findApiError(payload) {
  const results = payload?.RESPONSE?.RESULT;
  const list = Array.isArray(results) ? results : results ? [results] : [];
  for (const result of list) if (result?.ERROR) return JSON.stringify(result.ERROR);
  return null;
}

function extractItems(payload, objectType) {
  const results = payload?.RESPONSE?.RESULT;
  const list = Array.isArray(results) ? results : results ? [results] : [];
  const items = [];
  for (const result of list) {
    const value = result?.[objectType];
    if (Array.isArray(value)) items.push(...value);
    else if (value) items.push(value);
  }
  return items;
}

function describeShape(value, depth = 0) {
  if (depth > 4) return "…";
  if (value === null) return null;
  if (Array.isArray(value)) return value.length ? [describeShape(value[0], depth + 1)] : [];
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) out[key] = describeShape(child, depth + 1);
    return out;
  }
  return typeof value;
}

function sanitizeSample(value, depth = 0) {
  if (depth > 5) return "…";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 2).map((item) => sanitizeSample(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) out[key] = sanitizeSample(child, depth + 1);
    return out;
  }
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  return value;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePoint(wgs84) {
  const match = String(wgs84 || "").match(/POINT\s*\(\s*([-+0-9.]+)\s+([-+0-9.]+)\s*\)/i);
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (x) => (x * Math.PI) / 180;
  const r = 6371;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function windSpeed(obs) {
  const avg10 = numberOrNull(obs?.Aggregated10minutes?.Wind?.SpeedAverage?.Value);
  if (avg10 !== null) return avg10;
  const avg30 = numberOrNull(obs?.Aggregated30minutes?.Wind?.SpeedAverage?.Value);
  if (avg30 !== null) return avg30;
  const winds = Array.isArray(obs?.Wind) ? obs.Wind : [];
  return numberOrNull(winds[0]?.Speed?.Value);
}

function precipAmount(obs) {
  const p30 = numberOrNull(obs?.Aggregated30minutes?.Precipitation?.TotalWaterEquivalent?.Value);
  if (p30 !== null) return p30;
  const p10 = numberOrNull(obs?.Aggregated10minutes?.Precipitation?.TotalWaterEquivalent?.Value);
  if (p10 !== null) return p10;
  return numberOrNull(obs?.Aggregated5minutes?.Precipitation?.TotalWaterEquivalent?.Value);
}

function precipType(obs) {
  const direct = String(obs?.Weather?.Precipitation || "").trim();
  if (direct) return direct;
  const p = obs?.Aggregated10minutes?.Precipitation || obs?.Aggregated30minutes?.Precipitation || {};
  if (p?.Snow && p?.Rain) return "rain+snow";
  if (p?.Snow) return "snow";
  if (p?.Rain) return "rain";
  return "no";
}

function stationCompleteness(item) {
  const obs = item?.Observation || {};
  const fields = [
    obs?.Surface?.Temperature?.Value,
    obs?.Air?.Temperature?.Value,
    obs?.Air?.RelativeHumidity?.Value,
    windSpeed(obs),
    precipAmount(obs),
  ];
  return fields.filter((v) => numberOrNull(v) !== null).length;
}

function normalizeMeasurepoint(item) {
  const point = parsePoint(item?.Geometry?.WGS84);
  if (!point || !item?.Id) return null;
  return {
    id: String(item.Id),
    name: item?.Name || String(item.Id),
    lat: point.lat,
    lon: point.lon,
    observation: item?.Observation || null,
    completeness: stationCompleteness(item),
    modifiedTime: item?.ModifiedTime || null,
  };
}

async function fetchMeasurepoints(apiKey) {
  const payload = await postQuery(apiKey, "WeatherMeasurepoint", "2.1", 1000);
  return extractItems(payload, "WeatherMeasurepoint")
    .map(normalizeMeasurepoint)
    .filter(Boolean);
}

async function linkNearestVvisStations(db, stations) {
  const anchorsResult = await db.prepare(`SELECT a.id AS anchor_id, a.contract_id, a.label, a.latitude, a.longitude
    FROM weather_anchors a
    JOIN contracts c ON c.id=a.contract_id
    WHERE a.active=1 AND c.country='Sweden'`).all();
  const anchors = anchorsResult?.results || [];
  let linksWritten = 0;

  for (const anchor of anchors) {
    const ranked = stations
      .map((station) => {
        const distance = haversineKm(Number(anchor.latitude), Number(anchor.longitude), station.lat, station.lon);
        const penalty = Math.max(0, 4 - station.completeness) * 8;
        return { station, distance, score: distance + penalty };
      })
      .filter((x) => x.distance <= 120 && x.station.completeness >= 3)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);

    await db.prepare("UPDATE weather_station_links SET active=0 WHERE anchor_id=? AND source=?")
      .bind(anchor.anchor_id, SOURCE).run();

    for (let i = 0; i < ranked.length; i += 1) {
      const { station, distance } = ranked[i];
      await db.prepare(`INSERT INTO weather_station_links (
        contract_id, anchor_id, source, station_id, station_name, latitude, longitude,
        distance_km, completeness, rank_no, active, linked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(anchor_id, source, station_id) DO UPDATE SET
        station_name=excluded.station_name,
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        distance_km=excluded.distance_km,
        completeness=excluded.completeness,
        rank_no=excluded.rank_no,
        active=1,
        linked_at=CURRENT_TIMESTAMP`)
        .bind(anchor.contract_id, anchor.anchor_id, SOURCE, station.id, station.name, station.lat, station.lon,
          Math.round(distance * 10) / 10, station.completeness, i + 1).run();
      linksWritten += 1;
    }
  }
  return linksWritten;
}

async function writeCurrentVvisObservations(db, stations) {
  const links = await db.prepare("SELECT DISTINCT station_id FROM weather_station_links WHERE source=? AND active=1")
    .bind(SOURCE).all();
  const wanted = new Set((links?.results || []).map((r) => String(r.station_id)));
  const map = new Map(stations.map((s) => [s.id, s]));
  let written = 0;

  for (const stationId of wanted) {
    const station = map.get(stationId);
    const obs = station?.observation;
    if (!station || !obs?.Sample) continue;
    const observedAt = new Date(obs.Sample).toISOString();
    const raw = JSON.stringify({
      stationName: station.name,
      latitude: station.lat,
      longitude: station.lon,
      modifiedTime: station.modifiedTime,
      observation: obs,
    });

    await db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      air_temp_c=excluded.air_temp_c,
      road_temp_c=excluded.road_temp_c,
      precipitation_mm=excluded.precipitation_mm,
      precipitation_type=excluded.precipitation_type,
      wind_ms=excluded.wind_ms,
      humidity_pct=excluded.humidity_pct,
      raw_json=excluded.raw_json`)
      .bind(
        SOURCE,
        station.id,
        observedAt,
        numberOrNull(obs?.Air?.Temperature?.Value),
        numberOrNull(obs?.Surface?.Temperature?.Value),
        precipAmount(obs),
        precipType(obs),
        windSpeed(obs),
        numberOrNull(obs?.Air?.RelativeHumidity?.Value),
        raw,
      ).run();
    written += 1;
  }
  return written;
}

export async function collectVvisWeather(db, apiKey) {
  if (!db) throw new Error("D1 binding DB is missing");
  if (!apiKey) throw new Error("TRAFIKVERKET_API_KEY is missing");
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO weather_collection_runs (source, started_at, status)
    VALUES (?, ?, 'running') RETURNING id`).bind(SOURCE, startedAt).first();
  const runId = run?.id;

  try {
    const stations = await fetchMeasurepoints(apiKey);
    const linksWritten = await linkNearestVvisStations(db, stations);
    const observationsWritten = await writeCurrentVvisObservations(db, stations);
    const finishedAt = new Date().toISOString();
    if (runId) {
      await db.prepare(`UPDATE weather_collection_runs SET finished_at=?, status='ok', stations_fetched=?,
        observations_written=?, links_written=? WHERE id=?`)
        .bind(finishedAt, stations.length, observationsWritten, linksWritten, runId).run();
    }
    return { ok: true, source: SOURCE, startedAt, finishedAt, stationsFetched: stations.length, linksWritten, observationsWritten };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (runId) {
      await db.prepare(`UPDATE weather_collection_runs SET finished_at=?, status='error', error_text=? WHERE id=?`)
        .bind(finishedAt, String(error?.message || error).slice(0, 2000), runId).run();
    }
    throw error;
  }
}

export async function getVvisStatus(db) {
  const [links, observations, latest, latestRun] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM weather_station_links WHERE source=? AND active=1").bind(SOURCE).first(),
    db.prepare("SELECT COUNT(*) AS count FROM weather_observations WHERE source=?").bind(SOURCE).first(),
    db.prepare("SELECT MAX(observed_at) AS latest FROM weather_observations WHERE source=?").bind(SOURCE).first(),
    db.prepare(`SELECT source, started_at, finished_at, status, stations_fetched, observations_written, links_written, error_text
      FROM weather_collection_runs WHERE source=? ORDER BY id DESC LIMIT 1`).bind(SOURCE).first(),
  ]);
  return {
    configured: true,
    activeStationLinks: Number(links?.count || 0),
    observations: Number(observations?.count || 0),
    latestObservation: latest?.latest || null,
    latestRun: latestRun || null,
  };
}

export async function listVvisContracts(db) {
  const result = await db.prepare(`SELECT
      c.id AS contract_id, c.name AS contract_name, c.start_date,
      a.label AS anchor_label, a.latitude AS anchor_latitude, a.longitude AS anchor_longitude,
      l.station_id, l.station_name, l.distance_km, l.completeness, l.rank_no,
      MAX(o.observed_at) AS latest_observation,
      ROUND(AVG(CASE WHEN o.observed_at >= datetime('now','-24 hours') THEN o.air_temp_c END),1) AS avg_air_temp_24h,
      ROUND(AVG(CASE WHEN o.observed_at >= datetime('now','-24 hours') THEN o.road_temp_c END),1) AS avg_road_temp_24h,
      ROUND(AVG(CASE WHEN o.observed_at >= datetime('now','-24 hours') THEN o.wind_ms END),1) AS avg_wind_24h,
      SUM(CASE WHEN o.observed_at >= datetime('now','-24 hours') AND LOWER(COALESCE(o.precipitation_type,'')) NOT IN ('','no','none') THEN 1 ELSE 0 END) AS precip_observations_24h,
      SUM(CASE WHEN o.observed_at >= datetime('now','-24 hours') AND LOWER(COALESCE(o.precipitation_type,'')) LIKE '%snow%' THEN 1 ELSE 0 END) AS snow_observations_24h,
      COUNT(CASE WHEN o.observed_at >= datetime('now','-24 hours') THEN 1 END) AS observations_24h
    FROM weather_station_links l
    JOIN weather_anchors a ON a.id=l.anchor_id
    JOIN contracts c ON c.id=l.contract_id
    LEFT JOIN weather_observations o ON o.source=l.source AND o.station_id=l.station_id
    WHERE l.source=? AND l.active=1
    GROUP BY c.id, c.name, c.start_date, a.label, a.latitude, a.longitude,
      l.station_id, l.station_name, l.distance_km, l.completeness, l.rank_no
    ORDER BY c.name, l.rank_no`).bind(SOURCE).all();
  return result?.results || [];
}

export async function probeTrafikverket(apiKey) {
  const objects = [
    { objectType: "WeatherMeasurepoint", schemaVersion: "2.1", limit: 2 },
    { objectType: "WeatherObservation", schemaVersion: "2.1", limit: 2 },
  ];
  const probes = [];
  for (const item of objects) {
    try {
      const payload = await postQuery(apiKey, item.objectType, item.schemaVersion, item.limit);
      const rows = extractItems(payload, item.objectType);
      probes.push({
        ok: true,
        objectType: item.objectType,
        schemaVersion: item.schemaVersion,
        count: rows.length,
        responseKeys: Object.keys(payload?.RESPONSE || {}),
        resultKeys: Object.keys((Array.isArray(payload?.RESPONSE?.RESULT) ? payload.RESPONSE.RESULT[0] : payload?.RESPONSE?.RESULT) || {}),
        shape: rows.length ? describeShape(rows[0]) : null,
        sample: rows.length ? sanitizeSample(rows[0]) : null,
      });
    } catch (error) {
      probes.push({ ok: false, objectType: item.objectType, schemaVersion: item.schemaVersion, error: String(error?.message || error) });
    }
  }
  return { ok: probes.some((p) => p.ok), endpoint: TRAFIKVERKET_ENDPOINT, probes, note: "Probe returns public weather-data structure only. API key is never returned." };
}
