import { ensureNordicSchema } from "./nordic.js";

const DMI_STATIONS_URL = "https://opendataapi.dmi.dk/v2/metObs/collections/station/items";
const DMI_OBS_URL = "https://opendataapi.dmi.dk/v2/metObs/collections/observation/items";

const DMI_SPECS = [
  ["temp_dry", "air_temp_c"],
  ["wind_speed", "wind_ms"],
  ["humidity", "humidity_pct"],
  ["precip_past1h", "precipitation_mm"],
];
const REQUIRED_PARAMETERS = DMI_SPECS.map(([parameter]) => parameter);

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function rad(value) { return Number(value) * Math.PI / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchDmiStations() {
  const params = new URLSearchParams({
    bbox: "7.5,54.4,13.2,57.9",
    status: "Active",
    datetime: new Date().toISOString(),
    limit: "1000",
  });
  const response = await fetch(`${DMI_STATIONS_URL}?${params.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/0.8" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DMI-stasjoner feilet: ${response.status} ${body.slice(0, 240)}`);
  }
  const payload = await response.json();
  const map = new Map();
  for (const feature of payload?.features || []) {
    const p = feature?.properties || {};
    const coords = feature?.geometry?.coordinates || [];
    const stationId = String(p.stationId || p.stationid || p.id || feature.id || "");
    const parameterIds = Array.isArray(p.parameterId) ? p.parameterId.map(String) : [];
    const row = {
      station_id: stationId,
      station_name: p.name || p.stationName || p.stationname || stationId || "Ukjent DMI-stasjon",
      longitude: numeric(coords[0]),
      latitude: numeric(coords[1]),
      parameter_ids: parameterIds,
      station_type: p.type || null,
    };
    if (!row.station_id || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) continue;
    const old = map.get(row.station_id);
    if (!old || row.parameter_ids.length > old.parameter_ids.length) map.set(row.station_id, row);
  }
  return [...map.values()];
}

function supportsRequiredParameters(station) {
  const available = new Set(station.parameter_ids || []);
  return REQUIRED_PARAMETERS.every((parameter) => available.has(parameter));
}

function nearestDmiStation(target, stations) {
  const suitable = stations.filter(supportsRequiredParameters);
  let best = null;
  for (const station of suitable) {
    const distance = haversineKm(target.latitude, target.longitude, station.latitude, station.longitude);
    if (!best || distance < best.distance_km) best = { ...station, distance_km: distance };
  }
  return best;
}

async function fetchDmiParameter(stationId, parameterId, startIso, endIso) {
  const params = new URLSearchParams({
    datetime: `${startIso}/${endIso}`,
    limit: "500",
    stationId: String(stationId),
    parameterId,
    sortorder: "observed,ASC",
  });
  const response = await fetch(`${DMI_OBS_URL}?${params.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/0.8" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DMI ${stationId}/${parameterId} feilet: ${response.status} ${body.slice(0, 220)}`);
  }
  return response.json();
}

async function upsertObservation(db, row) {
  await db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES (?, 'DMI', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      contract_id=COALESCE(excluded.contract_id, weather_observations.contract_id),
      air_temp_c=COALESCE(excluded.air_temp_c, weather_observations.air_temp_c),
      precipitation_mm=COALESCE(excluded.precipitation_mm, weather_observations.precipitation_mm),
      wind_ms=COALESCE(excluded.wind_ms, weather_observations.wind_ms),
      humidity_pct=COALESCE(excluded.humidity_pct, weather_observations.humidity_pct),
      raw_json=excluded.raw_json`)
    .bind(row.contract_id || null, String(row.station_id), row.observed_at,
      row.air_temp_c, row.precipitation_mm, row.wind_ms, row.humidity_pct,
      JSON.stringify(row.raw || {})).run();
  return 1;
}

async function collectTarget(db, target, station) {
  const end = new Date();
  const start = new Date(end.getTime() - 26 * 3600000);
  const rows = new Map();
  const parameterCounts = {};

  for (const [parameter, field] of DMI_SPECS) {
    const dataset = await fetchDmiParameter(station.station_id, parameter, start.toISOString(), end.toISOString());
    let count = 0;
    for (const feature of dataset?.features || []) {
      const p = feature?.properties || {};
      const observed = p.observed && Number.isFinite(Date.parse(p.observed)) ? new Date(p.observed).toISOString() : null;
      const value = numeric(p.value);
      if (!observed || value === null) continue;
      count += 1;
      const row = rows.get(observed) || {
        contract_id: target.contract_id,
        station_id: station.station_id,
        observed_at: observed,
        air_temp_c: null,
        precipitation_mm: null,
        wind_ms: null,
        humidity_pct: null,
        raw: { location: target.label, stationName: station.station_name, parameters: {} },
      };
      row[field] = field === "precipitation_mm" && value < 0 ? 0 : value;
      row.raw.parameters[parameter] = { value, qcStatus: p.qcStatus || null };
      rows.set(observed, row);
    }
    parameterCounts[parameter] = count;
  }

  let written = 0;
  for (const row of rows.values()) written += await upsertObservation(db, row);
  return { written, rows: rows.size, parameterCounts };
}

export async function runDmiWeather(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO nordic_weather_runs (source, started_at, status)
    VALUES ('DMI', ?, 'running') RETURNING id`).bind(startedAt).first();
  const result = { attempted: 0, completed: 0, written: 0, details: [] };

  try {
    const stations = await fetchDmiStations();
    const suitableCount = stations.filter(supportsRequiredParameters).length;
    const targetResult = await db.prepare(`SELECT * FROM nordic_weather_targets WHERE active=1 AND source='DMI' ORDER BY id`).all();

    for (const target of targetResult?.results || []) {
      result.attempted += 1;
      try {
        const station = nearestDmiStation(target, stations);
        if (!station || station.distance_km > 120) {
          throw new Error(`Ingen aktiv DMI-stasjon med temperatur, vind, luftfuktighet og nedbør innen 120 km`);
        }
        await db.prepare(`UPDATE nordic_weather_targets SET station_id=?, station_name=?, distance_km=?,
            last_linked_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(station.station_id, station.station_name, round(station.distance_km, 2), new Date().toISOString(), target.id).run();

        const collected = await collectTarget(db, target, station);
        result.completed += 1;
        result.written += collected.written;
        result.details.push({
          label: target.label,
          station_id: station.station_id,
          station_name: station.station_name,
          station_type: station.station_type,
          distance_km: round(station.distance_km, 1),
          observations_written: collected.written,
          parameter_counts: collected.parameterCounts,
          status: "ok",
        });
      } catch (error) {
        result.details.push({ label: target.label, status: "feil", error: String(error?.message || error) });
      }
    }

    const finishedAt = new Date().toISOString();
    const status = result.completed === result.attempted ? "ok" : result.completed > 0 ? "partial" : "error";
    if (run?.id) {
      await db.prepare(`UPDATE nordic_weather_runs SET finished_at=?, status=?, targets_attempted=?,
          targets_completed=?, observations_written=?, error_text=? WHERE id=?`)
        .bind(finishedAt, status, result.attempted, result.completed, result.written,
          status === "ok" ? null : `Kun ${result.completed}/${result.attempted} danske værankere ble hentet`, run.id).run();
    }
    return {
      ...result,
      source: "DMI",
      startedAt,
      finishedAt,
      ok: status === "ok",
      stationCandidates: stations.length,
      fullyEquippedStations: suitableCount,
      method: "Nærmeste aktive DMI-stasjon som eksplisitt oppgir støtte for temperatur, vind, luftfuktighet og timesnedbør.",
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (run?.id) {
      await db.prepare(`UPDATE nordic_weather_runs SET finished_at=?, status='error', targets_attempted=?,
          targets_completed=?, observations_written=?, error_text=? WHERE id=?`)
        .bind(finishedAt, result.attempted, result.completed, result.written,
          String(error?.message || error).slice(0, 1800), run.id).run();
    }
    throw error;
  }
}
