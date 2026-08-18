-- Terranor Tracker 2.0 – D1 kjerneskjema
--
-- Dette er bootstrap-skjemaet for de delte kjernetabellene. Feature-spesifikke tabeller
-- (værkoblinger, historikk, Trafikverket, kommunale kilder osv.) opprettes fortsatt
-- idempotent av modulenes ensure*-funksjoner. Nye strukturelle endringer skal fremover
-- dokumenteres her eller flyttes til eksplisitte migreringer før de tas i bruk.

CREATE TABLE IF NOT EXISTS contracts (
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
);

CREATE TABLE IF NOT EXISTS weather_observations (
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
);

CREATE TABLE IF NOT EXISTS signals (
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
);

CREATE TABLE IF NOT EXISTS forecasts (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_unique ON contracts(country, name, start_date);
CREATE INDEX IF NOT EXISTS idx_contract_start_date ON contracts(start_date);
CREATE INDEX IF NOT EXISTS idx_weather_observed_at ON weather_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_weather_contract ON weather_observations(contract_id);
CREATE INDEX IF NOT EXISTS idx_weather_source_station_time ON weather_observations(source, station_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_signals_observed_at ON signals(observed_at);
CREATE INDEX IF NOT EXISTS idx_forecasts_quarter_time ON forecasts(quarter, generated_at);
