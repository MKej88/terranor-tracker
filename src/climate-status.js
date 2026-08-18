import { getClimateStatus as getBaseClimateStatus } from "./climate.js";
import { BASELINE_END_YEAR, BASELINE_START_YEAR, TRACKER_CONFIG } from "./config.js";

const CORE_PARAMETER_IDS = [1, 4, 7];
const EXPECTED_Q3_DAYS = 92;

async function qualityRows(db) {
  const result = await db.prepare(`SELECT station_id, parameter_id,
      COUNT(*) AS days,
      MIN(years) AS minimum_years,
      MAX(years) AS maximum_years
    FROM climate_normals
    WHERE baseline_start_year=? AND baseline_end_year=?
      AND parameter_id IN (1,4,7)
    GROUP BY station_id, parameter_id`)
    .bind(BASELINE_START_YEAR, BASELINE_END_YEAR).all();
  return result?.results || [];
}

function buildQualityMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const stationId = String(row.station_id);
    if (!map.has(stationId)) map.set(stationId, {});
    const days = Number(row.days || 0);
    const minimumYears = Number(row.minimum_years || 0);
    const dayCoveragePct = Math.round(1000 * days / EXPECTED_Q3_DAYS) / 10;
    map.get(stationId)[Number(row.parameter_id)] = {
      days,
      minimumYears,
      maximumYears: Number(row.maximum_years || 0),
      dayCoveragePct,
      ready: minimumYears >= TRACKER_CONFIG.weatherQuality.minHistoricalYears
        && dayCoveragePct >= TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct,
    };
  }
  return map;
}

export async function getClimateStatus(db) {
  // Basestatus oppretter/oppgraderer skjema og klimajobber. Kvalitetsspørringen må derfor
  // kjøres etterpå, ikke parallelt på en helt ny database.
  const base = await getBaseClimateStatus(db);
  const rows = await qualityRows(db);
  const qualityMap = buildQualityMap(rows);

  const stationStatus = (base.stationStatus || []).map((row) => {
    const metrics = qualityMap.get(String(row.station_id)) || {};
    const parameters = Object.fromEntries(CORE_PARAMETER_IDS.map((id) => [id, metrics[id] || {
      days: 0,
      minimumYears: 0,
      maximumYears: 0,
      dayCoveragePct: 0,
      ready: false,
    }]));
    const qualityReady = CORE_PARAMETER_IDS.every((id) => parameters[id].ready);
    return {
      ...row,
      task_full: Boolean(row.full),
      full: qualityReady,
      historical_quality: {
        ready: qualityReady,
        requiredYears: TRACKER_CONFIG.weatherQuality.minHistoricalYears,
        requiredDayCoveragePct: TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct,
        parameters,
      },
    };
  });

  return {
    ...base,
    qualityVersion: "2.0",
    stationsFullyReady: stationStatus.filter((row) => row.full).length,
    stationStatus,
    complete: stationStatus.length > 0 && stationStatus.every((row) => row.full),
    readinessRule: `Klar krever minst ${TRACKER_CONFIG.weatherQuality.minHistoricalYears} historiske år og ${TRACKER_CONFIG.weatherQuality.readyHistoricalDayCoveragePct} % Q3-dagdekning for temperatur, vind og nedbør.`,
  };
}
