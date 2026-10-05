-- B7 Incorporation Scout (IMPLEMENTATION_PLAN.md Section 7, B7).
-- Raw search pages, stream chunks and officer lists live in the core snapshot
-- store. Directors are summarised (counts by role), never stored by name:
-- B7 needs the setup, not the people.

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats        TEXT
);

-- Search: last incorporation date fully collected. Stream: last timepoint read.
CREATE TABLE harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE source_runs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  source       TEXT NOT NULL,
  items        INTEGER NOT NULL,
  weekday      INTEGER NOT NULL,              -- 1 if the window held a weekday
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'anomaly', 'failed')),
  note         TEXT,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX idx_source_runs ON source_runs (source, id);

-- Snapshots parsed successfully. Parse failures are NOT recorded: they are retried every run.
CREATE TABLE processed_snapshots (
  snapshot_id   INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  items         INTEGER NOT NULL,
  processed_at  TEXT NOT NULL
);

CREATE TABLE sic_watchlists (
  watchlist_id   TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  sic_codes      TEXT NOT NULL,                -- JSON: 5-digit codes, or 4/2-digit class/division prefixes
  regions        TEXT NOT NULL DEFAULT '[]',   -- JSON: postcode areas/districts, towns or regions
  min_score      INTEGER NOT NULL CHECK (min_score BETWEEN 0 AND 100),
  slack_channel  TEXT NOT NULL,
  weights        TEXT NOT NULL DEFAULT '{}',   -- JSON overrides for score.js weights
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL
);

CREATE TABLE incorporations (
  company_number     TEXT PRIMARY KEY,
  company_key        TEXT NOT NULL,                 -- "UK:01234567" spine id
  name               TEXT NOT NULL,
  company_type       TEXT,
  company_status     TEXT,
  date_of_creation   TEXT,                          -- NULL if not published; never guessed
  sic_codes          TEXT NOT NULL DEFAULT '[]',    -- JSON
  ro_address         TEXT,                          -- registered office, one line
  ro_postcode        TEXT,
  ro_locality        TEXT,
  ro_region          TEXT,
  ro_country         TEXT,
  formation_agent    TEXT,                          -- blocklist rule id when the office is a formation agent's address
  officers_status    TEXT NOT NULL DEFAULT 'pending' CHECK (officers_status IN ('pending', 'fetched', 'not-found', 'failed', 'skipped')),
  officers_summary   TEXT,                          -- JSON counts by role; no names
  source             TEXT NOT NULL CHECK (source IN ('advanced-search', 'stream')),
  snapshot_id        INTEGER NOT NULL,
  entity_id          INTEGER,                       -- spine
  event_id           INTEGER,                       -- spine INCORPORATION_DETECTED
  first_seen         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_incorporations_created ON incorporations (date_of_creation);

CREATE TABLE scored_leads (
  company_number  TEXT NOT NULL REFERENCES incorporations(company_number) ON DELETE CASCADE,
  watchlist_id    TEXT NOT NULL REFERENCES sic_watchlists(watchlist_id),
  matched_sic     TEXT NOT NULL,                    -- the watchlist entry that matched
  score           INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons         TEXT NOT NULL,                    -- JSON from score.js
  scored_at       TEXT NOT NULL,
  notified_at     TEXT,
  PRIMARY KEY (company_number, watchlist_id)
);
CREATE INDEX idx_scored_leads_pending ON scored_leads (watchlist_id, notified_at, score);