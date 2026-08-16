import { ensureNordicSchema } from "./nordic.js";

const EXTRA_TARGETS = [
  {
    country: "Finland",
    label: "Järvenpää",
    contractName: "Järvenpää",
    locationName: "Järvenpää",
    latitude: 60.4737,
    longitude: 25.0899,
    source: "FMI",
    confidence: "high-location",
    notes: "Kommunal vei-drift og vedlikehold. Fireårskontrakt fra 1. oktober 2026 til 30. september 2030; værankeret bruker bykoordinat og FMI velger nærmeste observasjonsstasjon.",
  },
];

async function resolveContractId(db, target) {
  const row = await db.prepare(`SELECT id FROM contracts WHERE country=? AND name=? LIMIT 1`)
    .bind(target.country, target.contractName).first();
  return row?.id ? Number(row.id) : null;
}

export async function ensureNordicExtraTargets(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  for (const target of EXTRA_TARGETS) {
    const contractId = await resolveContractId(db, target);
    await db.prepare(`INSERT INTO nordic_weather_targets (
        country, label, contract_name, contract_id, location_name, latitude, longitude,
        source, confidence, notes, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(country, label, source) DO UPDATE SET
        contract_name=excluded.contract_name,
        contract_id=COALESCE(excluded.contract_id, nordic_weather_targets.contract_id),
        location_name=excluded.location_name,
        latitude=excluded.latitude,
        longitude=excluded.longitude,
        confidence=excluded.confidence,
        notes=excluded.notes,
        active=1,
        updated_at=CURRENT_TIMESTAMP`)
      .bind(target.country, target.label, target.contractName, contractId, target.locationName,
        target.latitude, target.longitude, target.source, target.confidence, target.notes).run();
  }
  return EXTRA_TARGETS.length;
}
