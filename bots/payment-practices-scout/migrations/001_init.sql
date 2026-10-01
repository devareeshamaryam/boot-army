-- B9 Payment Practices Scout (IMPLEMENTATION_PLAN.md Section 7, B9).
-- Raw exports live in the core snapshot store; snapshot_id refers to it.
-- Reports are self-reported and semi-annual: every output must say which
-- period the figures describe ("data as of period ending …").

-- Every export this bot has processed (or rejected), one row per snapshot.
CREATE TABLE processed_snapshots (
  snapshot_id     INTEGER PRIMARY KEY,
  sha256          TEXT NOT NULL,
  source_url      TEXT,
  row_count       INTEGER NOT NULL,             -- CSV data rows
  report_count    INTEGER NOT NULL,             -- rows that parsed into reports
  skipped         INTEGER NOT NULL DEFAULT 0,
  column_mapping  TEXT,                         -- JSON { field: "header" } as detected
  outcome         TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'rejected')),
  note            TEXT,
  processed_at    TEXT NOT NULL
);

-- One row per published report (the plan's B9 table).
CREATE TABLE payment_records (
  report_id              TEXT PRIMARY KEY,      -- natural key: re-downloads never duplicate
  company_number         TEXT,                  -- Companies House number, zero-padded; NULL if absent/invalid
  company_key            TEXT NOT NULL,         -- "UK:01234567", or "name:<normalised name>" without a valid number
  company_name           TEXT NOT NULL,
  avg_days_to_pay        INTEGER,               -- NULL when not reported; never defaulted
  payments_beyond_terms  INTEGER,               -- % of payments not made within agreed terms; NULL when not reported
  period_start_date      TEXT,
  period_end_date        TEXT NOT NULL,
  filing_date            TEXT,
  report_url             TEXT,
  snapshot_id            INTEGER NOT NULL,      -- export the report was first seen in
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_payment_records_company ON payment_records (company_key, period_end_date);
CREATE INDEX idx_payment_records_filed ON payment_records (filing_date);

-- Detected jumps: a new report markedly worse than the same company's previous period.
CREATE TABLE payment_jumps (
  id              INTEGER PRIMARY KEY,
  report_id       TEXT NOT NULL UNIQUE REFERENCES payment_records(report_id),
  prev_report_id  TEXT NOT NULL,                -- may predate this bot (taken from the export's history)
  company_key     TEXT NOT NULL,
  reasons         TEXT NOT NULL,                -- JSON ["days", "late"]
  days_delta      INTEGER,
  pct_delta       INTEGER,
  late_delta      INTEGER,
  gap_days        INTEGER NOT NULL,
  score           INTEGER NOT NULL,
  refiled         INTEGER NOT NULL DEFAULT 0,   -- company already reported this period before
  prev_snapshot   TEXT NOT NULL,                -- JSON of the previous report's figures
  entity_id       INTEGER,                      -- spine entity
  event_id        INTEGER,                      -- spine PAYMENT_DAYS_JUMP event
  detected_at     TEXT NOT NULL,
  notified_at     TEXT
);
CREATE INDEX idx_payment_jumps_pending ON payment_jumps (notified_at, score);