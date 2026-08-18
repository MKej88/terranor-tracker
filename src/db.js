const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL,
    name TEXT NOT NULL,
    customer TEXT,
    contract_type TEXT,
    start_date TEXT,
    end_date TEXT,
    total_value_msek REAL,
    annual_run_rate_msek REAL,
    latitude REAL,
    longitude REAL,
    source_url TEXT,
    confidence TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS weather_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER,
    source TEXT NOT NULL,
    station_id TEXT,
    observed_at TEXT NOT NULL,
    air_temp_c REAL,
    road_temp_c REAL,
    precipitation_mm REAL,
    precipitation_type TEXT,
    wind_ms REAL,
    humidity_pct REAL,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, station_id, observed_at),
    FOREIGN KEY (contract_id) REFERENCES contracts(id)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL,
    country TEXT,
    contract_id INTEGER,
    signal_type TEXT NOT NULL,
    title TEXT NOT NULL,
    value REAL,
    unit TEXT,
    score REAL,
    confidence REAL,
    source_url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contract_id) REFERENCES contracts(id)
  )`,
  `CREATE TABLE IF NOT EXISTS forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quarter TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'live',
    revenue_low_msek REAL,
    revenue_base_msek REAL,
    revenue_high_msek REAL,
    revenue_consensus_msek REAL,
    ebita_low_msek REAL,
    ebita_base_msek REAL,
    ebita_high_msek REAL,
    ebita_consensus_msek REAL,
    confidence REAL,
    model_version TEXT,
    driver_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_unique ON contracts(country, name, start_date)`,
  `CREATE INDEX IF NOT EXISTS idx_contract_start_date ON contracts(start_date)`,
  `CREATE INDEX IF NOT EXISTS idx_weather_observed_at ON weather_observations(observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_weather_contract ON weather_observations(contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_observed_at ON signals(observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_forecasts_quarter_time ON forecasts(quarter, generated_at)`,
];

const CONTRACT_SEEDS = [
  {
    country: "Sweden",
    name: "Skellefteå Norra",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2025-09-01",
    endDate: "2029-08-31",
    totalValue: 215.0,
    annualRunRate: 53.75,
    sourceUrl: "https://terranor.se/terranor-vinner-stort-uppdrag-i-norrland/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Umeå Södra",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2025-09-01",
    endDate: "2029-08-31",
    totalValue: null,
    annualRunRate: null,
    sourceUrl: "https://terranor.se/terranor-vinner-umea-sodra-och-starker-sin-narvaro-i-norra-sverige/",
    confidence: "high-dates-value-pending",
  },
  {
    country: "Sweden",
    name: "Kungsbacka",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2025-09-01",
    endDate: "2029-08-31",
    totalValue: null,
    annualRunRate: null,
    sourceUrl: "https://terranor.se/terranor-atertar-ansvaret-for-driftomrade-kungsbacka-starker-sin-etablering-i-goteborgsregionen/",
    confidence: "high-dates-value-pending",
  },
  {
    country: "Sweden",
    name: "Kungälv",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2025-09-01",
    endDate: "2029-08-31",
    totalValue: null,
    annualRunRate: null,
    sourceUrl: "https://terranor.se/terranor-vinner-trafikverkets-kontrakt-bas-vag-kungalv/",
    confidence: "high-dates-value-pending",
  },
  {
    country: "Sweden",
    name: "Södra Skaraborg",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2025-09-01",
    endDate: null,
    totalValue: null,
    annualRunRate: null,
    sourceUrl: "https://terranor.se/terranor-starker-sin-etablering-i-skaraborg-vinner-driftomrade-sodra-skaraborg/",
    confidence: "high-start-value-pending",
  },
  {
    country: "Sweden",
    name: "Mjölby",
    customer: "Trafikverket",
    contractType: "State road O&M renewal",
    startDate: "2025-09-01",
    endDate: null,
    totalValue: null,
    annualRunRate: null,
    sourceUrl: "https://terranor.se/terranor-forsvarar-kontraktet-bas-vag-driftomrade-mjolby/",
    confidence: "high-renewal-value-pending",
  },
  {
    country: "Sweden",
    name: "Norrköping område 3",
    customer: "Norrköpings kommun",
    contractType: "Municipal O&M",
    startDate: "2025-10-01",
    endDate: "2028-09-30",
    totalValue: 90.0,
    annualRunRate: 30.0,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhall-for-omrade-3-i-norrkopings-kommun/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Stockholm road maintenance",
    customer: "Trafikverket",
    contractType: "Road maintenance / traffic flow",
    startDate: "2026-03-01",
    endDate: "2028-02-28",
    totalValue: 33.4,
    annualRunRate: 16.7,
    sourceUrl: "https://terranor.se/terranor-vinner-kontrakt-for-vagunderhall-och-forbattrande-av-trafikfloden-i-stockholm-vart-33-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Helsingborg – Byar Söder & Centrum Norr",
    customer: "Helsingborgs stad",
    contractType: "Municipal O&M",
    startDate: "2026-05-01",
    endDate: "2029-04-30",
    totalValue: 104.6,
    annualRunRate: 34.8,
    sourceUrl: "https://terranor.se/terranor-vinner-tva-kommunala-kontrakt-i-helsingborg-varda-105-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Falun område A",
    customer: "Falu kommun",
    contractType: "Municipal outdoor O&M",
    startDate: "2026-06-01",
    endDate: "2028-05-31",
    totalValue: 37.4,
    annualRunRate: 18.7,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-falu-kommun-vart-37-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Denmark",
    name: "Ikast-Brande",
    customer: "Ikast-Brande Municipality",
    contractType: "Municipal road O&M incl. winter",
    startDate: "2026-07-01",
    endDate: "2032-03-31",
    totalValue: 206.0,
    annualRunRate: 41.2,
    sourceUrl: "https://en.terranorgroup.com/pressreleases/terranor-wins-operation-and-maintenance-contract-in-ikast-brande-worth-sek-206-million/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Skellefteå Södra",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2026-09-01",
    endDate: "2030-08-31",
    totalValue: 224.0,
    annualRunRate: 56.0,
    sourceUrl: "https://en.terranorgroup.com/pressreleases/terranor-wins-operations-and-maintenance-contract-from-trafikverket-regarding-skelleftea-sodra-worth-sek-224-million/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Malmö",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2026-09-01",
    endDate: "2030-08-31",
    totalValue: 227.0,
    annualRunRate: 56.75,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-malmo-vart-227-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Vännäs",
    customer: "Trafikverket",
    contractType: "State road O&M renewal",
    startDate: "2026-09-01",
    endDate: "2030-08-31",
    totalValue: 167.0,
    annualRunRate: 41.75,
    sourceUrl: "https://en.terranorgroup.com/pressreleases/terranor-wins-operation-and-maintenance-contract-in-vannas-worth-sek-167-million/",
    confidence: "high-renewal",
  },
  {
    country: "Sweden",
    name: "Väsby",
    customer: "Trafikverket",
    contractType: "State road O&M renewal",
    startDate: "2026-09-01",
    endDate: "2030-08-31",
    totalValue: 272.0,
    annualRunRate: 68.0,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-vasby-vart-272-miljoner-kronor/",
    confidence: "high-renewal",
  },
  {
    country: "Sweden",
    name: "Sydöstra Värmland",
    customer: "Trafikverket",
    contractType: "State road O&M",
    startDate: "2026-09-01",
    endDate: "2030-08-31",
    totalValue: 214.0,
    annualRunRate: 53.5,
    sourceUrl: "https://terranor.se/terranor-vinner-drift-och-underhallskontrakt-i-sydostra-varmland-vart-214-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Falun område Norr",
    customer: "Falu kommun",
    contractType: "Municipal outdoor O&M",
    startDate: "2026-09-01",
    endDate: "2028-08-31",
    totalValue: 35.8,
    annualRunRate: 17.9,
    sourceUrl: "https://terranor.se/terranor-vinner-ytterligare-ett-drift-och-underhallskontrakt-i-falu-kommun-vart-36-miljoner-kronor/",
    confidence: "high",
  },
  {
    country: "Sweden",
    name: "Borås municipality urban O&M",
    customer: "Borås municipality",
    contractType: "Municipal O&M",
    startDate: "2026-09-01",
    endDate: "2030-08-31",
    totalValue: 44.0,
    annualRunRate: 11.0,
    sourceUrl: "https://en.terranorgroup.com/pressreleases/terranor-wins-an-operation-and-maintenance-contract-in-boras-municipality-worth-sek-44-million/",
    confidence: "high",
  },
  {
    country: "Denmark",
    name: "Copenhagen sweeping",
    customer: "Copenhagen Municipality",
    contractType: "Municipal sweeping & cleaning",
    startDate: "2027-01-01",
    endDate: "2030-12-31",
    totalValue: 114.8,
    annualRunRate: 28.7,
    sourceUrl: "https://en.terranorgroup.com/pressreleases/terranor-wins-sek-115-million-sweeping-contract-for-copenhagen-municipality/",
    confidence: "high-future",
  },
];

export async function ensureSchema(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

export async function seedContracts(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureSchema(db);

  const statements = CONTRACT_SEEDS.map((item) =>
    db.prepare(`INSERT INTO contracts (
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
      .bind(
        item.country,
        item.name,
        item.customer,
        item.contractType,
        item.startDate,
        item.endDate,
        item.totalValue,
        item.annualRunRate,
        item.sourceUrl,
        item.confidence,
      ),
  );

  await db.batch(statements);
  return listContracts(db);
}

export async function listContracts(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await ensureSchema(db);
  const result = await db
    .prepare(`SELECT id, country, name, customer, contract_type, start_date, end_date,
      total_value_msek, annual_run_rate_msek, latitude, longitude, source_url, confidence
      FROM contracts
      ORDER BY start_date, country, name`)
    .all();
  return result?.results || [];
}

export async function getDbStatus(db) {
  if (!db) return { configured: false };
  await ensureSchema(db);

  const [contracts, weather, signals, forecasts] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM contracts").first(),
    db.prepare("SELECT COUNT(*) AS count FROM weather_observations").first(),
    db.prepare("SELECT COUNT(*) AS count FROM signals").first(),
    db.prepare("SELECT COUNT(*) AS count FROM forecasts").first(),
  ]);

  return {
    configured: true,
    tables: {
      contracts: Number(contracts?.count || 0),
      weatherObservations: Number(weather?.count || 0),
      signals: Number(signals?.count || 0),
      forecasts: Number(forecasts?.count || 0),
    },
  };
}
