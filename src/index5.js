import worker from "./index4.js";
import { getMunicipalStatus, runMunicipalMonitor } from "./municipal-monitor-filtered.js";

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers || {}),
  },
});

function markMunicipalActive(activity, municipal = null) {
  const sources = Array.isArray(activity?.monitoredSources) ? activity.monitoredSources : [];
  const nextSources = sources.map((source) => source.key === "kommuner"
    ? {
      ...source,
      status: "aktiv",
      detail: municipal?.sources?.length
        ? `${municipal.activeSources || 0} av ${municipal.sources.length} kilder svarte sist`
        : "Kommunale kilder er aktivert og venter på første kontroll",
    }
    : source);
  return { ...activity, monitoredSources: nextSources, municipal };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/activity/status") {
      const base = await worker.fetch(request, env);
      if (!base.ok) return base;
      const activity = await base.json();
      if (!env.DB) return json(markMunicipalActive(activity));
      try {
        const municipal = await getMunicipalStatus(env.DB);
        return json(markMunicipalActive(activity, municipal));
      } catch (error) {
        return json({
          ...markMunicipalActive(activity),
          municipalError: String(error?.message || error),
        });
      }
    }

    if (url.pathname === "/api/activity/candidates" && !url.searchParams.get("status")) {
      const base = await worker.fetch(request, env);
      if (!base.ok) return base;
      const data = await base.json();
      return json({
        ...data,
        candidates: (data?.candidates || []).filter((row) => row.review_status === "ny"),
      });
    }

    if (url.pathname === "/api/activity/run") {
      const base = await worker.fetch(request, env);
      if (!base.ok) return base;
      const activity = await base.json();
      if (!env.DB) return json({ ...activity, municipal: { ok: false, error: "D1-bindingen DB mangler" } });
      try {
        const municipal = await runMunicipalMonitor(env.DB);
        return json({ ...activity, municipal });
      } catch (error) {
        return json({ ...activity, municipal: { ok: false, error: String(error?.message || error) } });
      }
    }

    const specialPath = ["/api/municipal/run", "/api/municipal/status"].includes(url.pathname);
    if (!specialPath) return worker.fetch(request, env);

    // Gjenbruk den eksisterende innloggingen. En ukjent API-rute gir 404 etter autentisering.
    const authCheck = await worker.fetch(request, env);
    if (authCheck.status !== 404) return authCheck;

    try {
      if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });
      if (url.pathname === "/api/municipal/run") return json(await runMunicipalMonitor(env.DB));
      if (url.pathname === "/api/municipal/status") return json(await getMunicipalStatus(env.DB));
      return json({ error: "Ikke funnet" }, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const cron = String(controller.cron || "");
    if (cron !== "20 3 * * *") return worker.scheduled(controller, env);

    if (!env.DB) {
      console.error("Kommunal kildekontroll hoppet over: D1-bindingen DB mangler");
      return;
    }

    try {
      const result = await runMunicipalMonitor(env.DB);
      console.log(JSON.stringify({ event: "scheduled-municipal-monitor", cron, ...result }));
    } catch (error) {
      console.error("Automatisk kommunal kildekontroll feilet", error);
    }
  },
};
