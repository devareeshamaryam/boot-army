-- B1 Sponsor Licence Scout (IMPLEMENTATION_PLAN.md Section 7, B1).
-- Raw CSVs live in the shared snapshot store (data/snapshots.sqlite + data/raw/);
-- snapshot_id columns below refer to snapshots.id there.

-- Current known state of every sponsor ever seen: the diff baseline.
-- The register has no licence number, so identity is normalised name + town (org_key).
CREATE TABLE sponsors (
  org_key      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  name_norm    TEXT NOT NULL,
  town         TEXT,
  county       TEXT,
  ratings      TEXT NOT NULL,          -- JSON {"Worker": "A", "Temporary Worker": "B"}
  routes       TEXT NOT NULL,          -- JSON ["Skilled Worker", "Scale-up"]
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  removed_at   TEXT
);
CREATE INDEX idx_sponsors_active ON sponsors (active);

-- Every register file this bot has processed (or rejected), one row per snapshot.
CREATE TABLE processed_snapshots (
  snapshot_id     INTEGER PRIMARY KEY,
  sha256          TEXT NOT NULL,
  source_url      TEXT,
  filename        TEXT,
  published_date  TEXT,
  row_count       INTEGER NOT NULL,
  org_count       INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'rejected')),
  note            TEXT,
  processed_at    TEXT NOT NULL
);

-- Detected changes. REMOVED means "no longer listed": the register gives no reason.
CREATE TABLE sponsor_diffs (
  id            INTEGER PRIMARY KEY,
  snapshot_id   INTEGER NOT NULL,
  org_key       TEXT NOT NULL,
  diff_type     TEXT NOT NULL CHECK (diff_type IN ('ADDED', 'REMOVED', 'RATING_CHANGED')),
  direction     TEXT CHECK (direction IN ('downgrade', 'upgrade', 'change')),
  name          TEXT NOT NULL,
  town          TEXT,
  county        TEXT,
  old           TEXT,                  -- JSON { ratings, routes } before
  new           TEXT,                  -- JSON { ratings, routes } after
  watch_match   TEXT,                  -- watchlist company name, if matched
  entity_id     INTEGER,               -- spine entity
  event_id      INTEGER,               -- spine event, if one was emitted
  detected_at   TEXT NOT NULL,
  notified_at   TEXT,
  UNIQUE (snapshot_id, org_key, diff_type)
);
CREATE INDEX idx_sponsor_diffs_pending ON sponsor_diffs (notified_at, diff_type);

-- Remove+add pairs recognised as the same sponsor (relocation or rename), kept for audit.
CREATE TABLE suppressed_changes (
  id           INTEGER PRIMARY KEY,
  snapshot_id  INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('RELOCATED', 'RENAMED')),
  from_key     TEXT NOT NULL,
  to_key       TEXT NOT NULL,
  from_label   TEXT NOT NULL,
  to_label     TEXT NOT NULL,
  similarity   INTEGER,
  detected_at  TEXT NOT NULL,
  UNIQUE (snapshot_id, from_key, to_key)
);