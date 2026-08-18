import { ensureActivitySchema } from "./activity.js";

const USER_AGENT = "Terranor-Tracker/0.8 (+private-investor-research)";

const SOURCES = [
  {
    key: "falun_anslagstavla",
    name: "Falu kommun – offisiell anslagstavle",
    municipality: "Falun",
    customerPattern: "%Falu kommun%",
    url: "https://www.falun.se/kommun--demokrati/officiell-anslagstavla.html",
    mode: "listing",
    maxLinks: 18,
    hostPattern: /(^|\.)falun\.se$/i,
    linkTerms: /upphandling|delegationsbeslut|servicen[aä]mnd|samh[aä]llsbygg|drift|underh[aå]ll|vinter|sn[oö]|gata|v[aä]g/i,
  },
  {
    key: "falun_eavrop_norr",
    name: "Falu kommun – e-Avrop kontrakt område Norr",
    municipality: "Falun",
    customerPattern: "%Falu kommun%",
    url: "https://www.e-avrop.com/falun/e-Avtal/AgreementDispatcher.aspx?adminClientId=1043&bilaga=&docid=-3244&ver=A",
    mode: "contract_page",
  },
  {
    key: "boras_tekniska_namnden",
    name: "Borås Stad – Tekniska nämnden",
    municipality: "Borås",
    customerPattern: "%Borås%",
    url: "https://www.boras.se/kommunochpolitik/kommunensorganisation/namnder/tekniskanamnden.4.392266d31578efe53774bda3.html",
    mode: "listing",
    maxLinks: 12,
    hostPattern: /(^|\.)boras\.se$/i,
    linkTerms: /tekniskanamndensammantrade|delegationsbeslut|upphandling|drift|underh[aå]ll|vinter|sn[oö]|gata|v[aä]g/i,
  },
  {
    key: "boras_vinter",
    name: "Borås Stad – vinterväghållning",
    municipality: "Borås",
    customerPattern: "%Borås%",
    url: "https://www.boras.se/bobyggaochtrafik/skotselavoffentligaplatser/snorojningochhalkbekampning.4.7c18dd931588ba82b03206d0.html",
    mode: "contract_page",
  },
  {
    key: "norrkoping_anslag",
    name: "Norrköpings kommun – aktuelle anslag",
    municipality: "Norrköping",
    customerPattern: "%Norrköping%",
    url: "https://norrkoping.se/kommun-och-politik/riktlinjer-beslut-och-dokument/anslagstavla/aktuella-anslag",
    mode: "listing",
    maxLinks: 16,
    hostPattern: /(^|\.)norrkoping\.se$/i,
    linkTerms: /samh[aä]llsplaneringsn[aä]mnden|delegationsbeslut|upphandling|drift|underh[aå]ll|vinter|sn[oö]|gata|v[aä]g/i,
  },
  {
    key: "helsingborg_drift",
    name: "Helsingborgs stad – drift og vedlikehold",
    municipality: "Helsingborg",
    customerPattern: "%Helsingborg%",
    url: "https://helsingborg.se/kommun-och-politik/kommunens-organisation/forvaltningar/stadsbyggnads-forvaltningen/",
    mode: "contract_page",
  },
  {
    key: "helsingborg_tang",
    name: "Helsingborgs stad – stranddrift",
    municipality: "Helsingborg",
    customerPattern: "%Helsingborg%",
    url: "https://helsingborg.se/uppleva-och-gora/friluftsliv-och-motion/badplatser-och-strander/rensning-av-tang/",
    mode: "contract_page",
  },
  {
    key: "eavrop_afterannonser",
    name: "e-Avrop – offentlige tildelinger",
    municipality: null,
    customerPattern: null,
    url: "https://www.e-avrop.com/nyhetsbrev-fran-e-avrop/e-Upphandling/ContractAwardNotices.aspx",
    mode: "eavrop_awards",
    maxLinks: 28,
    hostPattern: /(^|\.)e-avrop\.com$/i,
    linkTerms: /45000000|4523|45233|5023|9061|9062|7731|anl[aä]gg|v[aä]g|gata|marksk[oö]tsel|drift|underh[aå]ll|sn[oö]|sopning/i,
  },
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS municipal_source_state (
    source_key TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    municipality TEXT,
    last_hash TEXT,
    last_checked_at TEXT,
    last_changed_at TEXT,
    status TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS municipal_seen_items (
    item_key TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    item_url TEXT NOT NULL,
    title TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS municipal_monitor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    sources_attempted INTEGER DEFAULT 0,
    sources_completed INTEGER DEFAULT 0,
    items_seen INTEGER DEFAULT 0,
    candidates_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_municipal_seen_source ON municipal_seen_items(source_key, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_municipal_runs_time ON municipal_monitor_runs(started_at)`,
];

function cleanText(value, max = 5000) {
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

function stripHtml(html) {
  return cleanText(decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")), 30000) || "";
}

function normalize(value) {
  return String(value || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalUrl(href, baseUrl, hostPattern = null) {
  try {
    const url = new URL(decodeHtml(href), baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (hostPattern && !hostPattern.test(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Henting feilet (${response.status}) for ${url}`);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text") && !type.includes("html") && !type.includes("xml")) {
    throw new Error(`Kilden er ikke tekst/HTML (${type || "ukjent innholdstype"})`);
  }
  return { html: await response.text(), finalUrl: response.url || url };
}

function extractTitle(html, fallback = "Kommunalt dokument") {
  const h1 = String(html || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return cleanText(stripHtml(h1[1]), 500) || fallback;
  const title = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(title ? stripHtml(title[1]) : fallback, 500) || fallback;
}

function extractPublishedAt(text) {
  const value = String(text || "");
  const iso = value.match(/\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`;
  const swe = value.match(/\b(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\s+(20\d{2})\b/i);
  if (swe) {
    const months = { januari:1, februari:2, mars:3, april:4, maj:5, juni:6, juli:7, augusti:8, september:9, oktober:10, november:11, december:12 };
    return `${swe[3]}-${String(months[swe[2].toLowerCase()]).padStart(2,"0")}-${String(swe[1]).padStart(2,"0")}T12:00:00Z`;
  }
  return null;
}

function extractLinks(html, source) {
  const found = new Map();
  const re = /<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  const full = String(html || "");
  while ((match = re.exec(full))) {
    const url = canonicalUrl(match[2], source.url, source.hostPattern || null);
    if (!url) continue;
    const title = cleanText(stripHtml(match[4]), 500) || "Dokument/side";
    const context = cleanText(stripHtml(full.slice(Math.max(0, match.index - 500), Math.min(full.length, re.lastIndex + 700))), 1800) || title;
    if (source.linkTerms && !source.linkTerms.test(`${title} ${context} ${url}`)) continue;
    if (!found.has(url)) found.set(url, { url, title, context });
  }
  return [...found.values()].slice(0, source.maxLinks || 20);
}

function classify(text, source) {
  const raw = String(text || "");
  const value = normalize(raw);
  const hasTerranor = /\bterranor\b/i.test(raw);

  if (hasTerranor && /(vite|avvik|sanktion|brist|uppfolj|uppfölj|kontroll|revision)/i.test(raw)) {
    return { type: "kommunal_oppfolging", relevance: 100, confidence: 96 };
  }
  if (hasTerranor && /(option|forlang|förläng|forl[aä]ngning|utnyttj|losa ut|lösa ut)/i.test(raw)) {
    return { type: "utlost_option", relevance: 98, confidence: 97 };
  }
  if (hasTerranor && /(ata|äta|tillaggsarbete|tilläggsarbete|extraarbete|bestall|beställ|avrop)/i.test(raw)) {
    return { type: "ny_bestilling", relevance: 98, confidence: 95 };
  }
  if (hasTerranor && /(tilldel|vinnare|vinner|resultat|kontrakt|avtal)/i.test(raw)) {
    return { type: "kommunal_tildeling", relevance: 95, confidence: 96 };
  }
  if (hasTerranor) return { type: "kommunal_aktivitet", relevance: 88, confidence: 93 };

  if (/(delegationsbeslut|upphandling|tilldel|avrop|option|drift|underhall|underhåll|vintervaghall|vinterväghåll|snoroj|snöröj|gata|vag|väg)/i.test(raw)) {
    return { type: "kommunal_beslutning", relevance: source.mode === "listing" ? 62 : 55, confidence: 72 };
  }
  return { type: "annen_aktivitet", relevance: 25, confidence: 55 };
}

function extractValueMsek(text) {
  const value = String(text || "").replace(/\u00a0/g, " ");
  const patterns = [
    /(\d{1,4}(?:[,.]\d+)?)\s*(?:mkr|mnkr|miljon(?:er)?\s*(?:sek|kronor)?)/i,
    /(\d{1,3}(?:[ .]\d{3})+)\s*sek/i,
    /takvolym[^\d]{0,40}(\d[\d .]*)\s*sek/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.[1]) continue;
    const raw = match[1].replace(/\s|\./g, "").replace(",", ".");
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (/mkr|mnkr|miljon/i.test(match[0])) return n;
    return n / 1_000_000;
  }
  return null;
}

async function ensureSchema(db) {
  await ensureActivitySchema(db);
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

async function findContract(db, source, text) {
  if (!source.customerPattern) return null;
  const result = await db.prepare(`SELECT id, name, customer FROM contracts WHERE country='Sweden' AND customer LIKE ? ORDER BY LENGTH(name) DESC`)
    .bind(source.customerPattern).all();
  const rows = result?.results || [];
  if (!rows.length) return null;
  if (rows.length === 1) return Number(rows[0].id);
  const haystack = normalize(text);
  let best = null;
  for (const row of rows) {
    const tokens = normalize(row.name).split(" ").filter((token) => token.length >= 2 && !["omrade","område","municipality","kommun","drift","underhall","underhåll"].includes(token));
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    const score = tokens.length ? hits / tokens.length : 0;
    if (!best || score > best.score) best = { id: Number(row.id), score };
  }
  return best?.score >= 0.35 ? best.id : null;
}

async function alreadyCandidate(db, url) {
  const row = await db.prepare(`SELECT id FROM activity_candidates WHERE item_url=? LIMIT 1`).bind(url).first();
  return Boolean(row?.id);
}

async function saveCandidate(db, source, item, fullText, classification) {
  if (await alreadyCandidate(db, item.url)) return false;
  const contractId = await findContract(db, source, fullText);
  await db.prepare(`INSERT INTO activity_candidates (
      source_key, source_name, item_url, title, published_at, country, signal_type,
      value_msek, contract_id, relevance_score, confidence, review_status, excerpt, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Sweden', ?, ?, ?, ?, ?, 'ny', ?, CURRENT_TIMESTAMP)`)
    .bind(
      source.key, source.name, item.url, cleanText(item.title, 500) || source.name,
      item.published_at || null, classification.type, extractValueMsek(fullText), contractId,
      classification.relevance, classification.confidence,
      cleanText(fullText, 1400),
    ).run();
  return true;
}

async function touchSeen(db, sourceKey, item, hash = null) {
  const key = `${sourceKey}|${item.url}`.slice(0, 900);
  const existing = await db.prepare(`SELECT item_key, content_hash FROM municipal_seen_items WHERE item_key=?`).bind(key).first();
  await db.prepare(`INSERT INTO municipal_seen_items (item_key, source_key, item_url, title, content_hash, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(item_key) DO UPDATE SET title=excluded.title, content_hash=COALESCE(excluded.content_hash, municipal_seen_items.content_hash),
        last_seen_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`)
    .bind(key, sourceKey, item.url, cleanText(item.title, 500), hash).run();
  return existing;
}

async function updateSourceState(db, source, fields) {
  await db.prepare(`INSERT INTO municipal_source_state (
      source_key, source_name, source_url, municipality, last_hash, last_checked_at, last_changed_at, status, error_text, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source_key) DO UPDATE SET
      source_name=excluded.source_name, source_url=excluded.source_url, municipality=excluded.municipality,
      last_hash=COALESCE(excluded.last_hash, municipal_source_state.last_hash),
      last_checked_at=excluded.last_checked_at,
      last_changed_at=COALESCE(excluded.last_changed_at, municipal_source_state.last_changed_at),
      status=excluded.status, error_text=excluded.error_text, updated_at=CURRENT_TIMESTAMP`)
    .bind(
      source.key, source.name, source.url, source.municipality,
      fields.hash || null, fields.checkedAt || new Date().toISOString(), fields.changedAt || null,
      fields.status || "ok", fields.error ? String(fields.error).slice(0, 1800) : null,
    ).run();
}

async function inspectLinkedItem(db, source, link, firstSourceRun) {
  const isPdf = /\.pdf(?:$|[?#])/i.test(link.url);
  if (isPdf) {
    const classification = classify(`${link.title} ${link.context}`, source);
    await touchSeen(db, source.key, link);
    if (firstSourceRun || classification.relevance < 55) return { candidate: false, inspected: false };
    const candidate = await saveCandidate(db, source, { ...link, published_at: extractPublishedAt(link.context) }, `${link.title}. ${link.context}`, classification);
    return { candidate, inspected: false };
  }

  const seen = await touchSeen(db, source.key, link);
  if (seen && firstSourceRun) return { candidate: false, inspected: false };
  if (seen && !firstSourceRun) return { candidate: false, inspected: false };

  try {
    const page = await fetchPage(link.url);
    const body = stripHtml(page.html);
    const title = extractTitle(page.html, link.title);
    const text = `${title} ${body}`;
    const classification = classify(text, source);
    const hash = await sha256(text);
    await touchSeen(db, source.key, { ...link, title }, hash);
    if (firstSourceRun || classification.relevance < 55) return { candidate: false, inspected: true };
    const candidate = await saveCandidate(db, source, {
      ...link, title, published_at: extractPublishedAt(text),
    }, text, classification);
    return { candidate, inspected: true };
  } catch {
    const classification = classify(`${link.title} ${link.context}`, source);
    if (firstSourceRun || classification.relevance < 60) return { candidate: false, inspected: false };
    const candidate = await saveCandidate(db, source, { ...link, published_at: extractPublishedAt(link.context) }, `${link.title}. ${link.context}`, classification);
    return { candidate, inspected: false };
  }
}

async function runListingSource(db, source, page, priorState) {
  const links = extractLinks(page.html, source);
  const firstSourceRun = !priorState?.last_checked_at;
  let candidates = 0;
  let inspected = 0;
  for (const link of links) {
    const result = await inspectLinkedItem(db, source, link, firstSourceRun);
    if (result.candidate) candidates += 1;
    if (result.inspected) inspected += 1;
  }
  return { links: links.length, candidates, inspected, firstSourceRun };
}

function eavropRelevantLinks(html, source) {
  const links = extractLinks(html, source);
  return links.filter((item) => /ContractAwardNotice\.aspx\?id=/i.test(item.url)).slice(0, source.maxLinks || 28);
}

async function runEavropAwards(db, source, page, priorState) {
  const links = eavropRelevantLinks(page.html, source);
  const firstSourceRun = !priorState?.last_checked_at;
  let candidates = 0;
  let inspected = 0;
  for (const link of links) {
    const key = `${source.key}|${link.url}`.slice(0, 900);
    const seen = await db.prepare(`SELECT item_key FROM municipal_seen_items WHERE item_key=?`).bind(key).first();
    if (seen) {
      await touchSeen(db, source.key, link);
      continue;
    }
    try {
      const detail = await fetchPage(link.url);
      inspected += 1;
      const body = stripHtml(detail.html);
      const title = extractTitle(detail.html, link.title);
      const text = `${title} ${body}`;
      const hash = await sha256(text);
      await touchSeen(db, source.key, { ...link, title }, hash);
      if (!/\bTerranor AB\b/i.test(text)) continue;
      const classification = classify(text, source);
      // For the first import we deliberately keep exact Terranor hits. They can reveal recent awards not yet in the tracker.
      const candidate = await saveCandidate(db, source, {
        ...link, title, published_at: extractPublishedAt(text),
      }, text, classification);
      if (candidate) candidates += 1;
    } catch {
      await touchSeen(db, source.key, link);
    }
  }
  return { links: links.length, candidates, inspected, firstSourceRun };
}

async function runContractPage(db, source, page, priorState) {
  const body = stripHtml(page.html);
  const title = extractTitle(page.html, source.name);
  const text = `${title} ${body}`;
  const hash = await sha256(text);
  const firstSourceRun = !priorState?.last_checked_at;
  const changed = Boolean(priorState?.last_hash && priorState.last_hash !== hash);
  let candidates = 0;
  if (changed && !firstSourceRun) {
    const classification = classify(text, source);
    const itemUrl = `${source.url}${source.url.includes("?") ? "&" : "?"}tt_changed=${hash.slice(0, 12)}`;
    const candidate = await saveCandidate(db, source, {
      url: itemUrl,
      title: `${title} – kilde endret`,
      published_at: new Date().toISOString(),
    }, text, classification.type === "annen_aktivitet"
      ? { type: "kontraktsendring", relevance: 80, confidence: 88 }
      : classification);
    if (candidate) candidates += 1;
  }
  return { hash, changed, candidates, inspected: 1, firstSourceRun };
}

export async function runMunicipalMonitor(db, options = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureSchema(db);
  const startedAt = new Date().toISOString();
  const run = await db.prepare(`INSERT INTO municipal_monitor_runs (started_at, status, sources_attempted)
    VALUES (?, 'running', ?) RETURNING id`).bind(startedAt, SOURCES.length).first();
  const details = [];
  let completed = 0;
  let itemsSeen = 0;
  let candidatesWritten = 0;
  const errors = [];

  for (const source of SOURCES) {
    try {
      const priorState = await db.prepare(`SELECT * FROM municipal_source_state WHERE source_key=?`).bind(source.key).first();
      const page = await fetchPage(source.url);
      const pageText = stripHtml(page.html);
      const pageHash = await sha256(pageText);
      let result;
      if (source.mode === "listing") result = await runListingSource(db, source, page, priorState);
      else if (source.mode === "eavrop_awards") result = await runEavropAwards(db, source, page, priorState);
      else result = await runContractPage(db, source, page, priorState);

      const changed = source.mode === "contract_page"
        ? result.changed
        : Boolean(priorState?.last_hash && priorState.last_hash !== pageHash);
      await updateSourceState(db, source, {
        hash: source.mode === "contract_page" ? result.hash : pageHash,
        checkedAt: new Date().toISOString(),
        changedAt: changed ? new Date().toISOString() : null,
        status: "ok",
      });
      completed += 1;
      itemsSeen += Number(result.links || result.inspected || 0);
      candidatesWritten += Number(result.candidates || 0);
      details.push({ source: source.key, name: source.name, changed, ...result, status: "ok" });
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(`${source.key}: ${message}`);
      await updateSourceState(db, source, {
        checkedAt: new Date().toISOString(), status: "error", error: message,
      });
      details.push({ source: source.key, name: source.name, status: "error", error: message });
    }
  }

  const finishedAt = new Date().toISOString();
  const status = completed === SOURCES.length ? "ok" : completed > 0 ? "partial" : "error";
  if (run?.id) {
    await db.prepare(`UPDATE municipal_monitor_runs SET finished_at=?, status=?, sources_completed=?, items_seen=?,
      candidates_written=?, error_text=? WHERE id=?`)
      .bind(finishedAt, status, completed, itemsSeen, candidatesWritten,
        errors.length ? errors.join(" | ").slice(0, 1800) : null, run.id).run();
  }
  return {
    ok: status !== "error",
    phase: "B",
    source: "Kommunale og offentlige innkjøpskilder",
    startedAt,
    finishedAt,
    status,
    sourcesAttempted: SOURCES.length,
    sourcesCompleted: completed,
    itemsSeen,
    candidatesWritten,
    details,
    errors,
    note: "Kommunale funn blir kandidater for vurdering og påvirker ikke resultatestimatet automatisk. Første kjøring av kommunale møtekilder etablerer en grunnlinje for å unngå historisk støy; eksakte Terranor-treff i e-Avrops tildelingsfeed beholdes også ved første import.",
  };
}

export async function getMunicipalStatus(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureSchema(db);
  const [states, latestRun, candidateCounts, recent] = await Promise.all([
    db.prepare(`SELECT source_key, source_name, source_url, municipality, last_checked_at, last_changed_at, status, error_text
      FROM municipal_source_state ORDER BY source_name`).all(),
    db.prepare(`SELECT * FROM municipal_monitor_runs ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`SELECT source_key, review_status, COUNT(*) AS count FROM activity_candidates
      WHERE source_key IN (${SOURCES.map(() => "?").join(",")}) GROUP BY source_key, review_status`)
      .bind(...SOURCES.map((s) => s.key)).all(),
    db.prepare(`SELECT a.id, a.source_key, a.source_name, a.item_url, a.title, a.published_at, a.signal_type,
        a.value_msek, a.contract_id, c.name AS contract_name, a.relevance_score, a.confidence, a.review_status, a.excerpt
      FROM activity_candidates a LEFT JOIN contracts c ON c.id=a.contract_id
      WHERE a.source_key IN (${SOURCES.map(() => "?").join(",")})
      ORDER BY COALESCE(datetime(a.published_at), datetime(a.created_at)) DESC, a.id DESC LIMIT 30`)
      .bind(...SOURCES.map((s) => s.key)).all(),
  ]);
  const counts = {};
  for (const row of candidateCounts?.results || []) {
    counts[row.source_key] ??= {};
    counts[row.source_key][row.review_status] = Number(row.count || 0);
  }
  const statesByKey = Object.fromEntries((states?.results || []).map((row) => [row.source_key, row]));
  const sources = SOURCES.map((source) => ({
    key: source.key,
    name: source.name,
    municipality: source.municipality,
    url: source.url,
    mode: source.mode,
    status: statesByKey[source.key]?.status || "venter_pa_forste_kjoring",
    lastCheckedAt: statesByKey[source.key]?.last_checked_at || null,
    lastChangedAt: statesByKey[source.key]?.last_changed_at || null,
    error: statesByKey[source.key]?.error_text || null,
    candidates: counts[source.key] || {},
  }));
  return {
    ok: true,
    phase: "B",
    generatedAt: new Date().toISOString(),
    automaticCheck: "daglig",
    latestRun: latestRun || null,
    sources,
    activeSources: sources.filter((s) => s.status === "ok").length,
    recentCandidates: recent?.results || [],
    methodology: [
      "Kommunale møtesider og anslagstavler overvåkes for nye relevante dokumenter og saker.",
      "Eksisterende Terranor-relaterte kontrakts- og driftsider overvåkes for innholdsendringer.",
      "e-Avrops offentlige tildelingsfeed brukes som tilleggskilde; bare detaljer med eksplisitt Terranor-treff registreres.",
      "Ingen kommunale funn bokføres automatisk som omsetning eller EBITA.",
    ],
  };
}

export const MUNICIPAL_SOURCES = SOURCES;
