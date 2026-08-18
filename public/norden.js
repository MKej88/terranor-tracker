const fmt = (value, digits = 0) => {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("nb-NO", { maximumFractionDigits: digits }).format(n);
};

const time = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
};

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const countryName = (value) => value === "Denmark" ? "Danmark" : value === "Finland" ? "Finland" : value || "—";

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

function pill(id, text, ok = false) {
  const el = document.querySelector(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok");
  if (ok) el.classList.add("ok");
}

function signed(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const prefix = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${prefix}${fmt(Math.abs(n), 1)}${suffix}`;
}

function countryBackfill(backfill, country) {
  const rows = (backfill?.targetStatus || []).filter((row) => row.country === country);
  const complete = rows.filter((row) => row.complete).length;
  return {
    targets: rows.length,
    complete,
    pct: rows.length ? Math.round(100 * complete / rows.length) : 0,
  };
}

function readinessRows(country, fast, climate, comparison) {
  const c = fast?.status?.countries?.[country] || {};
  const source = country === "Denmark" ? fast?.status?.sources?.DMI : fast?.status?.sources?.FMI;
  const short = countryBackfill(fast?.backfill, country);
  const long = climate?.countries?.[country] || {};
  const comp = comparison?.countries?.[country] || {};
  return [
    { label: "Løpende værkilde er i drift", ok: source?.status === "ok" },
    { label: "Alle værankere er koblet til målestasjon", ok: Number(c.targets || 0) > 0 && Number(c.linked || 0) === Number(c.targets || 0) },
    { label: "Minst 90 % har 60-dagers historikk", ok: short.targets > 0 && short.pct >= 90 },
    { label: "Minst 90 % av 10-årsjobbene har brukbare data", ok: Number(long.usablePct || 0) >= 90 && Number(long.errorTasks || 0) === 0 },
    { label: "Minst 90 % kan sammenlignes mot 2016–2025", ok: Number(comp.coveragePct || 0) >= 90 },
  ];
}

function renderReadiness(country, fast, climate, comparison) {
  const rows = readinessRows(country, fast, climate, comparison);
  const passed = rows.filter((row) => row.ok).length;
  const ready = passed === rows.length;
  const prefix = country === "Denmark" ? "denmark" : "finland";
  document.querySelector(`#${prefix}-readiness`).innerHTML = rows.map((row) => `
    <div class="status-row"><span>${esc(row.label)}</span><b class="${row.ok ? "text-good" : "text-warn"}">${row.ok ? "OK" : "Må følges opp"}</b></div>
  `).join("");
  pill(`#${prefix}-pill`, ready ? "værgrunnlaget er klart" : `${passed} / ${rows.length} klare`, ready);
  return ready;
}

function renderFast(fast) {
  const dk = fast?.status?.countries?.Denmark || {};
  const fi = fast?.status?.countries?.Finland || {};
  document.querySelector("#denmark-targets").textContent = fmt(dk.targets || 0);
  document.querySelector("#denmark-linked").textContent = `${fmt(dk.linked || 0)} koblet til målestasjon`;
  document.querySelector("#finland-targets").textContent = fmt(fi.targets || 0);
  document.querySelector("#finland-linked").textContent = `${fmt(fi.linked || 0)} koblet til målestasjon`;

  const backfill = fast?.backfill || {};
  document.querySelector("#short-history").textContent = `${fmt(backfill.targetsComplete || 0)} / ${fmt(backfill.targets || 0)}`;
  document.querySelector("#short-history-text").textContent = `${fmt(backfill.progressPct || 0)} % samlet fremdrift`;
}

function renderClimate(climate) {
  const countries = climate?.countries || {};
  const totals = [countries.Denmark, countries.Finland].filter(Boolean);
  const totalTasks = totals.reduce((sum, row) => sum + Number(row.totalTasks || 0), 0);
  const okTasks = totals.reduce((sum, row) => sum + Number(row.okTasks || 0), 0);
  const finished = totals.reduce((sum, row) => sum + Number(row.okTasks || 0) + Number(row.unavailableTasks || 0), 0);
  const pct = totalTasks ? Math.round(100 * finished / totalTasks) : 0;
  const usablePct = totalTasks ? Math.round(100 * okTasks / totalTasks) : 0;

  document.querySelector("#long-history").textContent = `${fmt(usablePct)} %`;
  document.querySelector("#long-history-text").textContent = `${fmt(okTasks)} av ${fmt(totalTasks)} månedsjobber med data`;
  document.querySelector("#climate-progress").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.querySelector("#climate-detail").textContent = totalTasks
    ? `${fmt(finished)} av ${fmt(totalTasks)} månedsjobber er ferdig behandlet. ${fmt(okTasks)} har brukbare historiske data. Sammenligningsperioden er Q3 ${climate.baseline}.`
    : "Venter på at værankrene skal bli koblet til målestasjoner.";

  const errors = totals.reduce((sum, row) => sum + Number(row.errorTasks || 0), 0);
  pill("#climate-pill", errors ? `${errors} feil` : climate?.complete ? "ferdig" : `${pct} % behandlet`, Boolean(climate?.complete && errors === 0));

  for (const country of ["Denmark", "Finland"]) {
    const row = countries[country] || {};
    const id = country === "Denmark" ? "#denmark-climate" : "#finland-climate";
    document.querySelector(id).innerHTML = `
      <div class="status-row"><span>${countryName(country)} · klare værankere</span><b>${fmt(row.targetsReady || 0)} / ${fmt(row.targets || 0)}</b></div>
      <div class="status-row"><span>Brukbare 10-årsjobber</span><b>${fmt(row.usablePct || 0)} %</b></div>
      <div class="status-row"><span>Ikke tilgjengelige måneder</span><b>${fmt(row.unavailableTasks || 0)}</b></div>
      <div class="status-row"><span>Feil som prøves igjen</span><b class="${Number(row.errorTasks || 0) ? "text-warn" : "text-good"}">${fmt(row.errorTasks || 0)}</b></div>
      <div class="status-row"><span>Geografiske proxyer</span><b>${fmt(row.proxyTargets || 0)}</b></div>
      <div class="status-row"><span>Værankere koblet til kontrakt</span><b>${fmt(row.contractLinkedTargets || 0)} / ${fmt(row.targets || 0)}</b></div>
    `;
  }

  const rows = climate?.targetStatus || [];
  document.querySelector("#climate-body").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${countryName(row.country)}</td>
      <td><b>${esc(row.label)}</b><br><span class="table-subtext">${esc(row.contract_name || "")}</span></td>
      <td>${esc(row.station_name || row.station_id || "—")}</td>
      <td>${fmt(row.ok_tasks)} / ${fmt(climate.tasksPerTarget || 30)}</td>
      <td>${fmt(row.unavailable_tasks)}</td>
      <td><b class="${Number(row.error_tasks || 0) ? "text-warn" : "text-good"}">${fmt(row.error_tasks)}</b></td>
      <td>${fmt(row.remaining_tasks)}</td>
      <td>${row.proxy ? "proxy" : "direkte område"}</td>
    </tr>`).join("") : `<tr><td colspan="8">Ingen værankere med historikkstatus.</td></tr>`;
}

function renderComparison(comparison) {
  for (const country of ["Denmark", "Finland"]) {
    const row = comparison?.countries?.[country] || {};
    const prefix = country === "Denmark" ? "denmark" : "finland";
    document.querySelector(`#${prefix}-ready`).textContent = `${fmt(row.targetsReady || 0)} / ${fmt(row.targets || 0)}`;
    document.querySelector(`#${prefix}-comparison-text`).textContent = `${fmt(row.coveragePct || 0, 1)} % av værankrene`;
    const anomaly = row.weightedAnomalyPoints ?? row.simpleAnomalyPoints;
    document.querySelector(`#${prefix}-anomaly`).textContent = signed(anomaly, " p");
  }

  const dk = comparison?.countries?.Denmark || {};
  const fi = comparison?.countries?.Finland || {};
  const allReady = Number(dk.coveragePct || 0) >= 90 && Number(fi.coveragePct || 0) >= 90;
  pill("#comparison-pill", allReady ? "god dekning" : "historikk bygges", allReady);
  document.querySelector("#comparison-note").textContent = comparison?.interpretation || "";

  const rows = comparison?.targets || [];
  document.querySelector("#comparison-body").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${countryName(row.country)}</td>
      <td><b>${esc(row.label)}</b><br><span class="table-subtext">${esc(row.contract_name || "")}</span></td>
      <td>${esc(row.station_name || row.station_id || "—")}</td>
      <td>${signed(row.air_temperature_delta_c, " °C")}</td>
      <td>${signed(row.precipitation_event_delta_pct, " pp")}</td>
      <td>${signed(row.high_wind_delta_pct, " pp")}</td>
      <td><b class="${Number(row.workability_anomaly_points) >= 0 && row.ready ? "text-good" : row.ready ? "text-warn" : ""}">${signed(row.workability_anomaly_points, " p")}</b></td>
      <td>${fmt(row.baseline_years)}</td>
    </tr>`).join("") : `<tr><td colspan="8">Ingen historisk sammenligning tilgjengelig ennå.</td></tr>`;
}

let state = {};

function renderOverall() {
  if (!state.fast || !state.climate || !state.comparison) return;
  const dk = renderReadiness("Denmark", state.fast, state.climate, state.comparison);
  const fi = renderReadiness("Finland", state.fast, state.climate, state.comparison);
  pill("#overall-pill", dk && fi ? "begge land er klare" : dk || fi ? "ett land er klart" : "historikk bygges", dk && fi);
}

async function load() {
  const button = document.querySelector("#refresh-button");
  button.disabled = true;
  button.textContent = "Oppdaterer…";
  document.querySelector("#updated-line").textContent = "Henter fersk status fra databasen…";
  const jobs = [
    getJson("/api/fase-c/fast?days=60").then((data) => { state.fast = data; renderFast(data); }),
    getJson("/api/nordic/climate/status").then((data) => { state.climate = data; renderClimate(data); }),
    getJson("/api/nordic/climate/comparison?days=7").then((data) => { state.comparison = data; renderComparison(data); }),
  ];
  try {
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((row) => row.status === "rejected");
    renderOverall();
    document.querySelector("#updated-line").textContent = failed.length
      ? `Oppdatert ${time(new Date().toISOString())}. ${failed.length} del${failed.length === 1 ? "" : "er"} kunne ikke hentes.`
      : `Oppdatert ${time(new Date().toISOString())}. Historikken bygges automatisk videre hver time.`;
    for (const row of failed) console.error(row.reason);
  } finally {
    button.disabled = false;
    button.textContent = "Oppdater siden";
  }
}

async function runClimate(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Henter historikk…";
  try {
    const result = await getJson("/api/nordic/climate/run?tasks=12");
    const failed = (result?.details || []).filter((row) => row.status === "feil").length;
    button.textContent = failed ? `${failed} feil – se status` : result.tasksAttempted ? `${result.tasksAttempted} historikkjobber ferdig` : "Alt er ferdig";
    await load();
  } catch (error) {
    button.textContent = "Feil – prøv igjen";
    document.querySelector("#updated-line").textContent = `Historikkinnlasting feilet: ${error.message}`;
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 1800);
  }
}

document.querySelector("#refresh-button").addEventListener("click", load);
document.querySelector("#run-climate").addEventListener("click", (event) => runClimate(event.currentTarget));
load();
