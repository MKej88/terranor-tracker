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

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

function sourceStatusRows(source) {
  const run = source?.lastRun;
  return [
    `<div class="status-row"><span>Siste kjøring</span><b>${run?.finished_at ? `${formatTime(run.finished_at)} · ${formatAge(run.finished_at)}` : "ikke kjørt ennå"}</b></div>`,
    `<div class="status-row"><span>Status</span><b class="${run?.status === "ok" ? "text-good" : run ? "text-warn" : ""}">${run?.status === "ok" ? "OK" : run?.status === "error" ? "feil" : "venter"}</b></div>`,
    `<div class="status-row"><span>Områder forsøkt</span><b>${formatNumber(run?.targets_attempted || 0)}</b></div>`,
    `<div class="status-row"><span>Områder fullført</span><b>${formatNumber(run?.targets_completed || 0)}</b></div>`,
    `<div class="status-row"><span>Målinger skrevet sist</span><b>${formatNumber(run?.observations_written || 0)}</b></div>`,
  ].join("");
}

function render(status) {
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
  document.querySelector("#dmi-pill").textContent = dmi.status === "ok" ? "aktiv" : dmi.status === "error" ? "feil" : "klar for test";
  document.querySelector("#fmi-pill").textContent = fmi.status === "ok" ? "aktiv" : fmi.status === "error" ? "feil" : "klar for test";

  const targets = status?.targets || [];
  document.querySelector("#target-body").innerHTML = targets.length ? targets.map((row) => `
    <tr>
      <td>${countryName(row.country)}</td>
      <td><b>${row.label || "—"}</b><br><span class="table-subtext">${row.location_name || ""}</span></td>
      <td>${row.matched_contract || row.contract_name || "ikke koblet"}</td>
      <td>${sourceName(row.source)}</td>
      <td>${row.station_name || row.station_id || "venter på første kjøring"}</td>
      <td>${Number.isFinite(Number(row.distance_km)) ? `${Number(row.distance_km).toFixed(1)} km` : "—"}</td>
      <td>${confidenceName(row.confidence)}</td>
    </tr>`).join("") : `<tr><td colspan="7">Ingen værankere er registrert.</td></tr>`;

  document.querySelector("#method-list").innerHTML = Object.entries(status?.methodology || {}).map(([country, text]) => `
    <div class="status-row"><span>${countryName(country)}</span><b>${text}</b></div>
  `).join("");

  const limitations = status?.limitations || [];
  document.querySelector("#limitation-list").innerHTML = limitations.length ? limitations.map((text) => `
    <div class="problem-row"><div><b>Avgrensning</b><span>${text}</span></div></div>
  `).join("") : `<div class="empty-good"><b>Ingen kjente avgrensninger</b></div>`;

  const sourceHealthy = [dmi, fmi].filter((x) => x.status === "ok").length;
  const pill = document.querySelector("#phase-pill");
  pill.classList.remove("ok");
  if (sourceHealthy === 2) {
    pill.textContent = "Begge land samler data";
    pill.classList.add("ok");
  } else if (sourceHealthy === 1) {
    pill.textContent = "Én kilde er i drift";
  } else {
    pill.textContent = "Klar for første test";
  }
  document.querySelector("#updated-line").textContent = `Siden ble oppdatert ${formatTime(new Date().toISOString())}. Fase C kjøres automatisk hver time etter at deploymenten er aktiv.`;
}

async function load() {
  try {
    render(await getJson("/api/nordic/status"));
  } catch (error) {
    document.querySelector("#phase-pill").textContent = "Kunne ikke hente status";
    document.querySelector("#updated-line").textContent = `Feil: ${error.message}`;
    console.error(error);
  }
}

async function runCountry(country, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Henter…";
  try {
    const result = await getJson(`/api/nordic/run?country=${encodeURIComponent(country)}`);
    const source = country === "Denmark" ? result?.sources?.DMI : result?.sources?.FMI;
    const failed = (source?.details || []).filter((x) => x.status === "feil");
    button.textContent = failed.length ? `${failed.length} feil – se status` : "Ferdig";
    await load();
  } catch (error) {
    button.textContent = "Feil – prøv igjen";
    document.querySelector("#updated-line").textContent = `Innhenting feilet: ${error.message}`;
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 1800);
  }
}

document.querySelector("#run-denmark").addEventListener("click", (event) => runCountry("Denmark", event.currentTarget));
document.querySelector("#run-finland").addEventListener("click", (event) => runCountry("Finland", event.currentTarget));
document.querySelector("#refresh-button").addEventListener("click", load);
load();
