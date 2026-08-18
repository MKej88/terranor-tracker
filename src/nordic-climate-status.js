import { getNordicClimateStatus as getBaseNordicClimateStatus } from "./nordic-climate.js";
import {
  BASELINE_END_YEAR,
  BASELINE_START_YEAR,
  QUARTER_END,
  QUARTER_START,
  TRACKER_CONFIG,
} from "./config.js";

const KNOWN_FUTURE_LABELS = new Set(["København", "Kemi", "Ii", "Järvenpää"]);
const CORE_PARAMETERS = ["air_temp_c", "wind_ms", "precipitation_mm"];
const Q3_DAYS_PER_YEAR = 92;
const BASELINE_YEARS = BASELINE_END_YEAR - BASELINE_START_YEAR + 1;
const EXPECTED_DAYS_PER_PARAMETER = Q3_DAYS_PER_YEAR * BASELINE_YEARS;

async function historicalQualityByTarget(db) {
  const result = await db.prepare(`SELECT target_id, parameter_key,
      COUNT(*) AS days,
      COUNT(DISTINCT substr(observed_date,1,4)) AS years
    FROM nordic_climate_daily
    WHERE parameter_key IN ('air_temp_c','wind_ms','precipitation_mm')
      AND CAST(substr(observed_date,1,4) AS INTEGER) BETWEEN ? AND ?
      AND substr(observed_date,6,2) IN ('07','08','09')
    GROUP BY target_id, parameter_key`)
    .bind(BASELINE_START_YEAR, BASELINE_END_YEAR).all();

  const map = new Map();
  for (const row of result?.results || []) {
    const targetId = Number(row.target_id);
    if (!map.has(targetId)) map.set(targetId, {});
    const days = Number(row.days || 0);
    const years = Number(row.years || 0);
    map.get(targetId)[row.parameter_key] = {
      days,
      years,
      dayCoveragePct: Math.round(1000 * days / EXPECTED_DAYS_PER_PARAMETER) / 10,
    };
  }
  return map;
}

function qualityForTarget(metrics = {}) {
  const parameters = Object.fromEntries(CORE_PARAMETERS.map((key) => [key, metrics[key] || {
    days: 0, years: 0, dayCoveragePct: 0,
  }]));
  const minimumYears = Math.min(...CORE_PARAMETERS.map((key) => Number(parameters[key].years || 0)));
  const minimumDayCoveragePct = Math.min(...CORE_PARAMETERS.map((key) => Number(parameters[key].dayCoveragePct || 0)));
  const ready = minimumYears >= TRACKER_CONFIG.weatherQuality.minHistoricalYears
    && minimumDayCoveragePct >= TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct;
  return {
    ready,
    minimumYears,
    minimumDayCoveragePct,
    requiredYears: TRACKER_CONFIG.weatherQuality.minHistoricalYears,
    requiredDayCoveragePct: TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct,
    parameters,
  };
}

export async function getNordicClimateStatus(db) {
  // Basestatus oppretter/oppgraderer nordisk klimaskjema og oppgaver. Les kvalitetsdata etterpå.
  const base = await getBaseNordicClimateStatus(db);
  const [qualityMap, relevanceResult] = await Promise.all([
    historicalQualityByTarget(db),
    db.prepare(`SELECT t.id AS target_id, t.label, t.contract_id,
        c.start_date, c.end_date
      FROM nordic_weather_targets t
      LEFT JOIN contracts c ON c.id=t.contract_id
      WHERE t.active=1 AND t.source IN ('DMI','FMI')`).all(),
  ]);

  const relevance = new Map();
  for (const row of relevanceResult?.results || []) {
    let relevant = true;
    if (row.contract_id) {
      if (row.start_date && String(row.start_date) > QUARTER_END) relevant = false;
      if (row.end_date && String(row.end_date) < QUARTER_START) relevant = false;
    } else if (KNOWN_FUTURE_LABELS.has(String(row.label || ""))) {
      relevant = false;
    }
    relevance.set(Number(row.target_id), relevant);
  }

  const targetStatus = (base.targetStatus || []).map((row) => {
    const historicalQuality = qualityForTarget(qualityMap.get(Number(row.target_id)) || {});
    return {
      ...row,
      ready: historicalQuality.ready,
      task_complete: Number(row.remaining_tasks || 0) === 0 && Number(row.error_tasks || 0) === 0,
      historical_quality: historicalQuality,
      q3_relevant: relevance.get(Number(row.target_id)) !== false,
    };
  });

  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const allRows = targetStatus.filter((row) => row.country === country);
    const rows = allRows.filter((row) => row.q3_relevant);
    const totalTasks = rows.length * Number(base.tasksPerTarget || 30);
    const okTasks = rows.reduce((sum, row) => sum + Number(row.ok_tasks || 0), 0);
    const unavailableTasks = rows.reduce((sum, row) => sum + Number(row.unavailable_tasks || 0), 0);
    const errorTasks = rows.reduce((sum, row) => sum + Number(row.error_tasks || 0), 0);
    const remainingTasks = rows.reduce((sum, row) => sum + Number(row.remaining_tasks || 0), 0);
    const minimumHistoricalCoveragePct = rows.length
      ? Math.round(10 * Math.min(...rows.map((row) => Number(row.historical_quality?.minimumDayCoveragePct || 0)))) / 10
      : 0;
    countries[country] = {
      targets: rows.length,
      futureTargets: allRows.length - rows.length,
      linkedTargets: rows.filter((row) => row.station_id).length,
      contractLinkedTargets: rows.filter((row) => row.contract_id).length,
      proxyTargets: rows.filter((row) => row.proxy).length,
      targetsReady: rows.filter((row) => row.ready).length,
      totalTasks,
      okTasks,
      unavailableTasks,
      errorTasks,
      remainingTasks,
      progressPct: totalTasks ? Math.round(100 * (okTasks + unavailableTasks) / totalTasks) : 0,
      usablePct: totalTasks ? Math.round(100 * okTasks / totalTasks) : 0,
      minimumHistoricalCoveragePct,
    };
  }

  return {
    ...base,
    scope: "Q3 2026",
    qualityVersion: "2.0",
    readinessRule: `Klar krever minst ${TRACKER_CONFIG.weatherQuality.minHistoricalYears} historiske år og ${TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct} % Q3-dagdekning for temperatur, vind og nedbør.`,
    countries,
    targetStatus,
    q3TargetStatus: targetStatus.filter((row) => row.q3_relevant),
    futureTargetStatus: targetStatus.filter((row) => !row.q3_relevant),
    complete: ["Denmark", "Finland"].every((country) => {
      const row = countries[country];
      return row.targets > 0
        && row.linkedTargets === row.targets
        && row.targetsReady === row.targets
        && row.remainingTasks === 0
        && row.errorTasks === 0;
    }),
  };
}
