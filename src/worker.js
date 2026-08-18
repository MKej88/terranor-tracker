import { ensureSchema, getDbStatus, seedContracts, listContracts } from "./db.js";
import {
  collectSmhiWeather,
  ensureWeatherSchema,
  getWeatherStatus,
  listWeatherContracts,
  seedWeatherAnchors,
} from "./weather.js";
import { collectVvisWeather, getVvisStatus, listVvisContracts, probeTrafikverket } from "./vvis.js";
import { calculateWorkability, ensureWorkabilitySchema, getWorkabilityHistory } from "./workability.js";
import { getBackfillStatus, runSmhiBackfill } from "./backfill.js";
import { getContractBridge } from "./bridge.js";
import { addSignal, getSignalSummary, listSignals } from "./signals.js";
import { getDataQuality } from "./quality.js";
import { getClimateComparison, runClimateArchive } from "./climate.js";
import { getClimateStatus } from "./climate-status.js";
import { runFullClimateArchive } from "./climate-full.js";
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
import {
  ensureNordicBackfillSchema,
  getNordicBackfillStatus,
  runNordicBackfill,
} from "./nordic-backfill.js";
import {
  getTrafikverketProcurementStatus,
  listTrafikverketAwards,
  listTrafikverketPlan,
  runTrafikverketProcurementMonitor,
} from "./trafikverket-procurement.js";
import { getMunicipalStatus, runMunicipalMonitor } from "./municipal-monitor-filtered.js";
import { runNordicClimateArchive } from "./nordic-climate.js";
import { getNordicClimateComparison } from "./nordic-climate-comparison.js";
import { getNordicClimateStatus } from "./nordic-climate-status.js";
import { TARGET_QUARTER, TRACKER_CONFIG } from "./config.js";

const SESSION_COOKIE = "tt_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();

const seedForecast = {
  quarter: TARGET_QUARTER,
  status: "datagrunnlag bygges",
  revenue: { low: null, base: null, high: null, consensus: null },
  adjustedEbita: { low: null, base: null, high: null, consensus: null },
  confidence: null,
  updatedAt: null,
};

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const json = (data, init = {}) => new Response(JSON.stringify(data, null, 2), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders,
    ...(init.headers || {}),
  },
});

const html = (body, init = {}) => new Response(body, {
  ...init,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...securityHeaders,
    ...(init.headers || {}),
  },
});

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
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
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
  const prefix = `${name}=`;
  const found = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
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

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...securityHeaders, ...headers } });
}

function loginPage(error = "") {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Terranor Tracker – Logg inn</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e8eef8}.card{width:min(92vw,390px);padding:30px;border:1px solid #263246;border-radius:16px;background:#111a2b;box-shadow:0 18px 50px rgba(0,0,0,.35)}h1{margin:0 0 6px;font-size:24px}p{margin:0 0 24px;color:#9fb0c9}label{display:block;margin-bottom:8px;font-size:14px;color:#c7d3e5}input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #34435b;background:#0b1220;color:#fff;font-size:16px}button{width:100%;margin-top:14px;padding:12px 14px;border:0;border-radius:10px;background:#2f6fed;color:white;font-weight:700;cursor:pointer}.error{margin-top:12px;color:#ff9d9d;font-size:14px}.meta{margin-top:20px;font-size:12px;color:#71819b}</style></head><body><main class="card"><h1>Terranor Tracker</h1><p>Privat resultatestimat</p><form method="post" action="/login"><label for="password">Passord</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required/><button type="submit">Logg inn</button></form>${error ? `<div class="error">${error}</div>` : ""}<div class="meta">Innloggingen lagres i 7 dager på denne enheten.</div></main></body></html>`;
}

function setupPage() {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terranor Tracker – Oppsett</title></head><body style="font-family:system-ui;background:#0b1220;color:white;padding:40px"><h1>Sikkerhetsoppsett mangler</h1><p>Opprett hemmelige miljøvariabler <code>APP_PASSWORD</code> og <code>SESSION_SECRET</code> i Cloudflare før trackeren kan brukes.</p></body></html>`;
}

async function initializeCoreData(db) {
  await ensureSchema(db);
  await seedContracts(db);
  await ensureWeatherSchema(db);
  await seedWeatherAnchors(db);
  await ensureWorkabilitySchema(db);
}

async function ensurePhaseC(db) {
  await ensureNordicContracts(db);
  await ensureNordicExtraTargets(db);
  await ensureDenmarkStateTargets(db);
}

function collectionStatus(run, fallback = "ready") {
  if (run?.status === "ok") return "active";
  if (["error", "partial"].includes(String(run?.status || ""))) return "error";
  return fallback;
}

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

async function getCombinedActivityStatus(db) {
  let activity = await getActivityStatus(db);
  try { activity = markTrafikverketActive(activity, await getTrafikverketProcurementStatus(db)); }
  catch (error) { activity = { ...markTrafikverketActive(activity), trafikverketError: String(error?.message || error) }; }
  try { activity = markMunicipalActive(activity, await getMunicipalStatus(db)); }
  catch (error) { activity = { ...markMunicipalActive(activity), municipalError: String(error?.message || error) }; }
  return activity;
}

async function runCombinedActivity(db, url) {
  const activity = await runActivityMonitor(db, { maxItems: url.searchParams.get("items") || 4 });
  let trafikverket;
  let municipal;
  try {
    trafikverket = await runTrafikverketProcurementMonitor(db, { force: url.searchParams.get("force") === "1" });
  } catch (error) {
    trafikverket = { ok: false, error: String(error?.message || error) };
  }
  try { municipal = await runMunicipalMonitor(db); }
  catch (error) { municipal = { ok: false, error: String(error?.message || error) }; }
  return { ...activity, trafikverket, municipal };
}

async function getFastOverview(db, env) {
  await ensurePhaseC(db);
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
    targets: Number(row.targets || 0), linked: Number(row.linked || 0),
  }]));
  const ranges = Object.fromEntries((nordicObservations?.results || []).map((row) => [row.source, row]));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    targetQuarter: TARGET_QUARTER,
    dataCollection: {
      contracts: "seeded",
      smhi: collectionStatus(smhiRun),
      trafficWeather: collectionStatus(vvisRun, env.TRAFIKVERKET_API_KEY ? "ready" : "awaiting API key"),
      workability: workability?.generated_at ? "active" : "warming_up",
      forecastHistory: "database connected",
      dmi: collectionStatus(dmiRun),
      fmi: collectionStatus(fmiRun),
    },
    tables: { contracts: Number(contracts?.count || 0), weatherObservations: Number(weather?.count || 0) },
    sources: {
      DMI: { status: dmiRun?.status || "ikke_kjørt", lastRun: dmiRun || null, observations: Number(ranges?.DMI?.observations || 0), latest: ranges?.DMI?.latest || null },
      FMI: { status: fmiRun?.status || "ikke_kjørt", lastRun: fmiRun || null, observations: Number(ranges?.FMI?.observations || 0), latest: ranges?.FMI?.latest || null },
    },
    countries,
  };
}

const DAY_MS = 86400000;
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function latestRunMap(rows) { return Object.fromEntries((rows || []).map((row) => [row.source, row])); }

async function getFastPhaseC(db, days = 60) {
  await ensurePhaseC(db);
  await ensureNordicBackfillSchema(db);
  const wantedDays = clamp(Number.parseInt(days, 10) || 60, 7, 120);
  const nowMs = Date.now();
  const [targetsResult, runsResult, sourceRangesResult, latestBackfill] = await Promise.all([
    db.prepare(`WITH station_ranges AS (
        SELECT source, station_id, COUNT(*) AS observations,
          MIN(observed_at) AS earliest, MAX(observed_at) AS latest,
          SUM(CASE WHEN air_temp_c IS NOT NULL THEN 1 ELSE 0 END) AS air_temp_hours,
          SUM(CASE WHEN wind_ms IS NOT NULL THEN 1 ELSE 0 END) AS wind_hours,
          SUM(CASE WHEN precipitation_mm IS NOT NULL THEN 1 ELSE 0 END) AS precipitation_hours
        FROM weather_observations
        WHERE source IN ('DMI','FMI')
          AND observed_at>=datetime('now', ?)
        GROUP BY source, station_id
      )
      SELECT t.id, t.country, t.label, t.contract_name, t.contract_id,
        c.name AS matched_contract, t.location_name, t.latitude, t.longitude,
        t.source, t.station_id, t.station_name, t.distance_km, t.confidence,
        t.notes, t.last_linked_at,
        COALESCE(r.observations,0) AS observations,
        r.earliest, r.latest, r.air_temp_hours, r.wind_hours, r.precipitation_hours
      FROM nordic_weather_targets t
      LEFT JOIN contracts c ON c.id=t.contract_id
      LEFT JOIN station_ranges r ON r.source=t.source AND r.station_id=t.station_id
      WHERE t.active=1 AND t.source IN ('DMI','FMI')
      ORDER BY t.country, t.label`).bind(`-${wantedDays} days`).all(),
    db.prepare(`SELECT r.* FROM nordic_weather_runs r
      JOIN (SELECT source, MAX(id) AS id FROM nordic_weather_runs WHERE source IN ('DMI','FMI') GROUP BY source) latest
        ON latest.id=r.id ORDER BY r.source`).all(),
    db.prepare(`SELECT source, COUNT(*) AS observations, MIN(observed_at) AS earliest, MAX(observed_at) AS latest
      FROM weather_observations WHERE source IN ('DMI','FMI') GROUP BY source`).all(),
    db.prepare(`SELECT source, target_id, label, chunk_start, chunk_end,
      started_at, finished_at, status, observations_written, error_text
      FROM nordic_backfill_runs ORDER BY id DESC LIMIT 1`).first(),
  ]);

  const expectedHours = wantedDays * 24;
  const targets = (targetsResult?.results || []).map((row) => {
    const linked = Boolean(row.station_id);
    const earliestMs = row.earliest && Number.isFinite(Date.parse(row.earliest)) ? Date.parse(row.earliest) : nowMs;
    const coveredDays = linked ? clamp((nowMs - earliestMs) / DAY_MS, 0, wantedDays) : 0;
    const coverages = [row.air_temp_hours, row.wind_hours, row.precipitation_hours]
      .map((value) => expectedHours ? 100 * Number(value || 0) / expectedHours : 0);
    const minimumCoreCoveragePct = coverages.length ? Math.min(...coverages) : 0;
    return {
      ...row,
      observations: Number(row.observations || 0),
      covered_days: Math.round(coveredDays * 10) / 10,
      minimum_core_coverage_pct: Math.round(minimumCoreCoveragePct * 10) / 10,
      complete: linked
        && coveredDays >= wantedDays - 0.25
        && minimumCoreCoveragePct >= TRACKER_CONFIG.weatherQuality.readyMetricCoveragePct,
    };
  });

  const runs = latestRunMap(runsResult?.results || []);
  const ranges = Object.fromEntries((sourceRangesResult?.results || []).map((row) => [row.source, row]));
  const countries = {};
  for (const country of ["Denmark", "Finland"]) {
    const rows = targets.filter((row) => row.country === country);
    countries[country] = { targets: rows.length, linked: rows.filter((row) => row.station_id).length, matchedContracts: rows.filter((row) => row.contract_id).length };
  }
  const sources = {};
  for (const source of ["DMI", "FMI"]) {
    const run = runs[source] || null;
    const range = ranges[source] || null;
    sources[source] = {
      status: run?.status || "ikke_kjørt", lastRun: run,
      observations: Number(range?.observations || 0), earliest: range?.earliest || null, latest: range?.latest || null,
    };
  }
  const linked = targets.filter((row) => row.station_id).length;
  const complete = targets.filter((row) => row.complete).length;
  const avgCoverage = targets.length
    ? targets.reduce((sum, row) => sum + Math.min(Number(row.minimum_core_coverage_pct || 0), 100) / 100, 0) / targets.length
    : 0;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    status: {
      phase: "C", sources, countries, targets,
      methodology: {
        Denmark: "DMI meteorologiske målestasjoner; nærmeste aktive stasjon til kontrakts-/byankeret.",
        Finland: "FMI WFS-observasjoner for nærmeste værstasjon til navngitt sted.",
      },
      limitations: [
        "Danske statlige kontrakter bruker fortsatt regionale værproxyer der eksakte delkontraktsgrenser ikke er tilgjengelige.",
        "Finske områder uten dokumentert kontraktsverdi brukes til værdekning, ikke økonomisk vekting.",
        "Ferdig 60-dagersstatus krever minst 85 % faktisk dekning for temperatur, vind og nedbør.",
      ],
    },
    backfill: {
      phase: "C", days: wantedDays, targets: targets.length, targetsLinked: linked, targetsComplete: complete,
      complete: targets.length > 0 && complete === targets.length,
      progressPct: Math.round(clamp(avgCoverage * 100, 0, 100)), latestRun: latestBackfill || null,
      targetStatus: targets.map((row) => ({
        id: row.id, country: row.country, label: row.label, source: row.source,
        station_id: row.station_id, station_name: row.station_name, earliest: row.earliest, latest: row.latest,
        observations: row.observations, covered_days: row.covered_days,
        minimum_core_coverage_pct: row.minimum_core_coverage_pct, complete: row.complete,
      })),
    },
  };
}

function requirePost(request) {
  if (request.method === "POST") return null;
  return json({ ok: false, error: "Denne handlingen krever POST" }, { status: 405, headers: { allow: "POST" } });
}

function sameOriginWrite(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

async function handleApi(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1-bindingen DB mangler" }, { status: 503 });

  if (url.pathname === "/api/db-status") { await initializeCoreData(env.DB); return json(await getDbStatus(env.DB)); }
  if (url.pathname === "/api/contracts") { await initializeCoreData(env.DB); return json({ contracts: await listContracts(env.DB) }); }
  if (url.pathname === "/api/overview") return json(await getFastOverview(env.DB, env));
  if (url.pathname === "/api/status") return json(await getFastOverview(env.DB, env));

  if (url.pathname === "/api/weather/status") { await initializeCoreData(env.DB); return json(await getWeatherStatus(env.DB)); }
  if (url.pathname === "/api/weather/contracts") { await initializeCoreData(env.DB); return json({ contracts: await listWeatherContracts(env.DB) }); }
  if (url.pathname === "/api/weather/run") {
    const denied = requirePost(request); if (denied) return denied;
    await initializeCoreData(env.DB); return json(await collectSmhiWeather(env.DB));
  }

  if (url.pathname === "/api/vvis/probe") {
    if (!env.TRAFIKVERKET_API_KEY) return json({ ok: false, error: "TRAFIKVERKET_API_KEY er ikke konfigurert" }, { status: 503 });
    return json(await probeTrafikverket(env.TRAFIKVERKET_API_KEY));
  }
  if (url.pathname === "/api/vvis/status") return json(await getVvisStatus(env.DB));
  if (url.pathname === "/api/vvis/contracts") return json({ contracts: await listVvisContracts(env.DB) });
  if (url.pathname === "/api/vvis/run") {
    const denied = requirePost(request); if (denied) return denied;
    if (!env.TRAFIKVERKET_API_KEY) return json({ ok: false, error: "TRAFIKVERKET_API_KEY er ikke konfigurert" }, { status: 503 });
    await initializeCoreData(env.DB); return json(await collectVvisWeather(env.DB, env.TRAFIKVERKET_API_KEY));
  }

  if (url.pathname === "/api/workability") {
    await initializeCoreData(env.DB);
    return json(await calculateWorkability(env.DB, { persist: request.method === "POST" }));
  }
  if (url.pathname === "/api/workability/history") return json(await getWorkabilityHistory(env.DB, url.searchParams.get("hours") || 168));
  if (url.pathname === "/api/forecast") return json(seedForecast);

  if (url.pathname === "/api/backfill/smhi/status") return json(await getBackfillStatus(env.DB, url.searchParams.get("days") || 60));
  if (url.pathname === "/api/backfill/smhi/run") {
    const denied = requirePost(request); if (denied) return denied;
    return json(await runSmhiBackfill(env.DB, { days: url.searchParams.get("days") || 60, maxStations: url.searchParams.get("stations") || 2 }));
  }

  if (url.pathname === "/api/climate/status") return json(await getClimateStatus(env.DB));
  if (url.pathname === "/api/climate/comparison") return json(await getClimateComparison(env.DB, url.searchParams.get("days") || 7));
  if (url.pathname === "/api/climate/run") {
    const denied = requirePost(request); if (denied) return denied;
    return json(await runClimateArchive(env.DB, { maxTasks: url.searchParams.get("tasks") || 1 }));
  }
  if (url.pathname === "/api/climate/full-run") {
    const denied = requirePost(request); if (denied) return denied;
    return json(await runFullClimateArchive(env.DB, { maxTasks: url.searchParams.get("tasks") || 60 }));
  }

  if (url.pathname === "/api/geography") return json(await getGeographyStatus(env.DB));
  if (url.pathname === "/api/contract-bridge") return json(await getContractBridge(env.DB));
  if (url.pathname === "/api/data-quality") return json(await getDataQuality(env.DB));
  if (url.pathname === "/api/signals/summary") return json(await getSignalSummary(env.DB));
  if (url.pathname === "/api/signals" && request.method === "GET") return json(await listSignals(env.DB, { limit: url.searchParams.get("limit") || 100, type: url.searchParams.get("type") || null }));
  if (url.pathname === "/api/signals" && request.method === "POST") {
    if (!(request.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "Content-Type må være application/json" }, { status: 415 });
    return json(await addSignal(env.DB, await request.json()), { status: 201 });
  }

  if (url.pathname === "/api/activity/status") return json(await getCombinedActivityStatus(env.DB));
  if (url.pathname === "/api/activity/candidates") return json(await listActivityCandidates(env.DB, { limit: url.searchParams.get("limit") || 50, status: url.searchParams.get("status") || "ny" }));
  if (url.pathname === "/api/activity/review" && request.method === "POST") {
    if (!(request.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "Content-Type må være application/json" }, { status: 415 });
    return json(await reviewActivityCandidate(env.DB, await request.json()));
  }
  if (url.pathname === "/api/activity/run") {
    const denied = requirePost(request); if (denied) return denied;
    return json(await runCombinedActivity(env.DB, url));
  }

  if (url.pathname === "/api/nordic/status") { await ensurePhaseC(env.DB); return json(await getNordicWeatherStatus(env.DB)); }
  if (url.pathname === "/api/nordic/run") {
    const denied = requirePost(request); if (denied) return denied;
    await ensurePhaseC(env.DB);
    const country = String(url.searchParams.get("country") || "all").toLowerCase();
    if (["denmark", "danmark", "dmi"].includes(country)) {
      const DMI = await runDmiWeather(env.DB); return json({ ok: DMI.ok, phase: "C", sources: { DMI } });
    }
    if (["finland", "fmi"].includes(country)) {
      const FMI = await runFmiWeather(env.DB); return json({ ok: FMI.ok, phase: "C", sources: { FMI } });
    }
    if (country === "all") {
      const [DMI, FMI] = await Promise.all([runDmiWeather(env.DB), runFmiWeather(env.DB)]);
      return json({ ok: Boolean(DMI.ok && FMI.ok), phase: "C", sources: { DMI, FMI } });
    }
    return json({ ok: false, error: "country må være all, Denmark eller Finland" }, { status: 400 });
  }
  if (url.pathname === "/api/nordic/backfill/status") { await ensurePhaseC(env.DB); return json(await getNordicBackfillStatus(env.DB, url.searchParams.get("days") || 60)); }
  if (url.pathname === "/api/nordic/backfill/run") {
    const denied = requirePost(request); if (denied) return denied;
    await ensurePhaseC(env.DB);
    return json(await runNordicBackfill(env.DB, { days: url.searchParams.get("days") || 60, maxTasks: url.searchParams.get("tasks") || 2 }));
  }
  if (url.pathname === "/api/fase-c/fast") return json(await getFastPhaseC(env.DB, url.searchParams.get("days") || 60));

  if (url.pathname === "/api/trafikverket/status") return json(await getTrafikverketProcurementStatus(env.DB));
  if (url.pathname === "/api/trafikverket/awards") return json(await listTrafikverketAwards(env.DB, { limit: url.searchParams.get("limit") || 200 }));
  if (url.pathname === "/api/trafikverket/plan") return json(await listTrafikverketPlan(env.DB, { limit: url.searchParams.get("limit") || 250, active: url.searchParams.get("active") !== "0" }));
  if (url.pathname === "/api/trafikverket/run") {
    const denied = requirePost(request); if (denied) return denied;
    return json(await runTrafikverketProcurementMonitor(env.DB, { force: url.searchParams.get("force") === "1" }));
  }

  if (url.pathname === "/api/municipal/status") return json(await getMunicipalStatus(env.DB));
  if (url.pathname === "/api/municipal/run") {
    const denied = requirePost(request); if (denied) return denied;
    return json(await runMunicipalMonitor(env.DB));
  }

  if (url.pathname === "/api/nordic/climate/status") return json(await getNordicClimateStatus(env.DB));
  if (url.pathname === "/api/nordic/climate/comparison") return json(await getNordicClimateComparison(env.DB, url.searchParams.get("days") || 7));
  if (url.pathname === "/api/nordic/climate/run") {
    const denied = requirePost(request); if (denied) return denied;
    const countryRaw = String(url.searchParams.get("country") || "").toLowerCase();
    const country = ["denmark", "danmark", "dmi"].includes(countryRaw)
      ? "Denmark" : ["finland", "fmi"].includes(countryRaw) ? "Finland" : null;
    return json(await runNordicClimateArchive(env.DB, { maxTasks: url.searchParams.get("tasks") || 12, country }));
  }

  return json({ error: "Ikke funnet" }, { status: 404 });
}

async function runScheduled(cron, env) {
  if (!env.DB) {
    console.error("Planlagt innsamling hoppet over: D1-bindingen DB mangler");
    return;
  }
  const jobs = {
    "5 * * * *": async () => collectSmhiWeather(env.DB),
    "15 * * * *": async () => {
      if (!env.TRAFIKVERKET_API_KEY) throw new Error("TRAFIKVERKET_API_KEY mangler");
      return collectVvisWeather(env.DB, env.TRAFIKVERKET_API_KEY);
    },
    "25 * * * *": async () => { await ensurePhaseC(env.DB); return runDmiWeather(env.DB); },
    "30 * * * *": async () => runNordicClimateArchive(env.DB, { maxTasks: 12 }),
    "35 * * * *": async () => { await ensurePhaseC(env.DB); return runFmiWeather(env.DB); },
    "40 * * * *": async () => { await ensurePhaseC(env.DB); return runNordicBackfill(env.DB, { days: 60, maxTasks: 4 }); },
    "45 * * * *": async () => runSmhiBackfill(env.DB, { days: 60, maxStations: 2 }),
    "50 * * * *": async () => runFullClimateArchive(env.DB, { maxTasks: 60 }),
    "55 * * * *": async () => calculateWorkability(env.DB, { persist: true }),
    "0 */6 * * *": async () => runActivityMonitor(env.DB, { maxItems: 4 }),
    "10 2 * * *": async () => runTrafikverketProcurementMonitor(env.DB, { force: false }),
    "20 3 * * *": async () => runMunicipalMonitor(env.DB),
  };
  const job = jobs[cron];
  if (!job) {
    console.warn(`Ukjent cron-trigger ignorert: ${cron}`);
    return;
  }
  try {
    const result = await job();
    console.log(JSON.stringify({ event: "scheduled-job", cron, ok: result?.ok !== false, result }));
  } catch (error) {
    console.error(`Planlagt jobb feilet (${cron})`, error);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "terranor-tracker",
        architecture: "2.0-single-router",
        targetQuarter: TARGET_QUARTER,
        authConfigured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET),
        dbConfigured: Boolean(env.DB),
        trafikverketConfigured: Boolean(env.TRAFIKVERKET_API_KEY),
        timestamp: new Date().toISOString(),
      });
    }

    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return html(setupPage(), { status: 503 });

    if (url.pathname === "/login" && request.method === "GET") {
      if (await verifySession(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET)) return redirect("/");
      return html(loginPage());
    }

    if (url.pathname === "/login" && request.method === "POST") {
      const form = await request.formData();
      const valid = await secureEqual(String(form.get("password") || ""), env.APP_PASSWORD);
      if (!valid) return html(loginPage("Feil passord."), { status: 401 });
      if (env.DB) await initializeCoreData(env.DB);
      const now = Math.floor(Date.now() / 1000);
      const token = await signSession({ iat: now, exp: now + SESSION_TTL_SECONDS }, env.SESSION_SECRET);
      return redirect("/", { "set-cookie": `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict` });
    }

    if (url.pathname === "/logout") {
      return redirect("/login", { "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict` });
    }

    const authenticated = await verifySession(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
    if (!authenticated) {
      if (url.pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, { status: 401 });
      return redirect("/login");
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "POST" && !sameOriginWrite(request)) return json({ ok: false, error: "Ugyldig Origin" }, { status: 403 });
      try { return await handleApi(request, env, url); }
      catch (error) { return json({ ok: false, error: String(error?.message || error) }, { status: 500 }); }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
    if (String(headers.get("content-type") || "").includes("text/html")) {
      headers.set("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async scheduled(controller, env) {
    await runScheduled(String(controller.cron || ""), env);
  },
};
