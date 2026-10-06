-- TenderScout schema. Timestamps are UTC ISO-8601 strings, so they sort as text.

-- One row per bot run (audit).
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running',   -- running | ok | failed
  args         TEXT,                              -- JSON of the CLI options
  counts       TEXT,                              -- JSON: per-stage fetched/stored, scored, posted
  error        TEXT
);

-- Last successful publishedTo per source and stage. Only advanced after a whole window is fetched.
CREATE TABLE IF NOT EXISTS watermarks (
  source        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  published_to  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source, stage)
);

-- Every release version as fetched (raw JSON, for debugging). Dedupe key: source + release id.
CREATE TABLE IF NOT EXISTS releases (
  source         TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  ocid           TEXT NOT NULL,
  stage          TEXT NOT NULL,                   -- tender | award
  tag            TEXT,                            -- e.g. tender, tenderAmendment, award, awardUpdate
  release_date   TEXT,
  raw_json       TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  PRIMARY KEY (source, release_id)
);
CREATE INDEX IF NOT EXISTS releases_ocid ON releases (ocid);

-- Tender notices, normalised: one row per ocid, holding the latest release.
CREATE TABLE IF NOT EXISTS notices (
  ocid              TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  release_id        TEXT NOT NULL,                -- latest release (raw JSON in releases)
  release_date      TEXT NOT NULL,
  release_seq       INTEGER NOT NULL DEFAULT 0,   -- tie-break when two releases share a date
  tag               TEXT,
  status            TEXT,                         -- tender.status: active | cancelled | withdrawn | complete | NULL
  title             TEXT,
  description       TEXT,
  buyer_id          TEXT,
  buyer_name        TEXT,
  buyer_key         TEXT,                         -- lower-cased buyer name, joins to awards
  value_amount      REAL,                         -- NULL = not published
  value_currency    TEXT,
  value_placeholder INTEGER NOT NULL DEFAULT 0,   -- 1 = published as a placeholder (e.g. £1); value_amount is NULL
  deadline          TEXT,                         -- NULL = not published
  published_at      TEXT,
  cpv_codes         TEXT NOT NULL DEFAULT '[]',   -- JSON array
  regions           TEXT NOT NULL DEFAULT '[]',   -- JSON array of recognised region names (regions.js)
  regions_raw       TEXT NOT NULL DEFAULT '[]',   -- JSON array of region values as published (names or NUTS codes)
  procurement_method TEXT,
  link              TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_deadline ON notices (deadline);
CREATE INDEX IF NOT EXISTS notices_published ON notices (published_at);

-- Award notices: one row per ocid + award + supplier. Updated in place by awardUpdate; first_seen_at never changes.
-- Consumers (e.g. Hiring-Signal Scout) keep their own watermark and call newAwardsSince(first_seen_at).
CREATE TABLE IF NOT EXISTS awards (
  ocid               TEXT NOT NULL,
  award_id           TEXT NOT NULL,
  supplier_key       TEXT NOT NULL,               -- supplier id from the notice, else lower-cased name
  source             TEXT NOT NULL,
  release_id         TEXT NOT NULL,               -- latest release (raw JSON in releases)
  release_date       TEXT NOT NULL,
  release_seq        INTEGER NOT NULL DEFAULT 0,
  status             TEXT,                        -- award.status: active | pending | cancelled | unsuccessful | NULL
  supplier_name      TEXT,
  supplier_scheme    TEXT,                        -- GB-COH (Companies House) preferred, else e.g. GB-PPON; NULL when not published
  supplier_identifier TEXT,                       -- e.g. 08259035
  value_amount       REAL,
  value_currency     TEXT,
  award_date         TEXT,
  buyer_id           TEXT,
  buyer_name         TEXT,
  buyer_key          TEXT,
  title              TEXT,
  category           TEXT,                        -- mainProcurementCategory: goods | services | works
  cpv_codes          TEXT NOT NULL DEFAULT '[]',
  link               TEXT,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  PRIMARY KEY (ocid, award_id, supplier_key)
);
CREATE INDEX IF NOT EXISTS awards_first_seen ON awards (first_seen_at);
CREATE INDEX IF NOT EXISTS awards_buyer ON awards (buyer_key);
CREATE INDEX IF NOT EXISTS awards_supplier_identifier ON awards (supplier_scheme, supplier_identifier);

-- Latest score of each notice for each entity.
CREATE TABLE IF NOT EXISTS scores (
  ocid       TEXT NOT NULL REFERENCES notices (ocid),
  entity     TEXT NOT NULL,
  score      INTEGER NOT NULL,
  breakdown  TEXT NOT NULL,                       -- JSON [{component, points, max, reason}]
  gaps       TEXT NOT NULL,                       -- JSON [string]
  scored_at  TEXT NOT NULL,
  PRIMARY KEY (ocid, entity)
);
CREATE INDEX IF NOT EXISTS scores_entity_score ON scores (entity, score);

-- What each entity has been sent. A notice is never posted to the same entity twice.
CREATE TABLE IF NOT EXISTS digests_sent (
  entity   TEXT NOT NULL,
  ocid     TEXT NOT NULL,
  score    INTEGER,
  run_id   INTEGER REFERENCES runs (id),
  sent_at  TEXT NOT NULL,
  PRIMARY KEY (entity, ocid)
);
