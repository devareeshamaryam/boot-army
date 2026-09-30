import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  error        TEXT,
  stats_json   TEXT
);

-- Watchlist firms as last seen, with their cross-jurisdiction spine ID.
CREATE TABLE IF NOT EXISTS firms (
  regulator    TEXT NOT NULL,
  firm_ref     TEXT NOT NULL,             -- FRN, CE number, MAS/DFSA/FSRA firm ref
  name         TEXT NOT NULL,
  market       TEXT NOT NULL,
  tier         INTEGER NOT NULL,
  entity_id    TEXT,                      -- normalizeEntityId() output, e.g. "UK:01026167"
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (regulator, firm_ref)
);

-- One row per roster fetch. Rejected snapshots are kept for auditing but never diffed.
CREATE TABLE IF NOT EXISTS register_snapshots (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  regulator     TEXT NOT NULL,
  firm_ref      TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  record_count  INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'unchanged', 'rejected')),
  joiners       INTEGER NOT NULL DEFAULT 0,
  leavers       INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_firm ON register_snapshots (regulator, firm_ref, id);

-- Current known roster state per firm; the diff baseline.
CREATE TABLE IF NOT EXISTS register_people (
  regulator    TEXT NOT NULL,
  firm_ref     TEXT NOT NULL,
  person_ref   TEXT NOT NULL,             -- IRN, CE number, representative number, etc.
  name         TEXT NOT NULL,
  roles_json   TEXT NOT NULL,             -- [{ title, code?, since? }]
  start_date   TEXT,                      -- earliest role date published by the register
  first_seen   TEXT NOT NULL,             -- when this bot first saw them at this firm
  last_seen    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  left_at      TEXT,
  PRIMARY KEY (regulator, firm_ref, person_ref)
);
CREATE INDEX IF NOT EXISTS idx_people_person ON register_people (regulator, person_ref);

-- Detected changes. A joiner that matches an earlier leaver becomes a "move",
-- and the two source rows point at it via superseded_by.
CREATE TABLE IF NOT EXISTS movers (
  id                  INTEGER PRIMARY KEY,
  run_id              INTEGER NOT NULL REFERENCES runs(id),
  regulator           TEXT NOT NULL,
  person_ref          TEXT NOT NULL,
  name                TEXT NOT NULL,
  change_type         TEXT NOT NULL CHECK (change_type IN ('joiner', 'leaver', 'move')),
  from_firm_ref       TEXT NOT NULL DEFAULT '',
  to_firm_ref         TEXT NOT NULL DEFAULT '',
  to_firm_name        TEXT,                -- destination outside the watchlist, if known
  to_external_ref     TEXT,
  roles_json          TEXT NOT NULL,       -- new-firm roles (joiner/move) or old-firm roles (leaver)
  prev_roles_json     TEXT,                -- old-firm roles (move only)
  tenure_days         INTEGER,
  tenure_is_estimate  INTEGER NOT NULL DEFAULT 0,
  detected_at         TEXT NOT NULL,
  detected_on         TEXT NOT NULL,
  score               INTEGER,
  score_json          TEXT,
  superseded_by       INTEGER REFERENCES movers(id),
  notified_at         TEXT,
  UNIQUE (regulator, person_ref, change_type, from_firm_ref, to_firm_ref, detected_on)
);
CREATE INDEX IF NOT EXISTS idx_movers_digest ON movers (notified_at, superseded_by, score);
CREATE INDEX IF NOT EXISTS idx_movers_person ON movers (regulator, person_ref, change_type);

CREATE TABLE IF NOT EXISTS rss_items (
  id            INTEGER PRIMARY KEY,
  feed_url      TEXT NOT NULL,
  feed_name     TEXT NOT NULL,
  guid          TEXT NOT NULL,
  title         TEXT NOT NULL,
  link          TEXT,
  published_at  TEXT,
  summary       TEXT,
  matched_json  TEXT NOT NULL DEFAULT '[]',   -- watchlist firms / mover names found in the item
  first_seen    TEXT NOT NULL,
  notified_at   TEXT,
  UNIQUE (feed_url, guid)
);
CREATE INDEX IF NOT EXISTS idx_rss_digest ON rss_items (notified_at, first_seen);
`;

const statementCache = new WeakMap();

/** Prepare once per connection and reuse. */
function stmt(db, sql) {
  let cache = statementCache.get(db);
  if (!cache) statementCache.set(db, (cache = new Map()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

const DAY_MS = 86_400_000;
const daysBetween = (fromIso, toIso) =>
  Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS));

const earliestSince = (roles) =>
  roles.map((r) => r.since).filter(Boolean).sort()[0] ?? null;

/** Stable hash of a roster so unchanged days can be skipped cheaply. */
export function rosterHash(records) {
  const canonical = [...records]
    .sort((a, b) => a.personRef.localeCompare(b.personRef))
    .map((r) => [
      r.personRef,
      r.name,
      [...r.roles].map((x) => `${x.title}|${x.since ?? ''}`).sort(),
    ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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

/* ------------------------------------------------------------------ runs */

export function startRun(db, now = new Date().toISOString()) {
  return Number(stmt(db, `INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
}

export function finishRun(db, runId, { status, error = null, stats = null, now = new Date().toISOString() }) {
  stmt(db, `UPDATE runs SET finished_at = ?, status = ?, error = ?, stats_json = ? WHERE id = ?`)
    .run(now, status, error, stats ? JSON.stringify(stats) : null, runId);
}

/* ----------------------------------------------------------------- firms */

export function getFirm(db, regulator, firmRef) {
  return stmt(db, `SELECT * FROM firms WHERE regulator = ? AND firm_ref = ?`).get(regulator, firmRef);
}

export function upsertFirm(db, { regulator, ref, name, market, tier, entityId = null, now = new Date().toISOString() }) {
  stmt(db, `
    INSERT INTO firms (regulator, firm_ref, name, market, tier, entity_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (regulator, firm_ref) DO UPDATE SET
      name = excluded.name,
      market = excluded.market,
      tier = excluded.tier,
      entity_id = COALESCE(excluded.entity_id, firms.entity_id),
      updated_at = excluded.updated_at
  `).run(regulator, ref, name, market, tier, entityId, now);
}

/* ------------------------------------------------------ roster snapshots */

/**
 * Record a freshly fetched roster for one firm and diff it against the stored state.
 *
 * Safety rules (a broken scraper must never announce a mass exodus):
 * - First accepted snapshot for a firm is a baseline: stored, no movers emitted.
 * - An empty roster when people were active before is rejected.
 * - A drop of more than maxDropRatio (for rosters of 10+) is rejected.
 * Rejected snapshots are logged and leave the state untouched.
 *
 * @returns {{ outcome: string, joiners: object[], leavers: object[], note: string|null }}
 */
export function recordRoster(db, { runId, firm, records, now = new Date().toISOString(), maxDropRatio = 0.5 }) {
  const { regulator, ref } = firm;
  const hash = rosterHash(records);
  const today = now.slice(0, 10);

  const lastAccepted = stmt(db, `
    SELECT content_hash FROM register_snapshots
    WHERE regulator = ? AND firm_ref = ? AND outcome != 'rejected'
    ORDER BY id DESC LIMIT 1
  `).get(regulator, ref);

  const active = stmt(db, `
    SELECT * FROM register_people WHERE regulator = ? AND firm_ref = ? AND active = 1
  `).all(regulator, ref);

  const insertSnapshot = (outcome, joiners = 0, leavers = 0, note = null) =>
    stmt(db, `
      INSERT INTO register_snapshots
        (run_id, regulator, firm_ref, fetched_at, record_count, content_hash, outcome, joiners, leavers, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, regulator, ref, now, records.length, hash, outcome, joiners, leavers, note);

  if (lastAccepted && active.length > 0) {
    let note = null;
    if (records.length === 0) {
      note = `empty roster (previously ${active.length} active)`;
    } else if (active.length >= 10 && records.length < active.length * (1 - maxDropRatio)) {
      note = `roster fell from ${active.length} to ${records.length}, above the ${Math.round(maxDropRatio * 100)}% drop limit`;
    }
    if (note) {
      insertSnapshot('rejected', 0, 0, note);
      return { outcome: 'rejected', joiners: [], leavers: [], note };
    }
  }

  const upsertPerson = stmt(db, `
    INSERT INTO register_people
      (regulator, firm_ref, person_ref, name, roles_json, start_date, first_seen, last_seen, active, left_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
    ON CONFLICT (regulator, firm_ref, person_ref) DO UPDATE SET
      name = excluded.name,
      roles_json = excluded.roles_json,
      start_date = COALESCE(excluded.start_date, register_people.start_date),
      first_seen = CASE WHEN register_people.active = 0 THEN excluded.first_seen ELSE register_people.first_seen END,
      last_seen = excluded.last_seen,
      active = 1,
      left_at = NULL
  `);

  const insertMover = stmt(db, `
    INSERT OR IGNORE INTO movers
      (run_id, regulator, person_ref, name, change_type, from_firm_ref, to_firm_ref,
       roles_json, tenure_days, tenure_is_estimate, detected_at, detected_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writeAll = () => {
    for (const r of records) {
      upsertPerson.run(regulator, ref, r.personRef, r.name, JSON.stringify(r.roles), earliestSince(r.roles), now, now);
    }
  };

  return db.transaction(() => {
    if (!lastAccepted) {
      writeAll();
      insertSnapshot('baseline', 0, 0, 'first snapshot; no movers emitted');
      return { outcome: 'baseline', joiners: [], leavers: [], note: null };
    }

    if (lastAccepted.content_hash === hash) {
      stmt(db, `UPDATE register_people SET last_seen = ? WHERE regulator = ? AND firm_ref = ? AND active = 1`)
        .run(now, regulator, ref);
      insertSnapshot('unchanged');
      return { outcome: 'unchanged', joiners: [], leavers: [], note: null };
    }

    const activeByRef = new Map(active.map((p) => [p.person_ref, p]));
    const currentRefs = new Set(records.map((r) => r.personRef));
    const joiners = [];
    const leavers = [];

    for (const r of records) {
      if (activeByRef.has(r.personRef)) continue;
      const info = insertMover.run(
        runId, regulator, r.personRef, r.name, 'joiner', '', ref,
        JSON.stringify(r.roles), null, 0, now, today,
      );
      if (info.changes) joiners.push({ id: Number(info.lastInsertRowid), ...r });
    }

    for (const p of active) {
      if (currentRefs.has(p.person_ref)) continue;
      const since = p.start_date ?? p.first_seen;
      const info = insertMover.run(
        runId, regulator, p.person_ref, p.name, 'leaver', ref, '',
        p.roles_json, daysBetween(since, now), p.start_date ? 0 : 1, now, today,
      );
      stmt(db, `UPDATE register_people SET active = 0, left_at = ? WHERE regulator = ? AND firm_ref = ? AND person_ref = ?`)
        .run(now, regulator, ref, p.person_ref);
      if (info.changes) leavers.push({ id: Number(info.lastInsertRowid), personRef: p.person_ref, name: p.name });
    }

    writeAll();
    insertSnapshot('diffed', joiners.length, leavers.length);
    return { outcome: 'diffed', joiners, leavers, note: null };
  })();
}

/**
 * Pair this run's joiners with a recent leaver of the same person (same
 * regulator, different firm) and replace both with a single "move".
 * @returns {number} Moves created.
 */
export function pairMoves(db, { runId, lookbackDays = 90, now = new Date().toISOString() }) {
  const since = new Date(Date.parse(now) - lookbackDays * DAY_MS).toISOString();

  const joiners = stmt(db, `
    SELECT * FROM movers WHERE run_id = ? AND change_type = 'joiner' AND superseded_by IS NULL
  `).all(runId);

  const findLeaver = stmt(db, `
    SELECT * FROM movers
    WHERE change_type = 'leaver' AND regulator = ? AND person_ref = ?
      AND from_firm_ref != ? AND superseded_by IS NULL AND detected_at >= ?
    ORDER BY detected_at DESC LIMIT 1
  `);

  const insertMove = stmt(db, `
    INSERT OR IGNORE INTO movers
      (run_id, regulator, person_ref, name, change_type, from_firm_ref, to_firm_ref,
       roles_json, prev_roles_json, tenure_days, tenure_is_estimate, detected_at, detected_on)
    VALUES (?, ?, ?, ?, 'move', ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const supersede = stmt(db, `UPDATE movers SET superseded_by = ? WHERE id IN (?, ?)`);

  let created = 0;
  db.transaction(() => {
    for (const j of joiners) {
      const l = findLeaver.get(j.regulator, j.person_ref, j.to_firm_ref, since);
      if (!l) continue;
      const info = insertMove.run(
        runId, j.regulator, j.person_ref, j.name, l.from_firm_ref, j.to_firm_ref,
        j.roles_json, l.roles_json, l.tenure_days, l.tenure_is_estimate, now, now.slice(0, 10),
      );
      if (!info.changes) continue;
      supersede.run(Number(info.lastInsertRowid), j.id, l.id);
      created += 1;
    }
  })();
  return created;
}

export function setMoverDestination(db, moverId, { firmName, firmRef = null }) {
  stmt(db, `UPDATE movers SET to_firm_name = ?, to_external_ref = ? WHERE id = ?`)
    .run(firmName, firmRef, moverId);
}

/* --------------------------------------------------------------- scoring */

export function listUnscoredMovers(db) {
  return stmt(db, `SELECT * FROM movers WHERE score IS NULL AND superseded_by IS NULL`).all();
}

export function saveScore(db, moverId, score, breakdown) {
  stmt(db, `UPDATE movers SET score = ?, score_json = ? WHERE id = ?`)
    .run(score, JSON.stringify(breakdown), moverId);
}

export function listFirms(db) {
  return stmt(db, `SELECT * FROM firms`).all();
}

/* ---------------------------------------------------------------- digest */

export function listDigestMovers(db, { minScore = 0, limit = 15, windowDays = 7, now = new Date().toISOString() }) {
  const since = new Date(Date.parse(now) - windowDays * DAY_MS).toISOString();
  return stmt(db, `
    SELECT m.*,
           ff.name AS from_firm_label, ff.market AS from_market, ff.tier AS from_tier,
           ft.name AS to_firm_label,   ft.market AS to_market,   ft.tier AS to_tier
    FROM movers m
    LEFT JOIN firms ff ON ff.regulator = m.regulator AND ff.firm_ref = m.from_firm_ref
    LEFT JOIN firms ft ON ft.regulator = m.regulator AND ft.firm_ref = m.to_firm_ref
    WHERE m.superseded_by IS NULL
      AND m.notified_at IS NULL
      AND m.score >= ?
      AND m.detected_at >= ?
    ORDER BY m.score DESC, m.detected_at DESC
    LIMIT ?
  `).all(minScore, since, limit);
}

export function recentMoverNames(db, { days = 30, now = new Date().toISOString() } = {}) {
  const since = new Date(Date.parse(now) - days * DAY_MS).toISOString();
  return stmt(db, `SELECT DISTINCT name FROM movers WHERE detected_at >= ?`).all(since).map((r) => r.name);
}

export function markMoversNotified(db, ids, now = new Date().toISOString()) {
  const update = stmt(db, `UPDATE movers SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}

/* ------------------------------------------------------------------- rss */

/** @returns {boolean} true if the item was new. */
export function insertRssItem(db, item, now = new Date().toISOString()) {
  const info = stmt(db, `
    INSERT OR IGNORE INTO rss_items
      (feed_url, feed_name, guid, title, link, published_at, summary, matched_json, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.feedUrl, item.feedName, item.guid, item.title, item.link ?? null,
    item.publishedAt ?? null, item.summary ?? null, JSON.stringify(item.matched ?? []), now,
  );
  return info.changes > 0;
}

export function listDigestNews(db, { limit = 8, windowDays = 7, matchedOnly = true, now = new Date().toISOString() }) {
  const since = new Date(Date.parse(now) - windowDays * DAY_MS).toISOString();
  return stmt(db, `
    SELECT * FROM rss_items
    WHERE notified_at IS NULL AND first_seen >= ?
      AND (? = 0 OR matched_json != '[]')
    ORDER BY COALESCE(published_at, first_seen) DESC
    LIMIT ?
  `).all(since, matchedOnly ? 1 : 0, limit);
}

export function markNewsNotified(db, ids, now = new Date().toISOString()) {
  const update = stmt(db, `UPDATE rss_items SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}