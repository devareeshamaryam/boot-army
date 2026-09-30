import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  error        TEXT,
  stats_json   TEXT
);

-- Per-source polling cursor (timestamp, or JSON for sources that need more).
CREATE TABLE IF NOT EXISTS harvest_state (
  source      TEXT PRIMARY KEY,
  cursor      TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,           -- watchlist slug
  name        TEXT NOT NULL,
  domain      TEXT,
  entity_id   TEXT,                       -- normalizeEntityId() output, if known
  updated_at  TEXT NOT NULL
);

-- Contract awards won (or tendered for) by a watchlist company.
CREATE TABLE IF NOT EXISTS award_records (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,           -- contractsFinder | findATender | ted | gebiz | hk:<name>
  notice_id      TEXT NOT NULL,
  company_id     TEXT NOT NULL REFERENCES companies(id),
  supplier_name  TEXT NOT NULL,
  match_method   TEXT NOT NULL,           -- registration | name
  confidence     TEXT NOT NULL,           -- awarded | tenderer
  buyer          TEXT,
  title          TEXT,
  value          REAL,
  currency       TEXT,
  award_date     TEXT,
  published_at   TEXT,
  url            TEXT,
  first_seen     TEXT NOT NULL,
  processed_at   TEXT,
  UNIQUE (source, notice_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_awards_pending ON award_records (processed_at, first_seen);

-- One row per ATS poll of one company.
CREATE TABLE IF NOT EXISTS ats_snapshots (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  company_id    TEXT NOT NULL REFERENCES companies(id),
  ats_type      TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  open_count    INTEGER NOT NULL,
  new_count     INTEGER NOT NULL DEFAULT 0,
  closed_count  INTEGER NOT NULL DEFAULT 0,
  complete      INTEGER NOT NULL,          -- 0 if the feed was truncated (closures not inferred)
  outcome       TEXT NOT NULL CHECK (outcome IN ('baseline', 'diffed', 'rejected')),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_ats_snapshots_company ON ats_snapshots (company_id, id);

-- Every job seen on a company's board. first_seen drives spike detection.
CREATE TABLE IF NOT EXISTS ats_jobs (
  company_id     TEXT NOT NULL REFERENCES companies(id),
  job_key        TEXT NOT NULL,
  title          TEXT NOT NULL,
  location       TEXT,
  department     TEXT,
  url            TEXT,
  matches_focus  INTEGER NOT NULL DEFAULT 1,
  is_baseline    INTEGER NOT NULL DEFAULT 0,  -- present at the first snapshot, never counted as new
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  closed_at      TEXT,
  PRIMARY KEY (company_id, job_key)
);
CREATE INDEX IF NOT EXISTS idx_ats_jobs_new ON ats_jobs (company_id, is_baseline, first_seen);

CREATE TABLE IF NOT EXISTS hiring_spikes (
  id                  INTEGER PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  detected_at         TEXT NOT NULL,
  window_days         INTEGER NOT NULL,
  new_jobs            INTEGER NOT NULL,
  baseline_weekly     REAL,               -- NULL while history is too short
  threshold           INTEGER NOT NULL,
  sample_titles_json  TEXT NOT NULL,
  processed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_spikes_company ON hiring_spikes (company_id, detected_at);

-- Decision-maker contacts, cached to avoid re-spending enrichment credits.
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  source        TEXT NOT NULL,             -- apollo | lusha
  external_id   TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  title         TEXT,
  email         TEXT,
  email_status  TEXT,
  phone         TEXT,                      -- only numbers not flagged do-not-call
  linkedin_url  TEXT,
  fetched_at    TEXT NOT NULL,
  UNIQUE (company_id, source, external_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id           INTEGER PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  signal_type  TEXT NOT NULL CHECK (signal_type IN ('contract_award', 'hiring_spike')),
  signal_id    INTEGER NOT NULL,
  contact_id   INTEGER REFERENCES contacts(id),
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  template     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approving', 'approved', 'sent', 'rejected', 'failed')),
  created_at   TEXT NOT NULL,
  posted_at    TEXT,                       -- when it was posted to Slack for approval
  decided_by   TEXT,
  decided_at   TEXT,
  sent_at      TEXT,
  error        TEXT,
  UNIQUE (signal_type, signal_id)
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status, posted_at);
CREATE INDEX IF NOT EXISTS idx_proposals_company ON proposals (company_id, created_at);
`;

const cache = new WeakMap();
function stmt(db, sql) {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

const DAY_MS = 86_400_000;
const daysAgo = (now, days) => new Date(Date.parse(now) - days * DAY_MS).toISOString();

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // lets server.js and index.js share the file
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/* ------------------------------------------------------------------ runs */

export function startRun(db, now) {
  return Number(stmt(db, `INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
}

export function finishRun(db, runId, { status, error = null, stats = null, now = new Date().toISOString() }) {
  stmt(db, `UPDATE runs SET finished_at = ?, status = ?, error = ?, stats_json = ? WHERE id = ?`)
    .run(now, status, error, stats ? JSON.stringify(stats) : null, runId);
}

/* --------------------------------------------------------- harvest state */

export function getCursor(db, source) {
  return stmt(db, `SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;
}

export function setCursor(db, source, cursor, now) {
  stmt(db, `
    INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `).run(source, cursor, now);
}

/* ------------------------------------------------------------- companies */

export function upsertCompanies(db, companies, now) {
  const up = stmt(db, `
    INSERT INTO companies (id, name, domain, entity_id, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, domain = excluded.domain,
      entity_id = excluded.entity_id, updated_at = excluded.updated_at
  `);
  db.transaction(() => companies.forEach((c) => up.run(c.id, c.name, c.domain ?? null, c.entityId ?? null, now)))();
}

/* ---------------------------------------------------------------- awards */

/** @returns {boolean} true if new. */
export function insertAward(db, a, now) {
  return stmt(db, `
    INSERT OR IGNORE INTO award_records
      (source, notice_id, company_id, supplier_name, match_method, confidence, buyer, title,
       value, currency, award_date, published_at, url, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.source, a.noticeId, a.companyId, a.supplierName, a.matchMethod, a.confidence, a.buyer ?? null,
    a.title ?? null, a.value ?? null, a.currency ?? null, a.awardDate ?? null, a.publishedAt ?? null,
    a.url ?? null, now,
  ).changes > 0;
}

export function listPendingAwards(db) {
  return stmt(db, `SELECT * FROM award_records WHERE processed_at IS NULL ORDER BY value DESC NULLS LAST, id`).all();
}

export function markAwardProcessed(db, id, now) {
  stmt(db, `UPDATE award_records SET processed_at = ? WHERE id = ?`).run(now, id);
}

/* ------------------------------------------------------------------- ATS */

/**
 * Store one board poll and diff it against the known jobs.
 * - First accepted snapshot: baseline (jobs stored, none counted as new).
 * - Empty board, or a drop beyond maxDropRatio, when jobs were open before: rejected.
 * - Truncated feeds (complete=false) add new jobs but never close missing ones.
 */
export function recordAtsSnapshot(db, { runId, company, atsType, jobs, complete, focus, now, maxDropRatio = 0.6 }) {
  const prev = stmt(db, `
    SELECT 1 FROM ats_snapshots WHERE company_id = ? AND outcome != 'rejected' LIMIT 1
  `).get(company.id);
  const active = stmt(db, `SELECT job_key FROM ats_jobs WHERE company_id = ? AND active = 1`).all(company.id);

  const snapshot = (outcome, newCount = 0, closedCount = 0, note = null) =>
    stmt(db, `
      INSERT INTO ats_snapshots (run_id, company_id, ats_type, fetched_at, open_count, new_count, closed_count, complete, outcome, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, company.id, atsType, now, jobs.length, newCount, closedCount, complete ? 1 : 0, outcome, note);

  if (prev && active.length > 0) {
    let note = null;
    if (jobs.length === 0) note = `empty board (previously ${active.length} open)`;
    else if (complete && active.length >= 10 && jobs.length < active.length * (1 - maxDropRatio)) {
      note = `board fell from ${active.length} to ${jobs.length} jobs, above the drop limit`;
    }
    if (note) {
      snapshot('rejected', 0, 0, note);
      return { outcome: 'rejected', newJobs: 0, closed: 0, note };
    }
  }

  const upsert = stmt(db, `
    INSERT INTO ats_jobs (company_id, job_key, title, location, department, url, matches_focus, is_baseline, first_seen, last_seen, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (company_id, job_key) DO UPDATE SET
      title = excluded.title, location = excluded.location, department = excluded.department,
      url = excluded.url, matches_focus = excluded.matches_focus, last_seen = excluded.last_seen,
      first_seen = CASE WHEN ats_jobs.active = 0 THEN excluded.first_seen ELSE ats_jobs.first_seen END,
      is_baseline = CASE WHEN ats_jobs.active = 0 THEN 0 ELSE ats_jobs.is_baseline END,
      active = 1, closed_at = NULL
  `);

  return db.transaction(() => {
    const activeKeys = new Set(active.map((j) => j.job_key));
    const seenKeys = new Set();
    let newJobs = 0;

    for (const job of jobs) {
      if (seenKeys.has(job.key)) continue;
      seenKeys.add(job.key);
      if (prev && !activeKeys.has(job.key)) newJobs += 1;
      const matches = focus ? (focus.test(`${job.title} ${job.department ?? ''}`) ? 1 : 0) : 1;
      upsert.run(company.id, job.key, job.title, job.location ?? null, job.department ?? null,
        job.url ?? null, matches, prev ? 0 : 1, now, now);
    }

    if (!prev) {
      snapshot('baseline', 0, 0, 'first snapshot; existing jobs are the baseline');
      return { outcome: 'baseline', newJobs: 0, closed: 0, note: null };
    }

    let closed = 0;
    if (complete) {
      const close = stmt(db, `UPDATE ats_jobs SET active = 0, closed_at = ? WHERE company_id = ? AND job_key = ?`);
      for (const key of activeKeys) {
        if (!seenKeys.has(key)) { close.run(now, company.id, key); closed += 1; }
      }
    }
    snapshot('diffed', newJobs, closed, complete ? null : 'feed truncated; closures not inferred');
    return { outcome: 'diffed', newJobs, closed, note: null };
  })();
}

/** Inputs for spike detection. */
export function spikeStats(db, companyId, { now, windowDays, baselineWeeks, focusOnly }) {
  const windowStart = daysAgo(now, windowDays);
  const baselineStart = daysAgo(now, windowDays + baselineWeeks * 7);
  const focus = focusOnly ? 'AND matches_focus = 1' : '';

  const inWindow = stmt(db, `
    SELECT title FROM ats_jobs
    WHERE company_id = ? AND is_baseline = 0 AND first_seen >= ? ${focus}
    ORDER BY first_seen DESC
  `).all(companyId, windowStart);

  const baselineCount = stmt(db, `
    SELECT COUNT(*) AS n FROM ats_jobs
    WHERE company_id = ? AND is_baseline = 0 AND first_seen >= ? AND first_seen < ? ${focus}
  `).get(companyId, baselineStart, windowStart).n;

  const firstSnapshot = stmt(db, `
    SELECT MIN(fetched_at) AS t FROM ats_snapshots WHERE company_id = ? AND outcome != 'rejected'
  `).get(companyId).t;

  const lastSpike = stmt(db, `SELECT MAX(detected_at) AS t FROM hiring_spikes WHERE company_id = ?`).get(companyId).t;

  return {
    newTitles: inWindow.map((r) => r.title),
    baselineCount,
    trackedDays: firstSnapshot ? (Date.parse(now) - Date.parse(firstSnapshot)) / DAY_MS : 0,
    lastSpikeAt: lastSpike,
  };
}

export function insertSpike(db, s, now) {
  return Number(stmt(db, `
    INSERT INTO hiring_spikes (company_id, detected_at, window_days, new_jobs, baseline_weekly, threshold, sample_titles_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(s.companyId, now, s.windowDays, s.newJobs, s.baselineWeekly, s.threshold, JSON.stringify(s.sampleTitles)).lastInsertRowid);
}

export function listPendingSpikes(db) {
  return stmt(db, `SELECT * FROM hiring_spikes WHERE processed_at IS NULL ORDER BY new_jobs DESC`).all();
}

export function markSpikeProcessed(db, id, now) {
  stmt(db, `UPDATE hiring_spikes SET processed_at = ? WHERE id = ?`).run(now, id);
}

/* -------------------------------------------------------------- contacts */

export function getCachedContacts(db, companyId, { now, cacheDays }) {
  return stmt(db, `
    SELECT * FROM contacts WHERE company_id = ? AND fetched_at >= ? ORDER BY (email IS NULL), id
  `).all(companyId, daysAgo(now, cacheDays));
}

export function saveContact(db, c, now) {
  stmt(db, `
    INSERT INTO contacts (company_id, source, external_id, full_name, title, email, email_status, phone, linkedin_url, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, source, external_id) DO UPDATE SET
      full_name = excluded.full_name, title = excluded.title, email = excluded.email,
      email_status = excluded.email_status, phone = excluded.phone,
      linkedin_url = excluded.linkedin_url, fetched_at = excluded.fetched_at
  `).run(c.companyId, c.source, c.externalId, c.fullName, c.title ?? null, c.email ?? null,
    c.emailStatus ?? null, c.phone ?? null, c.linkedinUrl ?? null, now);
  return stmt(db, `SELECT * FROM contacts WHERE company_id = ? AND source = ? AND external_id = ?`)
    .get(c.companyId, c.source, c.externalId);
}

/* ------------------------------------------------------------- proposals */

export function companyInCooldown(db, companyId, { now, days }) {
  return Boolean(stmt(db, `
    SELECT 1 FROM proposals WHERE company_id = ? AND created_at >= ? AND status != 'rejected' LIMIT 1
  `).get(companyId, daysAgo(now, days)));
}

export function insertProposal(db, p, now) {
  const info = stmt(db, `
    INSERT OR IGNORE INTO proposals (company_id, signal_type, signal_id, contact_id, subject, body, template, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.companyId, p.signalType, p.signalId, p.contactId ?? null, p.subject, p.body, p.template, now);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export function listUnpostedProposals(db, limit) {
  return stmt(db, `
    SELECT p.*, c.name AS company_name, c.domain AS company_domain,
           k.full_name AS contact_name, k.title AS contact_title, k.email AS contact_email,
           k.email_status AS contact_email_status, k.linkedin_url AS contact_linkedin
    FROM proposals p
    JOIN companies c ON c.id = p.company_id
    LEFT JOIN contacts k ON k.id = p.contact_id
    WHERE p.status = 'pending' AND p.posted_at IS NULL
    ORDER BY p.id LIMIT ?
  `).all(limit);
}

export function getProposal(db, id) {
  return stmt(db, `
    SELECT p.*, c.name AS company_name, c.domain AS company_domain,
           k.full_name AS contact_name, k.title AS contact_title, k.email AS contact_email,
           k.email_status AS contact_email_status, k.linkedin_url AS contact_linkedin
    FROM proposals p
    JOIN companies c ON c.id = p.company_id
    LEFT JOIN contacts k ON k.id = p.contact_id
    WHERE p.id = ?
  `).get(id);
}

export function markProposalPosted(db, id, now) {
  stmt(db, `UPDATE proposals SET posted_at = ? WHERE id = ?`).run(now, id);
}

/**
 * Atomically move a proposal from `from` to `to`. Returns false if another
 * click (or process) already moved it, which is what prevents double sends.
 */
export function transitionProposal(db, id, from, to, { by = null, error = null, now = new Date().toISOString() } = {}) {
  const sentAt = to === 'sent' ? now : null;
  return stmt(db, `
    UPDATE proposals
    SET status = ?, decided_by = COALESCE(?, decided_by), decided_at = COALESCE(decided_at, ?),
        sent_at = COALESCE(?, sent_at), error = ?
    WHERE id = ? AND status = ?
  `).run(to, by, now, sentAt, error, id, from).changes > 0;
}

/* --------------------------------------------------------------- lookups */

export function getAward(db, id) {
  return stmt(db, `SELECT * FROM award_records WHERE id = ?`).get(id);
}

export function getSpike(db, id) {
  return stmt(db, `SELECT * FROM hiring_spikes WHERE id = ?`).get(id);
}