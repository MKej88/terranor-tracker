const sourceName = (source) => {
  const value = String(source || "").toUpperCase();
  if (value === "VVIS") return "Veivær fra Trafikverket";
  if (value === "SMHI") return "Vanlige svenske værstasjoner";
  return source || "Ukjent kilde";
};

const formatNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat("nb-NO").format(n) : "—";
};

const formatTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatAge = (minutes) => {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return "ukjent";
  if (n < 2) return "nå nettopp";
  if (n < 60) return `${Math.round(n)} min siden`;
  if (n < 1440) return `${Math.round(n / 60)} t siden`;
  return `${Math.round(n / 1440)} d siden`;
};

const yesNo = (value) => value ? "OK" : "Må sjekkes";

const checkLabels = {
  smhi_recent: "Vanlige svenske værdata er ferske",
  vvis_recent: "Veivær fra Trafikverket er ferskt",
  smhi_primary_links: "Vanlige værstasjoner er koblet til kontraktene",
  vvis_primary_links: "Veiværstasjoner er koblet til kontraktene",
  no_stale_primary_stations: "Ingen viktige målestasjoner har gamle data",
};

const modelLabels = {
  smhi: "Vanlige svenske værdata",
  trafficWeather: "Veivær fra Trafikverket",
  workability: "Værbaserte arbeidsforhold",
  contracts: "Kontraktsregister",
  forecastHistory: "Historikk for estimater",
  dmi: "Danske værdata",
  fmi: "Finske værdata",
};

const modelValues = {
  active: "aktiv",
  ready: "klar",
  planned: "planlagt",
  warming_up: "samler mer data",
  seeded: "grunnlag lagt inn",
  "database connected": "lagres i databasen",
  "awaiting API key": "venter på tilgang",
};

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

function setOverall(quality) {
  const pill = document.querySelector("#overall-pill");
  const score = Number(quality?.score);
  const status = quality?.status;
  document.querySelector("#quality-score").textContent = Number.isFinite(score) ? `${score} %` : "—";

  if (status === "healthy") {
    pill.textContent = "Alt ser bra ut";
    pill.classList.add("ok");
    document.querySelector("#quality-text").textContent = "Alle automatiske kontroller er bestått";
  } else if (status === "watch") {
    pill.textContent = "Følg med";
    document.querySelector("#quality-text").textContent = "Én kontroll trenger oppfølging";
  } else {
    pill.textContent = "Trenger oppfølging";
    document.querySelector("#quality-text").textContent = "Flere kontroller trenger oppfølging";
  }
}

function renderCollectionRuns(quality) {
  const rows = [];
  for (const source of ["SMHI", "VVIS"]) {
    const run = quality?.collection_runs?.[source];
    rows.push(`
      <div class="status-row">
        <span>${sourceName(source)}</span>
        <b>${run?.status === "ok" ? "OK" : "Ikke OK"}</b>
      </div>
      <div class="status-row sub-row">
        <span>Sist hentet</span>
        <b>${run ? `${formatTime(run.finished_at)} · ${formatAge(run.age_minutes)}` : "—"}</b>
      </div>
      <div class="status-row sub-row">
        <span>Målestasjoner i siste kjøring</span>
        <b>${formatNumber(run?.stations_fetched)}</b>
      </div>
      <div class="status-row sub-row">
        <span>Målinger skrevet i siste kjøring</span>
        <b>${formatNumber(run?.observations_written)}</b>
      </div>
    `);
  }
  document.querySelector("#collection-list").innerHTML = rows.join("");
}

function renderChecks(quality) {
  const checks = quality?.checks || {};
  document.querySelector("#check-list").innerHTML = Object.entries(checks)
    .map(([key, value]) => `
      <div class="status-row">
        <span>${checkLabels[key] || key}</span>
        <b class="${value ? "text-good" : "text-warn"}">${yesNo(value)}</b>
      </div>
    `).join("");
}

function renderRanges(quality) {
  const ranges = quality?.observation_ranges || [];
  const body = document.querySelector("#range-body");
  if (!ranges.length) {
    body.innerHTML = `<tr><td colspan="4">Ingen målinger funnet.</td></tr>`;
    return;
  }
  body.innerHTML = ranges.map((row) => `
    <tr>
      <td>${sourceName(row.source)}</td>
      <td>${formatNumber(row.count)}</td>
      <td>${formatTime(row.earliest)}</td>
      <td>${formatTime(row.latest)}</td>
    </tr>
  `).join("");
}

function renderBackfill(backfill) {
  const done = Number(backfill?.stationsBackfilled || 0);
  const total = Number(backfill?.stations || 0);
  const pct = total ? Math.round(100 * done / total) : 0;
  document.querySelector("#backfill-count").textContent = total ? `${done} / ${total}` : "—";
  document.querySelector("#backfill-text").textContent = backfill?.complete ? "60-dagershistorikken er ferdig" : `${pct} % ferdig`;
  document.querySelector("#backfill-progress").style.width = `${pct}%`;
  document.querySelector("#backfill-detail").textContent = backfill?.complete
    ? `Alle ${total} primære svenske værstasjoner har historikk for de siste ${backfill.days} dagene.`
    : `${done} av ${total} primære svenske værstasjoner har nok historiske målinger. Resten fylles automatisk inn litt etter litt.`;
}

function renderClimate(climate) {
  const pct = Number(climate?.progressPct || 0);
  document.querySelector("#climate-progress").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  const ready = Number(climate?.stationsFullyReady || 0);
  const stations = Number(climate?.stations || 0);
  document.querySelector("#climate-detail").textContent = stations
    ? `${ready} av ${stations} værstasjoner har komplett 10-årig sammenligningsgrunnlag for temperatur, vind og nedbør. Totalt er ${pct} % av arkivjobbene ferdige.`
    : "Venter på at værstasjonene skal bli registrert.";

  const latest = climate?.latestTask;
  const rows = [
    `<div class="status-row"><span>Sammenligningsperiode</span><b>${climate?.baselineLabel || "—"}</b></div>`,
    `<div class="status-row"><span>Ferdige arkivjobber</span><b>${formatNumber(climate?.finishedTasks)} / ${formatNumber(climate?.totalTasks)}</b></div>`,
    `<div class="status-row"><span>Feil som må prøves igjen</span><b class="${Number(climate?.errorTasks || 0) ? "text-warn" : "text-good"}">${formatNumber(climate?.errorTasks || 0)}</b></div>`,
  ];
  if (latest) rows.push(`<div class="status-row"><span>Sist behandlet</span><b>${latest.station_name || latest.station_id} · ${latest.parameter_name}</b></div>`);
  document.querySelector("#climate-list").innerHTML = rows.join("");
}

function renderGeography(geography) {
  const rows = [
    `<div class="status-row"><span>Gjennomsnittlig geografisk dekning</span><b>${formatNumber(geography?.averageCoveragePct)} %</b></div>`,
    `<div class="status-row"><span>Kontrakter med god flerstasjonsdekning</span><b>${formatNumber(geography?.contractsWithGoodCoverage)} / ${formatNumber(geography?.contracts)}</b></div>`,
    `<div class="status-row"><span>Kontrakter som bør forbedres</span><b class="${Number(geography?.contractsNeedingImprovement || 0) ? "text-warn" : "text-good"}">${formatNumber(geography?.contractsNeedingImprovement || 0)}</b></div>`,
    `<div class="status-row"><span>Geografiversjon</span><b>${geography?.geographyVersion || "—"}</b></div>`,
  ];
  document.querySelector("#geography-list").innerHTML = rows.join("");
  document.querySelector("#geography-note").textContent = geography?.limitation || "";
}

function renderModelStatus(status, signals) {
  const data = status?.dataCollection || {};
  const ordered = ["contracts", "smhi", "trafficWeather", "workability", "forecastHistory", "dmi", "fmi"];
  const rows = ordered.map((key) => {
    const raw = String(data[key] || "planned");
    const shown = modelValues[raw] || raw.replaceAll("_", " ");
    return `<div class="status-row"><span>${modelLabels[key] || key}</span><b>${shown}</b></div>`;
  });
  rows.push(`<div class="status-row"><span>Kildebelagte aktivitetssignaler</span><b>${formatNumber(signals?.total || 0)}</b></div>`);
  document.querySelector("#model-list").innerHTML = rows.join("");
}

function renderProblems(quality) {
  const stale = quality?.stale_primary_stations || [];
  const box = document.querySelector("#problem-list");
  if (!stale.length) {
    box.innerHTML = `<div class="empty-good"><b>Ingen problemer funnet</b><span>Alle primære målestasjoner har ferske data.</span></div>`;
    return;
  }
  box.innerHTML = stale.map((row) => `
    <div class="problem-row">
      <div><b>${row.contract_name || "Ukjent kontrakt"}</b><span>${sourceName(row.source)} · ${row.station_name || row.station_id}</span></div>
      <strong>${formatAge(row.age_minutes)}</strong>
    </div>
  `).join("");
}

async function loadStatus() {
  const button = document.querySelector("#refresh-button");
  button.disabled = true;
  button.textContent = "Oppdaterer…";

  try {
    const [quality, backfill, db, status, signals, climate, geography] = await Promise.all([
      getJson("/api/data-quality"),
      getJson("/api/backfill/smhi/status"),
      getJson("/api/db-status"),
      getJson("/api/status"),
      getJson("/api/signals/summary"),
      getJson("/api/climate/status"),
      getJson("/api/geography"),
    ]);

    setOverall(quality);
    document.querySelector("#contract-count").textContent = formatNumber(db?.tables?.contracts);
    document.querySelector("#weather-count").textContent = formatNumber(db?.tables?.weatherObservations);
    renderCollectionRuns(quality);
    renderChecks(quality);
    renderRanges(quality);
    renderBackfill(backfill);
    renderClimate(climate);
    renderGeography(geography);
    renderModelStatus(status, signals);
    renderProblems(quality);
    document.querySelector("#updated-line").textContent = `Siden ble oppdatert ${formatTime(new Date().toISOString())}. Automatisk datainnhenting kjører hver time.`;
  } catch (error) {
    document.querySelector("#overall-pill").textContent = "Kunne ikke hente status";
    document.querySelector("#updated-line").textContent = `Feil ved henting av status: ${error.message}`;
    console.error(error);
  } finally {
    button.disabled = false;
    button.textContent = "Oppdater nå";
  }
}

document.querySelector("#refresh-button").addEventListener("click", loadStatus);
loadStatus();
