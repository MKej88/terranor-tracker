const STATUS_TEXT = {
  active: "aktiv",
  ready: "klar for test",
  planned: "planlagt",
  warming_up: "samler mer data",
  seeded: "grunnlag lagt inn",
  "database connected": "lagres i databasen",
  "awaiting API key": "venter på API-nøkkel",
  ok: "i orden",
  error: "feil",
};

const labels = {
  trafficWeather: "Veivær fra Trafikverket",
  smhi: "Vanlige svenske værstasjoner",
  dmi: "Danske værdata",
  fmi: "Finske værdata",
  workability: "Værbaserte arbeidsforhold",
  contracts: "Kontraktsoversikt",
  forecastHistory: "Historikk for estimater",
};

const orderedKeys = ["contracts", "smhi", "trafficWeather", "workability", "forecastHistory", "dmi", "fmi"];

const fmtStatus = (value) => {
  const raw = String(value || "planned");
  return STATUS_TEXT[raw] || raw.replaceAll("_", " ");
};

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `${url}: ${response.status}`);
  return data;
}

function renderLoadingRows() {
  document.querySelector("#status-list").innerHTML = orderedKeys.map((key) => `
    <div class="status-row">
      <span>${labels[key]}</span>
      <b>henter…</b>
    </div>
  `).join("");
}

function renderOverview(overview) {
  const collection = overview?.dataCollection || {};
  document.querySelector("#status-list").innerHTML = orderedKeys.map((key) => `
    <div class="status-row">
      <span>${labels[key]}</span>
      <b>${fmtStatus(collection[key])}</b>
    </div>
  `).join("");
}

async function loadHealth() {
  const pill = document.querySelector("#health-pill");
  try {
    const health = await getJson("/api/health");
    pill.textContent = health.ok ? "Tjenesten er på nett" : "Feil i tjenesten";
    pill.classList.toggle("ok", Boolean(health.ok));
  } catch (error) {
    pill.textContent = "Tilkoblingsfeil";
    console.error(error);
  }
}

async function loadForecast() {
  try {
    const forecast = await getJson("/api/forecast");
    document.querySelector("#revenue").textContent = forecast?.revenue?.base
      ? `SEK ${forecast.revenue.base} mill.`
      : "—";
    document.querySelector("#ebita").textContent = forecast?.adjustedEbita?.base
      ? `SEK ${forecast.adjustedEbita.base} mill.`
      : "—";
    document.querySelector("#confidence").textContent = forecast?.confidence ?? "—";
  } catch (error) {
    console.error(error);
  }
}

async function loadOverview() {
  try {
    renderOverview(await getJson("/api/overview"));
  } catch (error) {
    document.querySelector("#status-list").innerHTML = `
      <div class="status-row"><span>Datainnsamling</span><b>kunne ikke hentes</b></div>
    `;
    console.error(error);
  }
}

function load() {
  renderLoadingRows();
  loadHealth();
  loadForecast();
  loadOverview();
}

load();
