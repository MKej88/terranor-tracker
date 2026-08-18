import { ensureClimateSchema } from "./climate.js";

const SMHI_BASE = "https://opendata-download-metobs.smhi.se/api/version/1.0";
const BASELINE_START_YEAR = 2016;
const BASELINE_END_YEAR = 2025;
const PARAMETERS = [
  { id: 1, name: "Lufttemperatur", eventThreshold: 30 },
  { id: 4, name: "Vindhastighet", eventThreshold: 10 },
  { id: 7, name: "Nedbør", eventThreshold: 0.05 },
];
const INSERT_ROWS_PER_QUERY = 10; // 9 bindings per row = 90, comfortably below D1's binding ceiling.

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

async function resetStaleRunningTasks(db) {
  await db.prepare(`UPDATE climate_archive_tasks
    SET status='error', error_text='Forrige kjøring ble avbrutt; prøves på nytt', updated_at=CURRENT_TIMESTAMP
    WHERE baseline_start_year=? AND baseline_end_year=? AND status='running'
      AND (last_started_at IS NULL OR datetime(last_started_at) < datetime('now','-20 minutes'))`)
    .bind(BASELINE_START_YEAR, BASELINE_END_YEAR).run();
}

async function fetchCorrectedArchive(stationId, parameterId) {
  const url = `${SMHI_BASE}/parameter/${parameterId}/station/${encodeURIComponent(stationId)}/period/corrected-archive/data.csv`;
  const response = await fetch(url, { headers: { "user-agent": "terranor-tracker/1.0-paid" } });
  if (response.status === 404) return { unavailable: true, text: "" };
  if (!response.ok) throw new Error(`Historisk SMHI-data feilet for stasjon ${stationId}, parameter ${parameterId}: ${response.status}`);
  return { unavailable: false, text: await response.text() };
}

async function nextTasks(db, limit) {
  const result = await db.prepare(`SELECT id, station_id, station_name, parameter_id, parameter_name, status
    FROM climate_archive_tasks
    WHERE baseline_start_year=? AND baseline_end_year=? AND status IN ('pending','error')
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC, id ASC
    LIMIT ?`).bind(BASELINE_START_YEAR, BASELINE_END_YEAR, limit).all();
  return result?.results || [];
}

async function insertNormalChunk(db, task, rows) {
  if (!rows.length) return;
  const valuesSql = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").join(",");
  const binds = [];
  for (const row of rows) {
    binds.push(
      String(task.station_id),
      Number(task.parameter_id),
      row.month_day,
      BASELINE_START_YEAR,
      BASELINE_END_YEAR,
      row.avg_value,
      row.event_share,
      row.observations,
      row.years,
    );
  }
  await db.prepare(`INSERT INTO climate_normals (
      station_id, parameter_id, month_day, baseline_start_year, baseline_end_year,
      avg_value, event_share, observations, years, updated_at
    ) VALUES ${valuesSql}
    ON CONFLICT(station_id, parameter_id, month_day, baseline_start_year, baseline_end_year) DO UPDATE SET
      avg_value=excluded.avg_value,
      event_share=excluded.event_share,
      observations=excluded.observations,
      years=excluded.years,
      updated_at=CURRENT_TIMESTAMP`).bind(...binds).run();
}

async function saveNormalRows(db, task, parsed) {
  await db.prepare(`DELETE FROM climate_normals
    WHERE station_id=? AND parameter_id=? AND baseline_start_year=? AND baseline_end_year=?`)
    .bind(String(task.station_id), Number(task.parameter_id), BASELINE_START_YEAR, BASELINE_END_YEAR).run();

  for (let i = 0; i < parsed.rows.length; i += INSERT_ROWS_PER_QUERY) {
    await insertNormalChunk(db, task, parsed.rows.slice(i, i + INSERT_ROWS_PER_QUERY));
  }
}

async function taskCounts(db) {
  const result = await db.prepare(`SELECT status, COUNT(*) AS count
    FROM climate_archive_tasks
    WHERE baseline_start_year=? AND baseline_end_year=?
    GROUP BY status`).bind(BASELINE_START_YEAR, BASELINE_END_YEAR).all();
  return Object.fromEntries((result?.results || []).map((row) => [row.status, Number(row.count || 0)]));
}

export async function runFullClimateArchive(db, options = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  const stationCount = await seedClimateTasks(db);
  await resetStaleRunningTasks(db);

  const maxTasks = clampInt(options.maxTasks, 60, 1, 60);
  const tasks = await nextTasks(db, maxTasks);
  const startedAt = new Date().toISOString();
  const details = [];

  for (const task of tasks) {
    const parameter = PARAMETERS.find((p) => p.id === Number(task.parameter_id));
    const taskStarted = new Date().toISOString();
    await db.prepare(`UPDATE climate_archive_tasks
      SET status='running', last_started_at=?, error_text=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).bind(taskStarted, task.id).run();

    try {
      const archive = await fetchCorrectedArchive(task.station_id, task.parameter_id);
      if (archive.unavailable) {
        const finished = new Date().toISOString();
        await db.prepare(`UPDATE climate_archive_tasks
          SET status='unavailable', last_finished_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(finished, task.id).run();
        details.push({ station_id: String(task.station_id), station_name: task.station_name, parameter: task.parameter_name, status: "ikke_tilgjengelig" });
        continue;
      }

      const parsed = parseCorrectedArchiveCsv(archive.text, parameter);
      if (!parsed.rows.length) {
        const finished = new Date().toISOString();
        await db.prepare(`UPDATE climate_archive_tasks
          SET status='unavailable', last_finished_at=?, error_text='Ingen Q3-data i valgt 10-årsperiode', updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).bind(finished, task.id).run();
        details.push({ station_id: String(task.station_id), station_name: task.station_name, parameter: task.parameter_name, status: "ingen_data" });
        continue;
      }

      await saveNormalRows(db, task, parsed);
      const finished = new Date().toISOString();
      await db.prepare(`UPDATE climate_archive_tasks
        SET status='ok', observations_used=?, years_used=?, rows_written=?, last_finished_at=?, error_text=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).bind(parsed.observationsUsed, parsed.yearsUsed, parsed.rows.length, finished, task.id).run();
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
      await db.prepare(`UPDATE climate_archive_tasks
        SET status='error', last_finished_at=?, error_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(finished, String(error?.message || error).slice(0, 1500), task.id).run();
      details.push({
        station_id: String(task.station_id),
        station_name: task.station_name,
        parameter: task.parameter_name,
        status: "feil",
        error: String(error?.message || error),
      });
    }
  }

  const counts = await taskCounts(db);
  const totalTasks = stationCount * PARAMETERS.length;
  const finishedTasks = Number(counts.ok || 0) + Number(counts.unavailable || 0);
  const remainingTasks = Number(counts.pending || 0) + Number(counts.running || 0) + Number(counts.error || 0);

  return {
    ok: details.every((row) => row.status !== "feil"),
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    mode: "paid-full-load",
    startedAt,
    finishedAt: new Date().toISOString(),
    tasksAttempted: tasks.length,
    totalTasks,
    finishedTasks,
    remainingTasks,
    progressPct: totalTasks ? Math.round(100 * finishedTasks / totalTasks) : 0,
    complete: remainingTasks === 0,
    details,
    note: "Paid-kjøringen forsøker alle gjenstående stasjon/parameter-kombinasjoner i én Worker-kjøring. Arkivene behandles sekvensielt for lavt minnebruk, mens D1-skrivingen samles i fler-radsoperasjoner for å holde databaseforbruket nede.",
  };
}
