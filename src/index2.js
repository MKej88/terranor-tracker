import baseWorker from "./index.js";
import { getBackfillStatus, runSmhiBackfill } from "./backfill.js";
import { getContractBridge } from "./bridge.js";
import { addSignal, getSignalSummary, listSignals } from "./signals.js";
import { getDataQuality } from "./quality.js";
import { getClimateComparison, getClimateStatus, runClimateArchive } from "./climate.js";
import { getGeographyStatus } from "./geography.js";
import {
  getActivityStatus,
  listActivityCandidates,
  reviewActivityCandidate,
  runActivityMonitor,
} from "./activity.js";
import { getNordicWeatherStatus } from "./nordic.js";
import { runDmiWeather } from "./dmi.js";
import { runFmiWeather } from "./fmi.js";
import { ensureNordicContracts } from "./nordic-contracts.js";
import { ensureNordicExtraTargets } from "./nordic-extra-targets.js";
import { ensureDenmarkStateTargets } from "./nordic-denmark-targets.js";
import { getNordicBackfillStatus, runNordicBackfill } from "./nordic-backfill.js";
import { collectSmhiWeather } from "./weather.js";
import { collectVvisWeather } from "./vvis.js";
import { calculateWorkability } from "./workability.js";

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers || {}),
  },
});

async function authenticatedFallback(request, env) {
  return baseWorker.fetch(request, env);
}

async function baseResponseWithNorwegianLogin(request, env, url) {
  const response = await baseWorker.fetch(request, env);
  if (url.pathname !== "/login" || !String(response.headers.get("content-type") || "").includes("text/html")) {
    return response;
  }

  const body = (await response.text())
    .replace("Privat earnings nowcast", "Privat resultatestimat")
    .replace("Cloudflare-secrets", "hemmelige miljøvariabler i Cloudflare");

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function ensurePhaseC(db) {
  await ensureNordicContracts(db);
  await ensureNordicExtraTargets(db);
  await ensureDenmarkStateTargets(db);
}

async function getPhaseCStatus(db) {
  const status = await getNordicWeatherStatus(db);
  status.limitations = [
    "De fire danske statlige 2026-2029-kontraktene er nå dekket med regionale værproxyer for de to områdene i Norddanmark og de to i Østdanmark. Eksakte delkontraktsgrenser må fortsatt erstatte proxyene når de er hentet fra anbudsdokumentene.",
    "Finland er utvidet med de offentlig listede Terranor-referanseområdene hvis oppgitte kontraktsperioder inkluderer 2026. Kontraktsverdi og årlig omsetningstakt er ikke dokumentert for alle disse områdene, så de brukes foreløpig til værdekning og ikke økonomisk vekting.",
    "Sørøst-Finland bruker Lappeenranta som regional værproxy for dreneringsarbeidet og er ikke en eksakt kontraktsgrense.",
  ];
  return status;
}

function collectionStatus(run, fallback = "ready") {
  if (run?.status === "ok") return "active";
  if (["error", "partial"].includes(String(run?.status || ""))) return "error";
  return fallback;
}

async function getFastOverview(db, env) {
  const [smhiRun, vvisRun, dmiRun, fmiRun, workability, contracts, weather, nordicCounts, nordicObservations] = await Promise.all([
    db.prepare(`SELECT source, status, started_at, finished_at, observations_written, error_text
      FROM weather_collection_runs WHERE source='SMHI' ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT source, status, started_at, finished_at, observations_written, error_text
      FROM weather_collection_runs WHERE source='VVIS' ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT source, status, started_at, finished_at, targets_attempted, targets_completed,
      observations_written, error_text FROM nordic_weather_runs WHERE source='DMI' ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT source, status, started_at, finished_at, targets_attempted, targets_completed,
      observations_written, error_text FROM nordic_weather_runs WHERE source='FMI' ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT MAX(generated_at) AS generated_at FROM workability_snapshots`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM contracts`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM weather_observations`).first(),
    db.prepare(`SELECT country, COUNT(*) AS targets,
      SUM(CASE WHEN station_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
      FROM nordic_weather_targets WHERE active=1 GROUP BY country`).all(),
    db.prepare(`SELECT source, COUNT(*) AS observations, MAX(observed_at) AS latest
      FROM weather_observations WHERE source IN ('DMI','FMI') GROUP BY source`).all(),
  ]);

  const countries = Object.fromEntries((nordicCounts?.results || []).map((row) => [row.country, {
    targets: Number(row.targets || 0),
    linked: Number(row.linked || 0),
  }]));
  const ranges = Object.fromEntries((nordicObservations?.results || []).map((row) => [row.source, row]));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataCollection: {
      contracts: "seeded",
      smhi: collectionStatus(smhiRun),
      trafficWeather: collectionStatus(vvisRun, env.TRAFIKVERKET_API_KEY ? "ready" : "awaiting API key"),
      workability: workability?.generated_at ? "active" : "warming_up",
      forecastHistory: "database connected",
      dmi: collectionStatus(dmiRun),
      fmi: collectionStatus(fmiRun),
    },
    tables: {
      contracts: Number(contracts?.count || 0),
      weatherObservations: Number(weather?.count || 0),
    },
    sources: {
      DMI: {
        status: dmiRun?.status || "ikke_kjørt",
        lastRun: dmiRun || null,
        observations: Number(ranges?.DMI?.observations || 0),
        latest: ranges?.DMI?.latest || null,
      },
      FMI: {
        status: fmiRun?.status || "ikke_kjørt",
        lastRun: fmiRun || null,
        observations: Number(ranges?.FMI?.observations || 0),
        latest: ranges?.FMI?.latest || null,
      },
    },
    countries,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isExtendedApi = [
      "/api/overview",
      "/api/backfill/smhi/run",
      "/api/backfill/smhi/status",
      "/api/contract-bridge",
      "/api/signals",
      "/api/signals/summary",
      "/api/data-quality",
      "/api/climate/run",
      "/api/climate/status",
      "/api/climate/comparison",
      "/api/geography",
      "/api/activity/run",
      "/api/activity/status",
      "/api/activity/candidates",
      "/api/activity/review",
      "/api/nordic/run",
      "/api/nordic/status",
      "/api/nordic/backfill/run",
      "/api/nordic/backfill/status",
    ].includes(url.pathname);

    if (!isExtendedApi) return baseResponseWithNorwegianLogin(request, env, url);

    const authResponse = await authenticatedFallback(request, env);
    if (authResponse.status !== 404) return authResponse;

    try {
      if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });

      if (url.pathname === "/api/overview") {
        return json(await getFastOverview(env.DB, env));
      }

      if (url.pathname === "/api/backfill/smhi/run") {
        return json(await runSmhiBackfill(env.DB, {
          days: url.searchParams.get("days") || 60,
          maxStations: url.searchParams.get("stations") || 2,
        }));
      }

      if (url.pathname === "/api/backfill/smhi/status") {
        return json(await getBackfillStatus(env.DB, url.searchParams.get("days") || 60));
      }

      if (url.pathname === "/api/climate/run") {
        return json(await runClimateArchive(env.DB, {
          maxTasks: url.searchParams.get("tasks") || 1,
        }));
      }

      if (url.pathname === "/api/climate/status") {
        return json(await getClimateStatus(env.DB));
      }

      if (url.pathname === "/api/climate/comparison") {
        return json(await getClimateComparison(env.DB, url.searchParams.get("days") || 7));
      }

      if (url.pathname === "/api/geography") {
        return json(await getGeographyStatus(env.DB));
      }

      if (url.pathname === "/api/activity/run") {
        return json(await runActivityMonitor(env.DB, {
          maxItems: url.searchParams.get("items") || 4,
        }));
      }

      if (url.pathname === "/api/activity/status") {
        return json(await getActivityStatus(env.DB));
      }

      if (url.pathname === "/api/activity/candidates") {
        return json(await listActivityCandidates(env.DB, {
          limit: url.searchParams.get("limit") || 50,
          status: url.searchParams.get("status") || null,
        }));
      }

      if (url.pathname === "/api/activity/review" && request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Content-Type må være application/json" }, { status: 415 });
        }
        return json(await reviewActivityCandidate(env.DB, await request.json()));
      }

      if (url.pathname === "/api/nordic/run") {
        await ensurePhaseC(env.DB);
        const country = String(url.searchParams.get("country") || "all").toLowerCase();
        if (["denmark", "danmark", "dmi"].includes(country)) {
          const DMI = await runDmiWeather(env.DB);
          return json({ ok: DMI.ok, phase: "C", sources: { DMI }, note: "Fase C samler meteorologiske observasjoner for kjente danske og finske lokasjoner. Været påvirker ikke resultatestimatet automatisk." });
        }
        if (["finland", "fmi"].includes(country)) {
          const FMI = await runFmiWeather(env.DB);
          return json({ ok: FMI.ok, phase: "C", sources: { FMI }, note: "Fase C samler meteorologiske observasjoner for kjente danske og finske lokasjoner. Været påvirker ikke resultatestimatet automatisk." });
        }
        if (country === "all") {
          const [DMI, FMI] = await Promise.all([
            runDmiWeather(env.DB),
            runFmiWeather(env.DB),
          ]);
          return json({
            ok: Boolean(DMI.ok && FMI.ok),
            phase: "C",
            sources: { DMI, FMI },
            note: "Fase C samler meteorologiske observasjoner for kjente danske og finske lokasjoner. Været påvirker ikke resultatestimatet automatisk.",
          });
        }
        return json({ ok: false, error: "country må være all, Denmark eller Finland" }, { status: 400 });
      }

      if (url.pathname === "/api/nordic/status") {
        await ensurePhaseC(env.DB);
        return json(await getPhaseCStatus(env.DB));
      }

      if (url.pathname === "/api/nordic/backfill/run") {
        await ensurePhaseC(env.DB);
        return json(await runNordicBackfill(env.DB, {
          days: url.searchParams.get("days") || 60,
          maxTasks: url.searchParams.get("tasks") || 2,
        }));
      }

      if (url.pathname === "/api/nordic/backfill/status") {
        await ensurePhaseC(env.DB);
        return json(await getNordicBackfillStatus(env.DB, url.searchParams.get("days") || 60));
      }

      if (url.pathname === "/api/contract-bridge") {
        return json(await getContractBridge(env.DB));
      }

      if (url.pathname === "/api/data-quality") {
        return json(await getDataQuality(env.DB));
      }

      if (url.pathname === "/api/signals/summary") {
        return json(await getSignalSummary(env.DB));
      }

      if (url.pathname === "/api/signals" && request.method === "GET") {
        return json(await listSignals(env.DB, {
          limit: url.searchParams.get("limit") || 100,
          type: url.searchParams.get("type") || null,
        }));
      }

      if (url.pathname === "/api/signals" && request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Content-Type må være application/json" }, { status: 415 });
        }
        return json(await addSignal(env.DB, await request.json()), { status: 201 });
      }

      return json({ error: "Ikke funnet" }, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const cron = String(controller.cron || "");

    // Paid-plan layout: keep each heavier collector isolated for reliability while
    // retaining conservative per-invocation CPU/subrequest caps in wrangler.jsonc.
    if (!env.DB) {
      console.error("Scheduled collection skipped: D1 binding missing");
      return;
    }

    if (cron === "5 * * * *") {
      try {
        const result = await collectSmhiWeather(env.DB);
        console.log(JSON.stringify({ event: "scheduled-smhi-collection", cron, ...result }));
      } catch (error) {
        console.error("Automatisk SMHI-innsamling feilet", error);
      }
      return;
    }

    if (cron === "15 * * * *") {
      if (!env.TRAFIKVERKET_API_KEY) {
        console.error("Automatisk VViS-innsamling hoppet over: TRAFIKVERKET_API_KEY mangler");
        return;
      }
      try {
        const result = await collectVvisWeather(env.DB, env.TRAFIKVERKET_API_KEY);
        console.log(JSON.stringify({ event: "scheduled-vvis-collection", cron, ...result }));
      } catch (error) {
        console.error("Automatisk VViS-innsamling feilet", error);
      }
      return;
    }

    if (cron === "25 * * * *") {
      try {
        await ensurePhaseC(env.DB);
        const DMI = await runDmiWeather(env.DB);
        console.log(JSON.stringify({ event: "scheduled-denmark-weather", cron, DMI }));
      } catch (error) {
        console.error("Automatisk dansk værinnsamling feilet", error);
      }
      return;
    }

    if (cron === "35 * * * *") {
      try {
        await ensurePhaseC(env.DB);
        const FMI = await runFmiWeather(env.DB);
        console.log(JSON.stringify({ event: "scheduled-finland-weather", cron, FMI }));
      } catch (error) {
        console.error("Automatisk finsk værinnsamling feilet", error);
      }
      return;
    }

    if (cron === "40 * * * *") {
      try {
        await ensurePhaseC(env.DB);
        const result = await runNordicBackfill(env.DB, { days: 60, maxTasks: 4 });
        console.log(JSON.stringify({ event: "scheduled-nordic-backfill", cron, ...result }));
      } catch (error) {
        console.error("Automatisk dansk/finsk 60-dagershistorikk feilet", error);
      }
      return;
    }

    if (cron === "45 * * * *") {
      try {
        const result = await runSmhiBackfill(env.DB, { days: 60, maxStations: 2 });
        console.log(JSON.stringify({ event: "scheduled-smhi-backfill", cron, ...result }));
      } catch (error) {
        console.error("Automatisk 60-dagers værhistorikk feilet", error);
      }
      return;
    }

    if (cron === "50 * * * *") {
      try {
        const result = await runClimateArchive(env.DB, { maxTasks: 2 });
        console.log(JSON.stringify({ event: "scheduled-climate-archive", cron, ...result }));
      } catch (error) {
        console.error("Automatisk 10-års værgrunnlag feilet", error);
      }
      return;
    }

    if (cron === "55 * * * *") {
      try {
        const result = await calculateWorkability(env.DB, { persist: true });
        console.log(JSON.stringify({ event: "scheduled-workability", cron, sweden: result.sweden }));
      } catch (error) {
        console.error("Automatisk beregning av værbaserte arbeidsforhold feilet", error);
      }
      return;
    }

    if (cron === "0 */6 * * *") {
      try {
        const result = await runActivityMonitor(env.DB, { maxItems: 4 });
        console.log(JSON.stringify({ event: "scheduled-activity-monitor", cron, ...result }));
      } catch (error) {
        console.error("Automatisk overvåking av ordre- og aktivitetssignaler feilet", error);
      }
      return;
    }

    console.warn(`Ukjent cron-trigger ignorert: ${cron}`);
  },
};