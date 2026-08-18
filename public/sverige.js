const formatNumber = (value, digits = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("nb-NO", { maximumFractionDigits: digits }).format(n);
};

const formatTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const statusText = (value) => ({
  god_flerstasjonsdekning: "god dekning",
  brukbar: "brukbar",
  bør_forbedres: "bør forbedres",
  ok: "OK",
  error: "feil",
  partial: "delvis",
}[String(value || "")] || String(value || "—").replaceAll("_", " "));

async function getJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

function setPill(selector, text, ok = false) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok");
  if (ok) el.classList.add("ok");
}

function renderLiveSources(quality) {
  const rows = [];
  for (const source of ["SMHI", "VVIS"]) {
    const run = quality?.collection_runs?.[source];
    const sourceLabel = source === "SMHI" ? "Vanlige værdata fra SMHI" : "Veivær fra Trafikverket";
    const freshCheck = source === "SMHI" ? quality?.checks?.smhi_recent : quality?.checks?.vvis_recent;
    rows.push(`
      <div class="status-row"><span>${sourceLabel}</span><b class="${freshCheck ? "text-good" : "text-warn"}">${freshCheck ? "fersk" : "må sjekkes"}</b></div>
      <div class="status-row sub-row"><span>Siste vellykkede kjøring</span><b>${escapeHtml(formatTime(run?.finished_at))}</b></div>
      <div class="status-row sub-row"><span>Målinger i siste kjøring</span><b>${formatNumber(run?.observations_written)}</b></div>
    `);
  }
  document.querySelector("#live-source-list").innerHTML = rows.join("");
}

function renderBackfill(backfill) {
  const done = Number(backfill?.stationsBackfilled || 0);
  const total = Number(backfill?.stations || 0);
  const pct = total ? Math.round(100 * done / total) : 0;
  document.querySelector("#backfill-summary").textContent = total ? `${done} / ${total}` : "—";
  document.querySelector("#backfill-kpi-text").textContent = backfill?.complete ? "Alle primære SMHI-stasjoner er klare" : `${pct} % ferdig`;
  document.querySelector("#backfill-progress").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.querySelector("#backfill-detail").textContent = total
    ? `${done} av ${total} primære SMHI-stasjoner har nok målinger for de siste ${formatNumber(backfill?.days || 60)} dagene.`
    : "Ingen primære SMHI-stasjoner er registrert ennå.";
  setPill("#backfill-pill", backfill?.complete ? "komplett" : `${pct} %`, Boolean(backfill?.complete));

  const rows = backfill?.stationStatus || [];
  document.querySelector("#backfill-body").innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.station_name || row.station_id)}</td>
        <td>${formatNumber(row.observations)}</td>
        <td><b class="${row.backfilled ? "text-good" : "text-warn"}">${row.backfilled ? "klar" : "fylles inn"}</b></td>
      </tr>
    `).join("")
    : `<tr><td colspan="3">Ingen stasjonsstatus tilgjengelig.</td></tr>`;
}

function renderClimate(climate) {
  const pct = Number(climate?.progressPct || 0);
  const ready = Number(climate?.stationsFullyReady || 0);
  const stations = Number(climate?.stations || 0);
  const errors = Number(climate?.errorTasks || 0);
  document.querySelector("#climate-progress-kpi").textContent = `${formatNumber(pct)} %`;
  document.querySelector("#climate-kpi-text").textContent = stations ? `${ready} / ${stations} stasjoner fullt klare` : "2016–2025 · Q3";
  document.querySelector("#climate-progress").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.querySelector("#climate-detail").textContent = stations
    ? `${formatNumber(climate?.finishedTasks)} av ${formatNumber(climate?.totalTasks)} stasjon/parameter-jobber er ferdige. ${ready} av ${stations} stasjoner har alle tre parametere klare.`
    : "Venter på registrerte SMHI-stasjoner.";
  setPill("#climate-pill", errors ? `${errors} feil` : pct >= 100 ? "komplett" : `${formatNumber(pct)} %`, pct >= 100 && errors === 0);

  const rows = climate?.stationStatus || [];
  document.querySelector("#climate-body").innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.station_name || row.station_id)}</td>
        <td>${formatNumber(row.ok_parameters)} / ${formatNumber(climate?.parametersPerStation || 3)}</td>
        <td>${formatNumber(row.unavailable_parameters)}</td>
        <td><b class="${Number(row.error_parameters || 0) ? "text-warn" : "text-good"}">${formatNumber(row.error_parameters)}</b></td>
        <td>${formatNumber(row.remaining_parameters)}</td>
        <td>${formatNumber(row.max_years)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="6">Ingen arkivstatus tilgjengelig.</td></tr>`;
}

function renderGeography(geography) {
  const contracts = Number(geography?.contracts || 0);
  const avg = Number(geography?.averageCoveragePct || 0);
  const good = Number(geography?.contractsWithGoodCoverage || 0);
  const weak = Number(geography?.contractsNeedingImprovement || 0);
  document.querySelector("#contract-count").textContent = contracts ? formatNumber(contracts) : "—";
  document.querySelector("#geography-coverage").textContent = contracts ? `${formatNumber(avg)} %` : "—";
  document.querySelector("#geography-summary").textContent = contracts ? `${good} av ${contracts} har god flerstasjonsdekning` : "Målestasjoner per kontrakt";
  document.querySelector("#geography-note").textContent = `${geography?.method || ""} ${geography?.limitation || ""}`.trim();
  setPill("#geography-pill", weak ? `${weak} bør forbedres` : "god dekning", contracts > 0 && weak === 0);

  const rows = geography?.contractStatus || [];
  document.querySelector("#geography-body").innerHTML = rows.length
    ? rows.map((row) => {
      const road = row.active_stations?.road_weather ?? 0;
      const roadTarget = row.target_stations?.road_weather ?? 0;
      const ordinary = row.active_stations?.ordinary_weather ?? 0;
      const ordinaryTarget = row.target_stations?.ordinary_weather ?? 0;
      const status = String(row.status || "");
      const goodStatus = status === "god_flerstasjonsdekning";
      return `
        <tr>
          <td>${escapeHtml(row.contract_name)}</td>
          <td>${escapeHtml(row.area_type || "—")}</td>
          <td>${formatNumber(road)} / ${formatNumber(roadTarget)}</td>
          <td>${formatNumber(ordinary)} / ${formatNumber(ordinaryTarget)}</td>
          <td>${formatNumber(row.coverage_pct)} %</td>
          <td>${Number.isFinite(Number(row.max_station_distance_km)) ? `${formatNumber(row.max_station_distance_km, 1)} km` : "—"}</td>
          <td><b class="${goodStatus ? "text-good" : status === "bør_forbedres" ? "text-warn" : ""}">${escapeHtml(statusText(status))}</b></td>
        </tr>
      `;
    }).join("")
    : `<tr><td colspan="7">Ingen svenske kontrakter med væranker funnet.</td></tr>`;
}

function signed(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const shown = formatNumber(Math.abs(n), 1);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${shown}${suffix}`;
}

function renderComparison(comparison) {
  const ready = Number(comparison?.contractsReady || 0);
  const total = Number(comparison?.contractsTotal || 0);
  const coverage = Number(comparison?.weightedCoveragePct || 0);
  const anomaly = Number(comparison?.swedenWorkabilityAnomalyPoints);
  document.querySelector("#comparison-ready").textContent = total ? `${ready} / ${total}` : "—";
  document.querySelector("#comparison-coverage").textContent = total ? `${formatNumber(coverage, 1)} %` : "—";
  document.querySelector("#comparison-anomaly").textContent = Number.isFinite(anomaly) ? signed(anomaly, " p") : "—";
  document.querySelector("#comparison-baseline").textContent = comparison?.baseline || "—";
  document.querySelector("#comparison-note").textContent = comparison?.interpretation || "";
  setPill("#comparison-pill", total && ready === total ? "alle klare" : `${ready} / ${total} klare`, total > 0 && ready === total);

  const rows = comparison?.contracts || [];
  document.querySelector("#comparison-body").innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.contract_name)}</td>
        <td>${escapeHtml(row.station_name || row.station_id)}</td>
        <td>${signed(row.air_temperature_delta_c, " °C")}</td>
        <td>${signed(row.precipitation_event_delta_pct, " pp")}</td>
        <td>${signed(row.high_wind_delta_pct, " pp")}</td>
        <td><b class="${Number(row.workability_anomaly_points) >= 0 ? "text-good" : Number.isFinite(Number(row.workability_anomaly_points)) ? "text-warn" : ""}">${signed(row.workability_anomaly_points, " p")}</b></td>
        <td>${formatNumber(row.baseline_years)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="7">Ingen sammenlignbare kontrakter ennå.</td></tr>`;
}

function renderReadiness({ quality, backfill, climate, geography, comparison }) {
  const checks = [
    { label: "SMHI-data er ferske", ok: Boolean(quality?.checks?.smhi_recent) },
    { label: "Veivær fra Trafikverket er ferskt", ok: Boolean(quality?.checks?.vvis_recent) },
    { label: "60-dagers SMHI-historikk er komplett", ok: Boolean(backfill?.complete) },
    { label: "10-årsgrunnlaget er ferdig uten arkivfeil", ok: Number(climate?.progressPct || 0) >= 100 && Number(climate?.errorTasks || 0) === 0 },
    { label: "Gjennomsnittlig geografisk dekning er minst 85 %", ok: Number(geography?.averageCoveragePct || 0) >= 85 },
    { label: "Minst 90 % av økonomisk vekt har historisk sammenligning", ok: Number(comparison?.weightedCoveragePct || 0) >= 90 },
  ];
  const passed = checks.filter((row) => row.ok).length;
  const ready = passed === checks.length;
  document.querySelector("#readiness-list").innerHTML = checks.map((row) => `
    <div class="status-row"><span>${escapeHtml(row.label)}</span><b class="${row.ok ? "text-good" : "text-warn"}">${row.ok ? "OK" : "Må følges opp"}</b></div>
  `).join("");
  setPill("#readiness-pill", ready ? "klar for Q3-modellen" : `${passed} / ${checks.length} klare`, ready);
  setPill("#sweden-pill", ready ? "datagrunnlaget er klart" : `${passed} / ${checks.length} hovedkontroller`, ready);
}

let state = {};

async function loadStatus() {
  const refresh = document.querySelector("#refresh-button");
  refresh.disabled = true;
  refresh.textContent = "Oppdaterer…";
  document.querySelector("#updated-line").textContent = "Henter fersk status fra databasen…";

  const jobs = [
    getJson("/api/data-quality").then((data) => { state.quality = data; renderLiveSources(data); }),
    getJson("/api/backfill/smhi/status?days=60").then((data) => { state.backfill = data; renderBackfill(data); }),
    getJson("/api/climate/status").then((data) => { state.climate = data; renderClimate(data); }),
    getJson("/api/geography").then((data) => { state.geography = data; renderGeography(data); }),
    getJson("/api/climate/comparison?days=7").then((data) => { state.comparison = data; renderComparison(data); }),
  ];

  try {
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((result) => result.status === "rejected");
    if (state.quality && state.backfill && state.climate && state.geography && state.comparison) renderReadiness(state);
    else setPill("#sweden-pill", "ufullstendig status", false);
    document.querySelector("#updated-line").textContent = failed.length
      ? `Oppdatert ${formatTime(new Date().toISOString())}. ${failed.length} del${failed.length === 1 ? "" : "er"} kunne ikke hentes.`
      : `Oppdatert ${formatTime(new Date().toISOString())}. Statusen leses direkte fra Terranor Tracker-databasen.`;
    for (const result of failed) console.error(result.reason);
  } finally {
    refresh.disabled = false;
    refresh.textContent = "Oppdater siden";
  }
}

async function runAction(button, url, workingText) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = workingText;
  try {
    await getJson(url);
    await loadStatus();
  } catch (error) {
    console.error(error);
    document.querySelector("#updated-line").textContent = `Kjøringen feilet: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

document.querySelector("#refresh-button").addEventListener("click", loadStatus);
document.querySelector("#run-backfill").addEventListener("click", (event) => runAction(event.currentTarget, "/api/backfill/smhi/run?days=60&stations=3", "Fyller historikk…"));
document.querySelector("#run-climate").addEventListener("click", (event) => runAction(event.currentTarget, "/api/climate/full-run?tasks=60", "Fyller 10-årsgrunnlag…"));

loadStatus();
