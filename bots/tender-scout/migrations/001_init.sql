-- B3 TenderScout (IMPLEMENTATION_PLAN.md Section 7, B3).
-- Raw API responses live in the core snapshot store; snapshot ids refer to it.
-- Buyer entities and TENDER_OPPORTUNITY events live in the shared spine (data/spine.sqlite).

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats        TEXT                                   -- JSON
);

/* ------------------------------------------------------------- profiles */

-- One row per subscribing entity (Ateca, Osbrooks, AMC, Trading Co …), mirrored from profiles.json.
CREATE TABLE keyword_profiles (
  profile_id        TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  keywords          TEXT NOT NULL,                    -- JSON: capability keywords
  exclude_keywords  TEXT NOT NULL DEFAULT '[]',       -- JSON: never-interested terms
  value_min         REAL,                             -- value floor: a known value below it is filtered out
  value_max         REAL,                             -- top of the comfortable band (above it scores lower, not excluded)
  value_currency    TEXT,                             -- currency the band is expressed in
  locations         TEXT NOT NULL DEFAULT '[]',       -- JSON: preferred delivery regions / countries
  min_days          INTEGER NOT NULL,                 -- fewer days to the deadline than this: filtered out
  slack_channel     TEXT NOT NULL,                    -- core.slack channel (SLACK_WEBHOOK_URL_<CHANNEL>)
  weights           TEXT NOT NULL,                    -- JSON: { value, keywords, location, deadline }
  active            INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL
);

CREATE TABLE watchlist_cpvs (
  profile_id  TEXT NOT NULL REFERENCES keyword_profiles(profile_id) ON DELETE CASCADE,
  cpv_prefix  TEXT NOT NULL CHECK (length(cpv_prefix) BETWEEN 2 AND 8),
  PRIMARY KEY (profile_id, cpv_prefix)
);

/* -------------------------------------------------------------- harvest */

CREATE TABLE harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,                                   -- ISO timestamp the next window starts from
  updated_at  TEXT NOT NULL
);

-- One row per source per run. The volume guard compares against recent 'ok' rows only.
CREATE TABLE source_runs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  source       TEXT NOT NULL,
  notices      INTEGER NOT NULL,                      -- open tender notices parsed this run
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'anomaly')),
  note         TEXT,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX idx_source_runs_source ON source_runs (source, outcome, id);

-- Snapshots already turned into tenders: re-runs never parse the same payload twice.
CREATE TABLE processed_snapshots (
  snapshot_id   INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  notices       INTEGER NOT NULL,
  processed_at  TEXT NOT NULL
);

/* -------------------------------------------------------------- tenders */

CREATE TABLE tenders (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL CHECK (source IN ('contractsFinder', 'findATender', 'ted')),
  notice_id        TEXT NOT NULL,                     -- OCDS ocid, or TED publication number
  title            TEXT NOT NULL,
  description      TEXT,
  buyer_raw        TEXT,
  buyer_entity_id  INTEGER,                           -- spine entity
  value_min        REAL,                              -- NULL when not published; never estimated
  value_max        REAL,
  currency         TEXT,
  deadline         TEXT,                              -- submission deadline (ISO); NULL when not published
  published_at     TEXT,
  cpv              TEXT NOT NULL DEFAULT '[]',        -- JSON: 8-digit CPV codes
  locations        TEXT NOT NULL DEFAULT '[]',        -- JSON: delivery regions / places as published
  status           TEXT,
  url              TEXT,
  fingerprint      TEXT NOT NULL,                     -- normalised buyer + title + deadline: same tender on two sources
  duplicate_of     INTEGER REFERENCES tenders(id),    -- set when another source already carries this tender
  content_hash     TEXT NOT NULL,                     -- changes when a tenderUpdate alters the notice
  raw_snapshot_id  INTEGER NOT NULL,
  event_id         INTEGER,                           -- spine TENDER_OPPORTUNITY event
  first_seen       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (source, notice_id)
);
CREATE INDEX idx_tenders_fingerprint ON tenders (fingerprint, duplicate_of);
CREATE INDEX idx_tenders_deadline ON tenders (deadline);

-- Every tender × profile evaluation. passed = 0 rows keep the filter reason for audit;
-- reasons hold the points per factor, which sum to score.
CREATE TABLE scored_matches (
  id             INTEGER PRIMARY KEY,
  tender_id      INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  profile_id     TEXT NOT NULL REFERENCES keyword_profiles(profile_id) ON DELETE CASCADE,
  passed         INTEGER NOT NULL,
  filter_reason  TEXT NOT NULL,                       -- why it failed, or why it passed ("cpv:<prefix>" / "keyword")
  -- Filtered-out tenders were never scored: NULL, not 0. Passing tenders always carry a 0–100 score.
  score          INTEGER CHECK ((passed = 0 AND score IS NULL) OR (passed = 1 AND score BETWEEN 0 AND 100)),
  reasons        TEXT NOT NULL,                       -- JSON from score.js
  content_hash   TEXT NOT NULL,                       -- tender version this was computed for
  scored_at      TEXT NOT NULL,
  notified_at    TEXT,
  UNIQUE (tender_id, profile_id)
);
CREATE INDEX idx_scored_matches_digest ON scored_matches (profile_id, passed, notified_at, score);