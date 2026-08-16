export async function ensureSignalIndexes(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_type_time ON signals(signal_type, observed_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_contract_time ON signals(contract_id, observed_at)`),
  ]);
}

function cleanText(value, max = 1000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function listSignals(db, { limit = 100, type = null } = {}) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureSignalIndexes(db);
  const max = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 100));
  let sql = `SELECT s.id, s.observed_at, s.country, s.contract_id, c.name AS contract_name,
      s.signal_type, s.title, s.value, s.unit, s.score, s.confidence, s.source_url, s.notes, s.created_at
    FROM signals s LEFT JOIN contracts c ON c.id=s.contract_id`;
  const binds = [];
  if (type) {
    sql += ` WHERE s.signal_type=?`;
    binds.push(String(type));
  }
  sql += ` ORDER BY datetime(s.observed_at) DESC, s.id DESC LIMIT ?`;
  binds.push(max);
  const result = await db.prepare(sql).bind(...binds).all();
  return { signals: result?.results || [] };
}

export async function addSignal(db, input = {}) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureSignalIndexes(db);

  const observedAt = cleanText(input.observed_at, 64) || new Date().toISOString();
  const signalType = cleanText(input.signal_type, 80);
  const title = cleanText(input.title, 300);
  if (!signalType || !title) throw new Error("signal_type and title are required");

  const country = cleanText(input.country, 80);
  const contractId = input.contract_id === null || input.contract_id === undefined || input.contract_id === ""
    ? null : Number.parseInt(input.contract_id, 10);
  const value = cleanNumber(input.value);
  const unit = cleanText(input.unit, 40);
  const score = cleanNumber(input.score);
  const confidence = cleanNumber(input.confidence);
  const sourceUrl = cleanText(input.source_url, 1200);
  const notes = cleanText(input.notes, 3000);

  if (contractId !== null && !Number.isFinite(contractId)) throw new Error("contract_id must be numeric");
  if (confidence !== null && (confidence < 0 || confidence > 100)) throw new Error("confidence must be 0-100");

  const row = await db.prepare(`INSERT INTO signals (
      observed_at, country, contract_id, signal_type, title, value, unit, score, confidence, source_url, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, observed_at, country, contract_id, signal_type, title, value, unit, score, confidence, source_url, notes, created_at`)
    .bind(observedAt, country, contractId, signalType, title, value, unit, score, confidence, sourceUrl, notes).first();
  return { ok: true, signal: row };
}

export async function getSignalSummary(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureSignalIndexes(db);
  const [total, recent, types] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM signals`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM signals WHERE datetime(observed_at)>=datetime('now','-30 days')`).first(),
    db.prepare(`SELECT signal_type, COUNT(*) AS count, ROUND(AVG(score),1) AS avg_score,
      ROUND(AVG(confidence),1) AS avg_confidence
      FROM signals GROUP BY signal_type ORDER BY count DESC`).all(),
  ]);
  return {
    total: Number(total?.count || 0),
    last_30_days: Number(recent?.count || 0),
    by_type: types?.results || [],
    note: "Signal tracker stores sourced observations such as extra works, budget changes, options and public maintenance activity. It does not infer revenue unless a later model explicitly does so.",
  };
}
