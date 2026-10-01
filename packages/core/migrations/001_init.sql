-- @botarmy/core — shared core database (data/spine.sqlite).
-- Raw snapshot index, entity spine (IMPLEMENTATION_PLAN.md Section 4) and approvals.
-- IF NOT EXISTS throughout so a database created by core 0.2 upgrades cleanly.

/* ------------------------------------------------------------ snapshots */

-- Index of immutable raw payloads. Bodies live gzipped under
-- data/raw/<source>/<YYYY-MM>/<sha256>.<ext>.gz (path is relative to data/).
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,          -- e.g. uk-sponsor-register
  ref           TEXT,                   -- source-specific reference: filename, page, firm id
  url           TEXT,
  sha256        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  content_type  TEXT,
  fetched_at    TEXT NOT NULL,
  path          TEXT NOT NULL,
  meta          TEXT,                   -- JSON
  UNIQUE (source, sha256)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_source ON snapshots (source, fetched_at);

/* --------------------------------------------------------------- spine */

CREATE TABLE IF NOT EXISTS entities (
  entity_id     INTEGER PRIMARY KEY,
  jurisdiction  TEXT NOT NULL,          -- UK, AE-DIFC, AE-ADGM, SG, HK, SA, ...
  registry_id   TEXT,                   -- CH number / UEN / licence no; NULL if unresolved
  spine_id      TEXT,                   -- normalizeEntityId() output, e.g. "UK:01026167"
  name          TEXT NOT NULL,
  name_norm     TEXT NOT NULL,          -- match.nameNorm()
  locality      TEXT,                   -- normalised town/city; disambiguates unresolved entities
  status        TEXT,                   -- active / dissolved / unknown
  postcode      TEXT,
  lat           REAL,
  lon           REAL,
  sic           TEXT,
  first_seen    TEXT,
  last_seen     TEXT,
  UNIQUE (jurisdiction, registry_id)
);
-- Unresolved entities (no registry id) are unique by jurisdiction + name + locality.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_unresolved
  ON entities (jurisdiction, name_norm, IFNULL(locality, '')) WHERE registry_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities (jurisdiction, name_norm);

CREATE TABLE IF NOT EXISTS entity_aliases (
  alias_id   INTEGER PRIMARY KEY,
  entity_id  INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_norm  TEXT NOT NULL,
  source     TEXT,
  UNIQUE (entity_id, name_norm)
);
CREATE INDEX IF NOT EXISTS idx_aliases_name ON entity_aliases (name_norm);

CREATE TABLE IF NOT EXISTS persons (
  person_id               INTEGER PRIMARY KEY,
  jurisdiction            TEXT,
  registry_person_id      TEXT,
  name                    TEXT,
  name_norm               TEXT,
  dob_partial             TEXT,         -- Companies House gives month/year
  current_firm_entity_id  INTEGER REFERENCES entities(entity_id),
  role_category           TEXT,
  licence_types           TEXT,         -- JSON
  first_seen              TEXT,
  last_seen               TEXT
);

CREATE TABLE IF NOT EXISTS person_history (
  person_id       INTEGER NOT NULL REFERENCES persons(person_id) ON DELETE CASCADE,
  firm_entity_id  INTEGER REFERENCES entities(entity_id),
  role            TEXT,
  from_date       TEXT,
  to_date         TEXT,
  source          TEXT
);

-- The bus every bot reads. Idempotent on (source, type, entity, date).
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY,
  entity_id    INTEGER REFERENCES entities(entity_id),
  person_id    INTEGER REFERENCES persons(person_id),
  type         TEXT NOT NULL,           -- TENDER_AWARD, SPONSOR_ADDED, MOVER, HIRING_SPIKE, ...
  event_date   TEXT,
  detected_at  TEXT,
  source       TEXT NOT NULL,           -- bot + source name
  payload      TEXT,                    -- JSON
  UNIQUE (source, type, entity_id, event_date)
);
CREATE INDEX IF NOT EXISTS idx_events_type_date ON events (type, event_date);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events (entity_id, event_date);

CREATE TABLE IF NOT EXISTS review_queue (
  item_id      INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue (status, kind);

/* ------------------------------------------------------------ approvals */

-- Human approval gate for outbound content (slack.requestApproval).
-- Outbound code must call slack.assertApproved(token) before sending.
CREATE TABLE IF NOT EXISTS approvals (
  approval_id   INTEGER PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  bot           TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- e.g. outreach_email
  ref           TEXT,                   -- bot-side id of the thing being approved
  payload       TEXT,                   -- JSON shown to the approver
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at  TEXT NOT NULL,
  expires_at    TEXT,
  decided_by    TEXT,                   -- Slack user id
  decided_at    TEXT,
  UNIQUE (bot, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, bot);