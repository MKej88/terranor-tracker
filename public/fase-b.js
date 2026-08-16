const relevantTypes = new Set(["utlost_option", "tilleggsarbeid", "ny_bestilling"]);

const typeName = (type) => ({
  utlost_option: "Utløst opsjon",
  tilleggsarbeid: "Tilleggsarbeid",
  ny_bestilling: "Ny bestilling",
  ny_kontrakt: "Ny hovedkontrakt",
  annen_aktivitet: "Annen aktivitet",
}[type] || String(type || "Ukjent"));

const statusName = (status) => ({
  aktiv: "aktiv",
  neste_kilde: "neste kilde",
  planlagt: "planlagt",
  ny: "ny",
  automatisk_godkjent: "automatisk godkjent",
  godkjent: "godkjent",
  ignorert: "ignorert",
  allerede_registrert: "allerede registrert",
}[status] || String(status || "ukjent").replaceAll("_", " "));

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const formatNumber = (value, digits = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("nb-NO", { maximumFractionDigits: digits }).format(n);
};

const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
};

const formatTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
};

const formatAgeHours = (hours) => {
  const n = Number(hours);
  if (!Number.isFinite(n)) return "ikke kjørt";
  if (n < 0.1) return "nå nettopp";
  if (n < 1) return `${Math.max(1, Math.round(n * 60))} min siden`;
  if (n < 24) return `${formatNumber(n, 1)} t siden`;
  return `${formatNumber(n / 24, 1)} d siden`;
};

async function getJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

function registeredSignalCount(activity) {
  return (activity?.signalTypes || [])
    .filter((row) => relevantTypes.has(row.signal_type))
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function renderTop(activity) {
  const sources = activity?.monitoredSources || [];
  const activeSources = sources.filter((x) => x.status === "aktiv").length;
  const newCandidates = Number(activity?.candidates?.new || 0);
  const signals = registeredSignalCount(activity);
  const latest = activity?.latestRun;

  document.querySelector("#active-sources").textContent = formatNumber(activeSources);
  document.querySelector("#new-candidates").textContent = formatNumber(newCandidates);
  document.querySelector("#signal-count").textContent = formatNumber(signals);
  document.querySelector("#last-run-age").textContent = formatAgeHours(latest?.age_hours);
  document.querySelector("#last-run-time").textContent = latest?.finished_at
    ? `Sist kontrollert ${formatTime(latest.finished_at)}`
    : `Automatisk kontroll hver ${formatNumber(activity?.automaticCheckEveryHours || 6)}. time`;

  const pill = document.querySelector("#phase-pill");
  pill.classList.remove("ok");
  if (latest?.status === "error") {
    pill.textContent = "Siste kontroll feilet";
  } else if (newCandidates > 0) {
    pill.textContent = `${newCandidates} nye funn`;
  } else {
    pill.textContent = "Ingen nye funn";
    pill.classList.add("ok");
  }

  document.querySelector("#candidate-pill").textContent = `${newCandidates} nye`;
  document.querySelector("#accounting-rule").textContent = activity?.rules?.accountingRule
    || "Et ordre- eller aktivitetssignal blir ikke automatisk omgjort til omsetning eller justert EBITA.";
}

function renderSources(activity) {
  const sources = activity?.monitoredSources || [];
  document.querySelector("#source-list").innerHTML = sources.length
    ? sources.map((source) => `
      <div class="status-row">
        <span>${escapeHtml(source.name)}</span>
        <b class="${source.status === "aktiv" ? "text-good" : ""}">${escapeHtml(statusName(source.status))}</b>
      </div>
    `).join("")
    : `<div class="status-row"><span>Ingen kilder registrert</span><b>—</b></div>`;
}

function candidateActions(row) {
  if (row.review_status !== "ny") return `<span class="badge">${escapeHtml(statusName(row.review_status))}</span>`;
  return `
    <div class="action-buttons">
      <button class="small-button approve" data-review-id="${Number(row.id)}" data-action="godkjenn" type="button">Godkjenn</button>
      <button class="small-button" data-review-id="${Number(row.id)}" data-action="ignorer" type="button">Ignorer</button>
    </div>`;
}

function renderCandidates(candidates) {
  const rows = candidates?.candidates || [];
  const body = document.querySelector("#candidate-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-good"><b>Ingen kandidater</b><span>Det er ingen nye eller tidligere vurderte funn i kandidatregisteret ennå.</span></div></td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${formatDate(row.published_at || row.created_at)}</td>
      <td>
        <a class="table-link" href="${escapeHtml(row.item_url)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a>
        <small class="table-subtext">${escapeHtml(row.source_name || "")}</small>
      </td>
      <td><span class="badge">${escapeHtml(typeName(row.signal_type))}</span></td>
      <td>${escapeHtml(row.contract_name || "Ikke koblet")}</td>
      <td>${Number.isFinite(Number(row.value_msek)) ? `${formatNumber(row.value_msek, 1)} MSEK` : "—"}</td>
      <td>${Number.isFinite(Number(row.relevance_score)) ? `${formatNumber(row.relevance_score)} %` : "—"}</td>
      <td>${candidateActions(row)}</td>
    </tr>
  `).join("");
}

function renderSignals(signals) {
  const rows = (signals?.signals || []).filter((row) => relevantTypes.has(row.signal_type));
  const body = document.querySelector("#signal-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7">Ingen registrerte høyt prioriterte aktivitetssignaler ennå.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${formatDate(row.observed_at)}</td>
      <td>${escapeHtml(row.title)}</td>
      <td><span class="badge">${escapeHtml(typeName(row.signal_type))}</span></td>
      <td>${escapeHtml(row.contract_name || "Ikke koblet")}</td>
      <td>${Number.isFinite(Number(row.value)) ? `${formatNumber(row.value, 1)} ${escapeHtml(row.unit || "MSEK")}` : "—"}</td>
      <td>${Number.isFinite(Number(row.confidence)) ? `${formatNumber(row.confidence)} %` : "—"}</td>
      <td>${row.source_url ? `<a class="table-link" href="${escapeHtml(row.source_url)}" target="_blank" rel="noreferrer">Åpne kilde</a>` : "—"}</td>
    </tr>
  `).join("");
}

async function reviewCandidate(id, action, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = action === "godkjenn" ? "Godkjenner…" : "Ignorerer…";
  try {
    await getJson("/api/activity/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    await loadPage();
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    alert(`Kunne ikke lagre vurderingen: ${error.message}`);
  }
}

function bindReviewButtons() {
  document.querySelectorAll("[data-review-id]").forEach((button) => {
    button.addEventListener("click", () => reviewCandidate(
      Number(button.dataset.reviewId),
      button.dataset.action,
      button,
    ));
  });
}

async function loadPage() {
  const refresh = document.querySelector("#refresh-button");
  refresh.disabled = true;
  refresh.textContent = "Oppdaterer…";
  try {
    const [activity, candidates, signals] = await Promise.all([
      getJson("/api/activity/status"),
      getJson("/api/activity/candidates?limit=100"),
      getJson("/api/signals?limit=200"),
    ]);
    renderTop(activity);
    renderSources(activity);
    renderCandidates(candidates);
    renderSignals(signals);
    bindReviewButtons();
    document.querySelector("#updated-line").textContent = `Siden ble oppdatert ${formatTime(new Date().toISOString())}.`;
  } catch (error) {
    document.querySelector("#phase-pill").textContent = "Kunne ikke hente status";
    document.querySelector("#updated-line").textContent = `Feil ved henting: ${error.message}`;
    console.error(error);
  } finally {
    refresh.disabled = false;
    refresh.textContent = "Oppdater siden";
  }
}

async function runMonitor() {
  const button = document.querySelector("#run-button");
  button.disabled = true;
  button.textContent = "Søker…";
  try {
    const result = await getJson("/api/activity/run");
    const found = Number(result?.candidatesWritten || 0);
    button.textContent = found ? `${found} nye funn` : "Ingen nye funn";
    await loadPage();
  } catch (error) {
    button.textContent = "Søket feilet";
    alert(`Kunne ikke kjøre kildesøket: ${error.message}`);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "Søk etter nye funn";
    }, 1200);
  }
}

document.querySelector("#refresh-button").addEventListener("click", loadPage);
document.querySelector("#run-button").addEventListener("click", runMonitor);
loadPage();
