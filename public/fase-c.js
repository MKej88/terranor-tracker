const CACHE_KEY = "terranor:fase-c:fast:v2";
const CACHE_TTL_MS = 10 * 60 * 1000;

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const formatNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat("nb-NO").format(n) : "—";
};

const formatTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
};

const formatAge = (value) => {
  if (!value) return "ikke kjørt";
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return "ukjent";
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 2) return "nå nettopp";
  if (minutes < 60) return `${minutes} min siden`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} t siden`;
  return `${Math.round(minutes / 1440)} d siden`;
};

const countryName = (value) => ({ Denmark: "Danmark", Finland: "Finland" }[value] || value || "—");
const sourceName = (value) => ({ DMI: "Danske værdata", FMI: "Finske værdata" }[value] || value || "—");
const confidenceName = (value) => ({
  high: "høy",
  "high-location": "høy for sted",
  "regional-proxy": "regional proxy",
}[value] || String(value || "—").replaceAll("_", " "));

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

const getJson = (url) => requestJson(url);
const postJson = (url) => requestJson(url, { method: "POST" });

function sourceStatusRows(source) {
  const run = source?.lastRun;
  const statusText = run?.status === "ok" ? "OK" : run?.status === "partial" ? "delvis" : run?.status === "error" ? "feil" : "venter";
  return [
    `<div class="status-row"><span>Siste kjøring</span><b>${run?.finished_at ? `${formatTime(run.finished_at)} · ${formatAge(run.finished_at)}` : "ikke kjørt ennå"}</b></div>`,
    `<div class="status-row"><span>Status</span><b class="${run?.status === "ok" ? "text-good" : run ? "text-warn" : ""}">${statusText}</b></div>`,
    `<div class="status-row"><span>Områder forsøkt</span><b>${formatNumber(run?.targets_attempted || 0)}</b></div>`,
    `<div class="status-row"><span>Områder fullført</span><b>${formatNumber(run?.targets_completed || 0)}</b></div>`,
    `<div class="status-row"><span>Målinger skrevet sist</span><b>${formatNumber(run?.observations_written || 0)}</b></div>`,
  ].join("");
}

function renderBackfill(backfill) {
  const pct = Math.max(0, Math.min(100, Number(backfill?.progressPct || 0)));
  document.querySelector("#backfill-progress").style.width = `${pct}%`;
  document.querySelector("#backfill-detail").textContent = backfill?.targets
    ? `${backfill.targetsComplete} av ${backfill.targets} værankere oppfyller kvalitetskravet for ${backfill.days} dager. Samlet fremdrift er ${pct} %. Historikken fylles automatisk bakover hver time.`
    : "Venter på at værankrene skal bli koblet til målestasjoner.";
  const pill = document.querySelector("#backfill-pill");
  pill.classList.remove("ok");
  if (backfill?.complete) {
    pill.textContent = "ferdig";
    pill.classList.add("ok");
  } else {
    pill.textContent = `${pct} %`;
  }

  const sourceRows = ["DMI", "FMI"].map((source) => {
    const rows = (backfill?.targetStatus || []).filter((x) => x.source === source);
    const done = rows.filter((x) => x.complete).length;
    const avg = rows.length ? Math.round(rows.reduce((sum, x) => sum + Number(x.minimum_core_coverage_pct || 0), 0) / rows.length) : 0;
    return `<div class="status-row"><span>${sourceName(source)}</span><b>${done}/${rows.length} ferdige · ca. ${avg} % kjerneparameterdekning</b></div>`;
  });
  const latest = backfill?.latestRun;
  if (latest) {
    sourceRows.push(`<div class="status-row"><span>Siste historikkjobb</span><b>${escapeHtml(latest.label || "—")} · ${latest.status === "ok" ? "OK" : "feil"} · ${formatNumber(latest.observations_written || 0)} målinger</b></div>`);
  }
  document.querySelector("#backfill-list").innerHTML = sourceRows.join("");
}

function render(status, backfill, generatedAt = null, cached = false) {
  const denmark = status?.countries?.Denmark || {};
  const finland = status?.countries?.Finland || {};
  const dmi = status?.sources?.DMI || {};
  const fmi = status?.sources?.FMI || {};

  document.querySelector("#denmark-targets").textContent = formatNumber(denmark.targets || 0);
  document.querySelector("#denmark-linked").textContent = `${formatNumber(denmark.linked || 0)} koblet til målestasjon`;
  document.querySelector("#finland-targets").textContent = formatNumber(finland.targets || 0);
  document.querySelector("#finland-linked").textContent = `${formatNumber(finland.linked || 0)} koblet til målestasjon`;
  document.querySelector("#dmi-observations").textContent = formatNumber(dmi.observations || 0);
  document.querySelector("#dmi-latest").textContent = dmi.latest ? `Siste: ${formatTime(dmi.latest)}` : "Ingen målinger ennå";
  document.querySelector("#fmi-observations").textContent = formatNumber(fmi.observations || 0);
  document.querySelector("#fmi-latest").textContent = fmi.latest ? `Siste: ${formatTime(fmi.latest)}` : "Ingen målinger ennå";

  document.querySelector("#dmi-status").innerHTML = sourceStatusRows(dmi);
  document.querySelector("#fmi-status").innerHTML = sourceStatusRows(fmi);
  document.querySelector("#dmi-pill").textContent = dmi.status === "ok" ? "aktiv" : dmi.status === "partial" ? "delvis" : dmi.status === "error" ? "feil" : "klar for test";
  document.querySelector("#fmi-pill").textContent = fmi.status === "ok" ? "aktiv" : fmi.status === "partial" ? "delvis" : fmi.status === "error" ? "feil" : "klar for test";

  const targets = status?.targets || [];
  document.querySelector("#target-body").innerHTML = targets.length ? targets.map((row) => `
    <tr>
      <td>${escapeHtml(countryName(row.country))}</td>
      <td><b>${escapeHtml(row.label || "—")}</b><br><span class="table-subtext">${escapeHtml(row.location_name || "")}</span></td>
      <td>${escapeHtml(row.matched_contract || row.contract_name || "ikke koblet")}</td>
      <td>${escapeHtml(sourceName(row.source))}</td>
      <td>${escapeHtml(row.station_name || row.station_id || "venter på første kjøring")}</td>
      <td>${Number.isFinite(Number(row.distance_km)) ? `${Number(row.distance_km).toFixed(1)} km` : "—"}</td>
      <td>${escapeHtml(confidenceName(row.confidence))}</td>
    </tr>`).join("") : `<tr><td colspan="7">Ingen værankere er registrert.</td></tr>`;

  document.querySelector("#method-list").innerHTML = Object.entries(status?.methodology || {}).map(([country, text]) => `
    <div class="status-row"><span>${escapeHtml(countryName(country))}</span><b>${escapeHtml(text)}</b></div>
  `).join("");

  const limitations = status?.limitations || [];
  document.querySelector("#limitation-list").innerHTML = limitations.length ? limitations.map((text) => `
    <div class="problem-row"><div><b>Avgrensning</b><span>${escapeHtml(text)}</span></div></div>
  `).join("") : `<div class="empty-good"><b>Ingen kjente avgrensninger</b></div>`;

  renderBackfill(backfill);

  const sourceHealthy = [dmi, fmi].filter((x) => x.status === "ok").length;
  const pill = document.querySelector("#phase-pill");
  pill.classList.remove("ok");
  if (sourceHealthy === 2) {
    pill.textContent = backfill?.complete ? "Begge land + historikk klare" : "Begge land samler data";
    pill.classList.add("ok");
  } else if (sourceHealthy === 1) {
    pill.textContent = "Én kilde er i drift";
  } else {
    pill.textContent = "Klar for første test";
  }

  const timestamp = generatedAt || new Date().toISOString();
  document.querySelector("#updated-line").textContent = cached
    ? `Viser nylig lagret status fra ${formatTime(timestamp)} · oppdaterer i bakgrunnen…`
    : `Siden ble oppdatert ${formatTime(timestamp)}. Live-data og historikk fortsetter automatisk hver time.`;
}

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!cached?.savedAt || Date.now() - cached.savedAt > CACHE_TTL_MS) return null;
    if (!cached?.payload?.status || !cached?.payload?.backfill) return null;
    return cached.payload;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), payload })); }
  catch {}
}

async function load({ showCache = true } = {}) {
  if (showCache) {
    const cached = readCache();
    if (cached) render(cached.status, cached.backfill, cached.generatedAt, true);
  }
  try {
    const payload = await getJson("/api/fase-c/fast?days=60");
    writeCache(payload);
    render(payload.status, payload.backfill, payload.generatedAt, false);
  } catch (error) {
    if (!readCache()) {
      document.querySelector("#phase-pill").textContent = "Kunne ikke hente status";
      document.querySelector("#updated-line").textContent = `Feil: ${error.message}`;
    } else {
      document.querySelector("#updated-line").textContent = `Viser sist lagrede status. Ny oppdatering feilet: ${error.message}`;
    }
    console.error(error);
  }
}

async function runCountry(country, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Henter…";
  try {
    const result = await postJson(`/api/nordic/run?country=${encodeURIComponent(country)}`);
    const source = country === "Denmark" ? result?.sources?.DMI : result?.sources?.FMI;
    const failed = (source?.details || []).filter((x) => x.status === "feil");
    button.textContent = failed.length ? `${failed.length} feil – se status` : "Ferdig";
    await load({ showCache: false });
  } catch (error) {
    button.textContent = "Feil – prøv igjen";
    document.querySelector("#updated-line").textContent = `Innhenting feilet: ${error.message}`;
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 1800);
  }
}

async function runBackfill(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Fyller historikk…";
  try {
    const result = await postJson("/api/nordic/backfill/run?days=60&tasks=2");
    const failed = (result?.details || []).filter((x) => x.status === "feil");
    button.textContent = failed.length ? `${failed.length} feil – se status` : result.tasksAttempted ? "Historikkbit ferdig" : "All historikk er ferdig";
    await load({ showCache: false });
  } catch (error) {
    button.textContent = "Feil – prøv igjen";
    document.querySelector("#updated-line").textContent = `Historikkinnlasting feilet: ${error.message}`;
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 1800);
  }
}

document.querySelector("#run-denmark").addEventListener("click", (event) => runCountry("Denmark", event.currentTarget));
document.querySelector("#run-finland").addEventListener("click", (event) => runCountry("Finland", event.currentTarget));
document.querySelector("#run-backfill").addEventListener("click", (event) => runBackfill(event.currentTarget));
document.querySelector("#refresh-button").addEventListener("click", () => load({ showCache: false }));
load();
