-- B5 Hiring-Signal Scout (IMPLEMENTATION_PLAN.md Section 7, B5).
-- Raw responses live in the core snapshot store (snapshot_id refers to it);
-- signals are also emitted to the spine as TENDER_AWARD / HIRING_SPIKE / FUNDING_ROUND.

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats        TEXT
);

CREATE TABLE watchlist_companies (
  id          TEXT PRIMARY KEY,                     -- watchlist slug
  name        TEXT NOT NULL,
  spine_id    TEXT,                                 -- normalizeEntityId() output, if a registration number is known
  entity_id   INTEGER,                              -- spine entity
  domain      TEXT,
  country     TEXT,
  ats_type    TEXT,
  ats_status  TEXT NOT NULL DEFAULT 'none' CHECK (ats_status IN ('supported', 'unsupported', 'none')),
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

-- Per-source polling cursor (timestamp, or JSON for sources that need more).
CREATE TABLE harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TEXT NOT NULL
);

-- Award/feed/funding snapshots already parsed (board fetches are tracked in board_fetches).
CREATE TABLE processed_snapshots (
  snapshot_id   INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('awards', 'jobFeed', 'funding')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('parsed', 'baseline')),  -- parse failures are not recorded: retried every run
  items         INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  processed_at  TEXT NOT NULL
);

CREATE TABLE contract_awards (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  notice_id      TEXT NOT NULL,
  company_id     TEXT NOT NULL REFERENCES watchlist_companies(id),
  supplier_name  TEXT NOT NULL,
  match_method   TEXT NOT NULL CHECK (match_method IN ('registration', 'name')),
  confidence     TEXT NOT NULL CHECK (confidence IN ('awarded', 'tenderer')),
  buyer          TEXT,
  title          TEXT,
  value          REAL,                              -- NULL when the notice states none; never estimated
  currency       TEXT,
  cpv            TEXT NOT NULL DEFAULT '[]',        -- JSON array of CPV codes, [] if the notice has none
  award_date     TEXT,
  url            TEXT,
  filter_passed  INTEGER NOT NULL,                  -- CPV / keyword filters
  filter_reason  TEXT NOT NULL,                     -- cpv | keyword | unfiltered | cpv-mismatch | keyword-mismatch
  snapshot_id    INTEGER NOT NULL,
  first_seen     TEXT NOT NULL,
  UNIQUE (source, notice_id, company_id)
);
CREATE INDEX idx_contract_awards_company ON contract_awards (company_id, first_seen);

-- One row per processed board / licensed-feed fetch.
CREATE TABLE board_fetches (
  id            INTEGER PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES watchlist_companies(id),
  source        TEXT NOT NULL,                      -- greenhouse | lever | workable | workday | linkedin | indeed | …
  fetch_key     TEXT NOT NULL UNIQUE,               -- company + source + snapshot ids
  job_count     INTEGER NOT NULL,
  complete      INTEGER NOT NULL,                   -- 0: truncated or partial feed, closures not inferred
  outcome       TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'rejected')),
  note          TEXT,
  processed_at  TEXT NOT NULL
);
CREATE INDEX idx_board_fetches_company ON board_fetches (company_id, source, id);

CREATE TABLE job_postings (
  company_id     TEXT NOT NULL REFERENCES watchlist_companies(id),
  source         TEXT NOT NULL,
  job_key        TEXT NOT NULL,
  title          TEXT NOT NULL,
  location       TEXT,
  url            TEXT,
  matches_stack  INTEGER NOT NULL DEFAULT 0,        -- title matches a configured stack keyword
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  is_baseline    INTEGER NOT NULL DEFAULT 0,        -- present at first sight; never counted as new
  PRIMARY KEY (company_id, source, job_key)
);

-- Daily posting velocity per company and source: the series spikes are computed on.
CREATE TABLE job_velocity (
  company_id       TEXT NOT NULL REFERENCES watchlist_companies(id),
  source           TEXT NOT NULL,
  day              TEXT NOT NULL,                   -- YYYY-MM-DD
  open_count       INTEGER NOT NULL,
  new_count        INTEGER NOT NULL,
  new_stack_count  INTEGER NOT NULL,
  closed_count     INTEGER NOT NULL,
  is_baseline      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, source, day)
);

CREATE TABLE funding_items (
  id          INTEGER PRIMARY KEY,
  item_key    TEXT NOT NULL UNIQUE,                 -- guid/link + company
  company_id  TEXT NOT NULL REFERENCES watchlist_companies(id),
  title       TEXT NOT NULL,
  link        TEXT,
  feed        TEXT,
  amount      REAL,                                 -- NULL when the headline gives none
  currency    TEXT,
  published   TEXT,
  snapshot_id INTEGER NOT NULL,
  first_seen  TEXT NOT NULL
);

-- At most one signal per company per type per ISO week (week = Monday, YYYY-MM-DD).
-- A stronger candidate replaces an unsent one; once sent, the week is closed.
CREATE TABLE signals (
  id           INTEGER PRIMARY KEY,
  signal_type  TEXT NOT NULL CHECK (signal_type IN ('contract_award', 'hiring_spike', 'funding')),
  company_id   TEXT NOT NULL REFERENCES watchlist_companies(id),
  week         TEXT NOT NULL,
  score        INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  evidence     TEXT NOT NULL,                       -- JSON shown in Slack
  rationale    TEXT NOT NULL,                       -- JSON from score.js
  angle        TEXT NOT NULL,                       -- suggested outreach angle (template text)
  ref_key      TEXT NOT NULL,                       -- what triggered it (award / spike day / news item)
  entity_id    INTEGER,
  event_id     INTEGER,
  detected_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  notified_at  TEXT,
  UNIQUE (company_id, signal_type, week)
);
CREATE INDEX idx_signals_pending ON signals (notified_at, signal_type, score);