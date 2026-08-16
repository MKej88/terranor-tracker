function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function targetCounts(confidence) {
  const value = String(confidence || "");
  if (value.includes("area-centre")) return { VVIS: 3, SMHI: 2, mode: "stort driftsområde" };
  return { VVIS: 2, SMHI: 1, mode: "by-/lokalområde" };
}

export async function getGeographyStatus(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  const result = await db.prepare(`SELECT
      c.id AS contract_id, c.name AS contract_name,
      a.id AS anchor_id, a.label AS anchor_label, a.confidence AS anchor_confidence,
      a.latitude AS anchor_latitude, a.longitude AS anchor_longitude,
      l.source, l.station_id, l.station_name, l.rank_no, l.distance_km, l.completeness,
      l.latitude AS station_latitude, l.longitude AS station_longitude
    FROM contracts c
    JOIN weather_anchors a ON a.contract_id=c.id AND a.active=1
    LEFT JOIN weather_station_links l ON l.anchor_id=a.id AND l.active=1 AND l.source IN ('VVIS','SMHI')
    WHERE c.country='Sweden'
      AND (c.start_date IS NULL OR c.start_date<='2026-09-30')
      AND (c.end_date IS NULL OR c.end_date>='2026-07-01')
    ORDER BY c.name, l.source, l.rank_no`).all();

  const map = new Map();
  for (const row of result?.results || []) {
    const id = Number(row.contract_id);
    if (!map.has(id)) {
      map.set(id, {
        contract_id: id,
        contract_name: row.contract_name,
        anchor: {
          id: Number(row.anchor_id),
          label: row.anchor_label,
          confidence: row.anchor_confidence,
          latitude: Number(row.anchor_latitude),
          longitude: Number(row.anchor_longitude),
        },
        stations: { VVIS: [], SMHI: [] },
      });
    }
    if (row.source && row.station_id) {
      map.get(id).stations[row.source].push({
        station_id: String(row.station_id),
        station_name: row.station_name,
        rank: Number(row.rank_no),
        distance_km: round(row.distance_km, 1),
        completeness: Number(row.completeness || 0),
        latitude: Number(row.station_latitude),
        longitude: Number(row.station_longitude),
      });
    }
  }

  const contracts = [...map.values()].map((contract) => {
    const targets = targetCounts(contract.anchor.confidence);
    const vvisCount = contract.stations.VVIS.length;
    const smhiCount = contract.stations.SMHI.length;
    const vvisCoverage = Math.min(vvisCount / targets.VVIS, 1);
    const smhiCoverage = Math.min(smhiCount / targets.SMHI, 1);
    const coverage = Math.round(100 * (0.7 * vvisCoverage + 0.3 * smhiCoverage));
    const allDistances = [...contract.stations.VVIS, ...contract.stations.SMHI]
      .map((x) => Number(x.distance_km)).filter(Number.isFinite);

    return {
      ...contract,
      area_type: targets.mode,
      target_stations: { road_weather: targets.VVIS, ordinary_weather: targets.SMHI },
      active_stations: { road_weather: vvisCount, ordinary_weather: smhiCount },
      coverage_pct: coverage,
      max_station_distance_km: allDistances.length ? round(Math.max(...allDistances), 1) : null,
      status: coverage >= 100 ? "god_flerstasjonsdekning" : coverage >= 70 ? "brukbar" : "bør_forbedres",
    };
  });

  const avgCoverage = contracts.length
    ? Math.round(contracts.reduce((sum, x) => sum + x.coverage_pct, 0) / contracts.length)
    : 0;

  return {
    geographyVersion: "0.2",
    contracts: contracts.length,
    averageCoveragePct: avgCoverage,
    contractsWithGoodCoverage: contracts.filter((x) => x.status === "god_flerstasjonsdekning").length,
    contractsNeedingImprovement: contracts.filter((x) => x.status === "bør_forbedres").length,
    method: "Store driftsområder bruker opptil tre veiværstasjoner og to vanlige værstasjoner. By-/lokalområder trenger færre. Stasjonene er foreløpig valgt rundt et representativt midtpunkt, ikke fra offisielle kontraktspolygoner.",
    limitation: "Dette forbedrer den geografiske robustheten, men eksakte driftsområdegrenser må legges inn senere dersom de blir tilgjengelige.",
    contractStatus: contracts,
  };
}
