const json = (data, init = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });

const seedForecast = {
  quarter: "Q3 2026",
  status: "pre-Q2 placeholder",
  revenue: {
    low: null,
    base: null,
    high: null,
    consensus: null,
  },
  adjustedEbita: {
    low: null,
    base: null,
    high: null,
    consensus: null,
  },
  confidence: null,
  updatedAt: null,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "terranor-tracker",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/forecast") {
      return json(seedForecast);
    }

    if (url.pathname === "/api/status") {
      return json({
        phase: "setup",
        targetQuarter: "Q3 2026",
        q2ReportDate: "2026-08-25",
        q3ReportDate: "2026-11-10",
        dataCollection: {
          trafficWeather: "planned",
          smhi: "planned",
          dmi: "planned",
          fmi: "planned",
          contracts: "seed data next",
          forecastHistory: "database next",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    console.log(
      JSON.stringify({
        event: "scheduled-collection-placeholder",
        cron: controller.cron,
        scheduledTime: new Date(controller.scheduledTime).toISOString(),
      }),
    );
  },
};
