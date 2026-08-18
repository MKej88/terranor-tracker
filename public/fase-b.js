const relevantTypes = new Set([
  "utlost_option",
  "tilleggsarbeid",
  "ny_bestilling",
  "kommunal_oppfolging",
  "kommunal_tildeling",
  "kommunal_aktivitet",
  "kommunal_beslutning",
  "kontraktsendring",
]);

const typeName = (type) => ({
  utlost_option: "Utløst opsjon",
  tilleggsarbeid: "Tilleggsarbeid",
  ny_bestilling: "Ny bestilling",
  ny_kontrakt: "Ny hovedkontrakt",
  kommunal_oppfolging: "Kommunal kontraktsoppfølging",
  kommunal_tildeling: "Kommunal tildeling",
  kommunal_aktivitet: "Kommunal aktivitet",
  kommunal_beslutning: "Kommunal beslutning",
  kontraktsendring: "Kontraktsendring",
  annen_aktivitet: "Annen aktivitet",
}[type] || String(type || "Ukjent").replaceAll("_", " "));

const statusName = (status) => ({
  aktiv: "aktiv",
  neste_kilde: "neste kilde",
  planlagt: "planlagt",
  ny: "ny",
  automatisk_godkjent: "automatisk godkjent",
  godkjent: "godkjent",
  ignorert: "ignorert",
  allerede_registrert: "allerede registrert",
  ok: "aktiv",
  partial: "delvis",
  error: "feil",
  venter_pa_forste_kjoring: "venter på første kontroll",
  unchanged: "uendret",
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

const formatMsek = (value, digits = 1) => {
  const n = Number(value);
  return Number.isFinite(n) ? `${formatNumber(n, digits)} MSEK` : "—";
};

const formatSekAsMsek = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? `${formatNumber(n / 1_000_000, 1)} MSEK` : "—";
};

const formatRangeMsek = (low, high) => {
  const a = Number(low);
  const b = Number(high);
  const hasA = Number.isFinite(a);
  const hasB = Number.isFinite(b);
  if (hasA && hasB) return a === b ? formatMsek(a, 0) : `${formatNumber(a)}–${formatNumber(b)} MSEK`;
  if (hasA) return `> ${formatNumber(a)} MSEK`;
  if (hasB) return `< ${formatNumber(b)} MSEK`;
  return "—";
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

function renderTrafikverket(status, awardsData, planData) {
  const pill = document.querySelector("#trafikverket-pill");
  const awards = awardsData?.awards || [];
  const plan = planData?.plan || [];
  const stats = status?.awards || {};
  const pipeline = status?.pipeline || {};
  const sourceStates = status?.sources || [];

  document.querySelector("#tv-bids").textContent = formatNumber(stats.terranorParticipations);
  document.querySelector("#tv-wins").textContent = formatNumber(stats.terranorWins);
  document.querySelector("#tv-pipeline").textContent = formatNumber(pipeline.uniqueRows);
  document.querySelector("#tv-contract-value").textContent = Number.isFinite(Number(stats.wonContractValueInclOptionsMsek))
    ? formatMsek(stats.wonContractValueInclOptionsMsek, 1)
    : "—";
  document.querySelector("#tv-win-rate").textContent = Number.isFinite(Number(stats.winRatePct))
    ? `${formatNumber(stats.winRatePct, 1)} % samlet win-rate`
    : "Tildelingshistorikk i gjeldende kildefil";
  document.querySelector("#tv-base-win-rate").textContent = Number.isFinite(Number(stats.baseRoadWinRatePct))
    ? `${formatNumber(stats.baseRoadWins)} av ${formatNumber(stats.baseRoadParticipations)} Basunderhåll väg · ${formatNumber(stats.baseRoadWinRatePct, 1)} %`
    : "Basunderhåll väg";

  const years = Object.entries(pipeline.byContractStartYear || {})
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  document.querySelector("#tv-pipeline-detail").textContent = years.length
    ? years.map(([year, value]) => `${year}: ${formatNumber(value.count)}`).join(" · ")
    : "Unike planlagte basområder";

  pill.classList.remove("ok");
  if (status?.ok && sourceStates.length) {
    pill.textContent = "aktiv";
    pill.classList.add("ok");
  } else if (awardsData?.error || planData?.error) {
    pill.textContent = "kunne ikke hente data";
  } else {
    pill.textContent = "venter på første import";
  }

  const planBody = document.querySelector("#tv-plan-body");
  if (!plan.length) {
    planBody.innerHTML = `<tr><td colspan="7">${planData?.error ? `Feil: ${escapeHtml(planData.error)}` : "Ingen pipeline-data ennå. Bruk «Søk etter nye funn» for første import."}</td></tr>`;
  } else {
    planBody.innerHTML = plan.slice(0, 40).map((row) => `
      <tr>
        <td>${escapeHtml(row.procurement_name)}</td>
        <td>${escapeHtml(row.region || "—")}</td>
        <td>${formatDate(row.planned_ad_start)}</td>
        <td>${formatDate(row.planned_bid_deadline)}</td>
        <td>${formatDate(row.planned_contract_start)}</td>
        <td><span class="badge ${String(row.planning_status || "").toLowerCase() === "säker" ? "text-good" : ""}">${escapeHtml(row.planning_status || "—")}</span></td>
        <td>${formatRangeMsek(row.estimated_cost_low_msek, row.estimated_cost_high_msek)}</td>
      </tr>
    `).join("");
  }

  const awardBody = document.querySelector("#tv-award-body");
  if (!awards.length) {
    awardBody.innerHTML = `<tr><td colspan="7">${awardsData?.error ? `Feil: ${escapeHtml(awardsData.error)}` : "Ingen tildelingsdata ennå. Bruk «Søk etter nye funn» for første import."}</td></tr>`;
  } else {
    awardBody.innerHTML = awards.slice(0, 40).map((row) => {
      const won = Number(row.terranor_won) === 1;
      return `
        <tr>
          <td>${escapeHtml(row.procurement_name)}</td>
          <td>${escapeHtml(row.purchase_category || "—")}</td>
          <td><b class="${won ? "text-good" : ""}">${won ? "Vunnet" : "Ikke vunnet"}</b></td>
          <td>${formatSekAsMsek(row.terranor_bid_sek)}</td>
          <td>${escapeHtml(row.winner_name || "—")}</td>
          <td>${formatSekAsMsek(row.contract_value_sek)}</td>
          <td>${formatDate(row.contract_start)}</td>
        </tr>`;
    }).join("");
  }
}

function municipalNewCount(status) {
  return (status?.sources || []).reduce((sum, source) => sum + Number(source?.candidates?.ny || 0), 0);
}

function renderMunicipal(status) {
  const pill = document.querySelector("#municipal-pill");
  const sources = status?.sources || [];
  const recent = status?.recentCandidates || [];
  const active = Number(status?.activeSources || 0);
  const newCount = municipalNewCount(status);
  const latest = status?.latestRun;

  document.querySelector("#municipal-source-count").textContent = formatNumber(sources.length);
  document.querySelector("#municipal-active-count").textContent = sources.length ? `${formatNumber(active)} / ${formatNumber(sources.length)}` : "—";
  document.querySelector("#municipal-active-detail").textContent = sources.length
    ? `${formatNumber(active)} av ${formatNumber(sources.length)} kilder svarte uten feil sist`
    : "Av kommunale kilder";
  document.querySelector("#municipal-new-count").textContent = formatNumber(newCount);
  document.querySelector("#municipal-candidate-pill").textContent = `${formatNumber(newCount)} nye`;
  document.querySelector("#municipal-last-run").textContent = latest?.finished_at ? formatTime(latest.finished_at) : "ikke kjørt";
  document.querySelector("#municipal-last-run-detail").textContent = latest?.status
    ? `Siste kjøring: ${statusName(latest.status)} · automatisk daglig`
    : "Daglig automatisk kontroll";

  pill.classList.remove("ok");
  if (!status || !sources.length) {
    pill.textContent = "venter på første kontroll";
  } else if (active === sources.length) {
    pill.textContent = `${active}/${sources.length} aktive`;
    pill.classList.add("ok");
  } else if (active > 0) {
    pill.textContent = `${active}/${sources.length} svarte`;
  } else {
    pill.textContent = "ingen kilder svarte";
  }

  const sourceBody = document.querySelector("#municipal-source-body");
  if (!sources.length) {
    sourceBody.innerHTML = `<tr><td colspan="5">Ingen kommunal status ennå. Bruk «Søk etter nye funn» for første kontroll.</td></tr>`;
  } else {
    sourceBody.innerHTML = sources.map((source) => {
      const sourceNew = Number(source?.candidates?.ny || 0);
      const sourceOk = source.status === "ok";
      return `
        <tr>
          <td><a class="table-link" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.name)}</a></td>
          <td>${escapeHtml(source.municipality || "Felles/offentlig")}</td>
          <td><b class="${sourceOk ? "text-good" : ""}">${escapeHtml(statusName(source.status))}</b>${source.error ? `<small class="table-subtext">${escapeHtml(source.error)}</small>` : ""}</td>
          <td>${formatTime(source.lastCheckedAt)}</td>
          <td>${sourceNew ? `<b>${formatNumber(sourceNew)}</b>` : "0"}</td>
        </tr>`;
    }).join("");
  }

  const candidateBody = document.querySelector("#municipal-candidate-body");
  if (!recent.length) {
    candidateBody.innerHTML = `<tr><td colspan="7"><div class="empty-good"><b>Ingen kommunale funn ennå</b><span>Når en overvåket kommune eller e-Avrop gir et relevant treff, vises det her.</span></div></td></tr>`;
  } else {
    candidateBody.innerHTML = recent.map((row) => `
      <tr>
        <td>${formatDate(row.published_at || row.created_at)}</td>
        <td><a class="table-link" href="${escapeHtml(row.item_url)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a></td>
        <td>${escapeHtml(row.source_name || "—")}</td>
        <td><span class="badge">${escapeHtml(typeName(row.signal_type))}</span></td>
        <td>${escapeHtml(row.contract_name || "Ikke koblet")}</td>
        <td>${Number.isFinite(Number(row.relevance_score)) ? `${formatNumber(row.relevance_score)} %` : "—"}</td>
        <td>${candidateActions(row)}</td>
      </tr>
    `).join("");
  }
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
    const [activity, candidates, signals, awards, plan] = await Promise.all([
      getJson("/api/activity/status"),
      getJson("/api/activity/candidates?limit=100"),
      getJson("/api/signals?limit=200"),
      getJson("/api/trafikverket/awards?limit=100").catch((error) => ({ awards: [], error: error.message })),
      getJson("/api/trafikverket/plan?limit=150").catch((error) => ({ plan: [], error: error.message })),
    ]);
    renderTop(activity);
    renderSources(activity);
    renderTrafikverket(activity?.trafikverket, awards, plan);
    renderMunicipal(activity?.municipal);
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
    const companyFound = Number(result?.candidatesWritten || 0);
    const municipalFound = Number(result?.municipal?.candidatesWritten || 0);
    const found = companyFound + municipalFound;
    const tvOk = result?.trafikverket?.ok === true;
    const municipalOk = result?.municipal?.ok === true;
    button.textContent = found ? `${found} nye funn` : (tvOk && municipalOk ? "Kildesøk ferdig" : "Søk ferdig med kildefeil");
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
