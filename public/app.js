const STATUS_TEXT = {
  active: "aktiv",
  ready: "klar",
  planned: "planlagt",
  warming_up: "samler mer data",
  seeded: "grunnlag lagt inn",
  "database connected": "lagres i databasen",
  "awaiting API key": "venter på API-nøkkel",
  ok: "i orden",
  error: "feil",
};

const fmtStatus = (value) => {
  const raw = String(value || "planned");
  return STATUS_TEXT[raw] || raw.replaceAll("_", " ");
};

async function load() {
  try {
    const [healthRes, statusRes, forecastRes] = await Promise.all([
      fetch("/api/health"),
      fetch("/api/status"),
      fetch("/api/forecast"),
    ]);

    const health = await healthRes.json();
    const status = await statusRes.json();
    const forecast = await forecastRes.json();

    const pill = document.querySelector("#health-pill");
    pill.textContent = health.ok ? "Tjenesten er på nett" : "Feil i tjenesten";
    if (health.ok) pill.classList.add("ok");

    document.querySelector("#revenue").textContent = forecast.revenue.base
      ? `SEK ${forecast.revenue.base} mill.`
      : "—";
    document.querySelector("#ebita").textContent = forecast.adjustedEbita.base
      ? `SEK ${forecast.adjustedEbita.base} mill.`
      : "—";
    document.querySelector("#confidence").textContent = forecast.confidence ?? "—";

    const labels = {
      trafficWeather: "Veivær fra Trafikverket",
      smhi: "Vanlige svenske værstasjoner",
      dmi: "Danske værdata",
      fmi: "Finske værdata",
      workability: "Værbaserte arbeidsforhold",
      contracts: "Kontraktsoversikt",
      forecastHistory: "Historikk for estimater",
    };

    const statusList = document.querySelector("#status-list");
    statusList.innerHTML = Object.entries(status.dataCollection || {})
      .map(
        ([key, value]) => `
          <div class="status-row">
            <span>${labels[key] || key}</span>
            <b>${fmtStatus(value)}</b>
          </div>`,
      )
      .join("");
  } catch (error) {
    const pill = document.querySelector("#health-pill");
    pill.textContent = "Tilkoblingsfeil";
    console.error(error);
  }
}

load();
