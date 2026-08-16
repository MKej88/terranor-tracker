const TRAFIKVERKET_ENDPOINT = "https://api.trafikinfo.trafikverket.se/v2/data.json";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildQuery(apiKey, objectType, schemaVersion = "2.1", limit = 3) {
  return `<REQUEST>
  <LOGIN authenticationkey="${xmlEscape(apiKey)}" />
  <QUERY objecttype="${objectType}" schemaversion="${schemaVersion}" limit="${limit}" />
</REQUEST>`;
}

async function postQuery(apiKey, objectType, schemaVersion = "2.1", limit = 3) {
  if (!apiKey) throw new Error("TRAFIKVERKET_API_KEY is missing");

  const body = buildQuery(apiKey, objectType, schemaVersion, limit);
  const response = await fetch(TRAFIKVERKET_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      accept: "application/json",
      "user-agent": "terranor-tracker/0.1",
    },
    body,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`Trafikverket ${objectType} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!payload) {
    throw new Error(`Trafikverket ${objectType} returned non-JSON response: ${text.slice(0, 500)}`);
  }

  const apiError = findApiError(payload);
  if (apiError) {
    throw new Error(`Trafikverket ${objectType} API error: ${apiError}`);
  }

  return payload;
}

function findApiError(payload) {
  const results = payload?.RESPONSE?.RESULT;
  const list = Array.isArray(results) ? results : results ? [results] : [];
  for (const result of list) {
    if (result?.ERROR) return JSON.stringify(result.ERROR);
  }
  return null;
}

function extractItems(payload, objectType) {
  const results = payload?.RESPONSE?.RESULT;
  const list = Array.isArray(results) ? results : results ? [results] : [];
  const items = [];
  for (const result of list) {
    const value = result?.[objectType];
    if (Array.isArray(value)) items.push(...value);
    else if (value) items.push(value);
  }
  return items;
}

function describeShape(value, depth = 0) {
  if (depth > 4) return "…";
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.length ? [describeShape(value[0], depth + 1)] : [];
  }
  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value).slice(0, 40);
    for (const [key, child] of entries) out[key] = describeShape(child, depth + 1);
    return out;
  }
  return typeof value;
}

function sanitizeSample(value, depth = 0) {
  if (depth > 5) return "…";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 2).map((item) => sanitizeSample(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      out[key] = sanitizeSample(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  return value;
}

export async function probeTrafikverket(apiKey) {
  const objects = [
    { objectType: "WeatherMeasurepoint", schemaVersion: "2.1", limit: 2 },
    { objectType: "WeatherObservation", schemaVersion: "2.1", limit: 2 },
  ];

  const probes = [];
  for (const item of objects) {
    try {
      const payload = await postQuery(apiKey, item.objectType, item.schemaVersion, item.limit);
      const rows = extractItems(payload, item.objectType);
      probes.push({
        ok: true,
        objectType: item.objectType,
        schemaVersion: item.schemaVersion,
        count: rows.length,
        responseKeys: Object.keys(payload?.RESPONSE || {}),
        resultKeys: Object.keys((Array.isArray(payload?.RESPONSE?.RESULT) ? payload.RESPONSE.RESULT[0] : payload?.RESPONSE?.RESULT) || {}),
        shape: rows.length ? describeShape(rows[0]) : null,
        sample: rows.length ? sanitizeSample(rows[0]) : null,
      });
    } catch (error) {
      probes.push({
        ok: false,
        objectType: item.objectType,
        schemaVersion: item.schemaVersion,
        error: String(error?.message || error),
      });
    }
  }

  return {
    ok: probes.some((p) => p.ok),
    endpoint: TRAFIKVERKET_ENDPOINT,
    probes,
    note: "Probe returns public weather-data structure only. API key is never returned.",
  };
}
