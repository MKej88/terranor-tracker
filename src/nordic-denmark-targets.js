import { ensureNordicSchema } from "./nordic.js";

// Vejdirektoratets 2026-2029-ramme er delt i fem geografiske delkontrakter:
// to i Norddanmark, én i Syddanmark og to i Østdanmark. Terranor vant alle
// unntatt Syddanmark. Eksakte delkontraktsgrenser er ikke lagt inn ennå, så
// disse fire punktene er tydelig merkede regionale værproxyer.
const DENMARK_STATE_TARGETS = [
  {
    label: "Statsveier Norddanmark – nordlig proxy",
    contractName: "Danish state roads 2026-2029 – North proxy A",
    latitude: 57.0488,
    longitude: 9.9217,
    confidence: "regional-proxy",
    notes: "Aalborg brukes som representativt værpunkt for ett av Terranors to områder i Norddanmark. Eksakt delkontraktsgrense gjenstår.",
  },
  {
    label: "Statsveier Norddanmark – midtre proxy",
    contractName: "Danish state roads 2026-2029 – North proxy B",
    latitude: 56.1697,
    longitude: 9.5451,
    confidence: "regional-proxy",
    notes: "Silkeborg brukes som representativt værpunkt for det andre området i Midt-/Nordjylland. Eksakt delkontraktsgrense gjenstår.",
  },
  {
    label: "Statsveier Østdanmark – vestlig proxy",
    contractName: "Danish state roads 2026-2029 – East proxy A",
    latitude: 55.4426,
    longitude: 11.7901,
    confidence: "regional-proxy",
    notes: "Ringsted brukes som representativt værpunkt for ett av Terranors to områder i Østdanmark. Eksakt delkontraktsgrense gjenstår.",
  },
  {
    label: "Statsveier Østdanmark – østlig proxy",
    contractName: "Danish state roads 2026-2029 – East proxy B",
    latitude: 55.6415,
    longitude: 12.0803,
    confidence: "regional-proxy",
    notes: "Roskilde brukes som representativt værpunkt for det andre området i Østdanmark. Eksakt delkontraktsgrense gjenstår.",
  },
];

export async function ensureDenmarkStateTargets(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  for (const target of DENMARK_STATE_TARGETS) {
    await db.prepare(`INSERT INTO nordic_weather_targets (
        country, label, contract_name, contract_id, location_name, latitude, longitude,
        source, confidence, notes, active, updated_at
      ) VALUES ('Denmark', ?, ?, NULL, ?, ?, ?, 'DMI', ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(country, label, source) DO UPDATE SET
        contract_name=excluded.contract_name,
        location_name=excluded.location_name,
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        confidence=excluded.confidence,
        notes=excluded.notes,
        active=1,
        updated_at=CURRENT_TIMESTAMP`)
      .bind(target.label, target.contractName, target.label, target.latitude, target.longitude,
        target.confidence, target.notes).run();
  }
  return DENMARK_STATE_TARGETS.length;
}
