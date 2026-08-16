const fmt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat("nb-NO").format(n) : "—";
};

async function loadPhaseC() {
  const box = document.querySelector("#phase-c-summary");
  if (!box) return;
  try {
    const response = await fetch("/api/nordic/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    const dmi = data?.sources?.DMI || {};
    const fmi = data?.sources?.FMI || {};
    const denmark = data?.countries?.Denmark || {};
    const finland = data?.countries?.Finland || {};
    const active = [dmi, fmi].filter((x) => x.status === "ok").length;
    const linked = Number(denmark.linked || 0) + Number(finland.linked || 0);
    const targets = Number(denmark.targets || 0) + Number(finland.targets || 0);
    const observations = Number(dmi.observations || 0) + Number(fmi.observations || 0);
    box.innerHTML = `<div class="status-row"><span>${active}/2 værkilder i drift · ${linked}/${targets} værankere koblet</span><b>${fmt(observations)} målinger</b></div>`;
  } catch (error) {
    box.innerHTML = `<div class="status-row"><span>Fase C-status kunne ikke hentes</span><b class="text-warn">sjekk siden</b></div>`;
  }
}

loadPhaseC();
