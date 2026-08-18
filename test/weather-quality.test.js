import test from "node:test";
import assert from "node:assert/strict";
import { expectedHourlyBuckets, summarizeMetricCoverage, historicalReadiness } from "../src/weather-quality.js";

test("forventede timebøtter inkluderer begge endepunkter", () => {
  const start = Date.parse("2026-08-01T00:00:00Z");
  const end = Date.parse("2026-08-01T23:00:00Z");
  assert.equal(expectedHourlyBuckets(start, end), 24);
});

test("manglende nedbør gir ikke falsk full dekning", () => {
  const start = Date.parse("2026-08-01T00:00:00Z");
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    observed_at: new Date(start + hour * 3600000).toISOString(),
    air_temp_c: 15,
    wind_ms: 3,
    precipitation_mm: hour < 6 ? 0 : null,
  }));
  const quality = summarizeMetricCoverage(rows, start, start + 23 * 3600000);
  assert.equal(quality.metricCoveragePct.air_temp_c, 100);
  assert.equal(quality.metricCoveragePct.precipitation_mm, 25);
  assert.equal(quality.ready, false);
  assert.equal(quality.usable, false);
});

test("historisk readiness krever både år og dagdekning", () => {
  assert.equal(historicalReadiness({ years: 10, dayCoveragePct: 90 }).ready, true);
  assert.equal(historicalReadiness({ years: 8, dayCoveragePct: 95 }).ready, false);
  assert.equal(historicalReadiness({ years: 10, dayCoveragePct: 70 }).ready, false);
});
