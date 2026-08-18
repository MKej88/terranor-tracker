import { ensureNordicSchema } from "./nordic.js";

const DMI_OBS_URL = "https://opendataapi.dmi.dk/v2/metObs/collections/observation/items";
const FMI_WFS_URL = "https://opendata.fmi.fi/wfs";
const BASELINE_START_YEAR = 2016;
const BASELINE_END_YEAR = 2025;
const Q3_MONTHS = [7, 8, 9];
const TASKS_PER_TARGET = (BASELINE_END_YEAR - BASELINE_START_YEAR + 1) * Q3_MONTHS.length;
const HOUR_MS = 3600000;

const PARAMETERS = [
  { key: "air_temp_c", dmi: "temp_dry", threshold: 30 },
  { key: "wind_ms", dmi: "wind_speed", threshold: 10 },
  { key: "precipitation_mm", dmi: "precip_past1h", threshold: 0.05 },
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nordic_climate_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL,
    country TEXT NOT NULL,
    source TEXT NOT NULL,
    station_id TEXT NOT NULL,
    station_name TEXT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    observations_used INTEGER NOT NULL DEFAULT 0,
    rows_written INTEGER NOT NULL DEFAULT 0,
    last_started_at TEXT,
    last_finished_at TEXT,
    error_text TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_id, year, month),
    FOREIGN KEY (target_id) REFERENCES nordic_weather_targets(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nordic_climate_tasks_status ON nordic_climate_tasks(status, source, updated_at)`,
  `CREATE TABLE IF NOT EXISTS nordic_climate_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    station_id TEXT NOT NULL,
    parameter_key TEXT NOT NULL,
    observed_date TEXT NOT NULL,
    avg_value REAL,
    event_share REAL,
    observations INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_id, parameter_key, observed_date),
    FOREIGN KEY (target_id) REFERENCES nordic_weather_targets(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nordic_climate_daily_target_date ON nordic_climate_daily(target_id, observed_date)`,
];

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
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

function isoRange(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const next = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const end = new Date(next.getTime() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function hourBucket(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString() : null;
}

export async function ensureNordicClimateSchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

async function seedTasks(db) {
  await ensureNordicClimateSchema(db);
  const years = Array.from({ length: BASELINE_END_YEAR - BASELINE_START_YEAR + 1 }, (_, i) => BASELINE_START_YEAR + i);
  const yearsSql = years.map((year) => `(${year})`).join(",");
  const monthsSql = Q3_MONTHS.map((month) => `(${month})`).join(",");
  await db.prepare(`WITH years(y) AS (VALUES ${yearsSql}), months(m) AS (VALUES ${monthsSql})
    INSERT INTO nordic_climate_tasks (target_id, country, source, station_id, station_name, year, month, status)
    SELECT t.id, t.country, t.source, t.station_id, t.station_name, years.y, months.m, 'pending'
    FROM nordic_weather_targets t CROSS JOIN years CROSS JOIN months
    WHERE t.active=1 AND t.source IN ('DMI','FMI') AND t.station_id IS NOT NULL
    ON CONFLICT(target_id, year, month) DO UPDATE SET
      country=excluded.country,
      source=excluded.source,
      station_id=excluded.station_id,
      station_name=excluded.station_name,
      status=CASE WHEN nordic_climate_tasks.station_id<>excluded.station_id THEN 'pending' ELSE nordic_climate_tasks.status END,
      updated_at=CASE WHEN nordic_climate_tasks.station_id<>excluded.station_id THEN CURRENT_TIMESTAMP ELSE nordic_climate_tasks.updated_at END`).run();
}

function dailyFromHourly(hourly, parameter) {
  const days = new Map();
  for (const [iso, value] of hourly.entries()) {
    if (!Number.isFinite(value)) continue;
    const date = iso.slice(0, 10);
    const row = days.get(date) || { sum: 0, count: 0, events: 0 };
    row.sum += value;
    row.count += 1;
    if (value >= parameter.threshold) row.events += 1;
    days.set(date, row);
  }
  return [...days.entries()].map(([observed_date, row]) => ({
    parameter_key: parameter.key,
    observed_date,
    avg_value: row.count ? row.sum / row.count : null,
    event_share: row.count ? row.events / row.count : null,
    observations: row.count,
  }));
}

async function fetchDmiMonth(stationId, year, month) {
  const { start, end } = isoRange(year, month);
  const allRows = [];
  let observations = 0;
  for (const parameter of PARAMETERS) {
    const query = new URLSearchParams({
      datetime: `${start}/${end}`,
      limit: "10000",
      stationId: String(stationId),
      parameterId: parameter.dmi,
    });
    const response = await fetch(`${DMI_OBS_URL}?${query.toString()}`, {
      headers: { "user-agent": "Terranor-Tracker/1.4-paid" },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DMI ${stationId}/${parameter.dmi} ${year}-${String(month).padStart(2, "0")} feilet: ${response.status} ${body.slice(0, 220)}`);
    }
    const payload = await response.json();
    const buckets = new Map();
    for (const feature of payload?.features || []) {
      const p = feature?.properties || {};
      const bucket = p.observed ? hourBucket(p.observed) : null;
      let value = numeric(p.value);
      if (!bucket || value === null) continue;
      if (parameter.key === "precipitation_mm" && value < 0) value = 0;
      const acc = buckets.get(bucket) || { sum: 0, count: 0 };
      acc.sum += value;
      acc.count += 1;
      buckets.set(bucket, acc);
      observations += 1;
    }
    const hourly = new Map([...buckets.entries()].map(([iso, acc]) => [iso, acc.sum / acc.count]));
    allRows.push(...dailyFromHourly(hourly, parameter));
  }
  return { rows: allRows, observations };
}

function fmiField(member) {
  const href = member.match(/observedProperty[^>]+(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] || "";
  const name = member.match(/<gml:name[^>]*>([\s\S]*?)<\/gml:name>/i)?.[1] || "";
  const text = `${href} ${xmlDecode(name)}`.toLowerCase();
  if (/pra_pt1h_acc|precipitation amount|precip/.test(text)) return "precipitation_mm";
  if (/ws_pt1h_avg|windspeed|wind speed|ws_10min/.test(text)) return "wind_ms";
  if (/ta_pt1h_avg|temperature|\bt2m\b/.test(text)) return "air_temp_c";
  return null;
}

async function fetchFmiMonth(stationId, year, month) {
  const { start, end } = isoRange(year, month);
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "getFeature",
    storedquery_id: "fmi::observations::weather::hourly::timevaluepair",
    starttime: start,
    endtime: end,
    parameters: "TA_PT1H_AVG,WS_PT1H_AVG,PRA_PT1H_ACC",
    fmisid: String(stationId),
  });
  const response = await fetch(`${FMI_WFS_URL}?${query.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/1.4-paid", accept: "application/xml,text/xml" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FMI ${stationId} ${year}-${String(month).padStart(2, "0")} feilet: ${response.status} ${body.slice(0, 300)}`);
  }
  const xml = await response.text();
  if (/ExceptionReport|ExceptionText/i.test(xml)) {
    const message = xml.match(/<[^>]*ExceptionText[^>]*>([\s\S]*?)<\/[^>]*ExceptionText>/i)?.[1];
    throw new Error(`FMI ${stationId} svarte med feil: ${xmlDecode(message || "ukjent WFS-feil").trim()}`);
  }

  const hourlyByField = new Map(PARAMETERS.map((p) => [p.key, new Map()]));
  let observations = 0;
  const members = String(xml).split(/<wfs:member\b/i).slice(1);
  for (const raw of members) {
    const member = `<wfs:member ${raw}`;
    const field = fmiField(member);
    if (!field || !hourlyByField.has(field)) continue;
    const pairRe = /<wml2:MeasurementTVP[^>]*>[\s\S]*?<wml2:time>([^<]+)<\/wml2:time>[\s\S]*?<wml2:value[^>]*>([^<]*)<\/wml2:value>[\s\S]*?<\/wml2:MeasurementTVP>/gi;
    let match;
    while ((match = pairRe.exec(member))) {
      const bucket = hourBucket(match[1]);
      let value = numeric(match[2]);
      if (!bucket || value === null) continue;
      if (field === "precipitation_mm" && value < 0) value = 0;
      hourlyByField.get(field).set(bucket, value);
      observations += 1;
    }
  }

  const rows = [];
  for (const parameter of PARAMETERS) rows.push(...dailyFromHourly(hourlyByField.get(parameter.key), parameter));
  return { rows, observations };
}

async function saveDailyRows(db, task, rows) {
  await db.prepare(`DELETE FROM nordic_climate_daily
    WHERE target_id=? AND observed_date>=? AND observed_date<?`)
    .bind(task.target_id, `${task.year}-${String(task.month).padStart(2, "0")}-01`, task.month === 12
      ? `${task.year + 1}-01-01`
      : `${task.year}-${String(task.month + 1).padStart(2, "0")}-01`).run();

  const chunkSize = 10;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").join(",");
    const binds = [];
    for (const row of chunk) binds.push(
      Number(task.target_id), task.source, String(task.station_id), row.parameter_key, row.observed_date,
      row.avg_value, row.event_share, Number(row.observations || 0),
    );
    await db.prepare(`INSERT INTO nordic_climate_daily (
        target_id, source, station_id, parameter_key, observed_date, avg_value, event_share, observations, updated_at
      ) VALUES ${placeholders}
      ON CONFLICT(target_id, parameter_key, observed_date) DO UPDATE SET
        source=excluded.source,
        station_id=excluded.station_id,
        avg_value=excluded.avg_value,
        event_share=excluded.event_share,
        observations=excluded.observations,
        updated_at=CURRENT_TIMESTAMP`).bind(...binds).run();
  }
}

async function nextTasks(db, limit, country = null) {
  const whereCountry = country ? " AND country=?" : "";
  const query = db.prepare(`SELECT id, target_id, country, source, station_id, station_name, year, month, status
    FROM nordic_climate_tasks
    WHERE status IN ('pending','error')${whereCountry}
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, year DESC, month ASC, source, target_id
    LIMIT ?`);
  const result = country ? await query.bind(country, limit).all() : await query.bind(limit).all();
  return result?.results || [];
}

async function resetStale(db) {
  await db.prepare(`UPDATE nordic_climate_tasks
    SET status='error', error_text='Forrige kjøring ble avbrutt; prøves igjen', updated_at=CURRENT_TIMESTAMP
    WHERE status='running' AND (last_started_at IS NULL OR datetime(last_started_at)<datetime('now','-30 minutes'))`).run();
}

export async function runNordicClimateArchive(db, options = {}) {
  await seedTasks(db);
  await resetStale(db);
  const maxTasks = clampInt(options.maxTasks, 6, 1, 12);
  const requestedCountry = String(options.country || "").trim();
  const country = ["Denmark", "Finland"].includes(requestedCountry) ? requestedCountry : null;
  const tasks = await nextTasks(db, maxTasks, country);
  const details = [];
  const startedAt = new Date().toISOString();

  for (const task of tasks) {
    const taskStarted = new Date().toISOString();
    await db.prepare(`UPDATE nordic_climate_tasks SET status='running', last_started_at=?, error_text=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(taskStarted, task.id).run();
    try {
      const result = task.source === "DMI"
        ? await fetchDmiMonth(task.station_id, Number(task.year), Number(task.month))
        : await fetchFmiMonth(task.station_id, Number(task.year), Number(task.month));
      if (!result.rows.length) {
        await db.prepare(`UPDATE nordic_climate_tasks SET status='unavailable', observations_used=0, rows_written=0,
          last_finished_at=?, error_text='Ingen Q3-observasjoner for denne måneden', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(new Date().toISOString(), task.id).run();
        details.push({ ...task, status: "ikke_tilgjengelig", rowsWritten: 0 });
        continue;
      }
      await saveDailyRows(db, task, result.rows);
      await db.prepare(`UPDATE nordic_climate_tasks SET status='ok', observations_used=?, rows_written=?,
        last_finished_at=?, error_text=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(result.observations, result.rows.length, new Date().toISOString(), task.id).run();
      details.push({ ...task, status: "ok", observationsUsed: result.observations, rowsWritten: result.rows.length });
    } catch (error) {
      const message = String(error?.message || error);
      await db.prepare(`UPDATE nordic_climate_tasks SET status='error', last_finished_at=?, error_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(new Date().toISOString(), message.slice(0, 1500), task.id).run();
      details.push({ ...task, status: "feil", error: message });
    }
  }

  const status = await getNordicClimateStatus(db, { skipSeed: true });
  return {
    ok: details.every((row) => row.status !== "feil"),
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    country: country || "all",
    tasksAttempted: tasks.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    details,
    countries: status.countries,
    complete: status.complete,
    note: "Historikken bygges måned for måned for Q3 2016–2025. DMI hentes per parameter; FMI bruker instituttets timebaserte WFS-produkt. Resultatet lagres som kompakte dagsverdier.",
  };
}

export async function getNordicClimateStatus(db, options = {}) {
  if (!options.skipSeed) await seedTasks(db);
  const [counts, targets, latest] = await Promise.all([
    db.prepare(`SELECT country, status, COUNT(*) AS count FROM nordic_climate_tasks GROUP BY country, status`).all(),
    db.prepare(`SELECT t.id AS target_id, t.country, t.label, t.contract_name, t.contract_id, t.source,
        t.station_id, t.station_name, t.confidence,
        SUM(CASE WHEN c.status='ok' THEN 1 ELSE 0 END) AS ok_tasks,
        SUM(CASE WHEN c.status='unavailable' THEN 1 ELSE 0 END) AS unavailable_tasks,
        SUM(CASE WHEN c.status='error' THEN 1 ELSE 0 END) AS error_tasks,
        SUM(CASE WHEN c.status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining_tasks
      FROM nordic_weather_targets t
      LEFT JOIN nordic_climate_tasks c ON c.target_id=t.id
      WHERE t.active=1 AND t.source IN ('DMI','FMI')
      GROUP BY t.id ORDER BY t.country, t.label`).all(),
    db.prepare(`SELECT target_id, country, source, station_name, year, month, status, last_finished_at, error_text
      FROM nordic_climate_tasks WHERE last_finished_at IS NOT NULL
      ORDER BY datetime(last_finished_at) DESC LIMIT 1`).first(),
  ]);

  const byCountry = { Denmark: {}, Finland: {} };
  for (const row of counts?.results || []) byCountry[row.country][row.status] = Number(row.count || 0);
  const targetRows = (targets?.results || []).map((row) => ({
    ...row,
    target_id: Number(row.target_id),
    contract_id: row.contract_id ? Number(row.contract_id) : null,
    ok_tasks: Number(row.ok_tasks || 0),
    unavailable_tasks: Number(row.unavailable_tasks || 0),
    error_tasks: Number(row.error_tasks || 0),
    remaining_tasks: Number(row.remaining_tasks || 0),
    ready: Number(row.ok_tasks || 0) === TASKS_PER_TARGET,
    proxy: /proxy/i.test(String(row.confidence || "")),
  }));

  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const rows = targetRows.filter((row) => row.country === country);
    const status = byCountry[country] || {};
    const totalTasks = rows.length * TASKS_PER_TARGET;
    const okTasks = Number(status.ok || 0);
    const unavailableTasks = Number(status.unavailable || 0);
    const finishedTasks = okTasks + unavailableTasks;
    countries[country] = {
      targets: rows.length,
      linkedTargets: rows.filter((row) => row.station_id).length,
      contractLinkedTargets: rows.filter((row) => row.contract_id).length,
      proxyTargets: rows.filter((row) => row.proxy).length,
      targetsReady: rows.filter((row) => row.ready).length,
      totalTasks,
      okTasks,
      unavailableTasks,
      errorTasks: Number(status.error || 0),
      remainingTasks: Number(status.pending || 0) + Number(status.running || 0),
      progressPct: totalTasks ? Math.round(100 * finishedTasks / totalTasks) : 0,
      usablePct: totalTasks ? Math.round(100 * okTasks / totalTasks) : 0,
    };
  }

  return {
    baselineStartYear: BASELINE_START_YEAR,
    baselineEndYear: BASELINE_END_YEAR,
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    months: Q3_MONTHS,
    tasksPerTarget: TASKS_PER_TARGET,
    countries,
    complete: ["Denmark", "Finland"].every((country) => countries[country].remainingTasks === 0 && countries[country].errorTasks === 0),
    latestTask: latest || null,
    targetStatus: targetRows,
    note: "Dette er et 10-årig Q3-sammenligningsgrunnlag, ikke offisielle klimanormaler. Historikken bruker samme målestasjon som den løpende datakjeden; manglende eldre data blir synlig som ikke tilgjengelig i stedet for å bytte stasjon automatisk.",
  };
}

function actualMetric(rows, key, threshold) {
  const values = rows.map((row) => numeric(row[key])).filter((value) => value !== null);
  if (!values.length) return null;
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    eventShare: values.filter((value) => value >= threshold).length / values.length,
    count: values.length,
  };
}

async function targetComparison(db, target, days) {
  if (!target.station_id) return null;
  const since = `-${days} days`;
  const currentResult = await db.prepare(`SELECT observed_at, air_temp_c, wind_ms, precipitation_mm
    FROM weather_observations WHERE source=? AND station_id=? AND julianday(observed_at)>=julianday('now', ?)
    ORDER BY observed_at`).bind(target.source, String(target.station_id), since).all();
  const current = currentResult?.results || [];
  const monthDays = [...new Set(current.map((row) => String(row.observed_at || "").slice(5, 10)).filter((x) => /^\d{2}-\d{2}$/.test(x)))];
  if (!monthDays.length) return null;
  const placeholders = monthDays.map(() => "?").join(",");
  const baselineResult = await db.prepare(`SELECT parameter_key,
      SUM(avg_value*observations)/NULLIF(SUM(observations),0) AS avg_value,
      SUM(event_share*observations)/NULLIF(SUM(observations),0) AS event_share,
      COUNT(DISTINCT substr(observed_date,1,4)) AS years
    FROM nordic_climate_daily
    WHERE target_id=? AND substr(observed_date,6,5) IN (${placeholders})
    GROUP BY parameter_key`).bind(Number(target.target_id), ...monthDays).all();
  const baseline = Object.fromEntries((baselineResult?.results || []).map((row) => [row.parameter_key, {
    avg: Number(row.avg_value), eventShare: Number(row.event_share), years: Number(row.years || 0),
  }]));
  const actual = Object.fromEntries(PARAMETERS.map((p) => [p.key, actualMetric(current, p.key, p.threshold)]));
  const precipDelta = actual.precipitation_mm && baseline.precipitation_mm ? actual.precipitation_mm.eventShare - baseline.precipitation_mm.eventShare : null;
  const windDelta = actual.wind_ms && baseline.wind_ms ? actual.wind_ms.eventShare - baseline.wind_ms.eventShare : null;
  const heatDelta = actual.air_temp_c && baseline.air_temp_c ? actual.air_temp_c.eventShare - baseline.air_temp_c.eventShare : null;
  const anomaly = [precipDelta, windDelta, heatDelta].every((x) => x !== null) ? -45 * precipDelta - 20 * windDelta - 8 * heatDelta : null;
  return {
    target_id: Number(target.target_id),
    country: target.country,
    label: target.label,
    contract_name: target.contract_name,
    contract_id: target.contract_id ? Number(target.contract_id) : null,
    source: target.source,
    station_id: String(target.station_id),
    station_name: target.station_name,
    confidence: target.confidence,
    ready: Number.isFinite(anomaly),
    baseline_years: Math.max(baseline.air_temp_c?.years || 0, baseline.wind_ms?.years || 0, baseline.precipitation_mm?.years || 0),
    air_temperature_delta_c: actual.air_temp_c && baseline.air_temp_c ? round(actual.air_temp_c.avg - baseline.air_temp_c.avg, 1) : null,
    precipitation_event_delta_pct: precipDelta === null ? null : round(100 * precipDelta, 1),
    high_wind_delta_pct: windDelta === null ? null : round(100 * windDelta, 1),
    workability_anomaly_points: round(anomaly, 1),
  };
}

export async function getNordicClimateComparison(db, days = 7) {
  await ensureNordicClimateSchema(db);
  const safeDays = clampInt(days, 7, 1, 30);
  const targetResult = await db.prepare(`SELECT t.id AS target_id, t.country, t.label, t.contract_name, t.contract_id,
      t.source, t.station_id, t.station_name, t.confidence,
      c.annual_run_rate_msek
    FROM nordic_weather_targets t
    LEFT JOIN contracts c ON c.id=t.contract_id
    WHERE t.active=1 AND t.source IN ('DMI','FMI')
    ORDER BY t.country, t.label`).all();
  const rows = [];
  for (const target of targetResult?.results || []) {
    const comparison = await targetComparison(db, target, safeDays);
    if (comparison) rows.push({ ...comparison, annual_run_rate_msek: numeric(target.annual_run_rate_msek) });
    else rows.push({
      target_id: Number(target.target_id), country: target.country, label: target.label,
      contract_name: target.contract_name, contract_id: target.contract_id ? Number(target.contract_id) : null,
      source: target.source, station_id: target.station_id, station_name: target.station_name,
      confidence: target.confidence, ready: false, baseline_years: 0,
      air_temperature_delta_c: null, precipitation_event_delta_pct: null,
      high_wind_delta_pct: null, workability_anomaly_points: null,
      annual_run_rate_msek: numeric(target.annual_run_rate_msek),
    });
  }

  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const countryRows = rows.filter((row) => row.country === country);
    const ready = countryRows.filter((row) => row.ready);
    const weighted = ready.filter((row) => Number.isFinite(row.annual_run_rate_msek) && row.annual_run_rate_msek > 0);
    const totalWeight = weighted.reduce((sum, row) => sum + row.annual_run_rate_msek, 0);
    countries[country] = {
      targets: countryRows.length,
      targetsReady: ready.length,
      coveragePct: countryRows.length ? round(100 * ready.length / countryRows.length, 1) : 0,
      economicallyLinkedTargets: countryRows.filter((row) => Number.isFinite(row.annual_run_rate_msek) && row.annual_run_rate_msek > 0).length,
      weightedAnomalyPoints: totalWeight ? round(weighted.reduce((sum, row) => sum + row.workability_anomaly_points * row.annual_run_rate_msek, 0) / totalWeight, 1) : null,
      simpleAnomalyPoints: ready.length ? round(ready.reduce((sum, row) => sum + row.workability_anomaly_points, 0) / ready.length, 1) : null,
    };
  }

  return {
    days: safeDays,
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    countries,
    targets: rows,
    interpretation: "Positivt arbeidsforholdsavvik betyr at vanlig vær har vært mer arbeidsvennlig enn de samme kalenderdagene i Q3 2016–2025. Beregningen bruker temperatur, vind og nedbør; den er et analysegrunnlag og ikke et direkte resultatestimat.",
  };
}
