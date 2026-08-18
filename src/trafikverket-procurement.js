import { parseAwardWorkbook, parsePlanWorkbook } from "./trafikverket-xlsx.js";

const AWARDS_PAGE_URL = "https://bransch.trafikverket.se/for-dig-i-branschen/upphandling/tilldelade-kontrakt/";
const PLAN_PAGE_URL = "https://bransch.trafikverket.se/for-dig-i-branschen/upphandling/Planerade-upphandlingar/";
const USER_AGENT = "Terranor-Tracker/2.0 (+private-investor-research)";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trafikverket_source_state (
    source_key TEXT PRIMARY KEY,
    source_page_url TEXT NOT NULL,
    source_file_url TEXT,
    source_updated_at TEXT,
    last_checked_at TEXT,
    last_imported_at TEXT,
    status TEXT,
    error_text TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trafikverket_procurement_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL,
    source_page_url TEXT NOT NULL,
    source_file_url TEXT,
    source_updated_at TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    rows_seen INTEGER DEFAULT 0,
    rows_matched INTEGER DEFAULT 0,
    rows_written INTEGER DEFAULT 0,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trafikverket_file_versions (
    version_key TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    source_file_url TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    source_updated_at TEXT,
    imported_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trafikverket_awards (
    procurement_id TEXT PRIMARY KEY,
    purchaser_org TEXT,
    region TEXT,
    purchase_category TEXT,
    procurement_type TEXT,
    procurement_name TEXT NOT NULL,
    terranor_bid_sek REAL,
    terranor_won INTEGER NOT NULL DEFAULT 0,
    winner_name TEXT,
    winner_orgno TEXT,
    winner_tender_sek REAL,
    contract_number TEXT,
    contract_start TEXT,
    contract_end TEXT,
    contract_value_sek REAL,
    contract_value_includes_option INTEGER NOT NULL DEFAULT 1,
    source_file_url TEXT NOT NULL,
    source_updated_at TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trafikverket_award_bids (
    bid_key TEXT PRIMARY KEY,
    procurement_id TEXT NOT NULL,
    tenderer_name TEXT NOT NULL,
    organization_number TEXT,
    tender_sum_sek REAL,
    contract_number TEXT,
    contract_start TEXT,
    contract_end TEXT,
    contract_value_sek REAL,
    is_winner INTEGER NOT NULL DEFAULT 0,
    is_terranor INTEGER NOT NULL DEFAULT 0,
    source_file_url TEXT NOT NULL,
    source_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (procurement_id) REFERENCES trafikverket_awards(procurement_id)
  )`,
  `CREATE TABLE IF NOT EXISTS trafikverket_plan (
    journal_id TEXT PRIMARY KEY,
    business_area TEXT,
    procurement_name TEXT NOT NULL,
    description TEXT,
    cpv_code TEXT,
    procurement_area TEXT,
    agreement_type TEXT,
    traffic_mode TEXT,
    purchase_category TEXT,
    region TEXT,
    planned_ad_start TEXT,
    planned_bid_deadline TEXT,
    planned_contract_start TEXT,
    planning_status TEXT,
    estimated_cost_text TEXT,
    estimated_cost_low_msek REAL,
    estimated_cost_high_msek REAL,
    estimated_contract_years REAL,
    contact_person TEXT,
    information TEXT,
    duplicate_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    source_file_url TEXT NOT NULL,
    source_updated_at TEXT,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trafikverket_plan_snapshots (
    snapshot_key TEXT PRIMARY KEY,
    journal_id TEXT NOT NULL,
    source_file_url TEXT NOT NULL,
    source_updated_at TEXT,
    captured_at TEXT NOT NULL,
    planning_status TEXT,
    planned_ad_start TEXT,
    planned_bid_deadline TEXT,
    planned_contract_start TEXT,
    estimated_cost_text TEXT,
    estimated_cost_low_msek REAL,
    estimated_cost_high_msek REAL,
    information TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trafikverket_runs_source_time ON trafikverket_procurement_runs(source_key, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_trafikverket_versions_source_time ON trafikverket_file_versions(source_key, imported_at)`,
  `CREATE INDEX IF NOT EXISTS idx_trafikverket_awards_category ON trafikverket_awards(purchase_category, terranor_won)`,
  `CREATE INDEX IF NOT EXISTS idx_trafikverket_bids_procurement ON trafikverket_award_bids(procurement_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trafikverket_plan_start ON trafikverket_plan(active, planned_contract_start)`,
  `CREATE INDEX IF NOT EXISTS idx_trafikverket_plan_duplicate ON trafikverket_plan(active, duplicate_key)`,
];

function normalize(value) {
  return String(value || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanText(value, max = 1000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function runBatches(db, statements, size = 70) {
  for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}

export async function ensureTrafikverketProcurementSchema(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await runBatches(db, SCHEMA.map((sql) => db.prepare(sql)), 40);
}

function xlsxLinks(html, baseUrl) {
  const found = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href || !/\.xlsx(?:$|[?#])/i.test(href)) continue;
    try {
      found.push({
        url: new URL(decodeHtml(href), baseUrl).toString(),
        text: cleanText(decodeHtml(match[2].replace(/<[^>]+>/g, " ")), 500),
      });
    } catch {}
  }
  return found;
}

function chooseWorkbookLink(sourceKey, links) {
  if (!links.length) return null;
  if (sourceKey === "plan") {
    return links.find((x) => /inkopstidsplan/i.test(x.url) || /inköpstidsplan/i.test(x.text || ""))?.url || links[0].url;
  }
  return links.find((x) => /upphandling-anbud-kontrakt/i.test(x.url))?.url
    || links.find((x) => !/totalrapport/i.test(x.text || ""))?.url
    || links[0].url;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
  });
  if (!response.ok) throw new Error(`Henting feilet (${response.status}) for ${url}`);
  return response.text();
}

async function fetchWorkbook(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream",
    },
  });
  if (!response.ok) throw new Error(`XLSX-henting feilet (${response.status}) for ${url}`);
  return response.arrayBuffer();
}

async function sha256Buffer(arrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function startRun(db, sourceKey, pageUrl, fileUrl = null) {
  return db.prepare(`INSERT INTO trafikverket_procurement_runs (
      source_key, source_page_url, source_file_url, started_at, status
    ) VALUES (?, ?, ?, ?, 'running') RETURNING id`)
    .bind(sourceKey, pageUrl, fileUrl, new Date().toISOString()).first();
}

async function finishRun(db, id, fields) {
  if (!id) return;
  await db.prepare(`UPDATE trafikverket_procurement_runs SET
      source_file_url=?, source_updated_at=?, finished_at=?, status=?, rows_seen=?, rows_matched=?, rows_written=?, error_text=?
    WHERE id=?`)
    .bind(
      fields.fileUrl || null, fields.sourceUpdatedAt || null, new Date().toISOString(), fields.status,
      Number(fields.rowsSeen || 0), Number(fields.rowsMatched || 0), Number(fields.rowsWritten || 0),
      fields.error ? String(fields.error).slice(0, 1800) : null, id,
    ).run();
}

async function updateState(db, sourceKey, pageUrl, fields) {
  await db.prepare(`INSERT INTO trafikverket_source_state (
      source_key, source_page_url, source_file_url, source_updated_at, last_checked_at, last_imported_at, status, error_text, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source_key) DO UPDATE SET
      source_page_url=excluded.source_page_url,
      source_file_url=COALESCE(excluded.source_file_url, trafikverket_source_state.source_file_url),
      source_updated_at=COALESCE(excluded.source_updated_at, trafikverket_source_state.source_updated_at),
      last_checked_at=excluded.last_checked_at,
      last_imported_at=COALESCE(excluded.last_imported_at, trafikverket_source_state.last_imported_at),
      status=excluded.status,
      error_text=excluded.error_text,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(
      sourceKey, pageUrl, fields.fileUrl || null, fields.sourceUpdatedAt || null,
      fields.lastCheckedAt || new Date().toISOString(), fields.lastImportedAt || null,
      fields.status, fields.error ? String(fields.error).slice(0, 1800) : null,
    ).run();
}

function versionKey(sourceKey, fileHash) {
  return `${sourceKey}|${fileHash}`;
}

async function alreadyImportedHash(db, sourceKey, fileHash) {
  const row = await db.prepare(`SELECT version_key FROM trafikverket_file_versions WHERE version_key=?`)
    .bind(versionKey(sourceKey, fileHash)).first();
  return Boolean(row?.version_key);
}

async function recordImportedVersion(db, sourceKey, fileUrl, fileHash, sourceUpdatedAt, importedAt) {
  await db.prepare(`INSERT OR IGNORE INTO trafikverket_file_versions (
      version_key, source_key, source_file_url, file_hash, source_updated_at, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(versionKey(sourceKey, fileHash), sourceKey, fileUrl, fileHash, sourceUpdatedAt, importedAt).run();
}

function versionedFileUrl(fileUrl, fileHash) {
  return `${fileUrl}#tt=${fileHash.slice(0, 16)}`;
}

function bidKey(procurementId, bid) {
  return [procurementId, bid.organization_number || "", normalize(bid.tenderer_name), bid.tender_sum_sek ?? ""]
    .join("|").slice(0, 800);
}

async function saveAwards(db, parsed, fileUrl) {
  const statements = [];
  for (const award of parsed.awards) {
    const rawJson = JSON.stringify({ procurement_id: award.procurement_id, bids: award.bids }).slice(0, 12000);
    statements.push(db.prepare(`INSERT INTO trafikverket_awards (
        procurement_id, purchaser_org, region, purchase_category, procurement_type, procurement_name,
        terranor_bid_sek, terranor_won, winner_name, winner_orgno, winner_tender_sek,
        contract_number, contract_start, contract_end, contract_value_sek, contract_value_includes_option,
        source_file_url, source_updated_at, last_seen_at, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(procurement_id) DO UPDATE SET
        purchaser_org=excluded.purchaser_org, region=excluded.region, purchase_category=excluded.purchase_category,
        procurement_type=excluded.procurement_type, procurement_name=excluded.procurement_name,
        terranor_bid_sek=excluded.terranor_bid_sek, terranor_won=excluded.terranor_won,
        winner_name=excluded.winner_name, winner_orgno=excluded.winner_orgno, winner_tender_sek=excluded.winner_tender_sek,
        contract_number=excluded.contract_number, contract_start=excluded.contract_start, contract_end=excluded.contract_end,
        contract_value_sek=excluded.contract_value_sek, contract_value_includes_option=1,
        source_file_url=excluded.source_file_url, source_updated_at=excluded.source_updated_at,
        last_seen_at=CURRENT_TIMESTAMP, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`)
      .bind(
        award.procurement_id, award.purchaser_org, award.region, award.purchase_category, award.procurement_type,
        award.procurement_name, award.terranor_bid_sek, award.terranor_won ? 1 : 0,
        award.winner_name, award.winner_orgno, award.winner_tender_sek, award.contract_number,
        award.contract_start, award.contract_end, award.contract_value_sek, fileUrl, parsed.sourceUpdatedAt, rawJson,
      ));

    statements.push(db.prepare(`DELETE FROM trafikverket_award_bids WHERE procurement_id=?`).bind(award.procurement_id));
    for (const bid of award.bids) {
      statements.push(db.prepare(`INSERT INTO trafikverket_award_bids (
          bid_key, procurement_id, tenderer_name, organization_number, tender_sum_sek, contract_number,
          contract_start, contract_end, contract_value_sek, is_winner, is_terranor, source_file_url, source_updated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(bid_key) DO UPDATE SET
          tenderer_name=excluded.tenderer_name, organization_number=excluded.organization_number,
          tender_sum_sek=excluded.tender_sum_sek, contract_number=excluded.contract_number,
          contract_start=excluded.contract_start, contract_end=excluded.contract_end,
          contract_value_sek=excluded.contract_value_sek, is_winner=excluded.is_winner, is_terranor=excluded.is_terranor,
          source_file_url=excluded.source_file_url, source_updated_at=excluded.source_updated_at, updated_at=CURRENT_TIMESTAMP`)
        .bind(
          bidKey(award.procurement_id, bid), award.procurement_id, bid.tenderer_name, bid.organization_number,
          bid.tender_sum_sek, bid.contract_number, bid.contract_start, bid.contract_end, bid.contract_value_sek,
          bid.contract_number ? 1 : 0, /\bterranor\b/i.test(bid.tenderer_name) ? 1 : 0,
          fileUrl, parsed.sourceUpdatedAt,
        ));
    }
  }
  await runBatches(db, statements);
  return parsed.awards.length;
}

async function savePlan(db, parsed, fileUrl) {
  const now = new Date().toISOString();
  const statements = [];
  for (const item of parsed.plan) {
    const rawJson = JSON.stringify(item).slice(0, 8000);
    statements.push(db.prepare(`INSERT INTO trafikverket_plan (
        journal_id, business_area, procurement_name, description, cpv_code, procurement_area, agreement_type,
        traffic_mode, purchase_category, region, planned_ad_start, planned_bid_deadline, planned_contract_start,
        planning_status, estimated_cost_text, estimated_cost_low_msek, estimated_cost_high_msek,
        estimated_contract_years, contact_person, information, duplicate_key, active,
        source_file_url, source_updated_at, last_seen_at, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(journal_id) DO UPDATE SET
        business_area=excluded.business_area, procurement_name=excluded.procurement_name, description=excluded.description,
        cpv_code=excluded.cpv_code, procurement_area=excluded.procurement_area, agreement_type=excluded.agreement_type,
        traffic_mode=excluded.traffic_mode, purchase_category=excluded.purchase_category, region=excluded.region,
        planned_ad_start=excluded.planned_ad_start, planned_bid_deadline=excluded.planned_bid_deadline,
        planned_contract_start=excluded.planned_contract_start, planning_status=excluded.planning_status,
        estimated_cost_text=excluded.estimated_cost_text, estimated_cost_low_msek=excluded.estimated_cost_low_msek,
        estimated_cost_high_msek=excluded.estimated_cost_high_msek, estimated_contract_years=excluded.estimated_contract_years,
        contact_person=excluded.contact_person, information=excluded.information, duplicate_key=excluded.duplicate_key,
        active=1, source_file_url=excluded.source_file_url, source_updated_at=excluded.source_updated_at,
        last_seen_at=CURRENT_TIMESTAMP, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`)
      .bind(
        item.journal_id, item.business_area, item.procurement_name, item.description, item.cpv_code,
        item.procurement_area, item.agreement_type, item.traffic_mode, item.purchase_category, item.region,
        item.planned_ad_start, item.planned_bid_deadline, item.planned_contract_start, item.planning_status,
        item.estimated_cost_text, item.estimated_cost_low_msek, item.estimated_cost_high_msek,
        item.estimated_contract_years, item.contact_person, item.information, item.duplicate_key,
        fileUrl, parsed.sourceUpdatedAt, rawJson,
      ));

    const snapshotKey = `${item.journal_id}|${fileUrl}`.slice(0, 900);
    statements.push(db.prepare(`INSERT OR IGNORE INTO trafikverket_plan_snapshots (
        snapshot_key, journal_id, source_file_url, source_updated_at, captured_at, planning_status,
        planned_ad_start, planned_bid_deadline, planned_contract_start, estimated_cost_text,
        estimated_cost_low_msek, estimated_cost_high_msek, information, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        snapshotKey, item.journal_id, fileUrl, parsed.sourceUpdatedAt, now, item.planning_status,
        item.planned_ad_start, item.planned_bid_deadline, item.planned_contract_start, item.estimated_cost_text,
        item.estimated_cost_low_msek, item.estimated_cost_high_msek, item.information, rawJson,
      ));
  }

  // Write the complete new version first. Only after every upsert succeeds do we deactivate
  // rows that were not present in this workbook version. A mid-import failure therefore
  // leaves the previous complete plan active instead of clearing it first.
  await runBatches(db, statements);
  await db.prepare(`UPDATE trafikverket_plan SET active=0, updated_at=CURRENT_TIMESTAMP
      WHERE active=1 AND source_file_url<>?`).bind(fileUrl).run();
  return parsed.plan.length;
}

async function runSource(db, sourceKey, pageUrl, parser, saver, force) {
  const startedAt = new Date().toISOString();
  const run = await startRun(db, sourceKey, pageUrl, null);
  let fileUrl = null;

  try {
    const pageHtml = await fetchText(pageUrl);
    fileUrl = chooseWorkbookLink(sourceKey, xlsxLinks(pageHtml, pageUrl));
    if (!fileUrl) throw new Error(`Fant ingen XLSX-lenke for Trafikverket-kilden ${sourceKey}`);

    // Download the workbook before deciding whether it changed. Hashing the bytes detects
    // silent replacements behind an unchanged Trafikverket URL.
    const workbook = await fetchWorkbook(fileUrl);
    const fileHash = await sha256Buffer(workbook);
    if (!force && await alreadyImportedHash(db, sourceKey, fileHash)) {
      const checked = new Date().toISOString();
      await finishRun(db, run?.id, { fileUrl, status: "unchanged" });
      await updateState(db, sourceKey, pageUrl, { fileUrl, lastCheckedAt: checked, status: "unchanged" });
      return { ok: true, sourceKey, status: "unchanged", startedAt, finishedAt: checked, fileUrl, fileHash, rowsSeen: 0, rowsMatched: 0, rowsWritten: 0 };
    }

    const parsed = await parser(workbook);
    const rowsMatched = sourceKey === "awards" ? parsed.awards.length : parsed.plan.length;
    const storedFileUrl = versionedFileUrl(fileUrl, fileHash);
    const rowsWritten = await saver(db, parsed, storedFileUrl);
    const finishedAt = new Date().toISOString();
    await recordImportedVersion(db, sourceKey, fileUrl, fileHash, parsed.sourceUpdatedAt, finishedAt);
    await finishRun(db, run?.id, {
      fileUrl, sourceUpdatedAt: parsed.sourceUpdatedAt, status: "ok",
      rowsSeen: parsed.rowsSeen, rowsMatched, rowsWritten,
    });
    await updateState(db, sourceKey, pageUrl, {
      fileUrl, sourceUpdatedAt: parsed.sourceUpdatedAt, lastCheckedAt: finishedAt,
      lastImportedAt: finishedAt, status: "ok",
    });
    return {
      ok: true, sourceKey, status: "ok", startedAt, finishedAt, fileUrl, fileHash,
      sourceUpdatedAt: parsed.sourceUpdatedAt, rowsSeen: parsed.rowsSeen, rowsMatched, rowsWritten,
    };
  } catch (error) {
    const message = String(error?.message || error);
    await finishRun(db, run?.id, { fileUrl, status: "error", error: message });
    await updateState(db, sourceKey, pageUrl, {
      fileUrl, lastCheckedAt: new Date().toISOString(), status: "error", error: message,
    });
    throw error;
  }
}

export async function runTrafikverketProcurementMonitor(db, options = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureTrafikverketProcurementSchema(db);
  const force = Boolean(options.force);
  const results = {};
  const errors = [];

  const sources = [
    { key: "awards", page: AWARDS_PAGE_URL, parser: parseAwardWorkbook, saver: saveAwards },
    { key: "plan", page: PLAN_PAGE_URL, parser: parsePlanWorkbook, saver: savePlan },
  ];
  for (const source of sources) {
    try {
      results[source.key] = await runSource(db, source.key, source.page, source.parser, source.saver, force);
    } catch (error) {
      const message = String(error?.message || error);
      results[source.key] = { ok: false, sourceKey: source.key, status: "error", error: message };
      errors.push(`${source.key}: ${message}`);
    }
  }

  return {
    ok: errors.length === 0,
    phase: "B",
    source: "Trafikverket",
    generatedAt: new Date().toISOString(),
    results,
    errors,
    note: "Trafikverket-filene identifiseres med innholdshash, slik at endringer oppdages selv om filadressen er uendret. Kontraktsverdier fra tildelingsfilen er inklusive opsjoner og holdes adskilt fra Terranors kommuniserte basisverdi.",
  };
}

function pct(a, b) {
  return b ? Math.round((a / b) * 1000) / 10 : null;
}

function dedupePlan(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = row.duplicate_key || row.journal_id;
    const current = map.get(key);
    if (!current || String(row.journal_id).localeCompare(String(current.journal_id)) < 0) map.set(key, row);
  }
  return [...map.values()];
}

export async function getTrafikverketProcurementStatus(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureTrafikverketProcurementSchema(db);
  const [states, latestRuns, awardsResult, planResult] = await Promise.all([
    db.prepare(`SELECT * FROM trafikverket_source_state ORDER BY source_key`).all(),
    db.prepare(`SELECT r.* FROM trafikverket_procurement_runs r
      JOIN (SELECT source_key, MAX(id) AS id FROM trafikverket_procurement_runs GROUP BY source_key) x ON x.id=r.id
      ORDER BY r.source_key`).all(),
    db.prepare(`SELECT * FROM trafikverket_awards ORDER BY procurement_id`).all(),
    db.prepare(`SELECT * FROM trafikverket_plan WHERE active=1 ORDER BY planned_contract_start, planned_ad_start, journal_id`).all(),
  ]);

  const awards = awardsResult?.results || [];
  const planRows = planResult?.results || [];
  const uniquePlan = dedupePlan(planRows);
  const wins = awards.filter((row) => Number(row.terranor_won) === 1);
  const baseBids = awards.filter((row) => normalize(row.purchase_category).includes("basunderhall vag"));
  const baseWins = baseBids.filter((row) => Number(row.terranor_won) === 1);
  const duplicateCounts = new Map();
  for (const row of planRows) duplicateCounts.set(row.duplicate_key, (duplicateCounts.get(row.duplicate_key) || 0) + 1);

  const byYear = {};
  for (const row of uniquePlan) {
    const year = row.planned_contract_start?.slice(0, 4) || "ukjent";
    if (!byYear[year]) byYear[year] = { count: 0, low_msek: 0, high_msek: 0 };
    byYear[year].count += 1;
    byYear[year].low_msek += Number(row.estimated_cost_low_msek || 0);
    byYear[year].high_msek += Number(row.estimated_cost_high_msek || 0);
  }
  for (const value of Object.values(byYear)) {
    value.low_msek = Math.round(value.low_msek * 10) / 10;
    value.high_msek = Math.round(value.high_msek * 10) / 10;
  }

  return {
    ok: true,
    phase: "B",
    generatedAt: new Date().toISOString(),
    sources: states?.results || [],
    latestRuns: latestRuns?.results || [],
    awards: {
      terranorParticipations: awards.length,
      terranorWins: wins.length,
      winRatePct: pct(wins.length, awards.length),
      baseRoadParticipations: baseBids.length,
      baseRoadWins: baseWins.length,
      baseRoadWinRatePct: pct(baseWins.length, baseBids.length),
      wonContractValueInclOptionsMsek: Math.round(wins.reduce((sum, row) => sum + Number(row.contract_value_sek || 0), 0) / 100000) / 10,
    },
    pipeline: {
      rows: planRows.length,
      uniqueRows: uniquePlan.length,
      duplicateGroups: [...duplicateCounts.values()].filter((count) => count > 1).length,
      byContractStartYear: byYear,
    },
    limitations: [
      "Tildelingsrapporten omfatter objektspesifikke anskaffelser og er ikke en fullstendig oversikt over alle anskaffelsesformer.",
      "Kontraktsverdien i tildelingsfilen er inklusive opsjon og kan være høyere enn Terranors kommuniserte basisverdi.",
      "Planlagte anskaffelser er foreløpige. Rå JournalID-rader beholdes, mens aggregater bruker et forsiktig duplikatfilter.",
    ],
  };
}

export async function listTrafikverketAwards(db, { limit = 200 } = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureTrafikverketProcurementSchema(db);
  const max = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200));
  const result = await db.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM trafikverket_award_bids b WHERE b.procurement_id=a.procurement_id) AS bidder_count
    FROM trafikverket_awards a
    ORDER BY COALESCE(a.contract_start,'9999-12-31') DESC, a.procurement_id DESC LIMIT ?`)
    .bind(max).all();
  return { awards: result?.results || [] };
}

export async function listTrafikverketPlan(db, { limit = 250, active = true } = {}) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  await ensureTrafikverketProcurementSchema(db);
  const max = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 250));
  const result = await db.prepare(`SELECT * FROM trafikverket_plan ${active ? "WHERE active=1" : ""}
    ORDER BY COALESCE(planned_contract_start,'9999-12-31'), COALESCE(planned_ad_start,'9999-12-31'), journal_id LIMIT ?`)
    .bind(max).all();
  return { plan: result?.results || [] };
}

export const TRAFIKVERKET_PROCUREMENT_SOURCES = {
  awards: AWARDS_PAGE_URL,
  plan: PLAN_PAGE_URL,
};
