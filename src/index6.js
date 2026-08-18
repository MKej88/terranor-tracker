import worker from "./index5.js";
import {
  getNordicClimateComparison,
  getNordicClimateStatus,
  runNordicClimateArchive,
} from "./nordic-climate.js";

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers || {}),
  },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const specialPath = [
      "/api/nordic/climate/run",
      "/api/nordic/climate/status",
      "/api/nordic/climate/comparison",
    ].includes(url.pathname);
    if (!specialPath) return worker.fetch(request, env);

    // Gjenbruk eksisterende privat innlogging. En autentisert ukjent API-rute returnerer 404.
    const authCheck = await worker.fetch(request, env);
    if (authCheck.status !== 404) return authCheck;

    try {
      if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });

      if (url.pathname === "/api/nordic/climate/run") {
        const countryRaw = String(url.searchParams.get("country") || "").toLowerCase();
        const country = ["denmark", "danmark", "dmi"].includes(countryRaw)
          ? "Denmark"
          : ["finland", "fmi"].includes(countryRaw)
            ? "Finland"
            : null;
        return json(await runNordicClimateArchive(env.DB, {
          maxTasks: url.searchParams.get("tasks") || 12,
          country,
        }));
      }

      if (url.pathname === "/api/nordic/climate/status") {
        return json(await getNordicClimateStatus(env.DB));
      }

      if (url.pathname === "/api/nordic/climate/comparison") {
        return json(await getNordicClimateComparison(env.DB, url.searchParams.get("days") || 7));
      }

      return json({ error: "Ikke funnet" }, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const cron = String(controller.cron || "");
    if (cron !== "30 * * * *") return worker.scheduled(controller, env);

    if (!env.DB) {
      console.error("Nordisk 10-årsgrunnlag hoppet over: D1-bindingen DB mangler");
      return;
    }

    try {
      const result = await runNordicClimateArchive(env.DB, { maxTasks: 12 });
      console.log(JSON.stringify({ event: "scheduled-nordic-climate", cron, ...result }));
    } catch (error) {
      console.error("Automatisk nordisk 10-årsinnlasting feilet", error);
    }
  },
};
