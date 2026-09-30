import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'unchanged', 'rejected', 'failed')),
  error        TEXT,
  stats_json   TEXT
);

-- One row per downloaded register file.
CREATE TABLE IF NOT EXISTS register_snapshots (
  id              INTEGER PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES runs(id),
  source_url      TEXT NOT NULL,
  filename        TEXT NOT NULL,
  published_date  TEXT,                 -- from the filename, e.g. 2026-09-30
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  row_count       INTEGER NOT NULL,     -- CSV rows (one per organisation per route)
  org_count       INTEGER NOT NULL,     -- distinct organisations after merging routes
  outcome         TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'unchanged', 'rejected')),
  note            TEXT,
  fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_sha ON register_snapshots (sha256);

-- Current known state of every sponsor ever seen. The diff baseline.
-- The register has no licence number, so identity is normalised name + town.
CREATE TABLE IF NOT EXISTS sponsors (
  org_key       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  town          TEXT,
  county        TEXT,
  ratings_json  TEXT NOT NULL,          -- {"Worker": "A", "Temporary Worker": "B"}
  routes_json   TEXT NOT NULL,          -- ["Skilled Worker", "Scale-up"]
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  removed_at    TEXT
);

CREATE TABLE IF NOT EXISTS sponsor_diffs (
  id            INTEGER PRIMARY KEY,
  snapshot_id   INTEGER NOT NULL REFERENCES register_snapshots(id),
  org_key       TEXT NOT NULL,
  diff_type     TEXT NOT NULL CHECK (diff_type IN ('ADDED', 'REMOVED', 'RATING_CHANGED')),
  direction     TEXT,                   -- RATING_CHANGED only: downgrade | upgrade | change
  name          TEXT NOT NULL,
  town          TEXT,
  county        TEXT,
  old_json      TEXT,                   -- { ratings, routes } before
  new_json      TEXT,                   -- { ratings, routes } after
  watch_match   TEXT,                   -- watchlist company name if it matched
  entity_id     TEXT,                   -- watchlist company's spine ID, if known
  detected_at   TEXT NOT NULL,
  notified_at   TEXT,
  UNIQUE (snapshot_id, org_key, diff_type)
);
CREATE INDEX IF NOT EXISTS idx_diffs_pending ON sponsor_diffs (notified_at, diff_type);
`;

const cache = new WeakMap();
function stmt(db, sql) {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function startRun(db, now) {
  return Number(stmt(db, `INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
}

export function finishRun(db, runId, { status, error = null, stats = null, now = new Date().toISOString() }) {
  stmt(db, `UPDATE runs SET finished_at = ?, status = ?, error = ?, stats_json = ? WHERE id = ?`)
    .run(now, status, error, stats ? JSON.stringify(stats) : null, runId);
}

export function lastAcceptedSnapshot(db) {
  return stmt(db, `
    SELECT * FROM register_snapshots WHERE outcome IN ('baseline', 'diffed') ORDER BY id DESC LIMIT 1
  `).get();
}

export function insertSnapshot(db, s) {
  return Number(stmt(db, `
    INSERT INTO register_snapshots
      (run_id, source_url, filename, published_date, sha256, bytes, row_count, org_count, outcome, note, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.runId, s.url, s.filename, s.publishedDate ?? null, s.sha256, s.bytes, s.rowCount, s.orgCount,
    s.outcome, s.note ?? null, s.now).lastInsertRowid);
}

/** @returns {Map<string, object>} active sponsors keyed by org_key, parsed. */
export function loadActiveSponsors(db) {
  const rows = stmt(db, `SELECT * FROM sponsors WHERE active = 1`).all();
  return new Map(rows.map((r) => [r.org_key, {
    key: r.org_key,
    name: r.name,
    town: r.town,
    county: r.county,
    ratings: JSON.parse(r.ratings_json),
    routes: JSON.parse(r.routes_json),
  }]));
}

/**
 * Write the new register state and its diffs in one transaction, so a crash
 * can never leave state updated without the diffs (or vice versa).
 *
 * @param {object} args
 * @param {Map<string, object>} args.orgs        current register, keyed by org key
 * @param {object} args.delta                    from computeDelta()
 * @param {(org) => { name: string, entityId: string|null } | null} args.watchMatch
 */
export function applyRegister(db, { snapshotId, orgs, delta, now, watchMatch, isBaseline }) {
  const upsert = stmt(db, `
    INSERT INTO sponsors (org_key, name, town, county, ratings_json, routes_json, first_seen, last_seen, active, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
    ON CONFLICT (org_key) DO UPDATE SET
      name = excluded.name, town = excluded.town, county = excluded.county,
      ratings_json = excluded.ratings_json, routes_json = excluded.routes_json,
      first_seen = CASE WHEN sponsors.active = 0 THEN excluded.first_seen ELSE sponsors.first_seen END,
      last_seen = excluded.last_seen, active = 1, removed_at = NULL
  `);
  const remove = stmt(db, `UPDATE sponsors SET active = 0, removed_at = ? WHERE org_key = ?`);
  const insertDiff = stmt(db, `
    INSERT OR IGNORE INTO sponsor_diffs
      (snapshot_id, org_key, diff_type, direction, name, town, county, old_json, new_json, watch_match, entity_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const snap = (o) => (o ? JSON.stringify({ ratings: o.ratings, routes: o.routes }) : null);
  const diff = (type, org, { before = null, after = null, direction = null } = {}) => {
    const watch = watchMatch(org);
    insertDiff.run(snapshotId, org.key, type, direction, org.name, org.town ?? null, org.county ?? null,
      snap(before), snap(after), watch?.name ?? null, watch?.entityId ?? null, now);
  };

  db.transaction(() => {
    for (const org of orgs.values()) {
      upsert.run(org.key, org.name, org.town ?? null, org.county ?? null,
        JSON.stringify(org.ratings), JSON.stringify(org.routes), now, now);
    }
    // Relocations: old key retired quietly, new key already upserted above.
    for (const { from } of delta.relocated) remove.run(now, from.key);
    if (isBaseline) return;

    for (const org of delta.added) diff('ADDED', org, { after: org });
    for (const org of delta.removed) {
      remove.run(now, org.key);
      diff('REMOVED', org, { before: org });
    }
    for (const c of delta.ratingChanged) diff('RATING_CHANGED', c.after, { before: c.before, after: c.after, direction: c.direction });
  })();
}

export function listPendingDiffs(db) {
  return stmt(db, `
    SELECT d.*, s.published_date FROM sponsor_diffs d
    JOIN register_snapshots s ON s.id = d.snapshot_id
    WHERE d.notified_at IS NULL
    ORDER BY (d.watch_match IS NULL), d.diff_type, d.name
  `).all();
}

export function markDiffsNotified(db, ids, now) {
  const update = stmt(db, `UPDATE sponsor_diffs SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}