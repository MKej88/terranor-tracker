const fmtStatus = (value) => String(value || "planned").replaceAll("_", " ");

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
    pill.textContent = health.ok ? "Worker online" : "Worker error";
    if (health.ok) pill.classList.add("ok");

    document.querySelector("#revenue").textContent = forecast.revenue.base
      ? `SEK ${forecast.revenue.base}m`
      : "—";
    document.querySelector("#ebita").textContent = forecast.adjustedEbita.base
      ? `SEK ${forecast.adjustedEbita.base}m`
      : "—";
    document.querySelector("#confidence").textContent = forecast.confidence ?? "—";

    const labels = {
      trafficWeather: "Trafikverket VViS",
      smhi: "SMHI",
      dmi: "DMI",
      fmi: "FMI",
      contracts: "Contract tracker",
      forecastHistory: "Forecast history",
    };

    const statusList = document.querySelector("#status-list");
    statusList.innerHTML = Object.entries(status.dataCollection)
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
    pill.textContent = "tilkoblingsfeil";
    console.error(error);
  }
}

load();
