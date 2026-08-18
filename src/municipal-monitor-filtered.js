import {
  getMunicipalStatus as getBaseMunicipalStatus,
  MUNICIPAL_SOURCES,
  runMunicipalMonitor as runBaseMunicipalMonitor,
} from "./municipal-monitor.js";

const SOURCE_KEYS = MUNICIPAL_SOURCES.map((source) => source.key);

const GENERIC_TITLES = /^(se och göra|beslut,? dokument,? taxor och avgifter|kommun och politik|norrköping tar plats|anslagstavla|kontakta kommunen|utforska mer|startsida|hem|meny|sök|kontakt)$/i;
const STRONG_TITLE_TERMS = /terranor|upphandling|tilldel|avrop|option|förläng|forlang|tillägg|tillagg|extraarbete|beställ|bestall|drift|underhåll|underhall|vinterväghåll|vintervaghall|snöröj|snoroj|sopning|kontrakt|avtal|entreprenad|delegationsbeslut/i;

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isObviousNoise(row) {
  const title = normalize(row?.title);
  const excerpt = normalize(row?.excerpt);
  if (!title) return true;
  if (GENERIC_TITLES.test(title)) return true;
  if (/\bTerranor\b/i.test(`${title} ${excerpt}`)) return false;

  const relevance = Number(row?.relevance_score || 0);
  const type = String(row?.signal_type || "");
  if ((type === "kommunal_beslutning" || type === "annen_aktivitet") && relevance <= 65) {
    return !STRONG_TITLE_TERMS.test(title);
  }
  return false;
}

async function cleanMunicipalCandidates(db) {
  if (!db || !SOURCE_KEYS.length) return { ignored: 0, unlinked: 0 };
  const placeholders = SOURCE_KEYS.map(() => "?").join(",");
  const result = await db.prepare(`SELECT id, title, excerpt, signal_type, relevance_score, review_status, contract_id
      FROM activity_candidates
      WHERE source_key IN (${placeholders}) AND review_status='ny'
      ORDER BY id DESC LIMIT 250`)
    .bind(...SOURCE_KEYS).all();

  let ignored = 0;
  let unlinked = 0;
  for (const row of result?.results || []) {
    if (isObviousNoise(row)) {
      await db.prepare(`UPDATE activity_candidates
          SET review_status='ignorert', contract_id=NULL, updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).bind(row.id).run();
      ignored += 1;
      continue;
    }

    if (row.contract_id && row.signal_type === "kommunal_beslutning") {
      const text = `${normalize(row.title)} ${normalize(row.excerpt)}`;
      if (!/\bTerranor\b/i.test(text) && !STRONG_TITLE_TERMS.test(normalize(row.title))) {
        await db.prepare(`UPDATE activity_candidates SET contract_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(row.id).run();
        unlinked += 1;
      }
    }
  }
  return { ignored, unlinked };
}

export async function runMunicipalMonitor(db, options = {}) {
  const result = await runBaseMunicipalMonitor(db, options);
  const cleanup = await cleanMunicipalCandidates(db);
  return {
    ...result,
    candidatesWrittenRaw: Number(result?.candidatesWritten || 0),
    candidatesWritten: Math.max(0, Number(result?.candidatesWritten || 0) - cleanup.ignored),
    cleanup,
  };
}

export async function getMunicipalStatus(db) {
  await cleanMunicipalCandidates(db);
  const status = await getBaseMunicipalStatus(db);
  const recentCandidates = (status?.recentCandidates || []).filter((row) => row.review_status === "ny" && !isObviousNoise(row));
  return {
    ...status,
    recentCandidates,
    visibleNewCandidates: recentCandidates.length,
    filtering: "Viser bare nye, kontraktsnære kommunale funn; generelle navigasjons- og informasjonssider ignoreres automatisk.",
  };
}
