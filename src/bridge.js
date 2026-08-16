const Q3_START = Date.UTC(2026, 6, 1, 0, 0, 0);
const Q3_END = Date.UTC(2026, 8, 30, 23, 59, 59);
const Q3_DAYS = 92;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function overlapDays(startText, endText) {
  const start = startText ? Date.parse(`${startText}T00:00:00Z`) : Q3_START;
  const end = endText ? Date.parse(`${endText}T23:59:59Z`) : Q3_END;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const a = Math.max(start, Q3_START);
  const b = Math.min(end, Q3_END);
  if (b < a) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

function classify(contract) {
  const type = String(contract.contract_type || "").toLowerCase();
  const start = contract.start_date ? Date.parse(`${contract.start_date}T00:00:00Z`) : null;
  const renewal = type.includes("renewal");
  if (Number.isFinite(start) && start >= Q3_START && start <= Q3_END) return renewal ? "q3_renewal_start" : "q3_new_start";
  if (renewal) return "carryover_renewal";
  return "carryover";
}

export async function getContractBridge(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  const result = await db.prepare(`SELECT id, country, name, customer, contract_type, start_date, end_date,
      total_value_msek, annual_run_rate_msek, confidence
    FROM contracts
    WHERE (start_date IS NULL OR start_date <= '2026-09-30')
      AND (end_date IS NULL OR end_date >= '2026-07-01')
    ORDER BY country, start_date, name`).all();

  const rows = (result?.results || []).map((contract) => {
    const annual = num(contract.annual_run_rate_msek);
    const days = overlapDays(contract.start_date, contract.end_date);
    const grossQ3 = annual !== null && annual > 0 ? annual * days / 365.25 : null;
    return {
      contract_id: Number(contract.id),
      country: contract.country,
      contract_name: contract.name,
      customer: contract.customer,
      contract_type: contract.contract_type,
      start_date: contract.start_date,
      end_date: contract.end_date,
      category: classify(contract),
      active_days_q3: days,
      active_share_q3: round(days / Q3_DAYS, 3),
      annual_run_rate_msek: annual,
      gross_q3_run_rate_msek: round(grossQ3, 2),
      confidence: contract.confidence,
    };
  });

  const known = rows.filter((r) => Number.isFinite(r.gross_q3_run_rate_msek));
  const byCountry = {};
  const byCategory = {};
  for (const row of known) {
    byCountry[row.country] = round((byCountry[row.country] || 0) + row.gross_q3_run_rate_msek, 2);
    byCategory[row.category] = round((byCategory[row.category] || 0) + row.gross_q3_run_rate_msek, 2);
  }

  const startsInQ3 = rows.filter((r) => r.category === "q3_new_start" || r.category === "q3_renewal_start");
  const q3StartGross = startsInQ3
    .filter((r) => Number.isFinite(r.gross_q3_run_rate_msek))
    .reduce((sum, r) => sum + r.gross_q3_run_rate_msek, 0);

  return {
    quarter: "Q3 2026",
    methodology: "annual run-rate prorated by active calendar days in Q3",
    warning: "Gross contract run-rate bridge only. It is not a net YoY revenue uplift: renewals can replace existing revenue, contract seasonality is not linear, and extra works are excluded.",
    summary: {
      active_contracts: rows.length,
      contracts_with_known_run_rate: known.length,
      contracts_with_unknown_run_rate: rows.length - known.length,
      gross_known_q3_run_rate_msek: round(known.reduce((sum, r) => sum + r.gross_q3_run_rate_msek, 0), 2),
      gross_q3_contribution_from_q3_starts_msek: round(q3StartGross, 2),
      by_country_msek: byCountry,
      by_category_msek: byCategory,
    },
    contracts: rows,
  };
}
