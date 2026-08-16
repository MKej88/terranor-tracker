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
import { getNordicWeatherStatus, runNordicWeather } from "./nordic.js";
import { runDmiWeather } from "./dmi.js";
import { ensureNordicContracts } from "./nordic-contracts.js";
import { ensureNordicExtraTargets } from "./nordic-extra-targets.js";
import { getNordicBackfillStatus, runNordicBackfill } from "./nordic-backfill.js";

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
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isExtendedApi = [
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
          return json(await runNordicWeather(env.DB, { country: "Finland" }));
        }
        if (country === "all") {
          const DMI = await runDmiWeather(env.DB);
          const finland = await runNordicWeather(env.DB, { country: "Finland" });
          const FMI = finland.sources?.FMI;
          return json({
            ok: Boolean(DMI.ok && FMI?.ok),
            phase: "C",
            sources: { DMI, FMI },
            note: "Fase C samler meteorologiske observasjoner for kjente danske og finske lokasjoner. Været påvirker ikke resultatestimatet automatisk.",
          });
        }
        return json({ ok: false, error: "country må være all, Denmark eller Finland" }, { status: 400 });
      }

      if (url.pathname === "/api/nordic/status") {
        await ensurePhaseC(env.DB);
        return json(await getNordicWeatherStatus(env.DB));
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
    await baseWorker.scheduled(controller, env);

    if (env.DB) {
      try {
        const result = await runSmhiBackfill(env.DB, { days: 60, maxStations: 2 });
        console.log(JSON.stringify({ event: "scheduled-smhi-backfill", cron: controller.cron, ...result }));
      } catch (error) {
        console.error("Automatisk 60-dagers værhistorikk feilet", error);
      }

      try {
        const result = await runClimateArchive(env.DB, { maxTasks: 1 });
        console.log(JSON.stringify({ event: "scheduled-climate-archive", cron: controller.cron, ...result }));
      } catch (error) {
        console.error("Automatisk 10-års værgrunnlag feilet", error);
      }

      try {
        await ensurePhaseC(env.DB);
        const DMI = await runDmiWeather(env.DB);
        const finland = await runNordicWeather(env.DB, { country: "Finland" });
        console.log(JSON.stringify({ event: "scheduled-nordic-weather", cron: controller.cron, DMI, FMI: finland.sources?.FMI }));
      } catch (error) {
        console.error("Automatisk dansk/finsk værinnsamling feilet", error);
      }

      try {
        await ensurePhaseC(env.DB);
        const result = await runNordicBackfill(env.DB, { days: 60, maxTasks: 2 });
        console.log(JSON.stringify({ event: "scheduled-nordic-backfill", cron: controller.cron, ...result }));
      } catch (error) {
        console.error("Automatisk dansk/finsk 60-dagershistorikk feilet", error);
      }

      const hourUtc = new Date().getUTCHours();
      if (hourUtc % 6 === 0) {
        try {
          const result = await runActivityMonitor(env.DB, { maxItems: 4 });
          console.log(JSON.stringify({ event: "scheduled-activity-monitor", cron: controller.cron, ...result }));
        } catch (error) {
          console.error("Automatisk overvåking av ordre- og aktivitetssignaler feilet", error);
        }
      }
    }
  },
};