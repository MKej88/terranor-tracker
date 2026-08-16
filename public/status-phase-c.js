const fmt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat("nb-NO").format(n) : "—";
};

function shownStatus(source) {
  if (source?.status === "ok") return { text: "aktiv", warn: false };
  if (source?.status === "partial") return { text: "delvis", warn: true };
  if (source?.status === "error") return { text: "feil", warn: true };
  return { text: "klar for test", warn: false };
}

function updateModelRows(data) {
  const wanted = new Map([
    ["Danske værdata", shownStatus(data?.sources?.DMI)],
    ["Finske værdata", shownStatus(data?.sources?.FMI)],
  ]);
  document.querySelectorAll("#model-list .status-row").forEach((row) => {
    const label = row.querySelector("span")?.textContent?.trim();
    if (!wanted.has(label)) return;
    const target = row.querySelector("b");
    const status = wanted.get(label);
    if (!target) return;
    target.textContent = status.text;
    target.classList.toggle("text-warn", status.warn);
  });
}

async function json(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function loadPhaseC() {
  const box = document.querySelector("#phase-c-summary");
  if (!box) return;
  try {
    const [data, backfill] = await Promise.all([
      json("/api/nordic/status"),
      json("/api/nordic/backfill/status"),
    ]);
    const dmi = data?.sources?.DMI || {};
    const fmi = data?.sources?.FMI || {};
    const denmark = data?.countries?.Denmark || {};
    const finland = data?.countries?.Finland || {};
    const active = [dmi, fmi].filter((x) => x.status === "ok").length;
    const linked = Number(denmark.linked || 0) + Number(finland.linked || 0);
    const targets = Number(denmark.targets || 0) + Number(finland.targets || 0);
    const observations = Number(dmi.observations || 0) + Number(fmi.observations || 0);
    box.innerHTML = `
      <div class="status-row"><span>${active}/2 værkilder i drift · ${linked}/${targets} værankere koblet</span><b>${fmt(observations)} målinger</b></div>
      <div class="status-row"><span>60-dagers historikk</span><b>${fmt(backfill?.progressPct || 0)} % · ${fmt(backfill?.targetsComplete || 0)}/${fmt(backfill?.targets || 0)} ferdige</b></div>
    `;
    updateModelRows(data);
    setTimeout(() => updateModelRows(data), 800);
  } catch (error) {
    box.innerHTML = `<div class="status-row"><span>Fase C-status kunne ikke hentes</span><b class="text-warn">sjekk siden</b></div>`;
  }
}

loadPhaseC();
