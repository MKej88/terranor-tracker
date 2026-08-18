export const TRACKER_CONFIG = Object.freeze({
  targetQuarter: "Q3 2026",
  quarterStart: "2026-07-01",
  quarterEnd: "2026-09-30",
  q2ReportDate: "2026-08-25",
  q3ReportDate: "2026-11-10",
  climateBaselineStartYear: 2016,
  climateBaselineEndYear: 2025,
  liveHistoryDays: 60,
  weatherQuality: Object.freeze({
    minMetricCoveragePct: 70,
    readyMetricCoveragePct: 85,
    minHistoricalYears: 9,
    readyHistoricalDayCoveragePct: 85,
  }),
});

export const TARGET_QUARTER = TRACKER_CONFIG.targetQuarter;
export const QUARTER_START = TRACKER_CONFIG.quarterStart;
export const QUARTER_END = TRACKER_CONFIG.quarterEnd;
export const QUARTER_START_MS = Date.parse(`${QUARTER_START}T00:00:00Z`);
export const QUARTER_END_MS = Date.parse(`${QUARTER_END}T23:59:59Z`);
export const BASELINE_START_YEAR = TRACKER_CONFIG.climateBaselineStartYear;
export const BASELINE_END_YEAR = TRACKER_CONFIG.climateBaselineEndYear;
