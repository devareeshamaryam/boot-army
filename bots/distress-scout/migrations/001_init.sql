-- B4 Distress Scout (IMPLEMENTATION_PLAN.md Section 7, B4).
-- Raw Gazette pages, notices, Companies House responses and CSV feeds live in
-- the core snapshot store; snapshot_id columns refer to it. Companies are keyed
-- on the Companies House number: names are recycled, numbers are not.

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats        TEXT
);

CREATE TABLE harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TEXT NOT NULL
);

-- Per-source volume history for the drop guard.
CREATE TABLE source_runs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  source       TEXT NOT NULL,
  items        INTEGER NOT NULL,
  weekday      INTEGER NOT NULL,           -- 1 if the window held a Gazette publishing day
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'anomaly', 'failed')),
  note         TEXT,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX idx_source_runs ON source_runs (source, id);

-- Snapshots parsed successfully. Failures are NOT recorded: they are retried every run.
CREATE TABLE processed_snapshots (
  snapshot_id   INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  items         INTEGER NOT NULL,
  processed_at  TEXT NOT NULL
);

CREATE TABLE watchlist_companies (
  company_key     TEXT PRIMARY KEY,          -- "UK:01234567"
  company_number  TEXT NOT NULL,
  name            TEXT NOT NULL,
  note            TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL
);

-- Every distress event from every source (Gazette, Companies House, CSV).
CREATE TABLE distress_records (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,              -- gazette | companies-house | csv:<feed>
  source_ref      TEXT NOT NULL,              -- notice id / CH case + date / CSV reference
  company_key     TEXT NOT NULL,              -- "UK:01234567", or "name:<normalised>" when no number was published
  company_number  TEXT,
  company_name    TEXT NOT NULL,
  event_type      TEXT NOT NULL,              -- score.js EVENT_TYPES
  tier            TEXT,                       -- NULL for resolving events
  stage           TEXT,                       -- EARLY | PRE_DISSOLUTION | FORMAL
  event_date      TEXT,                       -- when it happened (notice publication, case date, due date); NULL if unknown
  date_basis      TEXT NOT NULL CHECK (date_basis IN ('published', 'case', 'due', 'observed', 'reported', 'unknown')),
                                              -- what event_date means: "observed" = first seen by this bot
  notice_code     TEXT,                       -- Gazette notice code, when from the Gazette
  reference       TEXT,                       -- court case number, CH case number, CSV reference
  url             TEXT,
  snapshot_id     INTEGER NOT NULL,
  event_id        INTEGER,                    -- spine DISTRESS_EVENT
  detected_at     TEXT NOT NULL,
  UNIQUE (source, source_ref)
);
CREATE INDEX idx_distress_records_company ON distress_records (company_key, event_date);

-- Current state per company (the plan's "cases").
CREATE TABLE company_states (
  company_key     TEXT PRIMARY KEY,
  company_number  TEXT,
  company_name    TEXT NOT NULL,
  tier            TEXT NOT NULL,
  stage           TEXT,
  severity        INTEGER NOT NULL CHECK (severity BETWEEN 0 AND 100),
  open_signals    TEXT NOT NULL,              -- JSON
  reasons         TEXT NOT NULL,              -- JSON from score.js
  sic_codes       TEXT NOT NULL DEFAULT '[]', -- JSON, from Companies House when looked up
  entity_id       INTEGER,
  opened_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Tier changes: the only thing that alerts. One per company per tier per day.
CREATE TABLE transitions (
  id            INTEGER PRIMARY KEY,
  company_key   TEXT NOT NULL REFERENCES company_states(company_key) ON DELETE CASCADE,
  from_tier     TEXT NOT NULL,
  to_tier       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('escalation', 'de-escalation')),
  severity      INTEGER NOT NULL,
  reasons       TEXT NOT NULL,              -- JSON
  at            TEXT NOT NULL,
  at_day        TEXT NOT NULL,
  notified_at   TEXT,
  UNIQUE (company_key, to_tier, at_day)
);
CREATE INDEX idx_transitions_pending ON transitions (notified_at, kind, severity);

-- Action tags (ACQUIRE / ASSETS / APPROACH / PROPERTY / TALENT). Every tag records the rule that set it.
CREATE TABLE tags (
  transition_id  INTEGER NOT NULL REFERENCES transitions(id) ON DELETE CASCADE,
  tag            TEXT NOT NULL,
  rule_hit       TEXT NOT NULL,
  PRIMARY KEY (transition_id, tag)
);

-- Companies House lookups, so each company is refreshed at most every N days.
CREATE TABLE ch_lookups (
  company_key     TEXT PRIMARY KEY,
  company_name    TEXT,
  sic_codes       TEXT NOT NULL DEFAULT '[]',  -- JSON, for tag rules
  company_status  TEXT,
  looked_up_at    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'not-found', 'failed')),
  note            TEXT
);