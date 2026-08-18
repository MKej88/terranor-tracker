import { ensureNordicClimateSchema } from "./nordic-climate.js";
import {
  BASELINE_END_YEAR,
  BASELINE_START_YEAR,
  QUARTER_END,
  QUARTER_START,
  TARGET_QUARTER,
  TRACKER_CONFIG,
} from "./config.js";

const PARAMETERS = [
  { key: "air_temp_c", threshold: 30 },
  { key: "wind_ms", threshold: 10 },
  { key: "precipitation_mm", threshold: 0.05 },
];
const BASELINE_YEARS = BASELINE_END_YEAR - BASELINE_START_YEAR + 1;

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = numeric(value);
  if (n === null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function actualMetric(rows, key, threshold, expectedHours) {
  const values = rows.map((row) => numeric(row[key])).filter((value) => value !== null);
  if (!values.length) return null;
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    eventShare: values.filter((value) => value >= threshold).length / values.length,
    count: values.length,
    coveragePct: expectedHours ? round(100 * values.length / expectedHours, 1) : 0,
  };
}

async function targetComparison(db, target, days) {
  if (!target.station_id) return null;
  const currentResult = await db.prepare(`SELECT observed_at, air_temp_c, wind_ms, precipitation_mm
    FROM weather_observations
    WHERE source=? AND station_id=? AND julianday(observed_at)>=julianday('now', ?)
    ORDER BY observed_at`)
    .bind(target.source, String(target.station_id), `-${days} days`).all();
  const current = currentResult?.results || [];
  const monthDays = [...new Set(current
    .map((row) => String(row.observed_at || "").slice(5, 10))
    .filter((value) => /^\d{2}-\d{2}$/.test(value)))];
  if (!monthDays.length) return null;

  const placeholders = monthDays.map(() => "?").join(",");
  const baselineResult = await db.prepare(`SELECT parameter_key,
      SUM(avg_value*observations)/NULLIF(SUM(observations),0) AS avg_value,
      SUM(event_share*observations)/NULLIF(SUM(observations),0) AS event_share,
      COUNT(*) AS days,
      COUNT(DISTINCT substr(observed_date,1,4)) AS years
    FROM nordic_climate_daily
    WHERE target_id=?
      AND CAST(substr(observed_date,1,4) AS INTEGER) BETWEEN ? AND ?
      AND substr(observed_date,6,5) IN (${placeholders})
    GROUP BY parameter_key`)
    .bind(Number(target.target_id), BASELINE_START_YEAR, BASELINE_END_YEAR, ...monthDays).all();

  const expectedBaselineDays = Math.max(1, monthDays.length * BASELINE_YEARS);
  const baseline = Object.fromEntries((baselineResult?.results || []).map((row) => [row.parameter_key, {
    avg: numeric(row.avg_value),
    eventShare: numeric(row.event_share),
    years: Number(row.years || 0),
    days: Number(row.days || 0),
    dayCoveragePct: round(100 * Number(row.days || 0) / expectedBaselineDays, 1),
  }]));
  const expectedCurrentHours = Math.max(1, days * 24);
  const actual = Object.fromEntries(PARAMETERS.map((parameter) => [
    parameter.key,
    actualMetric(current, parameter.key, parameter.threshold, expectedCurrentHours),
  ]));

  const currentQualityReady = PARAMETERS.every((parameter) =>
    Number(actual[parameter.key]?.coveragePct || 0) >= TRACKER_CONFIG.weatherQuality.minMetricCoveragePct);
  const baselineQualityReady = PARAMETERS.every((parameter) => {
    const row = baseline[parameter.key];
    return Number(row?.years || 0) >= TRACKER_CONFIG.weatherQuality.minHistoricalYears
      && Number(row?.dayCoveragePct || 0) >= TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct;
  });

  const hasPrecip = actual.precipitation_mm && baseline.precipitation_mm && baseline.precipitation_mm.eventShare !== null;
  const hasWind = actual.wind_ms && baseline.wind_ms && baseline.wind_ms.eventShare !== null;
  const hasHeat = actual.air_temp_c && baseline.air_temp_c && baseline.air_temp_c.eventShare !== null;
  const precipDelta = hasPrecip ? actual.precipitation_mm.eventShare - baseline.precipitation_mm.eventShare : null;
  const windDelta = hasWind ? actual.wind_ms.eventShare - baseline.wind_ms.eventShare : null;
  const heatDelta = hasHeat ? actual.air_temp_c.eventShare - baseline.air_temp_c.eventShare : null;
  const rawAnomaly = [precipDelta, windDelta, heatDelta].every((value) => value !== null)
    ? -45 * precipDelta - 20 * windDelta - 8 * heatDelta
    : null;
  const anomaly = currentQualityReady && baselineQualityReady ? rawAnomaly : null;
  const hasTemperatureAvg = actual.air_temp_c && baseline.air_temp_c && baseline.air_temp_c.avg !== null;
  const minimumBaselineYears = Math.min(...PARAMETERS.map((parameter) => Number(baseline[parameter.key]?.years || 0)));
  const minimumBaselineDayCoveragePct = Math.min(...PARAMETERS.map((parameter) => Number(baseline[parameter.key]?.dayCoveragePct || 0)));
  const minimumCurrentCoveragePct = Math.min(...PARAMETERS.map((parameter) => Number(actual[parameter.key]?.coveragePct || 0)));

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
    ready: anomaly !== null,
    baseline_years: minimumBaselineYears,
    data_quality: {
      current_minimum_coverage_pct: round(minimumCurrentCoveragePct, 1),
      baseline_minimum_day_coverage_pct: round(minimumBaselineDayCoveragePct, 1),
      baseline_minimum_years: minimumBaselineYears,
      current_ready: currentQualityReady,
      baseline_ready: baselineQualityReady,
    },
    air_temperature_delta_c: hasTemperatureAvg && baselineQualityReady && currentQualityReady
      ? round(actual.air_temp_c.avg - baseline.air_temp_c.avg, 1)
      : null,
    precipitation_event_delta_pct: anomaly === null || precipDelta === null ? null : round(100 * precipDelta, 1),
    high_wind_delta_pct: anomaly === null || windDelta === null ? null : round(100 * windDelta, 1),
    workability_anomaly_points: round(anomaly, 1),
  };
}

export async function getNordicClimateComparison(db, days = 7) {
  await ensureNordicClimateSchema(db);
  const safeDays = clampInt(days, 7, 1, 30);
  const targetResult = await db.prepare(`SELECT t.id AS target_id, t.country, t.label, t.contract_name, t.contract_id,
      t.source, t.station_id, t.station_name, t.confidence, c.annual_run_rate_msek
    FROM nordic_weather_targets t
    LEFT JOIN contracts c ON c.id=t.contract_id
    WHERE t.active=1 AND t.source IN ('DMI','FMI')
      AND (
        (c.id IS NOT NULL
          AND (c.start_date IS NULL OR c.start_date<=?)
          AND (c.end_date IS NULL OR c.end_date>=?))
        OR
        (c.id IS NULL AND t.label NOT IN ('København','Kemi','Ii','Järvenpää'))
      )
    ORDER BY t.country, t.label`).bind(QUARTER_END, QUARTER_START).all();

  const rows = [];
  for (const target of targetResult?.results || []) {
    const comparison = await targetComparison(db, target, safeDays);
    if (comparison) {
      rows.push({ ...comparison, annual_run_rate_msek: numeric(target.annual_run_rate_msek) });
      continue;
    }
    rows.push({
      target_id: Number(target.target_id),
      country: target.country,
      label: target.label,
      contract_name: target.contract_name,
      contract_id: target.contract_id ? Number(target.contract_id) : null,
      source: target.source,
      station_id: target.station_id,
      station_name: target.station_name,
      confidence: target.confidence,
      ready: false,
      baseline_years: 0,
      data_quality: {
        current_minimum_coverage_pct: 0,
        baseline_minimum_day_coverage_pct: 0,
        baseline_minimum_years: 0,
        current_ready: false,
        baseline_ready: false,
      },
      air_temperature_delta_c: null,
      precipitation_event_delta_pct: null,
      high_wind_delta_pct: null,
      workability_anomaly_points: null,
      annual_run_rate_msek: numeric(target.annual_run_rate_msek),
    });
  }

  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const countryRows = rows.filter((row) => row.country === country);
    const ready = countryRows.filter((row) => row.ready);
    const economicallyLinked = countryRows.filter((row) => Number.isFinite(row.annual_run_rate_msek) && row.annual_run_rate_msek > 0);
    const weightedReady = ready.filter((row) => Number.isFinite(row.annual_run_rate_msek) && row.annual_run_rate_msek > 0);
    const totalWeight = weightedReady.reduce((sum, row) => sum + row.annual_run_rate_msek, 0);
    countries[country] = {
      targets: countryRows.length,
      targetsReady: ready.length,
      coveragePct: countryRows.length ? round(100 * ready.length / countryRows.length, 1) : 0,
      economicallyLinkedTargets: economicallyLinked.length,
      weightedAnomalyPoints: totalWeight
        ? round(weightedReady.reduce((sum, row) => sum + row.workability_anomaly_points * row.annual_run_rate_msek, 0) / totalWeight, 1)
        : null,
      simpleAnomalyPoints: ready.length
        ? round(ready.reduce((sum, row) => sum + row.workability_anomaly_points, 0) / ready.length, 1)
        : null,
    };
  }

  return {
    days: safeDays,
    scope: TARGET_QUARTER,
    baseline: `${BASELINE_START_YEAR}-${BASELINE_END_YEAR}`,
    qualityVersion: "2.0",
    countries,
    targets: rows,
    interpretation: `Positivt arbeidsforholdsavvik betyr at vanlig vær har vært mer arbeidsvennlig enn de samme kalenderdagene i Q3 ${BASELINE_START_YEAR}–${BASELINE_END_YEAR}. Sammenligning vises bare når løpende data og historikk oppfyller kvalitetskravene. Beregningen er et analysegrunnlag og ikke et direkte resultatestimat.`,
  };
}
