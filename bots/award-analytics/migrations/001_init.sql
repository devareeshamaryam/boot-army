-- B6 Award Analytics (IMPLEMENTATION_PLAN.md Section 7, B6).
-- Raw award pages live in the core snapshot store; snapshot_id refers to it.
-- Other bots read this database through analytics.js (openAwardLookup), never directly.

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  mode         TEXT NOT NULL CHECK (mode IN ('daily', 'backfill')),
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats        TEXT
);

-- Daily incremental cursor per source.
CREATE TABLE harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TEXT NOT NULL
);

-- Backfill plan: fixed windows per source, marked done one by one, so a killed backfill resumes where it stopped.
CREATE TABLE backfill_windows (
  source        TEXT NOT NULL,
  window_from   TEXT NOT NULL,
  window_to     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'truncated')),
  items         INTEGER,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source, window_from)
);

-- Per-source volume history for the drop guard.
CREATE TABLE source_runs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  source       TEXT NOT NULL,
  items        INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'anomaly', 'failed')),
  note         TEXT,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX idx_source_runs ON source_runs (source, id);

-- Snapshots parsed successfully. Parse failures are NOT recorded: they are retried every run.
CREATE TABLE processed_snapshots (
  snapshot_id   INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  awards        INTEGER NOT NULL,
  processed_at  TEXT NOT NULL
);

/* -------------------------------------------------------------- awards */

CREATE TABLE contract_awards (
  id                   INTEGER PRIMARY KEY,
  source               TEXT NOT NULL,                -- contractsFinder | findATender | ted
  notice_id            TEXT NOT NULL,
  award_ref            TEXT NOT NULL,                -- award id within the notice (OCDS award.id / TED lot)
  buyer_key            TEXT NOT NULL,                -- buyerKeyOf(name, country)
  buyer_name           TEXT NOT NULL,
  buyer_country        TEXT NOT NULL,
  buyer_entity_id      INTEGER,                      -- spine
  title                TEXT,
  value                REAL,                         -- NULL when not published; never estimated
  currency             TEXT,
  value_kind           TEXT NOT NULL CHECK (value_kind IN ('contract', 'framework_ceiling', 'unknown')),
  award_date           TEXT,
  cpv                  TEXT NOT NULL DEFAULT '[]',   -- JSON array of 8-digit codes
  cpv_division         TEXT,                         -- first 2 digits of the main CPV code; NULL if none published
  number_of_tenderers  INTEGER,                      -- NULL when not published
  supplier_count       INTEGER NOT NULL,
  confidence           TEXT NOT NULL CHECK (confidence IN ('awarded', 'tenderer')),  -- TED lists tenderers, not always winners
  url                  TEXT,
  snapshot_id          INTEGER NOT NULL,
  first_seen           TEXT NOT NULL,
  notified_at          TEXT,                         -- major-award announcement sent
  UNIQUE (source, notice_id, award_ref)
);
CREATE INDEX idx_awards_buyer ON contract_awards (buyer_key, cpv_division, award_date);
CREATE INDEX idx_awards_date ON contract_awards (award_date);

-- Winners per award. Raw name always kept; the resolved key may group JVs and name variants.
CREATE TABLE award_suppliers (
  award_id      INTEGER NOT NULL REFERENCES contract_awards(id) ON DELETE CASCADE,
  supplier_key  TEXT NOT NULL,                       -- "UK:01234567" or "name:<core name>"
  raw_name      TEXT NOT NULL,
  match_method  TEXT NOT NULL CHECK (match_method IN ('registry', 'name')),
  is_jv         INTEGER NOT NULL DEFAULT 0,           -- consortium / joint venture / "A and B" names
  PRIMARY KEY (award_id, supplier_key)
);
CREATE INDEX idx_award_suppliers_supplier ON award_suppliers (supplier_key);

/* ----------------------------------------------------------- profiles */

CREATE TABLE supplier_profiles (
  supplier_key       TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  company_number     TEXT,
  aliases            TEXT NOT NULL DEFAULT '[]',     -- JSON: raw names seen
  entity_id          INTEGER,                        -- spine
  wins               INTEGER NOT NULL,
  contested_wins     INTEGER NOT NULL,               -- wins where ≥ 2 tenderers were published
  avg_competitors    REAL,                           -- mean tenderers on wins where published; NULL if never
  first_win          TEXT,
  last_win           TEXT,
  top_buyers         TEXT NOT NULL DEFAULT '[]',     -- JSON [{ buyerKey, buyerName, wins }]
  cpv_divisions      TEXT NOT NULL DEFAULT '[]',     -- JSON [{ division, wins }]
  value_by_currency  TEXT NOT NULL DEFAULT '{}',     -- JSON { GBP: { total, n } }: single-supplier contract values only
  updated_at         TEXT NOT NULL
);

CREATE TABLE buyer_analytics (
  buyer_key               TEXT NOT NULL,
  cpv_division            TEXT NOT NULL,             -- '*' = all categories
  buyer_name              TEXT NOT NULL,
  window_months           INTEGER NOT NULL,
  awards                  INTEGER NOT NULL,
  distinct_suppliers      INTEGER NOT NULL,
  hhi                     INTEGER,                   -- 0–10000 over supplier win shares; NULL below the minimum sample
  concentration           TEXT NOT NULL CHECK (concentration IN ('insufficient_data', 'unconcentrated', 'moderate', 'high')),
  top_supplier_key        TEXT,
  top_share               REAL,
  incumbent_supplier_key  TEXT,                      -- NULL when no supplier meets the incumbency rule
  incumbent_share         REAL,
  incumbent_wins          INTEGER,
  avg_value               REAL,                      -- single-supplier contract values in value_currency only
  median_value            REAL,
  value_currency          TEXT,
  value_n                 INTEGER NOT NULL DEFAULT 0,
  avg_tenderers           REAL,
  prev_hhi                INTEGER,
  prev_concentration      TEXT,
  prev_incumbent_key      TEXT,
  computed_at             TEXT NOT NULL,
  changed_at              TEXT,                      -- concentration label or incumbent last changed
  shift_notified_at       TEXT,
  PRIMARY KEY (buyer_key, cpv_division)
);

-- Near-duplicate supplier names already sent to the spine review_queue (never auto-merged).
CREATE TABLE supplier_reviews (
  pair_key        TEXT PRIMARY KEY,                  -- sorted "keyA|keyB"
  review_item_id  INTEGER NOT NULL,
  similarity      INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);