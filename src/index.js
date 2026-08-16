import { ensureSchema, getDbStatus, seedContracts, listContracts } from "./db.js";
import {
  collectSmhiWeather,
  ensureWeatherSchema,
  getWeatherStatus,
  listWeatherContracts,
  seedWeatherAnchors,
} from "./weather.js";
import {
  collectVvisWeather,
  getVvisStatus,
  listVvisContracts,
  probeTrafikverket,
} from "./vvis.js";

const json = (data, init = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });

const html = (body, init = {}) =>
  new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });

const SESSION_COOKIE = "tt_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();

const seedForecast = {
  quarter: "Q3 2026",
  status: "pre-Q2 placeholder",
  revenue: { low: null, base: null, high: null, consensus: null },
  adjustedEbita: { low: null, base: null, high: null, consensus: null },
  confidence: null,
  updatedAt: null,
};

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function stringToBase64Url(value) {
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToString(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(payload, secret) {
  const encoded = stringToBase64Url(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes(".")) return false;
  try {
    const [encoded, signaturePart] = token.split(".");
    const key = await importHmacKey(secret);
    const padded = signaturePart.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((signaturePart.length + 3) % 4);
    const binary = atob(padded);
    const signature = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(encoded));
    if (!valid) return false;
    const payload = JSON.parse(base64UrlToString(encoded));
    return Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const cookies = header.split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  const found = cookies.find((part) => part.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function secureEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aa = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="no"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Terranor Tracker – Logg inn</title><style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; } * { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e8eef8; }
.card { width: min(92vw, 390px); padding: 30px; border: 1px solid #263246; border-radius: 16px; background: #111a2b; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
h1 { margin: 0 0 6px; font-size: 24px; } p { margin: 0 0 24px; color: #9fb0c9; }
label { display:block; margin-bottom:8px; font-size:14px; color:#c7d3e5; }
input { width:100%; padding:12px 14px; border-radius:10px; border:1px solid #34435b; background:#0b1220; color:#fff; font-size:16px; }
button { width:100%; margin-top:14px; padding:12px 14px; border:0; border-radius:10px; background:#2f6fed; color:white; font-weight:700; cursor:pointer; }
.error { margin-top:12px; color:#ff9d9d; font-size:14px; } .meta { margin-top:20px; font-size:12px; color:#71819b; }
</style></head><body><main class="card"><h1>Terranor Tracker</h1><p>Privat earnings nowcast</p>
<form method="post" action="/login"><label for="password">Passord</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required /><button type="submit">Logg inn</button></form>
${error ? `<div class="error">${error}</div>` : ""}<div class="meta">Innloggingen lagres i 7 dager på denne enheten.</div></main></body></html>`;
}

function setupPage() {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terranor Tracker – Oppsett</title></head><body style="font-family:system-ui;background:#0b1220;color:white;padding:40px"><h1>Sikkerhetsoppsett mangler</h1><p>Opprett Cloudflare-secrets <code>APP_PASSWORD</code> og <code>SESSION_SECRET</code> før trackeren kan brukes.</p></body></html>`;
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

async function initializeData(db) {
  await ensureSchema(db);
  await seedContracts(db);
  await ensureWeatherSchema(db);
  await seedWeatherAnchors(db);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "terranor-tracker",
        authConfigured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET),
        dbConfigured: Boolean(env.DB),
        smhiConfigured: true,
        trafikverketConfigured: Boolean(env.TRAFIKVERKET_API_KEY),
        timestamp: new Date().toISOString(),
      });
    }

    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return html(setupPage(), { status: 503 });

    if (url.pathname === "/login" && request.method === "GET") {
      const token = getCookie(request, SESSION_COOKIE);
      if (await verifySession(token, env.SESSION_SECRET)) return redirect("/");
      return html(loginPage());
    }

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const password = String(form.get("password") || "");
      const valid = await secureEqual(password, env.APP_PASSWORD);
      if (!valid) return html(loginPage("Feil passord."), { status: 401 });
      if (env.DB) await initializeData(env.DB);
      const now = Math.floor(Date.now() / 1000);
      const token = await signSession({ iat: now, exp: now + SESSION_TTL_SECONDS }, env.SESSION_SECRET);
      return redirect("/", { "set-cookie": `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict` });
    }

    if (url.pathname === "/logout") {
      return redirect("/login", { "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict` });
    }

    const token = getCookie(request, SESSION_COOKIE);
    const authenticated = await verifySession(token, env.SESSION_SECRET);
    if (!authenticated) {
      if (url.pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, { status: 401 });
      return redirect("/login");
    }

    if (url.pathname === "/api/db-status") {
      try { if (env.DB) await initializeData(env.DB); return json(await getDbStatus(env.DB)); }
      catch (error) { return json({ configured: Boolean(env.DB), error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/contracts") {
      try { if (env.DB) await initializeData(env.DB); return json({ contracts: await listContracts(env.DB) }); }
      catch (error) { return json({ error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/weather/status") {
      try { if (env.DB) await initializeData(env.DB); return json(await getWeatherStatus(env.DB)); }
      catch (error) { return json({ error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/weather/contracts") {
      try { if (env.DB) await initializeData(env.DB); return json({ contracts: await listWeatherContracts(env.DB) }); }
      catch (error) { return json({ error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/weather/run") {
      try { if (env.DB) await initializeData(env.DB); return json(await collectSmhiWeather(env.DB)); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/vvis/probe") {
      if (!env.TRAFIKVERKET_API_KEY) return json({ ok: false, error: "TRAFIKVERKET_API_KEY is not configured" }, { status: 503 });
      try { return json(await probeTrafikverket(env.TRAFIKVERKET_API_KEY)); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/vvis/run") {
      if (!env.TRAFIKVERKET_API_KEY) return json({ ok: false, error: "TRAFIKVERKET_API_KEY is not configured" }, { status: 503 });
      try { if (env.DB) await initializeData(env.DB); return json(await collectVvisWeather(env.DB, env.TRAFIKVERKET_API_KEY)); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/vvis/status") {
      try { if (env.DB) await initializeData(env.DB); return json(await getVvisStatus(env.DB)); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/vvis/contracts") {
      try { if (env.DB) await initializeData(env.DB); return json({ contracts: await listVvisContracts(env.DB) }); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }

    if (url.pathname === "/api/forecast") return json(seedForecast);

    if (url.pathname === "/api/status") {
      let weather = null;
      let vvis = null;
      if (env.DB) {
        try { await initializeData(env.DB); weather = await getWeatherStatus(env.DB); } catch { weather = null; }
        try { vvis = await getVvisStatus(env.DB); } catch { vvis = null; }
      }
      return json({
        phase: "Q3 data collection setup",
        targetQuarter: "Q3 2026",
        q2ReportDate: "2026-08-25",
        q3ReportDate: "2026-11-10",
        dataCollection: {
          smhi: weather?.latestRun?.status === "ok" ? "active" : "ready",
          trafficWeather: vvis?.latestRun?.status === "ok" ? "active" : env.TRAFIKVERKET_API_KEY ? "ready" : "awaiting API key",
          dmi: "planned",
          fmi: "planned",
          contracts: "seeded",
          forecastHistory: "database connected",
        },
        weather,
        vvis,
      });
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    if (!env.DB) {
      console.error("Scheduled collection skipped: D1 binding missing");
      return;
    }

    await initializeData(env.DB);

    try {
      const result = await collectSmhiWeather(env.DB);
      console.log(JSON.stringify({ event: "scheduled-smhi-collection", cron: controller.cron, scheduledTime: new Date(controller.scheduledTime).toISOString(), ...result }));
    } catch (error) {
      console.error("Scheduled SMHI collection failed", error);
    }

    if (env.TRAFIKVERKET_API_KEY) {
      try {
        const result = await collectVvisWeather(env.DB, env.TRAFIKVERKET_API_KEY);
        console.log(JSON.stringify({ event: "scheduled-vvis-collection", cron: controller.cron, scheduledTime: new Date(controller.scheduledTime).toISOString(), ...result }));
      } catch (error) {
        console.error("Scheduled VViS collection failed", error);
      }
    }
  },
};
