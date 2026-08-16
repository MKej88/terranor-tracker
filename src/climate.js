const SMHI_BASE = "https://opendata-download-metobs.smhi.se/api/version/1.0";
const BASELINE_START_YEAR = 2016;
const BASELINE_END_YEAR = 2025;
const Q3_START = Date.UTC(2026, 6, 1, 0, 0, 0);
const Q3_END = Date.UTC(2026, 8, 30, 23, 59, 59);

const PARAMETERS = [
  { id: 1, key: "air_temperature", name: "Lufttemperatur", eventThreshold: 30 },
  { id: 4, key: "wind_speed", name: "Vindhastighet", eventThreshold: 10 },
  { id: 7, key: "precipitation", name: "Nedbør", eventThreshold: 0.05 },
];

const CLIMATE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS climate_archive_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    station_name TEXT,
    parameter_id INTEGER NOT NULL,
    parameter_name TEXT NOT NULL,
    baseline_start_year INTEGER NOT NULL,
    baseline_end_year INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    observations_used INTEGER DEFAULT 0,
    years_used INTEGER DEFAULT 0,
    rows_written INTEGER DEFAULT 0,
    last_started_at TEXT,
    last_finished_at TEXT,
    error_text TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(station_id, parameter_id, baseline_start_year, baseline_end_year)
  )`,
  `CREATE TABLE IF NOT EXISTS climate_normals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    parameter_id INTEGER NOT NULL,
    month_day TEXT NOT NULL,
    baseline_start_year INTEGER NOT NULL,
    baseline_end_year INTEGER NOT NULL,
    avg_value REAL,
    event_share REAL,
    observations INTEGER NOT NULL DEFAULT 0,
    years INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(station_id, parameter_id, month_day, baseline_start_year, baseline_end_year)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_climate_tasks_status ON climate_archive_tasks(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_climate_normals_station_day ON climate_normals(station_id, month_day)`,
];

export async function ensureClimateSchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await db.batch(CLIMATE_SCHEMA.map((sql) => db.prepare(sql)));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numeric(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replaceAll('""', '"').trim();
  return text;
}

function q3Weight(startText, endText, annualRunRate) {
  const annual = Number(annualRunRate);
  if (!Number.isFinite(annual) || annual <= 0) return null;
  const start = startText ? Date.parse(`${startText}T00:00:00Z`) : Q3_START;
  const end = endText ? Date.parse(`${endText}T23:59:59Z`) : Q3_END;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const overlapStart = Math.max(start, Q3_START);
  const overlapEnd = Math.min(end, Q3_END);
  if (overlapEnd < overlapStart) return null;
  const days = Math.floor((overlapEnd - overlapStart) / 86400000) + 1;
  return annual * days / 365.25;
}

function parseCorrectedArchiveCsv(text, parameter) {
  const groups = new Map();
  let observationsUsed = 0;
  const yearsAll = new Set();

  for (const rawLine of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!rawLine || !rawLine.includes(";")) continue;
    const cells = rawLine.split(";").map(unquote);

    let dateIndex = -1;
    for (let i = 0; i < Math.min(4, cells.length); i += 1) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(cells[i])) {
        dateIndex = i;
        break;
      }
    }
    if (dateIndex < 0) continue;

    const dateText = cells[dateIndex];
    const timeText = cells[dateIndex + 1] || "00:00:00";
    if (!/^\d{2}:\d{2}/.test(timeText)) continue;

    const year = Number(dateText.slice(0, 4));
    const month = Number(dateText.slice(5, 7));
    if (year < BASELINE_START_YEAR || year > BASELINE_END_YEAR || month < 7 || month > 9) continue;

    let value = null;
    let quality = null;
    for (let i = dateIndex + 2; i < cells.length; i += 1) {
      const upper = String(cells[i] || "").toUpperCase();
      if (["G", "Y", "R"].includes(upper)) {
        quality = upper;
        continue;
      }
      if (value === null) value = numeric(cells[i]);
    }
    if (value === null || quality === "R") continue;

    const monthDay = dateText.slice(5, 10);
    const group = groups.get(monthDay) || { sum: 0, count: 0, eventCount: 0, years: new Set() };
    group.sum += value;
    group.count += 1;
    if (value >= parameter.eventThreshold) group.eventCount += 1;
    group.years.add(year);
    groups.set(monthDay, group);
    yearsAll.add(year);
    observationsUsed += 1;
  }

  const rows = [...groups.entries()].map(([monthDay, group]) => ({
    month_day: monthDay,
    avg_value: round(group.sum / group.count, 4),
    event_share: round(group.eventCount / group.count, 5),
    observations: group.count,
    years: group.years.size,
  })).sort((a, b) => a.month_day.localeCompare(b.month_day));

  return { rows, observationsUsed, yearsUsed: yearsAll.size };
}

async function primarySmhiStations(db) {
  const result = await db.prepare(`SELECT DISTINCT l.station_id, l.station_name
    FROM weather_station_links l
    JOIN contracts c ON c.id=l.contract_id
    WHERE l.source='SMHI' AND l.active=1 AND l.rank_no=1 AND c.country='Sweden'
    ORDER BY l.station_id`).all();
  return result?.results || [];
}

async function seedClimateTasks(db) {
  await ensureClimateSchema(db);
  const stations = await primarySmhiStations(db);
  const statements = [];
  for (const station of stations) {
    for (const parameter of PARAMETERS) {
      statements.push(db.prepare(`INSERT INTO climate_archive_tasks (
          station_id, station_name, parameter_id, parameter_name, baseline_start_year, baseline_end_year, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(station_id, parameter_id, baseline_start_year, baseline_end_year) DO UPDATE SET
          station_name=excluded.station_name,
          parameter_name=excluded.parameter_name,
          updated_at=CASE WHEN climate_archive_tasks.status='pending' THEN CURRENT_TIMESTAMP ELSE climate_archive_tasks.updated_at END`)
        .bind(String(station.station_id), station.station_name, parameter.id, parameter.name, BASELINE_START_YEAR, BASELINE_END_YEAR));
    }
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return stations.length;
}

async function fetchCorrectedArchive(stationId, parameterId) {
  const url = `${SMHI_BASE}/parameter/${parameterId}/station/${encodeURIComponent(stationId)}/period/corrected-archive/data.csv`;
  const response = await fetch(url, { headers: { "user-agent": "terranor-tracker/0.5" } });
  if (response.status === 404) return { unavailable: true, text: "", url };
  if (!response.ok) throw new Error(`Historisk SMHI-data feilet for stasjon ${stationId}, parameter ${parameterId}: ${response.status}`);
  return { unavailable: false, text: await response.text(), url };
}

async function nextTasks(db, limit) {
  const result = await db.prepare(`SELECT id, station_id, station_name, parameter_id, parameter_name, status
    FROM climate_archive_tasks
    WHERE baseline_start_year=? AND baseline_end_year=?
      AND status IN ('pending','error')
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC, id ASC
    LIMIT ?`).bind(BASELINE_START_YEAR, BASELINE_END_YEAR, limit).all();
  return result?.results || [];
}

async function saveNormalRows(db, task, parsed) {
  await db.prepare(`DELETE FROM climate_normals
    WHERE station_id=? AND parameter_id=? AND baseline_start_year=? AND baseline_end_year=?`)
    .bind(String(task.station_id), Number(task.parameter_id), BASELINE_START_YEAR, BASELINE_END_YEAR).run();

  const statements = parsed.rows.map((row) => db.prepare(`INSERT INTO climate_normals (
      station_id, parameter_id, month_day, baseline_start_year, baseline_end_year,
      avg_value, event_share, observations, years, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(station_id, parameter_id, month_day, baseline_start_year, baseline_end_year) DO UPDATE SET
      avg_value=excluded.avg_value,
      event_share=excluded.event_share,
      observations=excluded.observations,
      years=excluded.years,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(
      String(task.station_id), Number(task.parameter_id), row.month_day,
      BASELINE_START_YEAR, BASELINE_END_YEAR, row.avg_value, row.event_share,
      row.observations, row.years,
    ));
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
}

export async function runClimateArchive(db, options = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await seedClimateTasks(db);
  const maxTasks = clampInt(options.maxTasks, 1, 1, 2);
  const tasks = await nextTasks(db, maxTasks);
  const startedAt = new Date().toISOString();
  const details = [];

  for (const task of tasks) {
    const parameter = PARAMETERS.find((p) => p.id === Number(task.parameter_id));
    const taskStarted = new Date().toISOString();
    await db.prepare(`UPDATE climate_archive_tasks SET status='running', last_started_at=?, error_text=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(taskStarted, task.id).run();
    try {
      const archive = await fetchCorrectedArchive(task.station_id, task.parameter_id);
      if (archive.unavailable) {
        const finished = new Date().toISOString();
        await db.prepare(`UPDATE climate_archive_tasks SET status='unavailable', last_finished_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(finished, task.id).run();
        details.push({ station_id: task.station_id, station_name: task.station_name, parameter: task.parameter_name, status: "ikke_tilgjengelig" });
        continue;
      }

      const parsed = parseCorrectedArchiveCsv(archive.text, parameter);
      if (!parsed.rows.length) {
        const finished = new Date().toISOString();
        await db.prepare(`UPDATE climate_archive_tasks SET status='unavailable', last_finished_at=?, error_text='Ingen Q3-data i valgt 10-årsperiode', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(finished, task.id).run();
        details.push({ station_id: task.station_id, station_name: task.station_name, parameter: task.parameter_name, status: "ingen_data" });
        continue;
      }

      await saveNormalRows(db, task, parsed);
      const finished = new Date().toISOString();
      await db.prepare(`UPDATE climate_archive_tasks SET status='ok', observations_used=?, years_used=?, rows_written=?,
          last_finished_at=?, error_text=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(parsed.observationsUsed, parsed.yearsUsed, parsed.rows.length, finished, task.id).run();
      details.push({
        station_id: String(task.station_id),
        station_name: task.station_name,
        parameter: task.parameter_name,
        status: "ok",
        observations_used: parsed.observationsUsed,
        years_used: parsed.yearsUsed,
        normaldager_written: parsed.rows.length,
      });
    } catch (error) {
      const finished = new Date().toISOString();
      await db.prepare(`UPDATE climate_archive_tasks SET status='error', last_finished_at=?, error_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(finished, String(error?.message || error).slice(0, 1500), task.id).run();
      details.push({ station_id: task.station_id, station_name: task.station_name, parameter: task.parameter_name, status: "feil", error: String(error?.message || error) });
    }
  }

  return {
    ok: details.every((x) => x.status !== "feil"),
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    tasksAttempted: tasks.length,
    details,
    note: "Sammenligningsgrunnlaget bruker kvalitetssikret SMHI-arkiv for juli-september i 2016-2025. Det er et 10-årig sammenligningsgrunnlag, ikke SMHIs offisielle 30-års klimanormal.",
  };
}

export async function getClimateStatus(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  const stationCount = await seedClimateTasks(db);
  const [counts, stations, latest] = await Promise.all([
    db.prepare(`SELECT status, COUNT(*) AS count FROM climate_archive_tasks
      WHERE baseline_start_year=? AND baseline_end_year=? GROUP BY status`)
      .bind(BASELINE_START_YEAR, BASELINE_END_YEAR).all(),
    db.prepare(`SELECT station_id, MAX(station_name) AS station_name,
        SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_parameters,
        SUM(CASE WHEN status='unavailable' THEN 1 ELSE 0 END) AS unavailable_parameters,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error_parameters,
        SUM(CASE WHEN status='pending' OR status='running' THEN 1 ELSE 0 END) AS remaining_parameters,
        MAX(years_used) AS max_years
      FROM climate_archive_tasks
      WHERE baseline_start_year=? AND baseline_end_year=?
      GROUP BY station_id ORDER BY station_name`)
      .bind(BASELINE_START_YEAR, BASELINE_END_YEAR).all(),
    db.prepare(`SELECT station_id, station_name, parameter_name, status, last_finished_at, error_text
      FROM climate_archive_tasks
      WHERE baseline_start_year=? AND baseline_end_year=? AND last_finished_at IS NOT NULL
      ORDER BY datetime(last_finished_at) DESC LIMIT 1`)
      .bind(BASELINE_START_YEAR, BASELINE_END_YEAR).first(),
  ]);

  const byStatus = Object.fromEntries((counts?.results || []).map((r) => [r.status, Number(r.count || 0)]));
  const totalTasks = stationCount * PARAMETERS.length;
  const finishedTasks = (byStatus.ok || 0) + (byStatus.unavailable || 0);
  const stationRows = (stations?.results || []).map((row) => ({
    ...row,
    ok_parameters: Number(row.ok_parameters || 0),
    unavailable_parameters: Number(row.unavailable_parameters || 0),
    error_parameters: Number(row.error_parameters || 0),
    remaining_parameters: Number(row.remaining_parameters || 0),
    max_years: Number(row.max_years || 0),
    full: Number(row.ok_parameters || 0) === PARAMETERS.length,
  }));

  return {
    baselineStartYear: BASELINE_START_YEAR,
    baselineEndYear: BASELINE_END_YEAR,
    baselineLabel: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    stations: stationCount,
    parametersPerStation: PARAMETERS.length,
    totalTasks,
    finishedTasks,
    okTasks: byStatus.ok || 0,
    unavailableTasks: byStatus.unavailable || 0,
    errorTasks: byStatus.error || 0,
    remainingTasks: (byStatus.pending || 0) + (byStatus.running || 0),
    progressPct: totalTasks ? Math.round(100 * finishedTasks / totalTasks) : 0,
    stationsFullyReady: stationRows.filter((x) => x.full).length,
    latestTask: latest || null,
    stationStatus: stationRows,
    note: "Dette er et 10-årig sammenligningsgrunnlag for Q3-vær, ikke en offisiell 30-års klimanormal.",
  };
}

function actualMetric(rows, parameterId) {
  const values = rows
    .map((r) => r.value)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
  if (!values.length) return null;
  const parameter = PARAMETERS.find((p) => p.id === parameterId);
  const events = values.filter((v) => v >= parameter.eventThreshold).length;
  return { avg: values.reduce((a, b) => a + b, 0) / values.length, eventShare: events / values.length, count: values.length };
}

async function currentStationMetrics(db, stationId, days) {
  const since = `-${Math.max(1, Math.min(30, Number(days) || 7))} days`;
  const result = await db.prepare(`SELECT observed_at, air_temp_c, wind_ms, precipitation_mm
    FROM weather_observations
    WHERE source='SMHI' AND station_id=? AND julianday(observed_at)>=julianday('now', ?)
    ORDER BY observed_at`).bind(String(stationId), since).all();
  const rows = result?.results || [];
  return {
    1: actualMetric(rows.map((r) => ({ value: r.air_temp_c })), 1),
    4: actualMetric(rows.map((r) => ({ value: r.wind_ms })), 4),
    7: actualMetric(rows.map((r) => ({ value: r.precipitation_mm })), 7),
    monthDays: [...new Set(rows.map((r) => String(r.observed_at || "").slice(5, 10)).filter((x) => /^\d{2}-\d{2}$/.test(x)))],
  };
}

async function baselineStationMetrics(db, stationId, monthDays) {
  if (!monthDays.length) return {};
  const placeholders = monthDays.map(() => "?").join(",");
  const result = await db.prepare(`SELECT parameter_id,
      SUM(avg_value*observations)/NULLIF(SUM(observations),0) AS avg_value,
      SUM(event_share*observations)/NULLIF(SUM(observations),0) AS event_share,
      SUM(observations) AS observations,
      MAX(years) AS years
    FROM climate_normals
    WHERE station_id=? AND baseline_start_year=? AND baseline_end_year=?
      AND month_day IN (${placeholders})
    GROUP BY parameter_id`)
    .bind(String(stationId), BASELINE_START_YEAR, BASELINE_END_YEAR, ...monthDays).all();
  return Object.fromEntries((result?.results || []).map((r) => [Number(r.parameter_id), {
    avg: Number(r.avg_value), eventShare: Number(r.event_share), observations: Number(r.observations), years: Number(r.years),
  }]));
}

export async function getClimateComparison(db, days = 7) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureClimateSchema(db);
  const safeDays = clampInt(days, 7, 1, 30);
  const links = await db.prepare(`SELECT c.id AS contract_id, c.name AS contract_name,
      c.start_date, c.end_date, c.annual_run_rate_msek,
      l.station_id, l.station_name, l.distance_km
    FROM contracts c
    JOIN weather_station_links l ON l.contract_id=c.id
    WHERE c.country='Sweden' AND l.source='SMHI' AND l.active=1 AND l.rank_no=1
      AND (c.start_date IS NULL OR c.start_date<='2026-09-30')
      AND (c.end_date IS NULL OR c.end_date>='2026-07-01')
    ORDER BY c.name`).all();

  const rows = [];
  for (const link of links?.results || []) {
    const actual = await currentStationMetrics(db, link.station_id, safeDays);
    const baseline = await baselineStationMetrics(db, link.station_id, actual.monthDays);
    const precipDelta = actual[7] && baseline[7] ? actual[7].eventShare - baseline[7].eventShare : null;
    const windDelta = actual[4] && baseline[4] ? actual[4].eventShare - baseline[4].eventShare : null;
    const heatDelta = actual[1] && baseline[1] ? actual[1].eventShare - baseline[1].eventShare : null;
    const anomalyPoints = [precipDelta, windDelta, heatDelta].every((x) => x !== null)
      ? -45 * precipDelta - 20 * windDelta - 8 * heatDelta
      : null;
    const weight = q3Weight(link.start_date, link.end_date, link.annual_run_rate_msek);
    rows.push({
      contract_id: Number(link.contract_id),
      contract_name: link.contract_name,
      station_id: String(link.station_id),
      station_name: link.station_name,
      distance_km: link.distance_km,
      q3_weight_msek: round(weight, 3),
      ready: anomalyPoints !== null,
      workability_anomaly_points: round(anomalyPoints, 1),
      air_temperature_delta_c: actual[1] && baseline[1] ? round(actual[1].avg - baseline[1].avg, 1) : null,
      precipitation_event_delta_pct: precipDelta === null ? null : round(100 * precipDelta, 1),
      high_wind_delta_pct: windDelta === null ? null : round(100 * windDelta, 1),
      heat_event_delta_pct: heatDelta === null ? null : round(100 * heatDelta, 1),
      baseline_years: Math.max(baseline[1]?.years || 0, baseline[4]?.years || 0, baseline[7]?.years || 0),
    });
  }

  const ready = rows.filter((x) => Number.isFinite(x.workability_anomaly_points));
  const weighted = ready.filter((x) => Number.isFinite(x.q3_weight_msek) && x.q3_weight_msek > 0);
  const totalWeight = weighted.reduce((sum, row) => sum + row.q3_weight_msek, 0);
  const sweden = totalWeight
    ? round(weighted.reduce((sum, row) => sum + row.workability_anomaly_points * row.q3_weight_msek, 0) / totalWeight, 1)
    : null;

  return {
    days: safeDays,
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    contractsReady: ready.length,
    contractsTotal: rows.length,
    swedenWorkabilityAnomalyPoints: sweden,
    weightedCoveragePct: rows.reduce((sum, row) => sum + (Number(row.q3_weight_msek) || 0), 0)
      ? round(100 * totalWeight / rows.reduce((sum, row) => sum + (Number(row.q3_weight_msek) || 0), 0), 1)
      : 0,
    interpretation: "Positivt tall betyr at vanlig vær ved SMHI-stasjonen har vært mer arbeidsvennlig enn 10-årsgrunnlaget; negativt tall betyr mindre arbeidsvennlig. Veibaneforhold fra Trafikverket inngår ikke i denne historiske sammenligningen.",
    contracts: rows,
  };
}
