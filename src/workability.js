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
  if (!db) throw new Error("D1 binding DB is missing");
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
      count: 0,
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

  // Absolute summer workability score, not a revenue score and not yet normalized versus history.
  // Rain and high wind are the main penalties. Snow/freeze matter in northern/late-quarter areas.
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

function confidenceFor(vvis24, vvis7, smhi24, smhi7) {
  const count24 = Math.max(vvis24?.count || 0, smhi24?.count || 0);
  const count7 = Math.max(vvis7?.count || 0, smhi7?.count || 0);
  const coverage24 = clamp(count24 / 18, 0, 1);
  const coverage7 = clamp(count7 / 108, 0, 1);
  const sourceFactor = (vvis24?.count || vvis7?.count) ? 1 : 0.75;
  const score = Math.round(100 * (0.7 * coverage24 + 0.3 * coverage7) * sourceFactor);
  let label = "warming_up";
  if (count24 >= 18 && count7 >= 108) label = "high";
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

async function getPrimaryLinks(db) {
  const result = await db.prepare(`SELECT
      c.id AS contract_id, c.name, c.start_date, c.end_date, c.annual_run_rate_msek,
      l.source, l.station_id, l.station_name, l.distance_km
    FROM contracts c
    LEFT JOIN weather_station_links l
      ON l.contract_id=c.id AND l.active=1 AND l.rank_no=1 AND l.source IN ('VVIS','SMHI')
    WHERE c.country='Sweden'
      AND (c.start_date IS NULL OR c.start_date <= '2026-09-30')
      AND (c.end_date IS NULL OR c.end_date >= '2026-07-01')
    ORDER BY c.name, l.source`).all();

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
        links: {},
      });
    }
    if (row.source && row.station_id) {
      map.get(id).links[row.source] = {
        source: row.source,
        station_id: String(row.station_id),
        station_name: row.station_name,
        distance_km: row.distance_km,
      };
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

async function buildContractRow(db, contract, nowMs) {
  const vvisLink = contract.links.VVIS || null;
  const smhiLink = contract.links.SMHI || null;
  const [vvisRows, smhiRows] = await Promise.all([
    getObservations(db, 'VVIS', vvisLink?.station_id),
    getObservations(db, 'SMHI', smhiLink?.station_id),
  ]);

  const since24 = nowMs - 24 * 3600000;
  const since7 = nowMs - 7 * 24 * 3600000;
  const vvis24 = summarizeRows(vvisRows, since24);
  const vvis7 = summarizeRows(vvisRows, since7);
  const smhi24 = summarizeRows(smhiRows, since24);
  const smhi7 = summarizeRows(smhiRows, since7);
  const score24 = blend(vvis24, smhi24, 'score');
  const score7 = blend(vvis7, smhi7, 'score');
  const confidence = confidenceFor(vvis24, vvis7, smhi24, smhi7);
  const q3Weight = quarterWeight(contract);

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
    primary_source: vvisLink ? 'VVIS' : smhiLink ? 'SMHI' : null,
    primary_station: vvisLink || smhiLink || null,
    sources: {
      VVIS: vvisLink ? { station: vvisLink, h24: vvis24, d7: vvis7 } : null,
      SMHI: smhiLink ? { station: smhiLink, h24: smhi24, d7: smhi7 } : null,
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
      JSON.stringify(row.sources),
    ));
  if (statements.length) await db.batch(statements);
}

export async function calculateWorkability(db, { persist = true } = {}) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureWorkabilitySchema(db);
  const contracts = await getPrimaryLinks(db);
  const now = Date.now();
  const rows = [];
  for (const contract of contracts) rows.push(await buildContractRow(db, contract, now));

  const generatedAt = new Date(Math.floor(now / 3600000) * 3600000).toISOString();
  if (persist) await saveSnapshots(db, rows, generatedAt);

  const score24 = aggregate(rows, 'score_24h');
  const score7 = aggregate(rows, 'score_7d');
  const confidence = aggregateConfidence(rows);
  const totalKnownWeight = rows.filter((r) => Number.isFinite(r.q3_weight_msek) && r.q3_weight_msek > 0)
    .reduce((sum, r) => sum + r.q3_weight_msek, 0);
  const scoredWeight = rows.filter((r) => Number.isFinite(r.score_24h) && Number.isFinite(r.q3_weight_msek) && r.q3_weight_msek > 0)
    .reduce((sum, r) => sum + r.q3_weight_msek, 0);

  return {
    generated_at: generatedAt,
    quarter: TARGET_QUARTER,
    methodology: "absolute summer workability; contract-weighted; VViS 75% / SMHI 25% when both available",
    sweden: {
      score_24h: score24,
      score_7d: score7,
      signal: signalFromScore(score24),
      confidence,
      scored_weight_pct: totalKnownWeight ? round(100 * scoredWeight / totalKnownWeight, 1) : 0,
    },
    contracts: rows,
    note: "Dette er en absolutt workability-score, ikke et earnings- eller vær-mot-normal-signal. Historisk normalisering legges til når vi har nok observasjoner.",
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
