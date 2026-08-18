import worker from "./index2.js";
import { runFullClimateArchive } from "./climate-full.js";

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers || {}),
  },
});

const DAY_MS = 86400000;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function latestRunMap(rows) {
  return Object.fromEntries((rows || []).map((row) => [row.source, row]));
}

async function getFastPhaseC(db, days = 60) {
  const wantedDays = clamp(Number.parseInt(days, 10) || 60, 7, 120);
  const nowMs = Date.now();

  // Read-only endpoint for the Fase C page. It deliberately avoids ensure/seed calls
  // and replaces the previous N+1 coverage queries with one grouped range query.
  const [targetsResult, runsResult, sourceRangesResult, latestBackfill] = await Promise.all([
    db.prepare(`WITH station_ranges AS (
        SELECT source, station_id, COUNT(*) AS observations,
          MIN(observed_at) AS earliest, MAX(observed_at) AS latest
        FROM weather_observations
        WHERE source IN ('DMI','FMI')
        GROUP BY source, station_id
      )
      SELECT t.id, t.country, t.label, t.contract_name, t.contract_id,
        c.name AS matched_contract, t.location_name, t.latitude, t.longitude,
        t.source, t.station_id, t.station_name, t.distance_km, t.confidence,
        t.notes, t.last_linked_at,
        COALESCE(r.observations,0) AS observations,
        r.earliest, r.latest
      FROM nordic_weather_targets t
      LEFT JOIN contracts c ON c.id=t.contract_id
      LEFT JOIN station_ranges r ON r.source=t.source AND r.station_id=t.station_id
      WHERE t.active=1 AND t.source IN ('DMI','FMI')
      ORDER BY t.country, t.label`).all(),
    db.prepare(`SELECT r.* FROM nordic_weather_runs r
      JOIN (
        SELECT source, MAX(id) AS id
        FROM nordic_weather_runs
        WHERE source IN ('DMI','FMI')
        GROUP BY source
      ) latest ON latest.id=r.id
      ORDER BY r.source`).all(),
    db.prepare(`SELECT source, COUNT(*) AS observations,
        MIN(observed_at) AS earliest, MAX(observed_at) AS latest
      FROM weather_observations
      WHERE source IN ('DMI','FMI')
      GROUP BY source`).all(),
    db.prepare(`SELECT source, target_id, label, chunk_start, chunk_end,
        started_at, finished_at, status, observations_written, error_text
      FROM nordic_backfill_runs ORDER BY id DESC LIMIT 1`).first(),
  ]);

  const targets = (targetsResult?.results || []).map((row) => {
    const linked = Boolean(row.station_id);
    const earliestMs = row.earliest && Number.isFinite(Date.parse(row.earliest))
      ? Date.parse(row.earliest)
      : nowMs;
    const coveredDays = linked ? clamp((nowMs - earliestMs) / DAY_MS, 0, wantedDays) : 0;
    return {
      ...row,
      observations: Number(row.observations || 0),
      covered_days: Math.round(coveredDays * 10) / 10,
      complete: linked && coveredDays >= wantedDays - 0.25,
    };
  });

  const runs = latestRunMap(runsResult?.results || []);
  const ranges = Object.fromEntries((sourceRangesResult?.results || []).map((row) => [row.source, row]));
  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const rows = targets.filter((row) => row.country === country);
    countries[country] = {
      targets: rows.length,
      linked: rows.filter((row) => row.station_id).length,
      matchedContracts: rows.filter((row) => row.contract_id).length,
    };
  }

  const sources = {};
  for (const source of ["DMI", "FMI"]) {
    const run = runs[source] || null;
    const range = ranges[source] || null;
    sources[source] = {
      status: run?.status || "ikke_kjørt",
      lastRun: run,
      observations: Number(range?.observations || 0),
      earliest: range?.earliest || null,
      latest: range?.latest || null,
    };
  }

  const linked = targets.filter((row) => row.station_id).length;
  const complete = targets.filter((row) => row.complete).length;
  const avgCoverage = targets.length
    ? targets.reduce((sum, row) => sum + Number(row.covered_days || 0) / wantedDays, 0) / targets.length
    : 0;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    status: {
      phase: "C",
      sources,
      countries,
      targets,
      methodology: {
        Denmark: "DMI meteorologiske målestasjoner; nærmeste aktive stasjon til kontrakts-/byankeret.",
        Finland: "FMI WFS-observasjoner for nærmeste værstasjon til navngitt sted.",
      },
      limitations: [
        "De fire danske statlige 2026-2029-kontraktene er dekket med regionale værproxyer for de to områdene i Norddanmark og de to i Østdanmark. Eksakte delkontraktsgrenser må fortsatt erstatte proxyene når de er hentet fra anbudsdokumentene.",
        "Finland er utvidet med offentlig listede Terranor-referanseområder hvis oppgitte kontraktsperioder inkluderer 2026. Områder uten dokumentert kontraktsverdi brukes til værdekning, ikke økonomisk vekting.",
        "Sørøst-Finland bruker Lappeenranta som regional værproxy for dreneringsarbeidet og er ikke en eksakt kontraktsgrense.",
      ],
    },
    backfill: {
      phase: "C",
      days: wantedDays,
      targets: targets.length,
      targetsLinked: linked,
      targetsComplete: complete,
      complete: targets.length > 0 && complete === targets.length,
      progressPct: Math.round(clamp(avgCoverage * 100, 0, 100)),
      latestRun: latestBackfill || null,
      targetStatus: targets.map((row) => ({
        id: row.id,
        country: row.country,
        label: row.label,
        source: row.source,
        station_id: row.station_id,
        station_name: row.station_name,
        earliest: row.earliest,
        latest: row.latest,
        observations: row.observations,
        covered_days: row.covered_days,
        complete: row.complete,
      })),
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const specialPath = ["/api/climate/full-run", "/api/fase-c/fast"].includes(url.pathname);
    if (!specialPath) return worker.fetch(request, env);

    // Reuse the existing authentication layer. An authenticated unknown API route
    // returns 404 from index2; unauthenticated requests return 401 and stop here.
    const authCheck = await worker.fetch(request, env);
    if (authCheck.status !== 404) return authCheck;

    try {
      if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });

      if (url.pathname === "/api/fase-c/fast") {
        return json(await getFastPhaseC(env.DB, url.searchParams.get("days") || 60));
      }

      const maxTasks = url.searchParams.get("tasks") || 60;
      return json(await runFullClimateArchive(env.DB, { maxTasks }));
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const cron = String(controller.cron || "");
    if (cron !== "50 * * * *") return worker.scheduled(controller, env);

    if (!env.DB) {
      console.error("Automatisk 10-års værgrunnlag hoppet over: D1-bindingen DB mangler");
      return;
    }

    try {
      const result = await runFullClimateArchive(env.DB, { maxTasks: 60 });
      console.log(JSON.stringify({ event: "scheduled-climate-full-load", cron, ...result }));
    } catch (error) {
      console.error("Automatisk fullføring av 10-års værgrunnlag feilet", error);
    }
  },
};
