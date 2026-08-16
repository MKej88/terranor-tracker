function ageMinutes(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.round((Date.now() - ms) / 60000);
}

export async function getDataQuality(db) {
  if (!db) throw new Error("D1 binding DB is missing");

  const [latestSmhi, latestVvis, links, stale, observations] = await Promise.all([
    db.prepare(`SELECT finished_at, status, stations_fetched, observations_written, error_text
      FROM weather_collection_runs WHERE source='SMHI' ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT finished_at, status, stations_fetched, observations_written, error_text
      FROM weather_collection_runs WHERE source='VVIS' ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT source, COUNT(*) AS count FROM weather_station_links
      WHERE active=1 AND rank_no=1 GROUP BY source`).all(),
    db.prepare(`SELECT l.source, l.station_id, l.station_name, c.name AS contract_name,
        MAX(o.observed_at) AS latest_observation
      FROM weather_station_links l
      JOIN contracts c ON c.id=l.contract_id
      LEFT JOIN weather_observations o ON o.source=l.source AND o.station_id=l.station_id
      WHERE l.active=1 AND l.rank_no=1 AND l.source IN ('SMHI','VVIS')
      GROUP BY l.source, l.station_id, l.station_name, c.name`).all(),
    db.prepare(`SELECT source, COUNT(*) AS count, MIN(observed_at) AS earliest, MAX(observed_at) AS latest
      FROM weather_observations GROUP BY source`).all(),
  ]);

  const linkCounts = Object.fromEntries((links?.results || []).map((r) => [r.source, Number(r.count || 0)]));
  const stationRows = (stale?.results || []).map((row) => ({
    ...row,
    age_minutes: ageMinutes(row.latest_observation),
  }));
  const staleStations = stationRows.filter((row) => row.age_minutes === null || row.age_minutes > 150);

  const smhiAge = ageMinutes(latestSmhi?.finished_at);
  const vvisAge = ageMinutes(latestVvis?.finished_at);
  const checks = {
    smhi_recent: latestSmhi?.status === 'ok' && smhiAge !== null && smhiAge <= 90,
    vvis_recent: latestVvis?.status === 'ok' && vvisAge !== null && vvisAge <= 90,
    smhi_primary_links: (linkCounts.SMHI || 0) >= 15,
    vvis_primary_links: (linkCounts.VVIS || 0) >= 15,
    no_stale_primary_stations: staleStations.length === 0,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    status: passed === total ? 'healthy' : passed >= total - 1 ? 'watch' : 'degraded',
    score: Math.round(100 * passed / total),
    checks,
    collection_runs: {
      SMHI: latestSmhi ? { ...latestSmhi, age_minutes: smhiAge } : null,
      VVIS: latestVvis ? { ...latestVvis, age_minutes: vvisAge } : null,
    },
    primary_links: linkCounts,
    stale_primary_stations: staleStations,
    observation_ranges: observations?.results || [],
  };
}
