const TARGET_QUARTER = "Q3 2026";
const Q3_START = Date.UTC(2026, 6, 1, 0, 0, 0);
const Q3_END = Date.UTC(2026, 8, 30, 23, 59, 59);

const WORKABILITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workability_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at TEXT NOT NULL,
    quarter TEXT NOT NULL,
    contract_id INTEGER NOT NULL,
    score_24h REAL,
    score_7d REAL,
    confidence REAL,
    confidence_label TEXT,
    signal TEXT,
    q3_weight_msek REAL,
    primary_source TEXT,
    primary_station_id TEXT,
    metrics_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contract_id, generated_at),
    FOREIGN KEY (contract_id) REFERENCES contracts(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workability_time ON workability_snapshots(generated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workability_contract_time ON workability_snapshots(contract_id, generated_at)`,
];

export async function ensureWorkabilitySchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await db.batch(WORKABILITY_SCHEMA.map((sql) => db.prepare(sql)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function daysOverlap(startText, endText) {
  const start = startText ? Date.parse(`${startText}T00:00:00Z`) : Q3_START;
  const end = endText ? Date.parse(`${endText}T23:59:59Z`) : Q3_END;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const overlapStart = Math.max(start, Q3_START);
  const overlapEnd = Math.min(end, Q3_END);
  if (overlapEnd < overlapStart) return 0;
  return Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
}

function quarterWeight(contract) {
  const annual = num(contract.annual_run_rate_msek);
  if (annual === null || annual <= 0) return null;
  const activeDays = daysOverlap(contract.start_date, contract.end_date);
  return round(annual * activeDays / 365.25, 3);
}

function precipitationEvent(row) {
  const amount = num(row.precipitation_mm);
  const type = String(row.precipitation_type || "").toLowerCase();
  return (amount !== null && amount > 0.05) || (!['', 'no', 'none', 'false'].includes(type));
}

function snowEvent(row) {
  return String(row.precipitation_type || "").toLowerCase().includes("snow");
}

function summarizeRows(rows, sinceMs) {
  const filtered = rows.filter((row) => {
    const ts = Date.parse(row.observed_at);
    return Number.isFinite(ts) && ts >= sinceMs;
  });

  if (!filtered.length) {
    return {
      count: 0, score: null, precipShare: null, snowShare: null, highWindShare: null,
      freezeShare: null, heatShare: null, avgAirTemp: null, avgRoadTemp: null, avgWind: null,
    };
  }

  let precip = 0;
  let snow = 0;
  let highWind = 0;
  let freeze = 0;
  let heat = 0;
  const air = [];
  const road = [];
  const wind = [];

  for (const row of filtered) {
    if (precipitationEvent(row)) precip += 1;
    if (snowEvent(row)) snow += 1;
    const windValue = num(row.wind_ms);
    const airValue = num(row.air_temp_c);
    const roadValue = num(row.road_temp_c);
    if (windValue !== null) {
      wind.push(windValue);
      if (windValue >= 10) highWind += 1;
    }
    if (airValue !== null) {
      air.push(airValue);
      if (airValue >= 30) heat += 1;
    }
    if (roadValue !== null) {
      road.push(roadValue);
      if (roadValue <= 0) freeze += 1;
    }
  }

  const n = filtered.length;
  const precipShare = precip / n;
  const snowShare = snow / n;
  const highWindShare = highWind / n;
  const freezeShare = road.length ? freeze / road.length : 0;
  const heatShare = air.length ? heat / air.length : 0;
  const score = n >= 6
    ? clamp(100 - 45 * precipShare - 20 * highWindShare - 20 * snowShare - 12 * freezeShare - 8 * heatShare, 0, 100)
    : null;
  const avg = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  return {
    count: n,
    score: round(score, 1),
    precipShare: round(precipShare, 3),
    snowShare: round(snowShare, 3),
    highWindShare: round(highWindShare, 3),
    freezeShare: round(freezeShare, 3),
    heatShare: round(heatShare, 3),
    avgAirTemp: round(avg(air), 1),
    avgRoadTemp: round(avg(road), 1),
    avgWind: round(avg(wind), 1),
  };
}

function blend(vvis, smhi, field) {
  const a = num(vvis?.[field]);
  const b = num(smhi?.[field]);
  if (a !== null && b !== null) return round(0.75 * a + 0.25 * b, 1);
  if (a !== null) return round(a, 1);
  if (b !== null) return round(b, 1);
  return null;
}

function stationBaseWeight(source, rank) {
  const r = Math.max(1, Number(rank) || 1);
  if (source === "VVIS") return [0.55, 0.30, 0.15][r - 1] || 0.08;
  return [0.65, 0.35][r - 1] || 0.10;
}

function stationWeight(link) {
  const distance = Math.max(0, Number(link.distance_km) || 0);
  return stationBaseWeight(link.source, link.rank_no) / (1 + distance / 100);
}

function combineStationSummaries(entries) {
  const usable = entries.filter((entry) => Number.isFinite(entry.summary?.score));
  const count = entries.reduce((max, entry) => Math.max(max, Number(entry.summary?.count || 0)), 0);
  if (!usable.length) return {
    count,
    stationCount: 0,
    score: null,
    precipShare: null,
    snowShare: null,
    highWindShare: null,
    freezeShare: null,
    heatShare: null,
    avgAirTemp: null,
    avgRoadTemp: null,
    avgWind: null,
  };

  const fields = ["score", "precipShare", "snowShare", "highWindShare", "freezeShare", "heatShare", "avgAirTemp", "avgRoadTemp", "avgWind"];
  const result = { count, stationCount: usable.length };
  for (const field of fields) {
    const available = usable.filter((entry) => Number.isFinite(entry.summary?.[field]));
    const totalWeight = available.reduce((sum, entry) => sum + stationWeight(entry.link), 0);
    result[field] = totalWeight
      ? round(available.reduce((sum, entry) => sum + entry.summary[field] * stationWeight(entry.link), 0) / totalWeight, field.includes("Share") ? 3 : 1)
      : null;
  }
  return result;
}

function confidenceFor(vvis24, vvis7, smhi24, smhi7) {
  const count24 = Math.max(vvis24?.count || 0, smhi24?.count || 0);
  const count7 = Math.max(vvis7?.count || 0, smhi7?.count || 0);
  const coverage24 = clamp(count24 / 18, 0, 1);
  const coverage7 = clamp(count7 / 108, 0, 1);
  const sourceFactor = (vvis24?.count || vvis7?.count) ? 1 : 0.75;
  const stationFactor = vvis24?.stationCount
    ? 0.85 + 0.15 * Math.min(vvis24.stationCount / 3, 1)
    : smhi24?.stationCount ? 0.80 + 0.20 * Math.min(smhi24.stationCount / 2, 1) : 0.7;
  const score = Math.round(100 * (0.7 * coverage24 + 0.3 * coverage7) * sourceFactor * stationFactor);
  let label = "warming_up";
  if (count24 >= 18 && count7 >= 108 && score >= 85) label = "high";
  else if (count24 >= 12 && count7 >= 48) label = "medium";
  else if (count24 >= 6) label = "low";
  return { score, label, count24, count7 };
}

function signalFromScore(score) {
  if (!Number.isFinite(score)) return "warming_up";
  if (score >= 88) return "very_good";
  if (score >= 78) return "good";
  if (score >= 65) return "mixed";
  if (score >= 50) return "constrained";
  return "poor";
}

async function getContractLinks(db) {
  const result = await db.prepare(`SELECT
      c.id AS contract_id, c.name, c.start_date, c.end_date, c.annual_run_rate_msek,
      l.source, l.station_id, l.station_name, l.distance_km, l.rank_no
    FROM contracts c
    LEFT JOIN weather_station_links l
      ON l.contract_id=c.id AND l.active=1 AND l.source IN ('VVIS','SMHI')
      AND ((l.source='VVIS' AND l.rank_no<=3) OR (l.source='SMHI' AND l.rank_no<=2))
    WHERE c.country='Sweden'
      AND (c.start_date IS NULL OR c.start_date <= '2026-09-30')
      AND (c.end_date IS NULL OR c.end_date >= '2026-07-01')
    ORDER BY c.name, l.source, l.rank_no`).all();

  const map = new Map();
  for (const row of result?.results || []) {
    const id = Number(row.contract_id);
    if (!map.has(id)) {
      map.set(id, {
        contract_id: id,
        name: row.name,
        start_date: row.start_date,
        end_date: row.end_date,
        annual_run_rate_msek: row.annual_run_rate_msek,
        links: { VVIS: [], SMHI: [] },
      });
    }
    if (row.source && row.station_id) {
      map.get(id).links[row.source].push({
        source: row.source,
        station_id: String(row.station_id),
        station_name: row.station_name,
        distance_km: row.distance_km,
        rank_no: Number(row.rank_no),
      });
    }
  }
  return [...map.values()];
}

async function getObservations(db, source, stationId) {
  if (!source || !stationId) return [];
  const result = await db.prepare(`SELECT observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct
    FROM weather_observations
    WHERE source=? AND station_id=? AND julianday(observed_at) >= julianday('now','-7 days')
    ORDER BY observed_at`).bind(source, stationId).all();
  return result?.results || [];
}

async function summarizeSource(db, source, links, since24, since7) {
  if (!links?.length) return { h24: combineStationSummaries([]), d7: combineStationSummaries([]), stations: [] };
  const entries = await Promise.all(links.map(async (link) => {
    const rows = await getObservations(db, source, link.station_id);
    return { link, h24: summarizeRows(rows, since24), d7: summarizeRows(rows, since7) };
  }));
  return {
    h24: combineStationSummaries(entries.map((x) => ({ link: x.link, summary: x.h24 }))),
    d7: combineStationSummaries(entries.map((x) => ({ link: x.link, summary: x.d7 }))),
    stations: entries.map((x) => ({ station: x.link, h24: x.h24, d7: x.d7 })),
  };
}

async function buildContractRow(db, contract, nowMs) {
  const since24 = nowMs - 24 * 3600000;
  const since7 = nowMs - 7 * 24 * 3600000;
  const [vvis, smhi] = await Promise.all([
    summarizeSource(db, "VVIS", contract.links.VVIS, since24, since7),
    summarizeSource(db, "SMHI", contract.links.SMHI, since24, since7),
  ]);
  const score24 = blend(vvis.h24, smhi.h24, "score");
  const score7 = blend(vvis.d7, smhi.d7, "score");
  const confidence = confidenceFor(vvis.h24, vvis.d7, smhi.h24, smhi.d7);
  const q3Weight = quarterWeight(contract);
  const primaryStation = contract.links.VVIS[0] || contract.links.SMHI[0] || null;

  return {
    contract_id: contract.contract_id,
    contract_name: contract.name,
    start_date: contract.start_date,
    annual_run_rate_msek: num(contract.annual_run_rate_msek),
    q3_weight_msek: q3Weight,
    score_24h: score24,
    score_7d: score7,
    signal: signalFromScore(score24),
    confidence: confidence.score,
    confidence_label: confidence.label,
    primary_source: contract.links.VVIS.length ? "VVIS" : contract.links.SMHI.length ? "SMHI" : null,
    primary_station: primaryStation,
    geography: {
      road_weather_stations: contract.links.VVIS.length,
      ordinary_weather_stations: contract.links.SMHI.length,
    },
    sources: {
      VVIS: contract.links.VVIS.length ? vvis : null,
      SMHI: contract.links.SMHI.length ? smhi : null,
    },
  };
}

function aggregate(rows, field) {
  const eligible = rows.filter((row) => Number.isFinite(row[field]) && Number.isFinite(row.q3_weight_msek) && row.q3_weight_msek > 0);
  const totalWeight = eligible.reduce((sum, row) => sum + row.q3_weight_msek, 0);
  if (!totalWeight) return null;
  return round(eligible.reduce((sum, row) => sum + row[field] * row.q3_weight_msek, 0) / totalWeight, 1);
}

function aggregateConfidence(rows) {
  const eligible = rows.filter((row) => Number.isFinite(row.confidence) && Number.isFinite(row.q3_weight_msek) && row.q3_weight_msek > 0);
  const totalWeight = eligible.reduce((sum, row) => sum + row.q3_weight_msek, 0);
  if (!totalWeight) return 0;
  return Math.round(eligible.reduce((sum, row) => sum + row.confidence * row.q3_weight_msek, 0) / totalWeight);
}

async function saveSnapshots(db, rows, generatedAt) {
  const statements = rows.map((row) => db.prepare(`INSERT INTO workability_snapshots (
      generated_at, quarter, contract_id, score_24h, score_7d, confidence, confidence_label,
      signal, q3_weight_msek, primary_source, primary_station_id, metrics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_id, generated_at) DO UPDATE SET
      score_24h=excluded.score_24h,
      score_7d=excluded.score_7d,
      confidence=excluded.confidence,
      confidence_label=excluded.confidence_label,
      signal=excluded.signal,
      q3_weight_msek=excluded.q3_weight_msek,
      primary_source=excluded.primary_source,
      primary_station_id=excluded.primary_station_id,
      metrics_json=excluded.metrics_json`)
    .bind(
      generatedAt,
      TARGET_QUARTER,
      row.contract_id,
      row.score_24h,
      row.score_7d,
      row.confidence,
      row.confidence_label,
      row.signal,
      row.q3_weight_msek,
      row.primary_source,
      row.primary_station?.station_id || null,
      JSON.stringify({ geography: row.geography, sources: row.sources }),
    ));
  if (statements.length) await db.batch(statements);
}

export async function calculateWorkability(db, { persist = true } = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureWorkabilitySchema(db);
  const contracts = await getContractLinks(db);
  const now = Date.now();
  const rows = [];
  for (const contract of contracts) rows.push(await buildContractRow(db, contract, now));

  const generatedAt = new Date(Math.floor(now / 3600000) * 3600000).toISOString();
  if (persist) await saveSnapshots(db, rows, generatedAt);

  const score24 = aggregate(rows, "score_24h");
  const score7 = aggregate(rows, "score_7d");
  const confidence = aggregateConfidence(rows);
  const totalKnownWeight = rows.filter((r) => Number.isFinite(r.q3_weight_msek) && r.q3_weight_msek > 0)
    .reduce((sum, r) => sum + r.q3_weight_msek, 0);
  const scoredWeight = rows.filter((r) => Number.isFinite(r.score_24h) && Number.isFinite(r.q3_weight_msek) && r.q3_weight_msek > 0)
    .reduce((sum, r) => sum + r.q3_weight_msek, 0);

  return {
    generated_at: generatedAt,
    quarter: TARGET_QUARTER,
    methodology: "Absolutt sommerscore for arbeidsforhold. Flere målestasjoner brukes per kontrakt; veivær teller 75 % og vanlige værdata 25 % når begge finnes.",
    geography_version: "0.2",
    sweden: {
      score_24h: score24,
      score_7d: score7,
      signal: signalFromScore(score24),
      confidence,
      scored_weight_pct: totalKnownWeight ? round(100 * scoredWeight / totalKnownWeight, 1) : 0,
    },
    contracts: rows,
    note: "Dette er en absolutt score for værbaserte arbeidsforhold, ikke et direkte resultatestimat. Historisk sammenligning beregnes separat mot 10-årsgrunnlaget fra SMHI.",
  };
}

export async function getWorkabilityHistory(db, hours = 168) {
  await ensureWorkabilitySchema(db);
  const safeHours = clamp(Math.round(Number(hours) || 168), 1, 24 * 90);
  const result = await db.prepare(`SELECT generated_at,
      ROUND(SUM(score_24h*q3_weight_msek)/NULLIF(SUM(CASE WHEN score_24h IS NOT NULL THEN q3_weight_msek ELSE 0 END),0),1) AS score_24h,
      ROUND(SUM(score_7d*q3_weight_msek)/NULLIF(SUM(CASE WHEN score_7d IS NOT NULL THEN q3_weight_msek ELSE 0 END),0),1) AS score_7d,
      ROUND(SUM(confidence*q3_weight_msek)/NULLIF(SUM(q3_weight_msek),0),0) AS confidence
    FROM workability_snapshots
    WHERE julianday(generated_at) >= julianday('now', ?)
    GROUP BY generated_at
    ORDER BY generated_at`).bind(`-${safeHours} hours`).all();
  return { hours: safeHours, points: result?.results || [] };
}
