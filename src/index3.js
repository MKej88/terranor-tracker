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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/climate/full-run") return worker.fetch(request, env);

    // Reuse the existing authentication layer. An authenticated unknown API route
    // returns 404 from index2; unauthenticated requests return 401 and stop here.
    const authCheck = await worker.fetch(request, env);
    if (authCheck.status !== 404) return authCheck;

    try {
      if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });
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
