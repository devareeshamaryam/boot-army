import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  stats_json   TEXT,
  error        TEXT
);

-- The target watchlist as last loaded from watchlist.json.
CREATE TABLE IF NOT EXISTS watchlist_companies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  entity_id    TEXT,                     -- normalizeEntityId() output, if a registration number is known
  domain       TEXT,
  country      TEXT,
  ats_type     TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TEXT NOT NULL
);

-- Metadata for every raw response fetched (the bodies themselves are optional files).
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  source        TEXT NOT NULL,
  snapshot_key  TEXT NOT NULL,
  kind          TEXT NOT NULL,           -- awards | jobs | jobFeed | funding
  url           TEXT NOT NULL,
  http_status   INTEGER NOT NULL,
  content_type  TEXT,
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  body_path     TEXT                     -- set when HSS_SAVE_RAW=1
);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_run ON raw_snapshots (run_id);

CREATE TABLE IF NOT EXISTS contract_awards (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  notice_id      TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  supplier_name  TEXT NOT NULL,
  match_method   TEXT NOT NULL,          -- registration | name
  confidence     TEXT NOT NULL,          -- awarded | tenderer
  buyer          TEXT,
  title          TEXT,
  value          REAL,
  currency       TEXT,
  award_date     TEXT,
  url            TEXT,
  first_seen     TEXT NOT NULL,
  UNIQUE (source, notice_id, company_id)
);

-- Every job posting seen, per company and source. Used to tell new postings from old.
CREATE TABLE IF NOT EXISTS job_postings (
  company_id   TEXT NOT NULL,
  source       TEXT NOT NULL,            -- greenhouse | lever | workable | workday | linkedin | indeed | ...
  job_key      TEXT NOT NULL,
  title        TEXT NOT NULL,
  location     TEXT,
  url          TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, source, job_key)
);

-- Daily posting velocity: the series spike detection runs on.
CREATE TABLE IF NOT EXISTS job_velocity (
  company_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  day          TEXT NOT NULL,            -- YYYY-MM-DD
  open_count   INTEGER NOT NULL,
  new_count    INTEGER NOT NULL,
  closed_count INTEGER NOT NULL,
  is_baseline  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, source, day)
);

CREATE TABLE IF NOT EXISTS funding_news (
  id           INTEGER PRIMARY KEY,
  item_key     TEXT NOT NULL UNIQUE,     -- guid or link
  company_id   TEXT NOT NULL,
  title        TEXT NOT NULL,
  link         TEXT,
  feed         TEXT,
  amount       REAL,
  currency     TEXT,
  published    TEXT,
  first_seen   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY,
  signal_type   TEXT NOT NULL CHECK (signal_type IN ('contract_award', 'funding', 'job_spike')),
  company_id    TEXT NOT NULL,
  ref_key       TEXT NOT NULL UNIQUE,    -- prevents the same event signalling twice
  score         REAL NOT NULL,
  summary_json  TEXT NOT NULL,
  detected_at   TEXT NOT NULL,
  notified_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_pending ON signals (notified_at, signal_type);
CREATE INDEX IF NOT EXISTS idx_signals_company ON signals (company_id, signal_type, detected_at);
`;

/**
 * Live: create/migrate data/hiring-signals.db in WAL mode.
 * Dry run: never writes. An existing file is opened without schema or pragma
 * changes; a missing one is replaced by an empty in-memory database.
 */
export function openDb(dbPath, { dryRun = false } = {}) {
  if (dryRun) {
    if (!existsSync(dbPath)) {
      const mem = new Database(':memory:');
      mem.exec(SCHEMA);
      return { db: mem, persistent: false };
    }
    return { db: new Database(dbPath, { fileMustExist: true }), persistent: true };
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return { db, persistent: true };
}

const DAY_MS = 86_400_000;
const dayOffset = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/* ------------------------------------------------------------ runs/state */

export const startRun = (db, now) => Number(db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);

export function finishRun(db, runId, { status, stats = null, error = null, now = new Date().toISOString() }) {
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?`)
    .run(now, status, stats ? JSON.stringify(stats) : null, error, runId);
}

export const getCursor = (db, source) => db.prepare(`SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;

export function setCursors(db, cursors, now) {
  const up = db.prepare(`
    INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `);
  db.transaction(() => { for (const [s, c] of Object.entries(cursors)) if (c) up.run(s, c, now); })();
}

export function syncWatchlist(db, companies, now) {
  const up = db.prepare(`
    INSERT INTO watchlist_companies (id, name, entity_id, domain, country, ats_type, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, entity_id = excluded.entity_id, domain = excluded.domain,
      country = excluded.country, ats_type = excluded.ats_type, active = 1, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    db.prepare(`UPDATE watchlist_companies SET active = 0`).run();
    for (const c of companies) up.run(c.id, c.name, c.entityId ?? null, c.domain ?? null, c.country ?? null, c.ats?.type ?? null, now);
  })();
}

export function recordSnapshots(db, runId, snapshots) {
  const ins = db.prepare(`
    INSERT INTO raw_snapshots (run_id, source, snapshot_key, kind, url, http_status, content_type, bytes, sha256, fetched_at, body_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => snapshots.forEach((s) => ins.run(runId, s.source, s.key, s.kind, s.url, s.status, s.contentType ?? null, s.bytes, s.sha256, s.fetchedAt, s.bodyPath ?? null)))();
}

/* ---------------------------------------------------------------- awards */

export function knownAwardKeys(db) {
  return new Set(db.prepare(`SELECT source || '|' || notice_id || '|' || company_id FROM contract_awards`).pluck().all());
}

export function insertAwards(db, awards, now) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO contract_awards
      (source, notice_id, company_id, supplier_name, match_method, confidence, buyer, title, value, currency, award_date, url, first_seen)
    VALUES (@source, @noticeId, @companyId, @supplierName, @matchMethod, @confidence, @buyer, @title, @value, @currency, @awardDate, @url, @now)
  `);
  return db.transaction(() => awards.reduce((n, a) => n + ins.run({ ...a, now }).changes, 0))();
}

/* ------------------------------------------------------------------ jobs */

export function activeJobKeys(db, companyId, source) {
  return new Set(db.prepare(`SELECT job_key FROM job_postings WHERE company_id = ? AND source = ? AND active = 1`).pluck().all(companyId, source));
}

export function hasJobHistory(db, companyId, source) {
  return Boolean(db.prepare(`SELECT 1 FROM job_velocity WHERE company_id = ? AND source = ? LIMIT 1`).get(companyId, source));
}

/** Apply one board poll: upsert current jobs, close missing ones (complete feeds only), record velocity. */
export function applyBoard(db, { companyId, source, jobs, complete, delta, day, now, isBaseline }) {
  const up = db.prepare(`
    INSERT INTO job_postings (company_id, source, job_key, title, location, url, first_seen, last_seen, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (company_id, source, job_key) DO UPDATE SET title = excluded.title, location = excluded.location,
      url = excluded.url, last_seen = excluded.last_seen,
      first_seen = CASE WHEN job_postings.active = 0 THEN excluded.first_seen ELSE job_postings.first_seen END, active = 1
  `);
  const close = db.prepare(`UPDATE job_postings SET active = 0 WHERE company_id = ? AND source = ? AND job_key = ?`);
  const vel = db.prepare(`
    INSERT INTO job_velocity (company_id, source, day, open_count, new_count, closed_count, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, source, day) DO UPDATE SET open_count = excluded.open_count,
      new_count = job_velocity.new_count + excluded.new_count,
      closed_count = job_velocity.closed_count + excluded.closed_count
  `);
  db.transaction(() => {
    for (const j of jobs) up.run(companyId, source, j.key, j.title, j.location ?? null, j.url ?? null, now, now);
    if (complete) for (const key of delta.closedKeys) close.run(companyId, source, key);
    vel.run(companyId, source, day, jobs.length, isBaseline ? 0 : delta.newKeys.length, complete ? delta.closedKeys.length : 0, isBaseline ? 1 : 0);
  })();
}

/**
 * Velocity inputs for one company across all its sources. Today's postings
 * from this run come from the live poll, so the same maths works in dry runs.
 */
export function velocityHistory(db, companyId, { day, windowDays, baselineWeeks }) {
  const windowStart = dayOffset(day, -(windowDays - 1));
  const baselineStart = dayOffset(windowStart, -baselineWeeks * 7);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN day >= ? AND day < ? AND is_baseline = 0 THEN new_count END), 0) AS window_prior,
      COALESCE(SUM(CASE WHEN day = ? AND is_baseline = 0 THEN new_count END), 0) AS today_prior,
      COALESCE(SUM(CASE WHEN day >= ? AND day < ? AND is_baseline = 0 THEN new_count END), 0) AS baseline_new,
      MIN(day) AS first_day
    FROM job_velocity WHERE company_id = ?
  `).get(windowStart, day, day, baselineStart, windowStart, companyId);
  const trackedDays = row.first_day ? Math.round((Date.parse(day) - Date.parse(row.first_day)) / DAY_MS) : 0;
  // todayPrior: postings already counted by an earlier run today (read before this run writes).
  return { windowPrior: row.window_prior, todayPrior: row.today_prior, baselineNew: row.baseline_new, trackedDays };
}

/* ------------------------------------------------------- funding/signals */

export function knownFundingKeys(db) {
  return new Set(db.prepare(`SELECT item_key FROM funding_news`).pluck().all());
}

export function insertFunding(db, items, now) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO funding_news (item_key, company_id, title, link, feed, amount, currency, published, first_seen)
    VALUES (@itemKey, @companyId, @title, @link, @feed, @amount, @currency, @published, @now)
  `);
  db.transaction(() => items.forEach((i) => ins.run({ ...i, now })))();
}

export function lastSignalAt(db, companyId, type) {
  return db.prepare(`SELECT MAX(detected_at) FROM signals WHERE company_id = ? AND signal_type = ?`).pluck().get(companyId, type);
}

export function knownSignalKeys(db) {
  return new Set(db.prepare(`SELECT ref_key FROM signals`).pluck().all());
}

export function insertSignals(db, signals, now) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO signals (signal_type, company_id, ref_key, score, summary_json, detected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => signals.forEach((s) => ins.run(s.type, s.companyId, s.refKey, s.score, JSON.stringify(s.summary), now)))();
}

export function markSignalsNotified(db, refKeys, now) {
  const up = db.prepare(`UPDATE signals SET notified_at = ? WHERE ref_key = ?`);
  db.transaction(() => refKeys.forEach((k) => up.run(now, k)))();
}

/** Signals stored but never delivered (e.g. Slack was down last run). */
export function pendingSignals(db) {
  return db.prepare(`SELECT * FROM signals WHERE notified_at IS NULL ORDER BY score DESC`).all()
    .map((r) => ({ type: r.signal_type, companyId: r.company_id, refKey: r.ref_key, score: r.score, summary: JSON.parse(r.summary_json) }));
}