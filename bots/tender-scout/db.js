/**
 * TenderScout storage: opening the database plus every query the bot runs.
 *
 * Live runs use data/tender-scout-v2.sqlite (the old bot's data/tender-scout.sqlite
 * is never opened). Dry runs use core.db's in-memory copy, so nothing on disk changes.
 */
import { db as coreDb } from '@botarmy/core';

export const DB_NAME = 'tender-scout-v2';
const MIGRATIONS = new URL('./migrations/', import.meta.url);

/** Scratch database for `--dry-run --cache`: kept between dry runs, never the live file. */
export const CACHE_DB_NAME = `${DB_NAME}-dryrun`;

/**
 * @param {{ dryRun?: boolean, cache?: boolean, dataDir?: string }} [options]
 *   dryRun: in-memory copy of the live database (nothing on disk changes)
 *   cache:  (dry runs) use data/tender-scout-v2-dryrun.sqlite on disk instead, so harvested
 *           data and its watermark survive and the next dry run only fetches what is new
 */
export function openDb({ dryRun = false, cache = false, dataDir } = {}) {
  const dir = dataDir ? { dataDir } : {};
  const db = cache ? coreDb.connect(CACHE_DB_NAME, dir) : coreDb.connect(DB_NAME, { dryRun, ...dir });
  try {
    coreDb.migrate(db, MIGRATIONS, { namespace: 'tender-scout' });
    return db;
  } catch (err) {
    coreDb.safeClose(db);
    throw err;
  }
}

const json = (v) => JSON.stringify(v ?? []);

/* ------------------------------------------------------------------ runs */

export function startRun(db, args, now) {
  return db.prepare(`INSERT INTO runs (started_at, args) VALUES (?, ?)`).run(now, JSON.stringify(args)).lastInsertRowid;
}

export function finishRun(db, id, { status, counts, error = null }, now) {
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, counts = ?, error = ? WHERE id = ?`)
    .run(now, status, JSON.stringify(counts ?? {}), error, id);
}

/* ------------------------------------------------------------ watermarks */

export function getWatermark(db, source, stage) {
  return db.prepare(`SELECT published_to FROM watermarks WHERE source = ? AND stage = ?`).pluck().get(source, stage) ?? null;
}

export function setWatermark(db, source, stage, publishedTo, now) {
  db.prepare(`
    INSERT INTO watermarks (source, stage, published_to, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (source, stage) DO UPDATE SET published_to = excluded.published_to, updated_at = excluded.updated_at`)
    .run(source, stage, publishedTo, now);
}

/* -------------------------------------------------------------- releases */

/** Store a raw release once per release id. @returns {boolean} true if it was new */
export function insertRelease(db, { source, stage, release }, now) {
  const r = db.prepare(`
    INSERT OR IGNORE INTO releases (source, release_id, ocid, stage, tag, release_date, raw_json, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(source, release.id, release.ocid, stage, (release.tag ?? []).join(','), release.date ?? null, JSON.stringify(release), now);
  return r.changes > 0;
}

// "Newer" = later release date, or the same date with a higher sequence number.
const NEWER = `excluded.release_date > release_date OR (excluded.release_date = release_date AND excluded.release_seq >= release_seq)`;

/** Insert a normalised notice, or replace it if this release is newer. first_seen_at is kept. */
export function upsertNotice(db, n, now) {
  db.prepare(`
    INSERT INTO notices (ocid, source, release_id, release_date, release_seq, tag, status, title, description, buyer_id, buyer_name, buyer_key,
                         value_amount, value_currency, value_placeholder, deadline, published_at, cpv_codes, regions, regions_raw, procurement_method, link,
                         first_seen_at, last_seen_at)
    VALUES (@ocid, @source, @release_id, @release_date, @release_seq, @tag, @status, @title, @description, @buyer_id, @buyer_name, @buyer_key,
            @value_amount, @value_currency, @value_placeholder, @deadline, @published_at, @cpv_codes, @regions, @regions_raw, @procurement_method, @link,
            @now, @now)
    ON CONFLICT (ocid) DO UPDATE SET
      source = excluded.source, release_id = excluded.release_id, release_date = excluded.release_date, release_seq = excluded.release_seq,
      tag = excluded.tag, status = excluded.status, title = excluded.title, description = excluded.description, buyer_id = excluded.buyer_id,
      buyer_name = excluded.buyer_name, buyer_key = excluded.buyer_key, value_amount = excluded.value_amount,
      value_currency = excluded.value_currency, value_placeholder = excluded.value_placeholder, deadline = excluded.deadline, published_at = excluded.published_at,
      cpv_codes = excluded.cpv_codes, regions = excluded.regions, regions_raw = excluded.regions_raw, procurement_method = excluded.procurement_method,
      link = excluded.link, last_seen_at = excluded.last_seen_at
    WHERE ${NEWER}`)
    .run({ status: null, ...n, value_placeholder: n.value_placeholder ? 1 : 0, cpv_codes: json(n.cpv_codes), regions: json(n.regions), regions_raw: json(n.regions_raw), now });
}

/** Insert an award row, or update it in place if this release is newer. first_seen_at is kept. */
export function upsertAward(db, a, now) {
  db.prepare(`
    INSERT INTO awards (ocid, award_id, supplier_key, source, release_id, release_date, release_seq, status, supplier_name, supplier_scheme,
                        supplier_identifier, value_amount, value_currency, award_date, buyer_id, buyer_name, buyer_key, title, category,
                        cpv_codes, link, first_seen_at, last_seen_at)
    VALUES (@ocid, @award_id, @supplier_key, @source, @release_id, @release_date, @release_seq, @status, @supplier_name, @supplier_scheme,
            @supplier_identifier, @value_amount, @value_currency, @award_date, @buyer_id, @buyer_name, @buyer_key, @title, @category,
            @cpv_codes, @link, @now, @now)
    ON CONFLICT (ocid, award_id, supplier_key) DO UPDATE SET
      source = excluded.source, release_id = excluded.release_id, release_date = excluded.release_date, release_seq = excluded.release_seq,
      status = excluded.status, supplier_name = excluded.supplier_name, supplier_scheme = excluded.supplier_scheme, supplier_identifier = excluded.supplier_identifier,
      value_amount = excluded.value_amount, value_currency = excluded.value_currency, award_date = excluded.award_date,
      buyer_id = excluded.buyer_id, buyer_name = excluded.buyer_name, buyer_key = excluded.buyer_key, title = excluded.title,
      category = excluded.category, cpv_codes = excluded.cpv_codes, link = excluded.link, last_seen_at = excluded.last_seen_at
    WHERE ${NEWER}`)
    .run({ status: null, ...a, cpv_codes: json(a.cpv_codes), now });
}

const parseAward = (r) => ({ ...r, cpv_codes: JSON.parse(r.cpv_codes) });

/** Award statuses that mean "this supplier did not win". */
export const NOT_WON = Object.freeze(['cancelled', 'unsuccessful']);
const WON = `(status IS NULL OR status NOT IN (${NOT_WON.map((s) => `'${s}'`).join(', ')}))`;

/** Tender statuses that mean "no longer open for bids". */
export const CLOSED = Object.freeze(['cancelled', 'withdrawn', 'complete', 'unsuccessful']);
const OPEN = `(status IS NULL OR status NOT IN (${CLOSED.map((s) => `'${s}'`).join(', ')}))`;

/**
 * Awards first seen after `since` (exclusive), oldest first. For consumers such as
 * Hiring-Signal Scout: store the largest first_seen_at you processed and pass it next time.
 * Cancelled and unsuccessful awards are left out unless includeNotWon is set; a later
 * awardUpdate can change a row's status without changing its first_seen_at.
 * @param {string} since  UTC ISO timestamp
 * @param {{ limit?: number, includeNotWon?: boolean }} [options]
 */
export function newAwardsSince(db, since, { limit = 10_000, includeNotWon = false } = {}) {
  return db.prepare(`SELECT * FROM awards WHERE first_seen_at > ? ${includeNotWon ? '' : `AND ${WON}`}
    ORDER BY first_seen_at, ocid, award_id, supplier_key LIMIT ?`)
    .all(since, limit).map(parseAward);
}

/** How many awards we hold for this buyer, and how many fall under any of the CPV prefixes. */
export function buyerHistory(db, buyerKey, cpvPrefixes = []) {
  if (!buyerKey) return { total: 0, inCategory: 0 };
  const rows = db.prepare(`SELECT cpv_codes FROM awards WHERE buyer_key = ? AND ${WON}`).pluck().all(buyerKey);
  const inCategory = rows.filter((c) => JSON.parse(c).some((code) => cpvPrefixes.some((p) => code.startsWith(p)))).length;
  return { total: rows.length, inCategory };
}

/* --------------------------------------------------------------- scoring */

const parseNotice = (r) => ({
  ...r, value_placeholder: Boolean(r.value_placeholder), cpv_codes: JSON.parse(r.cpv_codes), regions: JSON.parse(r.regions), regions_raw: JSON.parse(r.regions_raw),
});

/** Notices still worth scoring: not closed, deadline in the future (or unknown), published in the last `days`. */
export function openNotices(db, now, { days = 30 } = {}) {
  const from = new Date(Date.parse(now) - days * 86_400_000).toISOString();
  return db.prepare(`SELECT * FROM notices WHERE ${OPEN} AND (deadline IS NULL OR deadline > ?) AND published_at >= ? ORDER BY published_at DESC`)
    .all(now, from).map(parseNotice);
}

export function saveScore(db, ocid, entity, { score, breakdown, gaps }, now) {
  db.prepare(`
    INSERT INTO scores (ocid, entity, score, breakdown, gaps, scored_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (ocid, entity) DO UPDATE SET score = excluded.score, breakdown = excluded.breakdown, gaps = excluded.gaps, scored_at = excluded.scored_at`)
    .run(ocid, entity, score, JSON.stringify(breakdown), JSON.stringify(gaps), now);
}

/** Remove a stale score (e.g. the notice is now excluded for this entity). */
export function deleteScore(db, ocid, entity) {
  db.prepare(`DELETE FROM scores WHERE ocid = ? AND entity = ?`).run(ocid, entity);
}

/* ---------------------------------------------------------------- digest */

/** Top unsent, still-open notices for an entity, best score first. */
export function digestCandidates(db, entity, now, limit) {
  return db.prepare(`
    SELECT n.*, s.score, s.breakdown, s.gaps FROM scores s
    JOIN notices n ON n.ocid = s.ocid
    WHERE s.entity = ? AND (n.deadline IS NULL OR n.deadline > ?) AND (n.status IS NULL OR n.status NOT IN (${CLOSED.map((x) => `'${x}'`).join(', ')}))
      AND NOT EXISTS (SELECT 1 FROM digests_sent d WHERE d.entity = s.entity AND d.ocid = s.ocid)
    ORDER BY s.score DESC, n.published_at DESC
    LIMIT ?`)
    .all(entity, now, limit)
    .map((r) => ({ ...parseNotice(r), score: { score: r.score, breakdown: JSON.parse(r.breakdown), gaps: JSON.parse(r.gaps) } }));
}

export function markSent(db, entity, items, runId, now) {
  const insert = db.prepare(`INSERT OR IGNORE INTO digests_sent (entity, ocid, score, run_id, sent_at) VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => items.forEach((n) => insert.run(entity, n.ocid, n.score?.score ?? null, runId, now)))();
}
