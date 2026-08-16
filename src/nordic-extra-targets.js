import { ensureNordicSchema } from "./nordic.js";

// Finland-porteføljen er utvidet fra Terranor Oys offentlige referanseliste.
// Koordinatene under er representative by-/stedsankere for visning. Selve FMI-
// innhentingen bruker locationName/place og lar FMI velge observasjonssted.
const EXTRA_TARGETS = [
  {
    country: "Finland",
    label: "Järvenpää",
    contractName: "Järvenpää",
    locationName: "Mäntsälä",
    latitude: 60.4737,
    longitude: 25.0899,
    source: "FMI",
    confidence: "weather-proxy",
    notes: "Kommunal vei-drift og vedlikehold. Fireårskontrakt fra 1. oktober 2026 til 30. september 2030. FMI sitt direkte Järvenpää-oppslag er tvetydig; Mäntsälä brukes som værproxy fordi FMI viser Mäntsälä Hirvihaara som nær observasjonsstasjon for Järvenpää-området.",
  },
  {
    country: "Finland",
    label: "Kuhmo",
    contractName: "Kuhmo road maintenance 2024-2029",
    locationName: "Kuhmo",
    latitude: 64.1275,
    longitude: 29.5200,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2024-2029 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Mikkeli",
    contractName: "Mikkeli road maintenance 2024-2029",
    locationName: "Mikkeli",
    latitude: 61.6886,
    longitude: 27.2723,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2024-2029 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Vuosaari",
    contractName: "Vuosaari area maintenance 2024-2029",
    locationName: "Helsinki",
    latitude: 60.2070,
    longitude: 25.1420,
    source: "FMI",
    confidence: "weather-proxy",
    notes: "Kommunal områdereferanse 2024-2029 for Helsinki by. Direkte Vuosaari-oppslag ga ingen observasjonsrader i FMI-kjeden; Helsinki brukes som robust byproxy inntil en stabil Vuosaari-stasjons-ID kan låses.",
  },
  {
    country: "Finland",
    label: "Kajaani",
    contractName: "Kajaani road maintenance 2023-2028",
    locationName: "Kajaani",
    latitude: 64.2273,
    longitude: 27.7285,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2023-2028 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Kangasniemi",
    contractName: "Kangasniemi area maintenance 2023-2028",
    locationName: "Kangasniemi",
    latitude: 61.9930,
    longitude: 26.6470,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Kommunal områdereferanse 2023-2028.",
  },
  {
    country: "Finland",
    label: "Kauhajoki",
    contractName: "Kauhajoki road maintenance 2023-2028",
    locationName: "Kauhajoki",
    latitude: 62.4330,
    longitude: 22.1830,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2023-2028 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Pieksämäki",
    contractName: "Pieksämäki road maintenance 2023-2028",
    locationName: "Pieksämäki",
    latitude: 62.3000,
    longitude: 27.1330,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2023-2028 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Suomussalmi",
    contractName: "Suomussalmi road maintenance 2023-2028",
    locationName: "Suomussalmi",
    latitude: 64.8840,
    longitude: 28.9110,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2023-2028 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Hollola",
    contractName: "Hollola area maintenance 2022-2027",
    locationName: "Hollola",
    latitude: 61.0500,
    longitude: 25.4300,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Kommunal områdereferanse 2022-2027.",
  },
  {
    country: "Finland",
    label: "Jyväskylä",
    contractName: "Jyväskylä road maintenance 2022-2027",
    locationName: "Jyväskylä",
    latitude: 62.2426,
    longitude: 25.7473,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2022-2027 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Keuruu",
    contractName: "Keuruu road maintenance 2022-2027",
    locationName: "Keuruu",
    latitude: 62.2597,
    longitude: 24.7060,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2022-2027 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Lahti",
    contractName: "Lahti road maintenance 2022-2027",
    locationName: "Lahti",
    latitude: 60.9827,
    longitude: 25.6615,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2022-2027 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Rovaniemi",
    contractName: "Rovaniemi road maintenance 2022-2027",
    locationName: "Rovaniemi",
    latitude: 66.5039,
    longitude: 25.7294,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2022-2027 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Sastamala",
    contractName: "Sastamala road maintenance 2022-2027",
    locationName: "Sastamala",
    latitude: 61.3400,
    longitude: 22.9100,
    source: "FMI",
    confidence: "official-reference-city-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2022-2027 på Terranor Oys offisielle tjenesteside.",
  },
  {
    country: "Finland",
    label: "Raasepori",
    contractName: "Raasepori road maintenance 2021-2026",
    locationName: "Hanko",
    latitude: 59.9740,
    longitude: 23.4360,
    source: "FMI",
    confidence: "weather-proxy",
    notes: "Statlig veivedlikeholdsreferanse 2021-2026. Relevant gjennom avslutningen av 2026-kontraktsperioden. Direkte Raasepori/Raseborg-oppslag ga feil eller ingen data; Hanko brukes som regional værproxy fordi FMI viser Hanko Tvärminne som en nær observasjonsstasjon for Raasepori-området.",
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
