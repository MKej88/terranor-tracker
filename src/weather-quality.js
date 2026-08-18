import { TRACKER_CONFIG } from "./config.js";

const HOUR_MS = 3600000;
export const CORE_WEATHER_FIELDS = Object.freeze(["air_temp_c", "wind_ms", "precipitation_mm"]);

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function expectedHourlyBuckets(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.max(1, Math.floor((endMs - startMs) / HOUR_MS) + 1);
}

export function summarizeMetricCoverage(rows, startMs, endMs = Date.now(), fields = CORE_WEATHER_FIELDS) {
  const expected = expectedHourlyBuckets(startMs, endMs);
  const bucketsByField = Object.fromEntries(fields.map((field) => [field, new Set()]));
  let earliest = null;
  let latest = null;

  for (const row of rows || []) {
    const ts = Date.parse(row?.observed_at);
    if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
    earliest = earliest === null ? ts : Math.min(earliest, ts);
    latest = latest === null ? ts : Math.max(latest, ts);
    const bucket = Math.floor(ts / HOUR_MS);
    for (const field of fields) {
      const value = Number(row?.[field]);
      if (row?.[field] !== null && row?.[field] !== undefined && row?.[field] !== "" && Number.isFinite(value)) {
        bucketsByField[field].add(bucket);
      }
    }
  }

  const metricCoveragePct = Object.fromEntries(fields.map((field) => [
    field,
    expected ? Math.round(1000 * bucketsByField[field].size / expected) / 10 : 0,
  ]));
  const minimumCoveragePct = fields.length
    ? Math.min(...fields.map((field) => metricCoveragePct[field] || 0))
    : 0;

  return {
    expectedHours: expected,
    earliest: earliest === null ? null : new Date(earliest).toISOString(),
    latest: latest === null ? null : new Date(latest).toISOString(),
    metricHours: Object.fromEntries(fields.map((field) => [field, bucketsByField[field].size])),
    metricCoveragePct,
    minimumCoveragePct,
    ready: minimumCoveragePct >= TRACKER_CONFIG.weatherQuality.readyMetricCoveragePct,
    usable: minimumCoveragePct >= TRACKER_CONFIG.weatherQuality.minMetricCoveragePct,
  };
}

export function historicalReadiness({ years = 0, dayCoveragePct = 0 } = {}) {
  const minYears = TRACKER_CONFIG.weatherQuality.minHistoricalYears;
  const minDays = TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct;
  return {
    years: Number(years || 0),
    dayCoveragePct: Number(dayCoveragePct || 0),
    ready: Number(years || 0) >= minYears && Number(dayCoveragePct || 0) >= minDays,
    minimumYears: minYears,
    minimumDayCoveragePct: minDays,
  };
}
