import worker from "./index3.js";
import {
  getTrafikverketProcurementStatus,
  listTrafikverketAwards,
  listTrafikverketPlan,
  runTrafikverketProcurementMonitor,
} from "./trafikverket-procurement.js";

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers || {}),
  },
});

function markTrafikverketActive(activity, procurement = null) {
  const sources = Array.isArray(activity?.monitoredSources) ? activity.monitoredSources : [];
  const nextSources = sources.map((source) => source.key === "trafikverket"
    ? {
      ...source,
      status: "aktiv",
      url: "https://bransch.trafikverket.se/for-dig-i-branschen/upphandling/tilldelade-kontrakt/",
      detail: procurement?.sources?.length
        ? "Tildelte kontrakter og innkjøpsplan hentes automatisk"
        : "Kilden er aktiv og venter på første import",
    }
    : source);
  return { ...activity, monitoredSources: nextSources, trafikverket: procurement };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Behold eksisterende Fase B-grensesnitt, men koble Trafikverket inn i samme status og manuelle søk.
    if (url.pathname === "/api/activity/status") {
      const base = await worker.fetch(request, env);
      if (!base.ok) return base;
      const activity = await base.json();
      if (!env.DB) return json(markTrafikverketActive(activity));
      try {
        const procurement = await getTrafikverketProcurementStatus(env.DB);
        return json(markTrafikverketActive(activity, procurement));
      } catch (error) {
        return json({
          ...markTrafikverketActive(activity),
          trafikverketError: String(error?.message || error),
        });
      }
    }

    if (url.pathname === "/api/activity/run") {
      const base = await worker.fetch(request, env);
      if (!base.ok) return base;
      const activity = await base.json();
      if (!env.DB) return json({ ...activity, trafikverket: { ok: false, error: "D1-bindingen DB mangler" } });
      try {
        const procurement = await runTrafikverketProcurementMonitor(env.DB, {
          force: url.searchParams.get("force") === "1",
        });
        return json({ ...activity, trafikverket: procurement });
      } catch (error) {
        return json({
          ...activity,
          trafikverket: { ok: false, error: String(error?.message || error) },
        });
      }
    }

    const specialPath = [
      "/api/trafikverket/run",
      "/api/trafikverket/status",
      "/api/trafikverket/awards",
      "/api/trafikverket/plan",
    ].includes(url.pathname);
    if (!specialPath) return worker.fetch(request, env);

    // Gjenbruk eksisterende innlogging. Ukjente API-ruter gir 404 etter vellykket autentisering.
    const authCheck = await worker.fetch(request, env);
    if (authCheck.status !== 404) return authCheck;

    try {
      if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });

      if (url.pathname === "/api/trafikverket/run") {
        return json(await runTrafikverketProcurementMonitor(env.DB, {
          force: url.searchParams.get("force") === "1",
        }));
      }

      if (url.pathname === "/api/trafikverket/status") {
        return json(await getTrafikverketProcurementStatus(env.DB));
      }

      if (url.pathname === "/api/trafikverket/awards") {
        return json(await listTrafikverketAwards(env.DB, {
          limit: url.searchParams.get("limit") || 200,
        }));
      }

      if (url.pathname === "/api/trafikverket/plan") {
        return json(await listTrafikverketPlan(env.DB, {
          limit: url.searchParams.get("limit") || 250,
          active: url.searchParams.get("active") !== "0",
        }));
      }

      return json({ error: "Ikke funnet" }, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const cron = String(controller.cron || "");
    if (cron !== "10 2 * * *") return worker.scheduled(controller, env);

    if (!env.DB) {
      console.error("Automatisk Trafikverket-kontroll hoppet over: D1-bindingen DB mangler");
      return;
    }

    try {
      const result = await runTrafikverketProcurementMonitor(env.DB, { force: false });
      console.log(JSON.stringify({ event: "scheduled-trafikverket-procurement", cron, ...result }));
    } catch (error) {
      console.error("Automatisk Trafikverket-kontroll feilet", error);
    }
  },
};
