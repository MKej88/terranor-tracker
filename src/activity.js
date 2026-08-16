const COMPANY_NEWS_URL = "https://terranor.se/nyheter/";
const MONITOR_INTERVAL_HOURS = 6;

const ACTIVITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS activity_monitor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    items_seen INTEGER DEFAULT 0,
    candidates_written INTEGER DEFAULT 0,
    signals_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS activity_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL,
    source_name TEXT NOT NULL,
    item_url TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at TEXT,
    country TEXT,
    signal_type TEXT NOT NULL,
    value_msek REAL,
    contract_id INTEGER,
    relevance_score REAL,
    confidence REAL,
    review_status TEXT NOT NULL DEFAULT 'ny',
    excerpt TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(item_url),
    FOREIGN KEY (contract_id) REFERENCES contracts(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_candidates_status ON activity_candidates(review_status, published_at)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_runs_time ON activity_monitor_runs(source_key, started_at)`,
];

const SEEDED_SIGNALS = [
  {
    observed_at: "2026-04-17T09:30:00Z",
    country: "Sweden",
    signal_type: "utlost_option",
    title: "Trafikverket løser ut toårig opsjon i Göteborg",
    value: 175,
    unit: "MSEK",
    score: 35,
    confidence: 100,
    source_url: "https://terranor.se/terranor-tilldelas-tvaarig-option-i-goteborg-vard-175-miljoner-kronor/",
    notes: "Offisiell Terranor-melding. Opsjonen gjelder Driftområde Göteborg fra 1. september 2027 til 31. august 2029. Dette er et ordre-/kontraktssignal, ikke et Q3 2026-omsetningsestimat.",
  },
  {
    observed_at: "2025-12-11T12:00:00Z",
    country: "Sweden",
    signal_type: "utlost_option",
    title: "Trafikverket bestiller ytterligere 54 hastighetskameraer",
    value: 20,
    unit: "MSEK",
    score: 80,
    confidence: 100,
    source_url: "https://terranor.se/terranor-beviljas-en-option-for-att-ytterligare-forbattra-sakerheten-for-trafikverket/",
    notes: "Offisiell Terranor-melding. Trafikverket utnyttet en opsjon på ytterligere 54 hastighetskameraer. Total ordreverdi er 20 MSEK og avtalen løper til 31. mars 2027. Kan være relevant for 2026-aktivitet, men inntektsføring per kvartal er ikke kjent.",
  },
];

export async function ensureActivitySchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await db.batch(ACTIVITY_SCHEMA.map((sql) => db.prepare(sql)));
  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_type_time ON signals(signal_type, observed_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_contract_time ON signals(contract_id, observed_at)`),
  ]);
}

function cleanText(value, max = 1200) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(text) {
  return cleanText(decodeHtml(String(text || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")), 8000) || "";
}

function canonicalUrl(href) {
  try {
    const url = new URL(href, COMPANY_NEWS_URL);
    if (url.hostname !== "terranor.se" && url.hostname !== "www.terranor.se") return null;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractNewsLinks(html) {
  const found = new Map();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const url = canonicalUrl(match[1]);
    const title = cleanText(stripHtml(match[2]), 350);
    if (!url || !title) continue;
    if (url === COMPANY_NEWS_URL || /\/category\//i.test(url) || /\/tag\//i.test(url)) continue;
    if (!/terranor|kontrakt|option|uppdrag|underh[aå]ll|tilldel|vinner|best[aä]ll/i.test(title)) continue;
    if (!found.has(url)) found.set(url, { url, title });
  }
  return [...found.values()].slice(0, 30);
}

function extractPublishedAt(html) {
  const text = String(html || "");
  const patterns = [
    /property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
    /<time\b[^>]*datetime=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && Number.isFinite(Date.parse(match[1]))) return new Date(match[1]).toISOString();
  }
  const date = stripHtml(text).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return date ? `${date[1]}-${date[2]}-${date[3]}T12:00:00Z` : null;
}

function extractTitle(html, fallback) {
  const match = String(html || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return cleanText(match ? stripHtml(match[1]) : fallback, 350) || fallback;
}

function extractValueMsek(text) {
  const normalized = String(text || "").replace(/\u00a0/g, " ");
  const patterns = [
    /(?:cirka|ca\.?|omkring)?\s*(\d{1,4}(?:[,.]\d+)?)\s*miljon(?:er)?\s*(?:svenska\s*)?kronor/i,
    /v[aä]rd(?:a)?\s*(\d{1,4}(?:[,.]\d+)?)\s*miljon/i,
    /order(?:v[aä]rde|värdet)?[^\d]{0,30}(\d{1,4}(?:[,.]\d+)?)\s*miljon/i,
    /optionsv[aä]rd(?:et)?[^\d]{0,30}(\d{1,4}(?:[,.]\d+)?)\s*miljon/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1].replace(",", "."));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function inferCountry(text) {
  const value = String(text || "").toLowerCase();
  if (/finland|väylävirasto|j[aä]rvenp[aä][aä]|kemi\b|\bii\b/.test(value)) return "Finland";
  if (/danmark|denmark|københavn|ikast|brande/.test(value)) return "Denmark";
  return "Sweden";
}

function classify(text) {
  const value = String(text || "").toLowerCase();
  if (/option/.test(value) && /(l[oö]sa ut|utnyttj|bevilj|tilldel|f[oö]rl[aä]ng|ytterligare)/.test(value)) {
    return { type: "utlost_option", relevance: 95 };
  }
  if (/(till[aä]gg|ytterligare).{0,80}(arbete|uppdrag|best[aä]ll|installation|kamer)/s.test(value)
      || /(arbete|uppdrag|best[aä]ll|installation).{0,80}(till[aä]gg|ytterligare)/s.test(value)) {
    return { type: "tilleggsarbeid", relevance: 100 };
  }
  if (/f[aå]tt i uppdrag|ny best[aä]llning|order/.test(value)) return { type: "ny_bestilling", relevance: 85 };
  if (/vinner|tilldelas|tilldela/.test(value) && /kontrakt|upphandling|entreprenad/.test(value)) {
    return { type: "ny_kontrakt", relevance: 50 };
  }
  return { type: "annen_aktivitet", relevance: 25 };
}

function normalize(value) {
  return String(value || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

async function matchContract(db, title, body, country) {
  const result = await db.prepare(`SELECT id, name FROM contracts WHERE country=? ORDER BY LENGTH(name) DESC`).bind(country).all();
  const haystack = normalize(`${title} ${body}`).replace(/\bdriftomrade\b/g, " ");
  let best = null;
  for (const row of result?.results || []) {
    const name = normalize(row.name)
      .replace(/municipality|kommun|road maintenance|state road o m|municipal o m|renewal/g, " ")
      .replace(/\s+/g, " ").trim();
    const tokens = name.split(" ").filter((x) => x.length >= 4);
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    const score = tokens.length ? hits / tokens.length : 0;
    if (hits >= 1 && (!best || score > best.score)) best = { id: Number(row.id), score };
  }
  return best && best.score >= 0.45 ? best.id : null;
}

async function hasSignalForUrl(db, url) {
  const row = await db.prepare(`SELECT id FROM signals WHERE source_url=? LIMIT 1`).bind(url).first();
  return Boolean(row?.id);
}

async function writeSignal(db, item) {
  if (await hasSignalForUrl(db, item.item_url)) return false;
  await db.prepare(`INSERT INTO signals (
      observed_at, country, contract_id, signal_type, title, value, unit, score, confidence, source_url, notes
    ) VALUES (?, ?, ?, ?, ?, ?, 'MSEK', ?, ?, ?, ?)`)
    .bind(
      item.published_at || new Date().toISOString(), item.country, item.contract_id, item.signal_type,
      item.title, item.value_msek, item.relevance_score, item.confidence, item.item_url,
      `Automatisk funnet i offisiell Terranor-kilde. Må behandles som et kildebelagt ordre-/aktivitetssignal, ikke som direkte kvartalsomsetning. ${item.excerpt || ""}`.slice(0, 3000),
    ).run();
  return true;
}

async function seedKnownSignals(db) {
  let written = 0;
  for (const seed of SEEDED_SIGNALS) {
    if (await hasSignalForUrl(db, seed.source_url)) continue;
    await db.prepare(`INSERT INTO signals (
        observed_at, country, contract_id, signal_type, title, value, unit, score, confidence, source_url, notes
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(seed.observed_at, seed.country, seed.signal_type, seed.title, seed.value, seed.unit,
        seed.score, seed.confidence, seed.source_url, seed.notes).run();
    written += 1;
  }
  return written;
}

async function alreadyCandidate(db, url) {
  const row = await db.prepare(`SELECT id FROM activity_candidates WHERE item_url=? LIMIT 1`).bind(url).first();
  return Boolean(row?.id);
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Terranor-Tracker/0.6 (+private-investor-research)",
      "accept": "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`Henting feilet (${response.status}) for ${url}`);
  return response.text();
}

async function inspectItem(db, item) {
  const html = await fetchPage(item.url);
  const body = stripHtml(html);
  const title = extractTitle(html, item.title);
  const combined = `${title} ${body}`;
  const classification = classify(combined);
  const country = inferCountry(combined);
  const publishedAt = extractPublishedAt(html);
  const valueMsek = extractValueMsek(combined);
  const contractId = await matchContract(db, title, body, country);
  const excerpt = cleanText(body, 850);
  return {
    source_key: "terranor_nyheter",
    source_name: "Terranors offisielle nyhetsside",
    item_url: item.url,
    title,
    published_at: publishedAt,
    country,
    signal_type: classification.type,
    value_msek: valueMsek,
    contract_id: contractId,
    relevance_score: classification.relevance,
    confidence: 98,
    excerpt,
  };
}

async function saveCandidate(db, item) {
  await db.prepare(`INSERT INTO activity_candidates (
      source_key, source_name, item_url, title, published_at, country, signal_type,
      value_msek, contract_id, relevance_score, confidence, review_status, excerpt, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ny', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(item_url) DO UPDATE SET
      title=excluded.title,
      published_at=COALESCE(excluded.published_at, activity_candidates.published_at),
      country=excluded.country,
      signal_type=excluded.signal_type,
      value_msek=COALESCE(excluded.value_msek, activity_candidates.value_msek),
      contract_id=COALESCE(excluded.contract_id, activity_candidates.contract_id),
      relevance_score=excluded.relevance_score,
      confidence=excluded.confidence,
      excerpt=excluded.excerpt,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(item.source_key, item.source_name, item.item_url, item.title, item.published_at, item.country,
      item.signal_type, item.value_msek, item.contract_id, item.relevance_score, item.confidence, item.excerpt).run();
}

export async function runActivityMonitor(db, options = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureActivitySchema(db);
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO activity_monitor_runs (source_key, started_at, status)
    VALUES ('terranor_nyheter', ?, 'running') RETURNING id`).bind(startedAt).first();
  const runId = run?.id;
  let itemsSeen = 0;
  let candidatesWritten = 0;
  let signalsWritten = await seedKnownSignals(db);
  const details = [];

  try {
    const listingHtml = await fetchPage(COMPANY_NEWS_URL);
    const links = extractNewsLinks(listingHtml);
    itemsSeen = links.length;
    const maxItems = Math.max(1, Math.min(8, Number.parseInt(options.maxItems, 10) || 4));
    let inspected = 0;

    for (const link of links) {
      if (inspected >= maxItems) break;
      if (await alreadyCandidate(db, link.url)) continue;
      inspected += 1;
      try {
        const item = await inspectItem(db, link);
        await saveCandidate(db, item);
        candidatesWritten += 1;
        let promoted = false;
        if (["utlost_option", "tilleggsarbeid", "ny_bestilling"].includes(item.signal_type)) {
          promoted = await writeSignal(db, item);
          if (promoted) signalsWritten += 1;
          await db.prepare(`UPDATE activity_candidates SET review_status=? WHERE item_url=?`)
            .bind(promoted ? "automatisk_godkjent" : "allerede_registrert", item.item_url).run();
        }
        details.push({
          title: item.title,
          type: item.signal_type,
          value_msek: item.value_msek,
          country: item.country,
          contract_id: item.contract_id,
          promoted,
        });
      } catch (error) {
        details.push({ title: link.title, url: link.url, status: "feil", error: String(error?.message || error) });
      }
    }

    const finishedAt = new Date().toISOString();
    if (runId) await db.prepare(`UPDATE activity_monitor_runs SET finished_at=?, status='ok', items_seen=?,
      candidates_written=?, signals_written=? WHERE id=?`)
      .bind(finishedAt, itemsSeen, candidatesWritten, signalsWritten, runId).run();

    return {
      ok: true,
      source: "Terranors offisielle nyhetsside",
      startedAt,
      finishedAt,
      itemsSeen,
      candidatesWritten,
      signalsWritten,
      details,
      note: "Opsjoner, tilleggsarbeider og tydelige nye bestillinger fra den offisielle selskapskilden kan registreres automatisk. Nye hovedkontrakter blir kandidater, men skal håndteres i kontraktsregisteret og ikke regnes som tilleggsarbeid.",
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    if (runId) await db.prepare(`UPDATE activity_monitor_runs SET finished_at=?, status='error', items_seen=?,
      candidates_written=?, signals_written=?, error_text=? WHERE id=?`)
      .bind(finishedAt, itemsSeen, candidatesWritten, signalsWritten, String(error?.message || error).slice(0, 1800), runId).run();
    throw error;
  }
}

export async function listActivityCandidates(db, { limit = 50, status = null } = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureActivitySchema(db);
  const max = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
  let sql = `SELECT a.id, a.source_name, a.item_url, a.title, a.published_at, a.country,
      a.signal_type, a.value_msek, a.contract_id, c.name AS contract_name, a.relevance_score,
      a.confidence, a.review_status, a.excerpt, a.created_at, a.updated_at
    FROM activity_candidates a LEFT JOIN contracts c ON c.id=a.contract_id`;
  const binds = [];
  if (status) {
    sql += ` WHERE a.review_status=?`;
    binds.push(String(status));
  }
  sql += ` ORDER BY COALESCE(datetime(a.published_at), datetime(a.created_at)) DESC, a.id DESC LIMIT ?`;
  binds.push(max);
  const result = await db.prepare(sql).bind(...binds).all();
  return { candidates: result?.results || [] };
}

export async function reviewActivityCandidate(db, input = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureActivitySchema(db);
  const id = Number.parseInt(input.id, 10);
  const action = String(input.action || "").toLowerCase();
  if (!Number.isFinite(id)) throw new Error("Kandidat-id mangler");
  if (!["godkjenn", "ignorer"].includes(action)) throw new Error("Handling må være 'godkjenn' eller 'ignorer'");
  const candidate = await db.prepare(`SELECT * FROM activity_candidates WHERE id=?`).bind(id).first();
  if (!candidate) throw new Error("Kandidaten finnes ikke");

  let signalWritten = false;
  if (action === "godkjenn") {
    signalWritten = await writeSignal(db, {
      item_url: candidate.item_url,
      published_at: candidate.published_at,
      country: candidate.country,
      contract_id: candidate.contract_id,
      signal_type: candidate.signal_type,
      title: candidate.title,
      value_msek: candidate.value_msek,
      relevance_score: candidate.relevance_score,
      confidence: candidate.confidence,
      excerpt: candidate.excerpt,
    });
  }
  const reviewStatus = action === "godkjenn" ? "godkjent" : "ignorert";
  await db.prepare(`UPDATE activity_candidates SET review_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(reviewStatus, id).run();
  return { ok: true, id, reviewStatus, signalWritten };
}

export async function getActivityStatus(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureActivitySchema(db);
  await seedKnownSignals(db);
  const [latestRun, candidateCounts, signalCounts, recentSignals] = await Promise.all([
    db.prepare(`SELECT source_key, started_at, finished_at, status, items_seen, candidates_written,
      signals_written, error_text FROM activity_monitor_runs ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT review_status, COUNT(*) AS count FROM activity_candidates GROUP BY review_status`).all(),
    db.prepare(`SELECT signal_type, COUNT(*) AS count, ROUND(SUM(COALESCE(value,0)),1) AS value_msek
      FROM signals GROUP BY signal_type ORDER BY count DESC`).all(),
    db.prepare(`SELECT id, observed_at, signal_type, title, value, unit, confidence, source_url
      FROM signals WHERE signal_type IN ('utlost_option','tilleggsarbeid','ny_bestilling')
      ORDER BY datetime(observed_at) DESC, id DESC LIMIT 10`).all(),
  ]);
  const candidates = Object.fromEntries((candidateCounts?.results || []).map((r) => [r.review_status, Number(r.count || 0)]));
  const latestAgeHours = latestRun?.finished_at && Number.isFinite(Date.parse(latestRun.finished_at))
    ? Math.round((Date.now() - Date.parse(latestRun.finished_at)) / 3600000 * 10) / 10
    : null;
  return {
    phase: "B",
    monitoredSources: [
      { key: "terranor_nyheter", name: "Terranors offisielle nyhetsside", status: "aktiv", url: COMPANY_NEWS_URL },
      { key: "trafikverket", name: "Trafikverket – offentlige kontrakts- og bestillingskilder", status: "neste_kilde" },
      { key: "kommuner", name: "Kommunale bestillinger og beslutninger", status: "planlagt" },
    ],
    automaticCheckEveryHours: MONITOR_INTERVAL_HOURS,
    latestRun: latestRun ? { ...latestRun, age_hours: latestAgeHours } : null,
    candidates: {
      total: Object.values(candidates).reduce((a, b) => a + b, 0),
      new: candidates.ny || 0,
      automaticallyApproved: candidates.automatisk_godkjent || 0,
      approved: candidates.godkjent || 0,
      ignored: candidates.ignorert || 0,
    },
    signalTypes: signalCounts?.results || [],
    recentHighRelevanceSignals: recentSignals?.results || [],
    rules: {
      automatic: ["utløst opsjon", "tydelig tilleggsarbeid", "tydelig ny bestilling"],
      manualReview: ["nye hovedkontrakter", "generelle aktivitetsmeldinger", "uklar kvartalseffekt"],
      accountingRule: "Et funnet ordre- eller aktivitetssignal blir ikke automatisk omgjort til omsetning eller EBITA. Kvartalseffekt må modelleres separat.",
    },
  };
}
