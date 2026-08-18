const PHASE_C_CONTRACTS = [
  {
    country: "Denmark",
    name: "Tønder",
    customer: "Tønder Municipality",
    contractType: "Municipal O&M",
    startDate: "2026-04-01",
    endDate: "2030-03-31",
    totalValue: 270.0,
    annualRunRate: 67.5,
    sourceUrl: null,
    confidence: "high-project-source",
  },
  {
    country: "Finland",
    name: "Road drainage South-East Finland",
    customer: null,
    contractType: "Drainage",
    startDate: "2026-05-01",
    endDate: "2027-11-30",
    totalValue: 14.0,
    annualRunRate: null,
    sourceUrl: null,
    confidence: "medium-project-source",
  },
  {
    country: "Finland",
    name: "Järvenpää",
    customer: "Järvenpää city",
    contractType: "Municipal road O&M incl. winter",
    startDate: "2026-10-01",
    endDate: "2030-09-30",
    totalValue: 116.0,
    annualRunRate: 29.0,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-jarvenpaa-finland-vart-116-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Finland",
    name: "Kemi",
    customer: null,
    contractType: "State road O&M",
    startDate: "2026-10-01",
    endDate: "2031-10-01",
    totalValue: 195.0,
    annualRunRate: 39.0,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-kemi-vart-195-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Finland",
    name: "Ii",
    customer: null,
    contractType: "State road O&M",
    startDate: "2026-10-01",
    endDate: "2031-10-01",
    totalValue: 83.0,
    annualRunRate: 16.6,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-ii-finland-vart-83-miljoner-kronor/",
    confidence: "high",
  },
];

export async function ensureNordicContracts(db) {
  if (!db) throw new Error("D1-bindingen DB mangler");
  const statements = PHASE_C_CONTRACTS.map((item) => db.prepare(`INSERT INTO contracts (
      country, name, customer, contract_type, start_date, end_date,
      total_value_msek, annual_run_rate_msek, source_url, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(country, name, start_date) DO UPDATE SET
      customer=COALESCE(excluded.customer, contracts.customer),
      contract_type=COALESCE(excluded.contract_type, contracts.contract_type),
      end_date=COALESCE(excluded.end_date, contracts.end_date),
      total_value_msek=COALESCE(excluded.total_value_msek, contracts.total_value_msek),
      annual_run_rate_msek=COALESCE(excluded.annual_run_rate_msek, contracts.annual_run_rate_msek),
      source_url=COALESCE(excluded.source_url, contracts.source_url),
      confidence=COALESCE(excluded.confidence, contracts.confidence),
      updated_at=CURRENT_TIMESTAMP`)
    .bind(item.country, item.name, item.customer, item.contractType, item.startDate, item.endDate,
      item.totalValue, item.annualRunRate, item.sourceUrl, item.confidence));
  if (statements.length) await db.batch(statements);
  return PHASE_C_CONTRACTS.length;
}
