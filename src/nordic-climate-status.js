import { getNordicClimateStatus as getBaseNordicClimateStatus } from "./nordic-climate.js";

const Q3_START = "2026-07-01";
const Q3_END = "2026-09-30";
const KNOWN_FUTURE_LABELS = new Set(["København", "Kemi", "Ii", "Järvenpää"]);

export async function getNordicClimateStatus(db) {
  const base = await getBaseNordicClimateStatus(db);
  const relevanceResult = await db.prepare(`SELECT t.id AS target_id, t.label, t.contract_id,
      c.start_date, c.end_date
    FROM nordic_weather_targets t
    LEFT JOIN contracts c ON c.id=t.contract_id
    WHERE t.active=1 AND t.source IN ('DMI','FMI')`).all();

  const relevance = new Map();
  for (const row of relevanceResult?.results || []) {
    let relevant = true;
    if (row.contract_id) {
      if (row.start_date && String(row.start_date) > Q3_END) relevant = false;
      if (row.end_date && String(row.end_date) < Q3_START) relevant = false;
    } else if (KNOWN_FUTURE_LABELS.has(String(row.label || ""))) {
      relevant = false;
    }
    relevance.set(Number(row.target_id), relevant);
  }

  const targetStatus = (base.targetStatus || []).map((row) => ({
    ...row,
    q3_relevant: relevance.get(Number(row.target_id)) !== false,
  }));

  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const allRows = targetStatus.filter((row) => row.country === country);
    const rows = allRows.filter((row) => row.q3_relevant);
    const totalTasks = rows.length * Number(base.tasksPerTarget || 30);
    const okTasks = rows.reduce((sum, row) => sum + Number(row.ok_tasks || 0), 0);
    const unavailableTasks = rows.reduce((sum, row) => sum + Number(row.unavailable_tasks || 0), 0);
    const errorTasks = rows.reduce((sum, row) => sum + Number(row.error_tasks || 0), 0);
    const remainingTasks = rows.reduce((sum, row) => sum + Number(row.remaining_tasks || 0), 0);
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
    };
  }

  return {
    ...base,
    scope: "Q3 2026",
    countries,
    targetStatus,
    q3TargetStatus: targetStatus.filter((row) => row.q3_relevant),
    futureTargetStatus: targetStatus.filter((row) => !row.q3_relevant),
    complete: ["Denmark", "Finland"].every((country) => {
      const row = countries[country];
      return row.targets > 0 && row.linkedTargets === row.targets && row.remainingTasks === 0 && row.errorTasks === 0;
    }),
  };
}
