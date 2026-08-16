import { ensureNordicSchema } from "./nordic.js";

const DMI_OBS_URL = "https://opendataapi.dmi.dk/v2/metObs/collections/observation/items";
const FMI_WFS_URL = "https://opendata.fmi.fi/wfs";
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const INSERT_ROWS_PER_QUERY = 11; // 11 rows x 9 bindings = 99, below D1's 100-bind limit.

const DMI_SPECS = [
  ["temp_dry", "air_temp_c"],
  ["wind_speed", "wind_ms"],
  ["humidity", "humidity_pct"],
  ["precip_past1h", "precipitation_mm"],
];

const BACKFILL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nordic_backfill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target_id INTEGER,
    label TEXT,
    chunk_start TEXT,
    chunk_end TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    observations_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_id) REFERENCES nordic_weather_targets(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nordic_backfill_source_time ON nordic_backfill_runs(source, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_nordic_backfill_target_time ON nordic_backfill_runs(target_id, started_at)`,
];

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function xmlDecode(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function hourBucket(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
}

export async function ensureNordicBackfillSchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  await db.batch(BACKFILL_SCHEMA.map((sql) => db.prepare(sql)));
}

function insertObservationChunk(db, rows) {
  const placeholders = rows.map(() => "(?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)").join(",");
  const values = [];
  for (const row of rows) {
    values.push(
      row.contract_id || null,
      row.source,
      String(row.station_id),
      row.observed_at,
      row.air_temp_c,
      row.precipitation_mm,
      row.wind_ms,
      row.humidity_pct,
      JSON.stringify(row.raw || {}),
    );
  }
  return db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES ${placeholders}
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      contract_id=COALESCE(excluded.contract_id, weather_observations.contract_id),
      air_temp_c=COALESCE(excluded.air_temp_c, weather_observations.air_temp_c),
      precipitation_mm=COALESCE(excluded.precipitation_mm, weather_observations.precipitation_mm),
      wind_ms=COALESCE(excluded.wind_ms, weather_observations.wind_ms),
      humidity_pct=COALESCE(excluded.humidity_pct, weather_observations.humidity_pct),
      raw_json=excluded.raw_json`).bind(...values).run();
}

async function upsertRows(db, rows) {
  let written = 0;
  const ordered = [...rows].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  for (let i = 0; i < ordered.length; i += INSERT_ROWS_PER_QUERY) {
    const chunk = ordered.slice(i, i + INSERT_ROWS_PER_QUERY);
    if (!chunk.length) continue;
    await insertObservationChunk(db, chunk);
    written += chunk.length;
  }
  return written;
}

async function fetchDmiParameter(stationId, parameterId, startIso, endIso) {
  const params = new URLSearchParams({
    datetime: `${startIso}/${endIso}`,
    limit: "10000",
    stationId: String(stationId),
    parameterId,
  });
  const response = await fetch(`${DMI_OBS_URL}?${params.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/1.1" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DMI ${stationId}/${parameterId} historikk feilet: ${response.status} ${body.slice(0, 220)}`);
  }
  return response.json();
}

async function backfillDmiTarget(db, target, startIso, endIso) {
  const datasets = await Promise.all(DMI_SPECS.map(([parameter]) =>
    fetchDmiParameter(target.station_id, parameter, startIso, endIso)));
  const buckets = new Map();
  const parameterCounts = {};

  for (let i = 0; i < DMI_SPECS.length; i += 1) {
    const [parameter, field] = DMI_SPECS[i];
    let count = 0;
    for (const feature of datasets[i]?.features || []) {
      const p = feature?.properties || {};
      const observed = p.observed && Number.isFinite(Date.parse(p.observed)) ? new Date(p.observed).toISOString() : null;
      const value = numeric(p.value);
      const bucket = observed ? hourBucket(observed) : null;
      if (!bucket || value === null) continue;
      count += 1;
      const entry = buckets.get(bucket) || {
        contract_id: target.contract_id,
        source: "DMI",
        station_id: target.station_id,
        observed_at: bucket,
        accumulators: {},
        raw: { location: target.label, stationName: target.station_name, historicalBackfill: true, hourlyAggregation: true, parameters: {} },
      };
      const adjusted = field === "precipitation_mm" && value < 0 ? 0 : value;
      const acc = entry.accumulators[field] || { sum: 0, count: 0 };
      acc.sum += adjusted;
      acc.count += 1;
      entry.accumulators[field] = acc;
      entry.raw.parameters[parameter] = { samples: acc.count, lastValue: adjusted, qcStatus: p.qcStatus || null };
      buckets.set(bucket, entry);
    }
    parameterCounts[parameter] = count;
  }

  const rows = [...buckets.values()].map((entry) => {
    const avg = (field) => {
      const acc = entry.accumulators[field];
      return acc?.count ? acc.sum / acc.count : null;
    };
    return {
      contract_id: entry.contract_id,
      source: entry.source,
      station_id: entry.station_id,
      observed_at: entry.observed_at,
      air_temp_c: avg("air_temp_c"),
      precipitation_mm: avg("precipitation_mm"),
      wind_ms: avg("wind_ms"),
      humidity_pct: avg("humidity_pct"),
      raw: entry.raw,
    };
  });

  const written = await upsertRows(db, rows);
  return { written, rows: rows.length, parameterCounts, resolution: "hourly" };
}

function fmiParameterFromMember(member) {
  const href = member.match(/observedProperty[^>]+(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] || "";
  const name = member.match(/<gml:name[^>]*>([\s\S]*?)<\/gml:name>/i)?.[1] || "";
  const text = `${href} ${xmlDecode(name)}`.toLowerCase();
  if (/pra_pt1h_acc|precipitation amount|precip/.test(text)) return "precipitation_mm";
  if (/ws_pt1h_avg|windspeed|wind speed|ws_10min/.test(text)) return "wind_ms";
  if (/rh_pt1h_avg|humidity|relative humidity|\brh\b/.test(text)) return "humidity_pct";
  if (/ta_pt1h_avg|temperature|\bt2m\b/.test(text)) return "air_temp_c";
  return null;
}

function parseFmi(xml, target) {
  const rows = new Map();
  const members = String(xml || "").split(/<wfs:member\b/i).slice(1);
  let stationId = target.station_id;
  let stationName = target.station_name || target.location_name;
  for (const memberRaw of members) {
    const member = `<wfs:member ${memberRaw}`;
    const field = fmiParameterFromMember(member);
    if (!field) continue;
    const identifier = member.match(/<gml:identifier[^>]*>([^<]+)<\/gml:identifier>/i)?.[1];
    const name = member.match(/<gml:name[^>]*>([^<]+)<\/gml:name>/i)?.[1];
    if (identifier) stationId = xmlDecode(identifier).trim();
    if (name) stationName = xmlDecode(name).trim();
    const pairRe = /<wml2:MeasurementTVP[^>]*>[\s\S]*?<wml2:time>([^<]+)<\/wml2:time>[\s\S]*?<wml2:value[^>]*>([^<]*)<\/wml2:value>[\s\S]*?<\/wml2:MeasurementTVP>/gi;
    let match;
    while ((match = pairRe.exec(member))) {
      const observed = Number.isFinite(Date.parse(match[1])) ? new Date(match[1]).toISOString() : null;
      const value = numeric(match[2]);
      if (!observed || value === null) continue;
      const row = rows.get(observed) || {
        contract_id: target.contract_id,
        source: "FMI",
        station_id: stationId || `place:${target.location_name}`,
        observed_at: observed,
        air_temp_c: null,
        precipitation_mm: null,
        wind_ms: null,
        humidity_pct: null,
        raw: { location: target.label, requestedPlace: target.location_name, historicalBackfill: true, hourlyProduct: true },
      };
      row.station_id = stationId || row.station_id;
      row[field] = value;
      rows.set(observed, row);
    }
  }
  return { stationId, stationName, rows: [...rows.values()] };
}

async function backfillFmiTarget(db, target, startIso, endIso) {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "getFeature",
    storedquery_id: "fmi::observations::weather::hourly::timevaluepair",
    starttime: startIso,
    endtime: endIso,
    parameters: "TA_PT1H_AVG,RH_PT1H_AVG,WS_PT1H_AVG,PRA_PT1H_ACC",
  });

  // Historical backfill uses FMI's dedicated hourly product rather than the real-time
  // instantaneous query used by the live collector. Once the live collector has resolved
  // a station, lock historical requests to that exact FMI station ID.
  const numericStationId = /^\d+$/.test(String(target.station_id || "")) ? String(target.station_id) : null;
  const selector = numericStationId ? `fmisid ${numericStationId}` : `place ${target.location_name}`;
  if (numericStationId) params.set("fmisid", numericStationId);
  else params.set("place", target.location_name);

  const response = await fetch(`${FMI_WFS_URL}?${params.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/1.3", "accept": "application/xml,text/xml" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FMI hourly ${selector} historikk feilet: ${response.status} ${body.slice(0, 500)}`);
  }
  const xml = await response.text();
  if (/ExceptionReport|ExceptionText/i.test(xml)) {
    const message = xml.match(/<[^>]*ExceptionText[^>]*>([\s\S]*?)<\/[^>]*ExceptionText>/i)?.[1];
    throw new Error(`FMI hourly ${selector} svarte med feil: ${xmlDecode(message || "ukjent WFS-feil").trim()}`);
  }
  const parsed = parseFmi(xml, target);
  if (!parsed.rows.length) {
    throw new Error(`FMI hourly ${selector} ga ingen historiske observasjoner for ${startIso}–${endIso}`);
  }
  if (parsed.stationId) {
    await db.prepare(`UPDATE nordic_weather_targets SET station_id=?, station_name=?, last_linked_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(String(parsed.stationId), parsed.stationName, new Date().toISOString(), target.id).run();
  }
  const written = await upsertRows(db, parsed.rows);
  return {
    written,
    rows: parsed.rows.length,
    stationId: parsed.stationId,
    stationName: parsed.stationName,
    selector,
    product: "fmi::observations::weather::hourly::timevaluepair",
    resolution: "hourly",
  };
}

async function getTargetCoverage(db, target, days, nowMs) {
  if (!target.station_id) {
    return { ...target, linked: false, earliest: null, latest: null, observations: 0, coveredDays: 0, complete: false };
  }
  const range = await db.prepare(`SELECT COUNT(*) AS observations, MIN(observed_at) AS earliest, MAX(observed_at) AS latest
      FROM weather_observations WHERE source=? AND station_id=?`)
    .bind(target.source, String(target.station_id)).first();
  const earliestMs = range?.earliest && Number.isFinite(Date.parse(range.earliest)) ? Date.parse(range.earliest) : nowMs;
  const coveredDays = clamp((nowMs - earliestMs) / DAY_MS, 0, days);
  return {
    ...target,
    linked: true,
    earliest: range?.earliest || null,
    latest: range?.latest || null,
    observations: Number(range?.observations || 0),
    coveredDays: Math.round(coveredDays * 10) / 10,
    complete: coveredDays >= days - 0.25,
  };
}

async function chooseTasks(db, days, maxTasks) {
  const result = await db.prepare(`SELECT id, country, label, contract_id, location_name, source, station_id, station_name
      FROM nordic_weather_targets WHERE active=1 AND source IN ('DMI','FMI') ORDER BY source, id`).all();
  const nowMs = Date.now();
  const coverage = [];
  for (const target of result?.results || []) coverage.push(await getTargetCoverage(db, target, days, nowMs));
  const incomplete = coverage.filter((x) => x.linked && !x.complete)
    .sort((a, b) => a.coveredDays - b.coveredDays || String(a.source).localeCompare(String(b.source)) || Number(a.id) - Number(b.id));

  const selected = [];
  const usedSources = new Set();
  for (const target of incomplete) {
    if (selected.length >= maxTasks) break;
    if (usedSources.has(target.source)) continue;
    selected.push(target);
    usedSources.add(target.source);
  }
  if (selected.length < maxTasks) {
    for (const target of incomplete) {
      if (selected.length >= maxTasks) break;
      if (selected.some((x) => x.id === target.id)) continue;
      selected.push(target);
    }
  }
  return { coverage, selected };
}

async function runTask(db, target, days) {
  const now = new Date();
  const cutoffMs = now.getTime() - days * DAY_MS;
  const earliestMs = target.earliest && Number.isFinite(Date.parse(target.earliest)) ? Date.parse(target.earliest) : now.getTime();
  const chunkDays = target.source === "DMI" ? 7 : 14;
  const rawEndMs = Math.min(now.getTime(), earliestMs - 60000);
  const endMs = target.source === "FMI" ? Math.floor(rawEndMs / HOUR_MS) * HOUR_MS : rawEndMs;
  const rawStartMs = Math.max(cutoffMs, endMs - chunkDays * DAY_MS);
  const startMs = target.source === "FMI" ? Math.floor(rawStartMs / HOUR_MS) * HOUR_MS : rawStartMs;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO nordic_backfill_runs (
      source, target_id, label, chunk_start, chunk_end, started_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'running') RETURNING id`)
    .bind(target.source, target.id, target.label, startIso, endIso, startedAt).first();
  try {
    const collected = target.source === "DMI"
      ? await backfillDmiTarget(db, target, startIso, endIso)
      : await backfillFmiTarget(db, target, startIso, endIso);
    const finishedAt = new Date().toISOString();
    if (run?.id) await db.prepare(`UPDATE nordic_backfill_runs SET finished_at=?, status='ok', observations_written=? WHERE id=?`)
      .bind(finishedAt, collected.written || 0, run.id).run();
    return {
      source: target.source,
      label: target.label,
      chunkStart: startIso,
      chunkEnd: endIso,
      observationsWritten: collected.written || 0,
      resolution: collected.resolution || "hourly",
      selector: collected.selector || null,
      product: collected.product || null,
      status: "ok",
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (run?.id) await db.prepare(`UPDATE nordic_backfill_runs SET finished_at=?, status='error', error_text=? WHERE id=?`)
      .bind(finishedAt, String(error?.message || error).slice(0, 1800), run.id).run();
    return { source: target.source, label: target.label, chunkStart: startIso, chunkEnd: endIso, status: "feil", error: String(error?.message || error) };
  }
}

export async function runNordicBackfill(db, { days = 60, maxTasks = 2 } = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicBackfillSchema(db);
  const wantedDays = clamp(Number.parseInt(days, 10) || 60, 7, 120);
  const wantedTasks = clamp(Number.parseInt(maxTasks, 10) || 2, 1, 4);
  const { coverage, selected } = await chooseTasks(db, wantedDays, wantedTasks);
  const details = [];
  for (const target of selected) details.push(await runTask(db, target, wantedDays));
  return {
    ok: details.every((x) => x.status === "ok"),
    phase: "C",
    days: wantedDays,
    tasksAttempted: details.length,
    details,
    completeBeforeRun: coverage.length > 0 && coverage.every((x) => x.complete),
    note: "Historikken fylles bakover i små deler. Danmark aggregeres til timeverdier og bruker 7-dagersblokker; Finland bruker FMIs dedikerte timesprodukt i 14-dagersblokker og låst stasjons-ID når den er kjent.",
  };
}

export async function getNordicBackfillStatus(db, days = 60) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicBackfillSchema(db);
  const wantedDays = clamp(Number.parseInt(days, 10) || 60, 7, 120);
  const { coverage } = await chooseTasks(db, wantedDays, 1);
  const latestRun = await db.prepare(`SELECT source, target_id, label, chunk_start, chunk_end, started_at, finished_at,
      status, observations_written, error_text FROM nordic_backfill_runs ORDER BY id DESC LIMIT 1`).first();
  const linked = coverage.filter((x) => x.linked).length;
  const complete = coverage.filter((x) => x.complete).length;
  const avgCoverage = coverage.length
    ? coverage.reduce((sum, x) => sum + x.coveredDays / wantedDays, 0) / coverage.length
    : 0;
  return {
    phase: "C",
    days: wantedDays,
    targets: coverage.length,
    targetsLinked: linked,
    targetsComplete: complete,
    complete: coverage.length > 0 && complete === coverage.length,
    progressPct: Math.round(clamp(avgCoverage * 100, 0, 100)),
    latestRun: latestRun || null,
    targetStatus: coverage.map((x) => ({
      id: x.id,
      country: x.country,
      label: x.label,
      source: x.source,
      station_id: x.station_id,
      station_name: x.station_name,
      earliest: x.earliest,
      latest: x.latest,
      observations: x.observations,
      covered_days: x.coveredDays,
      complete: x.complete,
    })),
  };
}
