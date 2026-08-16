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
  `CREATE INDEX IF NOT EXISTS idx_weather_observed_at ON weather_observations(observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_weather_contract ON weather_observations(contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_observed_at ON signals(observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_forecasts_quarter_time ON forecasts(quarter, generated_at)`,
];

export async function ensureSchema(db) {
  if (!db) throw new Error("D1 binding DB is missing");
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
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
