import baseWorker from "./index.js";
import { getBackfillStatus, runSmhiBackfill } from "./backfill.js";
import { getContractBridge } from "./bridge.js";
import { addSignal, getSignalSummary, listSignals } from "./signals.js";
import { getDataQuality } from "./quality.js";

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers || {}),
  },
});

async function authenticatedFallback(request, env) {
  // The existing worker owns authentication. For new /api routes it returns 401
  // before login and 404 after successful authentication, so we only execute a
  // new handler after the base worker has confirmed the session.
  return baseWorker.fetch(request, env);
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
    ].includes(url.pathname);

    if (!isExtendedApi) return baseWorker.fetch(request, env);

    const authResponse = await authenticatedFallback(request, env);
    if (authResponse.status !== 404) return authResponse;

    try {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB is missing" }, { status: 503 });

      if (url.pathname === "/api/backfill/smhi/run") {
        return json(await runSmhiBackfill(env.DB, {
          days: url.searchParams.get("days") || 60,
          maxStations: url.searchParams.get("stations") || 2,
        }));
      }

      if (url.pathname === "/api/backfill/smhi/status") {
        return json(await getBackfillStatus(env.DB, url.searchParams.get("days") || 60));
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
          return json({ ok: false, error: "Content-Type must be application/json" }, { status: 415 });
        }
        return json(await addSignal(env.DB, await request.json()), { status: 201 });
      }

      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    // Keep the existing hourly SMHI/VViS/workability collection intact.
    await baseWorker.scheduled(controller, env);

    // Progressive Q3-to-date backfill: only stations without enough historical
    // observations are selected, so this becomes a near-no-op when complete.
    if (env.DB) {
      try {
        const result = await runSmhiBackfill(env.DB, { days: 60, maxStations: 2 });
        console.log(JSON.stringify({ event: "scheduled-smhi-backfill", cron: controller.cron, ...result }));
      } catch (error) {
        console.error("Scheduled SMHI backfill failed", error);
      }
    }
  },
};
