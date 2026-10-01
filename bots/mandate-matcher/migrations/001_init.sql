-- B2 Mandate Matcher (IMPLEMENTATION_PLAN.md Section 7, B2).
-- People live in the shared spine (data/spine.sqlite: persons, person_history,
-- review_queue, events). This database holds the watchlist, the mandate matrix,
-- per-firm roster state, detected movers and their scores. Snapshot ids refer to
-- the core snapshot index; person_id / entity_id refer to the spine.

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats        TEXT                                   -- JSON
);

/* ------------------------------------------------------------ watchlist */

CREATE TABLE watchlist_firms (
  firm_key             TEXT PRIMARY KEY,              -- "FCA:122702"
  regulator            TEXT NOT NULL CHECK (regulator IN ('FCA', 'MAS', 'SFC', 'DFSA', 'FSRA')),
  firm_ref             TEXT NOT NULL,                 -- FRN / CE number / regulator firm reference
  name                 TEXT NOT NULL,
  market               TEXT NOT NULL CHECK (market IN ('UK', 'SG', 'HK', 'DIFC', 'ADGM')),
  tier                 INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  registration_number  TEXT,                          -- company number, if known
  entity_id            INTEGER,                       -- spine entity for the firm
  active               INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT NOT NULL
);

/* -------------------------------------------------------------- matrix */

-- One row per live mandate. Unset criteria are not counted.
CREATE TABLE matrix (
  mandate_id          TEXT PRIMARY KEY,
  client              TEXT NOT NULL,
  title               TEXT NOT NULL,
  market              TEXT NOT NULL DEFAULT '[]',     -- JSON array of markets
  seniority           TEXT,                           -- minimum seniority band (score.js SENIORITY_BANDS)
  licence_category    TEXT NOT NULL DEFAULT '[]',     -- JSON array of role regexes, e.g. ["SMF16", "compliance"]
  firm_tier           TEXT NOT NULL DEFAULT '[]',     -- JSON array of tiers
  exclusions          TEXT NOT NULL DEFAULT '{}',     -- JSON { firms: [firm_key], fromFirms: [firm_key] }
  active              INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL
);

/* -------------------------------------------------------- roster state */

-- One row per processed roster fetch (all pages/parts of one firm in one run).
CREATE TABLE roster_fetches (
  id            INTEGER PRIMARY KEY,
  firm_key      TEXT NOT NULL REFERENCES watchlist_firms(firm_key),
  fetch_key     TEXT NOT NULL UNIQUE,                 -- firm + snapshot ids: identical data is processed once
  snapshot_ids  TEXT NOT NULL,                        -- JSON
  record_count  INTEGER NOT NULL,
  complete      INTEGER NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'rejected')),
  note          TEXT,
  processed_at  TEXT NOT NULL
);
CREATE INDEX idx_roster_fetches_firm ON roster_fetches (firm_key, id);

-- Current known roster of each firm: the diff baseline.
CREATE TABLE roster_people (
  firm_key     TEXT NOT NULL REFERENCES watchlist_firms(firm_key),
  person_ref   TEXT NOT NULL,                         -- IRN / CE number / representative number
  person_id    INTEGER NOT NULL,                      -- spine persons.person_id
  name         TEXT NOT NULL,
  roles        TEXT NOT NULL,                         -- JSON [{ title, code, since }]
  start_date   TEXT,                                  -- earliest published role date; NULL if not published
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  left_at      TEXT,
  PRIMARY KEY (firm_key, person_ref)
);
CREATE INDEX idx_roster_people_person ON roster_people (person_id);

-- Raw joiner/leaver changes per fetch, before move pairing.
CREATE TABLE roster_changes (
  id               INTEGER PRIMARY KEY,
  fetch_id         INTEGER NOT NULL REFERENCES roster_fetches(id),
  firm_key         TEXT NOT NULL,
  regulator        TEXT NOT NULL,
  person_ref       TEXT NOT NULL,
  person_id        INTEGER NOT NULL,
  change_type      TEXT NOT NULL CHECK (change_type IN ('joiner', 'leaver')),
  name             TEXT NOT NULL,
  roles            TEXT NOT NULL,
  tenure_days      INTEGER,                           -- leavers only; NULL if unknown
  tenure_estimate  INTEGER NOT NULL DEFAULT 0,        -- 1 = lower bound from first sighting
  detected_at      TEXT NOT NULL,
  mover_id         INTEGER,                           -- set once turned into a mover
  UNIQUE (fetch_id, person_ref, change_type)
);
CREATE INDEX idx_roster_changes_pending ON roster_changes (mover_id, change_type);

/* -------------------------------------------------------------- movers */

CREATE TABLE movers (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('move', 'leaver', 'joiner')),
  person_id         INTEGER NOT NULL,
  regulator         TEXT NOT NULL,                    -- regulator of the newest change
  person_ref        TEXT NOT NULL,
  name              TEXT NOT NULL,
  from_firm_key     TEXT,
  to_firm_key       TEXT,
  dest_firm_name    TEXT,                             -- leaver destination outside the watchlist, if published
  dest_firm_ref     TEXT,
  roles             TEXT NOT NULL,                    -- JSON: new-firm roles (move/joiner) or old-firm roles (leaver)
  prev_roles        TEXT,                             -- JSON: old-firm roles (move only)
  tenure_days       INTEGER,
  tenure_estimate   INTEGER NOT NULL DEFAULT 0,
  match_method      TEXT,                             -- registry-id | cross-register-name (moves only)
  match_confidence  INTEGER,                          -- 0-100 (moves only)
  detected_at       TEXT NOT NULL,
  superseded_by     INTEGER REFERENCES movers(id),
  event_id          INTEGER,                          -- spine event
  notified_at       TEXT
);
CREATE INDEX idx_movers_digest ON movers (superseded_by, notified_at);
CREATE INDEX idx_movers_person ON movers (regulator, person_ref, kind);

CREATE TABLE scores (
  mover_id   INTEGER NOT NULL REFERENCES movers(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rationale  TEXT NOT NULL,                           -- JSON from score.js
  PRIMARY KEY (mover_id, date)
);

-- Cross-register identity questions already sent to the spine review_queue.
CREATE TABLE identity_reviews (
  joiner_change_id  INTEGER PRIMARY KEY REFERENCES roster_changes(id) ON DELETE CASCADE,
  review_item_id    INTEGER NOT NULL,                 -- spine review_queue.item_id
  best_confidence   INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);

/* ----------------------------------------------------- UK GDPR controls */

-- Every spine person this bot processes, with its lawful basis and retention.
CREATE TABLE person_registry (
  person_id           INTEGER PRIMARY KEY,
  jurisdiction        TEXT NOT NULL,
  registry_person_id  TEXT NOT NULL,
  lawful_basis        TEXT NOT NULL,                  -- e.g. legitimate_interests
  purpose             TEXT NOT NULL,
  source              TEXT NOT NULL,                  -- public register it came from
  first_seen          TEXT NOT NULL,
  last_active_at      TEXT NOT NULL,                  -- last time listed on any watchlist roster
  UNIQUE (jurisdiction, registry_person_id)
);
CREATE INDEX idx_person_registry_active ON person_registry (last_active_at);

-- Audit of retention runs. Counts only: no personal data.
CREATE TABLE retention_log (
  id                INTEGER PRIMARY KEY,
  run_at            TEXT NOT NULL,
  cutoff            TEXT NOT NULL,
  purged_persons    INTEGER NOT NULL,
  purged_movers     INTEGER NOT NULL,
  kept_shared       INTEGER NOT NULL                  -- referenced by other bots' events, left for review
);