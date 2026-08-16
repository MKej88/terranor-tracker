import { ensureNordicSchema } from "./nordic.js";

const FMI_WFS_URL = "https://opendata.fmi.fi/wfs";
const CONCURRENCY = 4;

// FMI accepts a region after the place name, separated by a comma. These three
// labels were ambiguous or not directly resolvable in the first expanded test.
const PLACE_OVERRIDES = {
  "Järvenpää": "Järvenpää,Uusimaa",
  "Vuosaari": "Vuosaari,Helsinki",
  "Raasepori": "Raseborg,Raasepori",
};

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function xmlDecode(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function queryPlace(target) {
  return PLACE_OVERRIDES[target.label] || target.location_name;
}

function fmiParameterFromMember(member) {
  const href = member.match(/observedProperty[^>]+(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] || "";
  const name = member.match(/<gml:name[^>]*>([\s\S]*?)<\/gml:name>/i)?.[1] || "";
  const text = `${href} ${xmlDecode(name)}`.toLowerCase();
  if (/precip/.test(text)) return "precipitation_mm";
  if (/windspeed|wind speed|ws_10min/.test(text)) return "wind_ms";
  if (/humidity|relative humidity|\brh\b/.test(text)) return "humidity_pct";
  if (/temperature|\bt2m\b/.test(text)) return "air_temp_c";
  return null;
}

function parseFmiTimeValuePair(xml, target, requestedPlace) {
  const rows = new Map();
  const members = String(xml || "").split(/<wfs:member\b/i).slice(1);
  let detectedStationId = null;
  let detectedStationName = null;

  for (const memberRaw of members) {
    const member = `<wfs:member ${memberRaw}`;
    const field = fmiParameterFromMember(member);
    if (!field) continue;
    const identifier = member.match(/<gml:identifier[^>]*>([^<]+)<\/gml:identifier>/i)?.[1];
    const stationName = member.match(/<gml:name[^>]*>([^<]+)<\/gml:name>/i)?.[1];
    if (identifier) detectedStationId = xmlDecode(identifier).trim();
    if (stationName) detectedStationName = xmlDecode(stationName).trim();

    const pairRe = /<wml2:MeasurementTVP[^>]*>[\s\S]*?<wml2:time>([^<]+)<\/wml2:time>[\s\S]*?<wml2:value[^>]*>([^<]*)<\/wml2:value>[\s\S]*?<\/wml2:MeasurementTVP>/gi;
    let match;
    while ((match = pairRe.exec(member))) {
      const observed = Number.isFinite(Date.parse(match[1])) ? new Date(match[1]).toISOString() : null;
      const value = numeric(match[2]);
      if (!observed || value === null) continue;
      const row = rows.get(observed) || {
        observed_at: observed,
        air_temp_c: null,
        precipitation_mm: null,
        wind_ms: null,
        humidity_pct: null,
        raw: { fmi: true, location: target.label, requestedPlace },
      };
      row[field] = value;
      rows.set(observed, row);
    }
  }

  return {
    station_id: detectedStationId,
    station_name: detectedStationName,
    rows: [...rows.values()],
    requested_place: requestedPlace,
  };
}

async function fetchTarget(target) {
  const end = new Date();
  const start = new Date(end.getTime() - 26 * 3600000);
  start.setUTCMinutes(0, 0, 0);
  const requestedPlace = queryPlace(target);
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "getFeature",
    storedquery_id: "fmi::observations::weather::timevaluepair",
    place: requestedPlace,
    starttime: start.toISOString(),
    endtime: end.toISOString(),
    timestep: "60",
    parameters: "temperature,windspeedms,humidity,precipitation1h",
  });
  const response = await fetch(`${FMI_WFS_URL}?${params.toString()}`, {
    headers: { "user-agent": "Terranor-Tracker/1.0", "accept": "application/xml,text/xml" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FMI ${requestedPlace} feilet: ${response.status} ${body.slice(0, 180)}`);
  }
  const xml = await response.text();
  if (/ExceptionReport|ExceptionText/i.test(xml)) {
    const message = xml.match(/<[^>]*ExceptionText[^>]*>([\s\S]*?)<\/[^>]*ExceptionText>/i)?.[1];
    throw new Error(`FMI svarte med feil for ${requestedPlace}: ${xmlDecode(message || "ukjent WFS-feil").trim()}`);
  }
  return parseFmiTimeValuePair(xml, target, requestedPlace);
}

function observationStatement(db, target, stationId, row) {
  return db.prepare(`INSERT INTO weather_observations (
      contract_id, source, station_id, observed_at, air_temp_c, road_temp_c,
      precipitation_mm, precipitation_type, wind_ms, humidity_pct, raw_json
    ) VALUES (?, 'FMI', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT(source, station_id, observed_at) DO UPDATE SET
      contract_id=COALESCE(excluded.contract_id, weather_observations.contract_id),
      air_temp_c=COALESCE(excluded.air_temp_c, weather_observations.air_temp_c),
      precipitation_mm=COALESCE(excluded.precipitation_mm, weather_observations.precipitation_mm),
      wind_ms=COALESCE(excluded.wind_ms, weather_observations.wind_ms),
      humidity_pct=COALESCE(excluded.humidity_pct, weather_observations.humidity_pct),
      raw_json=excluded.raw_json`)
    .bind(target.contract_id || null, String(stationId), row.observed_at,
      row.air_temp_c, row.precipitation_mm, row.wind_ms, row.humidity_pct,
      JSON.stringify(row.raw || {}));
}

async function persistTarget(db, target, parsed) {
  if (!parsed.station_id || !parsed.rows.length) return 0;
  await db.prepare(`UPDATE nordic_weather_targets SET station_id=?, station_name=?, distance_km=NULL,
      last_linked_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(String(parsed.station_id), parsed.station_name || parsed.station_id, new Date().toISOString(), target.id).run();

  let written = 0;
  for (let i = 0; i < parsed.rows.length; i += 50) {
    const chunk = parsed.rows.slice(i, i + 50);
    await db.batch(chunk.map((row) => observationStatement(db, target, parsed.station_id, row)));
    written += chunk.length;
  }
  return written;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        output[index] = await fn(items[index], index);
      } catch (error) {
        output[index] = { ok: false, error: String(error?.message || error), target: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}

export async function runFmiWeather(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureNordicSchema(db);
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO nordic_weather_runs (source, started_at, status)
    VALUES ('FMI', ?, 'running') RETURNING id`).bind(startedAt).first();
  const targetResult = await db.prepare(`SELECT * FROM nordic_weather_targets WHERE active=1 AND source='FMI' ORDER BY id`).all();
  const targets = targetResult?.results || [];
  const result = { attempted: targets.length, completed: 0, noData: 0, written: 0, details: [] };

  try {
    const fetched = await mapWithConcurrency(targets, CONCURRENCY, async (target) => ({
      ok: true,
      target,
      parsed: await fetchTarget(target),
    }));

    for (const item of fetched) {
      const target = item.target;
      if (!item.ok) {
        result.details.push({ label: target.label, status: "feil", error: item.error });
        continue;
      }
      try {
        if (!item.parsed.rows.length || !item.parsed.station_id) {
          result.noData += 1;
          result.details.push({
            label: target.label,
            requested_place: item.parsed.requested_place,
            observations_written: 0,
            status: "ingen_data",
          });
          continue;
        }
        const written = await persistTarget(db, target, item.parsed);
        result.completed += 1;
        result.written += written;
        result.details.push({
          label: target.label,
          requested_place: item.parsed.requested_place,
          station_id: String(item.parsed.station_id),
          station_name: item.parsed.station_name,
          observations_written: written,
          status: "ok",
        });
      } catch (error) {
        result.details.push({ label: target.label, status: "feil", error: String(error?.message || error) });
      }
    }

    const finishedAt = new Date().toISOString();
    const status = result.completed === result.attempted ? "ok" : result.completed > 0 ? "partial" : "error";
    if (run?.id) {
      await db.prepare(`UPDATE nordic_weather_runs SET finished_at=?, status=?, targets_attempted=?,
          targets_completed=?, observations_written=?, error_text=? WHERE id=?`)
        .bind(finishedAt, status, result.attempted, result.completed, result.written,
          status === "ok" ? null : `${result.completed}/${result.attempted} finske værankere ga observasjonsdata; ${result.noData} ga ingen data`, run.id).run();
    }
    return {
      ...result,
      source: "FMI",
      startedAt,
      finishedAt,
      ok: status === "ok",
      concurrency: CONCURRENCY,
      method: "FMI timevaluepair for navngitte kontraktssteder. Tvetydige steder presiseres med region, og områder hentes parallelt i små grupper.",
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (run?.id) {
      await db.prepare(`UPDATE nordic_weather_runs SET finished_at=?, status='error', targets_attempted=?,
          targets_completed=?, observations_written=?, error_text=? WHERE id=?`)
        .bind(finishedAt, result.attempted, result.completed, result.written,
          String(error?.message || error).slice(0, 1800), run.id).run();
    }
    throw error;
  }
}
