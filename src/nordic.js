const DMI_STATIONS_URL = "https://opendataapi.dmi.dk/v2/metObs/collections/station/items";
const DMI_OBS_URL = "https://opendataapi.dmi.dk/v2/metObs/collections/observation/items";
const FMI_WFS_URL = "https://opendata.fmi.fi/wfs";

const TARGETS = [
  {
    country: "Denmark",
    label: "Ikast-Brande",
    contractName: "Ikast-Brande",
    locationName: "Ikast-Brande",
    latitude: 56.1386,
    longitude: 9.1577,
    confidence: "high",
    notes: "Kommunal kontrakt med oppstart 1. juli 2026. By-/kommune-koordinat brukes som væranker.",
  },
  {
    country: "Denmark",
    label: "Tønder",
    contractName: "Tønder",
    locationName: "Tønder",
    latitude: 54.9331,
    longitude: 8.8667,
    confidence: "high-location",
    notes: "Kjent kommunal kontrakt fra nowcast-grunnlaget. Kontrakten finnes ikke nødvendigvis som egen rad i databasen ennå.",
  },
  {
    country: "Denmark",
    label: "København",
    contractName: "Denmark Copenhagen sweeping",
    locationName: "København",
    latitude: 55.6761,
    longitude: 12.5683,
    confidence: "high-location",
    notes: "Kontrakten starter i 2027, men datainnsamling bygges opp på forhånd.",
  },
  {
    country: "Finland",
    label: "Kemi",
    contractName: "Kemi",
    locationName: "Kemi",
    latitude: 65.7362,
    longitude: 24.5637,
    confidence: "high-location",
    notes: "Kjent statlig kontrakt med oppstart 1. oktober 2026.",
  },
  {
    country: "Finland",
    label: "Ii",
    contractName: "Ii",
    locationName: "Ii",
    latitude: 65.3170,
    longitude: 25.3731,
    confidence: "high-location",
    notes: "Kjent statlig kontrakt med oppstart 1. oktober 2026.",
  },
  {
    country: "Finland",
    label: "Sørøst-Finland drenering",
    contractName: "Road drainage South-East Finland",
    locationName: "Lappeenranta",
    latitude: 61.0587,
    longitude: 28.1887,
    confidence: "regional-proxy",
    notes: "Regional proxy for kjent dreneringsarbeid i Sørøst-Finland. Skal ikke tolkes som eksakt kontraktsgeografi.",
  },
];

const NORDIC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nordic_weather_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL,
    label TEXT NOT NULL,
    contract_name TEXT,
    contract_id INTEGER,
    location_name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    source TEXT NOT NULL,
    station_id TEXT,
    station_name TEXT,
    distance_km REAL,
    confidence TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_linked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country, label, source),
    FOREIGN KEY (contract_id) REFERENCES contracts(id)
  )`,
  `CREATE TABLE IF NOT EXISTS nordic_weather_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    targets_attempted INTEGER DEFAULT 0,
    targets_completed INTEGER DEFAULT 0,
    observations_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nordic_targets_source ON nordic_weather_targets(source, active)`,
  `CREATE INDEX IF NOT EXISTS idx_nordic_runs_source_time ON nordic_weather_runs(source, started_at)`,
];

export async function ensureNordicSchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await db.batch(NORDIC_SCHEMA.map((sql) => db.prepare(sql)));
  await seedTargets(db);
}

function rad(value) { return Number(value) * Math.PI / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function xmlDecode(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

async function resolveContractId(db, target) {
  const exact = await db.prepare(`SELECT id FROM contracts WHERE country=? AND name=? LIMIT 1`)
    .bind(target.country, target.contractName).first();
  if (exact?.id) return Number(exact.id);
  const fuzzy = await db.prepare(`SELECT id FROM contracts WHERE country=? AND (name LIKE ? OR ? LIKE '%' || name || '%') ORDER BY LENGTH(name) DESC LIMIT 1`)
    .bind(target.country, `%${target.contractName}%`, target.contractName).first();
  return fuzzy?.id ? Number(fuzzy.id) : null;
}

async function seedTargets(db) {
  for (const target of TARGETS) {
    const source = target.country === "Denmark" ? "DMI" : "FMI";
    const contractId = await resolveContractId(db, target);
    await db.prepare(`INSERT INTO nordic_weather_targets (
        country, label, contract_name, contract_id, location_name, latitude, longitude,
        source, confidence, notes, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(country, label, source) DO UPDATE SET
        contract_name=excluded.contract_name,
        contract_id=COALESCE(excluded.contract_id, nordic_weather_targets.contract_id),
        location_name=excluded.location_name,
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        confidence=excluded.confidence,
        notes=excluded.notes,
        active=1,
        updated_at=CURRENT_TIMESTAMP`)
      .bind(target.country, target.label, target.contractName, contractId, target.locationName,
        target.latitude, target.longitude, source, target.confidence, target.notes).run();
  }
}

async function startRun(db, source) {
  const startedAt = new Date().toISOString();
  const row = await db.prepare(`INSERT INTO nordic_weather_runs (source, started_at, status)
    VALUES (?, ?, 'running') RETURNING id`).bind(source, startedAt).first();
  return { id: row?.id, startedAt };
}

async function finishRun(db, run, source, result, error = null) {
  const finishedAt = new Date().toISOString();
  if (run.id) {
    await db.prepare(`UPDATE nordic_weather_runs SET finished_at=?, status=?, targets_attempted=?,
      targets_completed=?, observations_written=?, error_text=? WHERE id=?`)
      .bind(finishedAt, error ? "error" : "ok", result.attempted || 0, result.completed || 0,
        result.written || 0, error ? String(error?.message || error).slice(0, 1800) : null, run.id).run();
  }
  return { ...result, source, startedAt: run.startedAt, finishedAt, ok: !error };
}

async function upsertObservation(db, row) {
  if (!row.station_id || !row.observed_at) return 0;
  await db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      contract_id=COALESCE(excluded.contract_id, weather_observations.contract_id),
      air_temp_c=COALESCE(excluded.air_temp_c, weather_observations.air_temp_c),
      precipitation_mm=COALESCE(excluded.precipitation_mm, weather_observations.precipitation_mm),
      wind_ms=COALESCE(excluded.wind_ms, weather_observations.wind_ms),
      humidity_pct=COALESCE(excluded.humidity_pct, weather_observations.humidity_pct),
      raw_json=excluded.raw_json`)
    .bind(row.contract_id || null, row.source, String(row.station_id), row.observed_at,
      row.air_temp_c, row.precipitation_mm, row.wind_ms, row.humidity_pct,
      JSON.stringify(row.raw || {})).run();
  return 1;
}

// ---- Denmark / DMI ---------------------------------------------------------

async function fetchDmiStations() {
  const url = `${DMI_STATIONS_URL}?bbox=7.5,54.4,13.2,57.9&status=Active&limit=1000`;
  const response = await fetch(url, { headers: { "user-agent": "Terranor-Tracker/0.7" } });
  if (!response.ok) throw new Error(`DMI-stasjoner feilet: ${response.status}`);
  const payload = await response.json();
  return (payload?.features || []).map((feature) => {
    const p = feature?.properties || {};
    const coords = feature?.geometry?.coordinates || [];
    return {
      station_id: String(p.stationId || p.stationid || p.id || feature.id || ""),
      station_name: p.name || p.stationName || p.stationname || p.stationId || feature.id || "Ukjent DMI-stasjon",
      longitude: numeric(coords[0]),
      latitude: numeric(coords[1]),
    };
  }).filter((x) => x.station_id && Number.isFinite(x.latitude) && Number.isFinite(x.longitude));
}

function nearestDmiStation(target, stations) {
  let best = null;
  for (const station of stations) {
    const distance = haversineKm(target.latitude, target.longitude, station.latitude, station.longitude);
    if (!best || distance < best.distance_km) best = { ...station, distance_km: distance };
  }
  return best;
}

async function linkDmiTarget(db, target, station) {
  await db.prepare(`UPDATE nordic_weather_targets SET station_id=?, station_name=?, distance_km=?,
      last_linked_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(station.station_id, station.station_name, round(station.distance_km, 2), new Date().toISOString(), target.id).run();
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
    headers: { "user-agent": "Terranor-Tracker/0.7" },
  });
  if (!response.ok) throw new Error(`DMI ${stationId}/${parameterId} feilet: ${response.status}`);
  return response.json();
}

async function collectDmiTarget(db, target) {
  if (!target.station_id) throw new Error(`DMI-stasjon mangler for ${target.label}`);
  const end = new Date();
  const start = new Date(end.getTime() - 26 * 3600000);
  const specs = [
    ["temp_dry", "air_temp_c"],
    ["wind_speed", "wind_ms"],
    ["humidity", "humidity_pct"],
    ["precip_past1h", "precipitation_mm"],
  ];
  const datasets = await Promise.all(specs.map(([parameter]) =>
    fetchDmiParameter(target.station_id, parameter, start.toISOString(), end.toISOString())));
  const rows = new Map();
  for (let i = 0; i < specs.length; i += 1) {
    const [parameter, field] = specs[i];
    for (const feature of datasets[i]?.features || []) {
      const p = feature?.properties || {};
      const observed = p.observed && Number.isFinite(Date.parse(p.observed)) ? new Date(p.observed).toISOString() : null;
      const value = numeric(p.value);
      if (!observed || value === null) continue;
      const key = observed;
      const row = rows.get(key) || {
        contract_id: target.contract_id,
        source: "DMI",
        station_id: String(target.station_id),
        observed_at: observed,
        air_temp_c: null,
        precipitation_mm: null,
        wind_ms: null,
        humidity_pct: null,
        raw: { location: target.label, parameters: {} },
      };
      // DMI uses -0.1 for trace precipitation below 0.1 mm.
      row[field] = field === "precipitation_mm" && value < 0 ? 0 : value;
      row.raw.parameters[parameter] = { value, qcStatus: p.qcStatus || null };
      rows.set(key, row);
    }
  }
  let written = 0;
  for (const row of rows.values()) written += await upsertObservation(db, row);
  return { written, rows: rows.size };
}

async function collectDmi(db) {
  const run = await startRun(db, "DMI");
  const result = { attempted: 0, completed: 0, written: 0, details: [] };
  try {
    const stations = await fetchDmiStations();
    const targetResult = await db.prepare(`SELECT * FROM nordic_weather_targets WHERE active=1 AND source='DMI' ORDER BY id`).all();
    const targets = targetResult?.results || [];
    for (const target of targets) {
      result.attempted += 1;
      try {
        const station = nearestDmiStation(target, stations);
        if (!station || station.distance_km > 120) throw new Error("Ingen egnet DMI-stasjon innen 120 km");
        await linkDmiTarget(db, target, station);
        target.station_id = station.station_id;
        target.station_name = station.station_name;
        target.distance_km = station.distance_km;
        const collected = await collectDmiTarget(db, target);
        result.completed += 1;
        result.written += collected.written;
        result.details.push({ label: target.label, station_id: station.station_id, station_name: station.station_name,
          distance_km: round(station.distance_km, 1), observations_written: collected.written, status: "ok" });
      } catch (error) {
        result.details.push({ label: target.label, status: "feil", error: String(error?.message || error) });
      }
    }
    return await finishRun(db, run, "DMI", result);
  } catch (error) {
    await finishRun(db, run, "DMI", result, error);
    throw error;
  }
}

// ---- Finland / FMI ---------------------------------------------------------

function fmiParameterFromMember(member) {
  const href = member.match(/observedProperty[^>]+(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] || "";
  const name = member.match(/<gml:name[^>]*>([\s\S]*?)<\/gml:name>/i)?.[1] || "";
  const text = `${href} ${xmlDecode(name)}`.toLowerCase();
  if (/precip/.test(text)) return "precipitation_mm";
  if (/windspeed|wind speed|ws_10min/.test(text)) return "wind_ms";
  if (/humidity|relative humidity|\brh\b/.test(text)) return "humidity_pct";
  if (/temperature|\bt2m\b/.test(text)) return "air_temp_c";
  return null;
}

function parseFmiTimeValuePair(xml, fallbackStationId, fallbackName) {
  const rows = new Map();
  const members = String(xml || "").split(/<wfs:member\b/i).slice(1);
  let detectedStationId = null;
  let detectedStationName = null;

  for (const memberRaw of members) {
    const member = `<wfs:member ${memberRaw}`;
    const field = fmiParameterFromMember(member);
    if (!field) continue;
    const identifier = member.match(/<gml:identifier[^>]*>([^<]+)<\/gml:identifier>/i)?.[1];
    const stationName = member.match(/<gml:name[^>]*>([^<]+)<\/gml:name>/i)?.[1];
    if (identifier) detectedStationId = xmlDecode(identifier).trim();
    if (stationName) detectedStationName = xmlDecode(stationName).trim();

    const pairRe = /<wml2:MeasurementTVP[^>]*>[\s\S]*?<wml2:time>([^<]+)<\/wml2:time>[\s\S]*?<wml2:value[^>]*>([^<]*)<\/wml2:value>[\s\S]*?<\/wml2:MeasurementTVP>/gi;
    let match;
    while ((match = pairRe.exec(member))) {
      const observed = Number.isFinite(Date.parse(match[1])) ? new Date(match[1]).toISOString() : null;
      const value = numeric(match[2]);
      if (!observed || value === null) continue;
      const row = rows.get(observed) || {
        observed_at: observed,
        air_temp_c: null,
        precipitation_mm: null,
        wind_ms: null,
        humidity_pct: null,
        raw: { fmi: true },
      };
      row[field] = value;
      rows.set(observed, row);
    }
  }
  return {
    station_id: detectedStationId || fallbackStationId,
    station_name: detectedStationName || fallbackName,
    rows: [...rows.values()],
  };
}

async function fetchFmiTarget(target) {
  const end = new Date();
  const start = new Date(end.getTime() - 26 * 3600000);
  start.setUTCMinutes(0, 0, 0);
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "getFeature",
    storedquery_id: "fmi::observations::weather::timevaluepair",
    place: target.location_name,
    starttime: start.toISOString(),
    endtime: end.toISOString(),
    timestep: "60",
    parameters: "temperature,windspeedms,humidity,precipitation1h",
  });
  const response = await fetch(`${FMI_WFS_URL}?${params.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/0.7", "accept": "application/xml,text/xml" },
  });
  if (!response.ok) throw new Error(`FMI ${target.location_name} feilet: ${response.status}`);
  const xml = await response.text();
  if (/ExceptionReport|ExceptionText/i.test(xml)) {
    const message = xml.match(/<[^>]*ExceptionText[^>]*>([\s\S]*?)<\/[^>]*ExceptionText>/i)?.[1];
    throw new Error(`FMI svarte med feil: ${xmlDecode(message || "ukjent WFS-feil").trim()}`);
  }
  return parseFmiTimeValuePair(xml, `place:${target.location_name}`, target.location_name);
}

async function collectFmi(db) {
  const run = await startRun(db, "FMI");
  const result = { attempted: 0, completed: 0, written: 0, details: [] };
  try {
    const targetResult = await db.prepare(`SELECT * FROM nordic_weather_targets WHERE active=1 AND source='FMI' ORDER BY id`).all();
    for (const target of targetResult?.results || []) {
      result.attempted += 1;
      try {
        const parsed = await fetchFmiTarget(target);
        await db.prepare(`UPDATE nordic_weather_targets SET station_id=?, station_name=?, distance_km=NULL,
            last_linked_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(String(parsed.station_id), parsed.station_name, new Date().toISOString(), target.id).run();
        let written = 0;
        for (const item of parsed.rows) {
          written += await upsertObservation(db, {
            ...item,
            contract_id: target.contract_id,
            source: "FMI",
            station_id: String(parsed.station_id),
            raw: { ...item.raw, location: target.label, requestedPlace: target.location_name },
          });
        }
        result.completed += 1;
        result.written += written;
        result.details.push({ label: target.label, station_id: String(parsed.station_id), station_name: parsed.station_name,
          observations_written: written, status: parsed.rows.length ? "ok" : "ingen_data" });
      } catch (error) {
        result.details.push({ label: target.label, status: "feil", error: String(error?.message || error) });
      }
    }
    return await finishRun(db, run, "FMI", result);
  } catch (error) {
    await finishRun(db, run, "FMI", result, error);
    throw error;
  }
}

export async function runNordicWeather(db, { country = "all" } = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  const wanted = String(country || "all").toLowerCase();
  const output = {};
  if (["all", "denmark", "danmark", "dmi"].includes(wanted)) output.DMI = await collectDmi(db);
  if (["all", "finland", "fmi"].includes(wanted)) output.FMI = await collectFmi(db);
  if (!Object.keys(output).length) throw new Error("country må være all, Denmark eller Finland");
  return {
    ok: Object.values(output).every((x) => x.ok),
    phase: "C",
    sources: output,
    note: "Fase C samler meteorologiske observasjoner for kjente danske og finske lokasjoner. Været påvirker ikke resultatestimatet automatisk.",
  };
}

export async function getNordicWeatherStatus(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  const [targets, runs, ranges, counts] = await Promise.all([
    db.prepare(`SELECT t.id, t.country, t.label, t.contract_name, t.contract_id, c.name AS matched_contract,
        t.location_name, t.latitude, t.longitude, t.source, t.station_id, t.station_name,
        t.distance_km, t.confidence, t.notes, t.last_linked_at
      FROM nordic_weather_targets t LEFT JOIN contracts c ON c.id=t.contract_id
      WHERE t.active=1 ORDER BY t.country, t.label`).all(),
    db.prepare(`SELECT r.* FROM nordic_weather_runs r
      JOIN (SELECT source, MAX(id) AS id FROM nordic_weather_runs GROUP BY source) x ON x.id=r.id
      ORDER BY r.source`).all(),
    db.prepare(`SELECT source, COUNT(*) AS observations, MIN(observed_at) AS earliest, MAX(observed_at) AS latest
      FROM weather_observations WHERE source IN ('DMI','FMI') GROUP BY source`).all(),
    db.prepare(`SELECT country, COUNT(*) AS targets,
        SUM(CASE WHEN station_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
        SUM(CASE WHEN contract_id IS NOT NULL THEN 1 ELSE 0 END) AS matched_contracts
      FROM nordic_weather_targets WHERE active=1 GROUP BY country`).all(),
  ]);
  const runMap = Object.fromEntries((runs?.results || []).map((r) => [r.source, r]));
  const rangeMap = Object.fromEntries((ranges?.results || []).map((r) => [r.source, r]));
  const countryMap = Object.fromEntries((counts?.results || []).map((r) => [r.country, {
    targets: Number(r.targets || 0), linked: Number(r.linked || 0), matchedContracts: Number(r.matched_contracts || 0),
  }]));
  const sourceStatus = {};
  for (const source of ["DMI", "FMI"]) {
    const run = runMap[source] || null;
    const range = rangeMap[source] || null;
    sourceStatus[source] = {
      status: run?.status || "ikke_kjørt",
      lastRun: run,
      observations: Number(range?.observations || 0),
      earliest: range?.earliest || null,
      latest: range?.latest || null,
    };
  }
  return {
    phase: "C",
    sources: sourceStatus,
    countries: countryMap,
    targets: targets?.results || [],
    methodology: {
      Denmark: "DMI meteorologiske målestasjoner; nærmeste aktive stasjon til kontrakts-/byankeret.",
      Finland: "FMI WFS-observasjoner for nærmeste værstasjon til navngitt sted.",
    },
    limitations: [
      "Danmarks fire nye statlige sommerkontrakter ligger foreløpig aggregert i modellgrunnlaget og har ikke fire separate geografiske kontraktsrader i databasen.",
      "Terranor har en større eksisterende finsk portefølje enn de navngitte lokasjonene i trackeren. Fase C starter derfor med kjente Kemi, Ii og regionalt dreneringsarbeid, ikke hele Finland-porteføljen.",
      "Sørøst-Finland bruker Lappeenranta som regional værproxy og er ikke en eksakt kontraktsgrense.",
    ],
    note: "Dette er datainnsamling og geografisk dekning. Ingen DMI- eller FMI-måling omgjøres direkte til omsetning eller EBITA.",
  };
}
