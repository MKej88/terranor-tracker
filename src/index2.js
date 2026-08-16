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

    if (!isExtendedApi) return baseResponseWithNorwegianLogin(request, env, url);

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
    await baseWorker.scheduled(controller, env);

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
