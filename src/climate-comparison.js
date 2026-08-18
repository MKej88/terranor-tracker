import { getClimateComparison as getBaseClimateComparison } from "./climate.js";
import { getClimateStatus } from "./climate-status.js";

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

export async function getClimateComparison(db, days = 7) {
  // Baseberegningen beholder den validerte anomali-logikken. 2.0-laget filtrerer
  // resultatet mot den strengere historiske readiness-regelen før avvik eksponeres.
  const base = await getBaseClimateComparison(db, days);
  const status = await getClimateStatus(db);
  const readyStations = new Set((status?.stationStatus || [])
    .filter((row) => row.full)
    .map((row) => String(row.station_id)));

  const contracts = (base?.contracts || []).map((row) => {
    const qualityReady = readyStations.has(String(row.station_id));
    const ready = Boolean(row.ready && qualityReady);
    return {
      ...row,
      ready,
      quality_ready: qualityReady,
      workability_anomaly_points: ready ? row.workability_anomaly_points : null,
      air_temperature_delta_c: ready ? row.air_temperature_delta_c : null,
      precipitation_event_delta_pct: ready ? row.precipitation_event_delta_pct : null,
      high_wind_delta_pct: ready ? row.high_wind_delta_pct : null,
      heat_event_delta_pct: ready ? row.heat_event_delta_pct : null,
    };
  });

  const ready = contracts.filter((row) => Number.isFinite(Number(row.workability_anomaly_points)));
  const weighted = ready.filter((row) => Number.isFinite(Number(row.q3_weight_msek)) && Number(row.q3_weight_msek) > 0);
  const totalWeight = weighted.reduce((sum, row) => sum + Number(row.q3_weight_msek), 0);
  const allKnownWeight = contracts.reduce((sum, row) => sum + (Number(row.q3_weight_msek) || 0), 0);
  const sweden = totalWeight
    ? round(weighted.reduce((sum, row) => sum + Number(row.workability_anomaly_points) * Number(row.q3_weight_msek), 0) / totalWeight, 1)
    : null;

  return {
    ...base,
    qualityVersion: "2.0",
    contractsReady: ready.length,
    contractsTotal: contracts.length,
    swedenWorkabilityAnomalyPoints: sweden,
    weightedCoveragePct: allKnownWeight ? round(100 * totalWeight / allKnownWeight, 1) : 0,
    interpretation: `${base?.interpretation || ""} I Tracker 2.0 vises avvik bare for stasjoner som oppfyller kravet til historiske år og Q3-dagdekning.`.trim(),
    contracts,
  };
}
