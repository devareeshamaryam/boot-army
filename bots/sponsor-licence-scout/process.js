/**
 * B1 processor: raw snapshot → typed state → diffs → spine events.
 *
 * Reads ONLY from the snapshot store, never the network, so any stored file
 * can be re-processed after a parser fix.
 */
import { match, normalizeEntityId } from '@botarmy/core';

export const BOT = 'sponsor-licence-scout';
export const REQUIRED_COLUMNS = ['Organisation Name', 'Town/City', 'County', 'Type & Rating', 'Route'];
export const EVENT_TYPES = Object.freeze({ ADDED: 'SPONSOR_ADDED', REMOVED: 'SPONSOR_REMOVED', DOWNGRADED: 'SPONSOR_DOWNGRADED' });

/** Thrown when a snapshot fails the anomaly checks. Processing halts. */
export class AnomalyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AnomalyError';
    this.details = details;
  }
}

/* --------------------------------------------------------------- parsing */

/** Decode as UTF-8, falling back to Windows-1252. */
export function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export const looksLikeHtml = (text) => /^\s*<(!doctype|html)/i.test(text.slice(0, 300));

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Identity key: normalised name + normalised town. */
export const orgKey = (name, town) => `${match.nameNorm(name)}|${match.nameNorm(town ?? '')}`;

/**
 * "Worker (A rating)"      → { type: "Worker", rating: "A" }
 * "Worker (A (Premium))"   → { type: "Worker", rating: "A (Premium)" }
 */
export function parseTypeAndRating(value) {
  const s = squash(value);
  const open = s.indexOf('(');
  if (open === -1 || !s.endsWith(')')) return { type: s || 'Unknown', rating: 'Unknown' };
  return {
    type: s.slice(0, open).trim() || 'Unknown',
    rating: s.slice(open + 1, -1).replace(/\s*rating$/i, '').trim() || 'Unknown',
  };
}

/** Higher is better. B = on a Home Office action plan. */
export function ratingRank(rating) {
  const r = String(rating ?? '').toLowerCase();
  if (r.startsWith('a')) return r.includes('premium') ? 4 : r.includes('sme') ? 3 : 2;
  if (r.startsWith('b')) return 0;
  return 1; // provisional / unknown
}

/**
 * One record per organisation (the CSV has one row per organisation per route).
 * @returns {{ orgs: Map<string, object>, rowCount: number, skipped: number }}
 */
export function parseRegister(text) {
  const [header = [], ...rows] = parseCsvRows(text);
  const columns = header.map(squash);
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) {
    throw new AnomalyError(`Register CSV is missing column(s): ${missing.join(', ')}. Found: ${columns.join(', ') || '(none)'}`, { kind: 'columns', columns });
  }
  const idx = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, columns.indexOf(c)]));
  const orgs = new Map();
  let rowCount = 0;
  let skipped = 0;

  for (const r of rows) {
    if (!r.some((v) => v.trim() !== '')) continue;
    rowCount += 1;
    const name = squash(r[idx['Organisation Name']]);
    if (!name) { skipped += 1; continue; }
    const town = squash(r[idx['Town/City']]) || null;
    const county = squash(r[idx.County]) || null;
    const { type, rating } = parseTypeAndRating(r[idx['Type & Rating']]);
    const route = squash(r[idx.Route]);

    const key = orgKey(name, town);
    const org = orgs.get(key) ?? { key, name, nameNorm: match.nameNorm(name), town, county, ratings: {}, routes: [] };
    // If one organisation lists different ratings for the same type, keep the worse.
    if (!org.ratings[type] || ratingRank(rating) < ratingRank(org.ratings[type])) org.ratings[type] = rating;
    if (route && !org.routes.includes(route)) org.routes.push(route);
    orgs.set(key, org);
  }
  for (const org of orgs.values()) org.routes.sort();
  return { orgs, rowCount, skipped };
}

/* -------------------------------------------------------------- anomalies */

/**
 * The register must never be diffed from a broken download.
 * @returns {string|null} rejection reason, or null if the snapshot is acceptable
 */
export function anomalyReason({ orgCount, previousOrgCount, minOrgs, maxDropRatio }) {
  if (orgCount === 0) return 'register parsed to 0 sponsors';
  if (orgCount < minOrgs) return `only ${orgCount} sponsors parsed (minimum ${minOrgs})`;
  if (previousOrgCount) {
    const drop = 1 - orgCount / previousOrgCount;
    if (drop > maxDropRatio) {
      return `register shrank ${(drop * 100).toFixed(1)}% (${previousOrgCount} → ${orgCount}); limit ${(maxDropRatio * 100).toFixed(0)}%`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ delta */

function ratingDirection(before, after) {
  let worse = false;
  let better = false;
  for (const type of Object.keys(after)) {
    if (!(type in before) || before[type] === after[type]) continue;
    const d = ratingRank(after[type]) - ratingRank(before[type]);
    if (d < 0) worse = true;
    if (d > 0) better = true;
  }
  return worse ? 'downgrade' : better ? 'upgrade' : 'change';
}

const ratingsDiffer = (before, after) => Object.keys(after).some((t) => t in before && before[t] !== after[t]);

/** One-to-one pairing only: a key seen twice is ambiguous and never paired. */
function uniqueBy(list, keyFn) {
  const m = new Map();
  for (const o of list) {
    const k = keyFn(o);
    m.set(k, m.has(k) ? null : o);
  }
  return m;
}

/**
 * Likely the same sponsor renamed within the same town, e.g. "Acme Care Ltd" →
 * "Acme Care Services Ltd". Conservative: shares ≥ 2 significant tokens and is
 * either near-identical or differs by at most one extra token.
 * @returns {number} 0 (not a rename) or a similarity score 90–100
 */
export function renameSimilarity(a, b) {
  const ta = new Set(match.significantTokens(a));
  const tb = new Set(match.significantTokens(b));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  if (shared < 2) return 0;
  const sort = match.tokenSortRatio(a, b);
  const extra = Math.max(ta.size, tb.size) - shared;
  return sort >= 92 || extra <= 1 ? Math.max(sort, 90) : 0;
}

/**
 * Compare the previous active state with today's register.
 * Relocations (same name, new town) and renames (same town, very similar name)
 * are paired and suppressed instead of reported as remove + add.
 */
export function computeDelta(previous, current) {
  const added = [];
  const removed = [];
  const ratingChanged = [];

  for (const [key, org] of current) {
    const before = previous.get(key);
    if (!before) added.push(org);
    else if (ratingsDiffer(before.ratings, org.ratings)) {
      ratingChanged.push({ before, after: org, direction: ratingDirection(before.ratings, org.ratings) });
    }
  }
  for (const [key, org] of previous) if (!current.has(key)) removed.push(org);

  const suppressed = [];
  const paired = new Set();

  // Relocation: identical normalised name, different town.
  const addedByName = uniqueBy(added, (o) => match.nameNorm(o.name));
  for (const [name, from] of uniqueBy(removed, (o) => match.nameNorm(o.name))) {
    const to = addedByName.get(name);
    if (from && to) {
      suppressed.push({ kind: 'RELOCATED', from, to, similarity: 100 });
      paired.add(from.key).add(to.key);
    }
  }

  // Rename: same town, very similar name, exactly one candidate on each side.
  const byTown = (list) => {
    const m = new Map();
    for (const o of list) {
      if (paired.has(o.key)) continue;
      const t = match.nameNorm(o.town ?? '');
      if (!m.has(t)) m.set(t, []);
      m.get(t).push(o);
    }
    return m;
  };
  const addedByTown = byTown(added);
  for (const [town, removedHere] of byTown(removed)) {
    const addedHere = addedByTown.get(town) ?? [];
    for (const from of removedHere) {
      if (paired.has(from.key)) continue;
      const scored = addedHere
        .filter((a) => !paired.has(a.key))
        .map((to) => ({ to, s: renameSimilarity(from.name, to.name) }))
        .filter((x) => x.s > 0);
      if (scored.length !== 1) continue;
      const rivals = removedHere.filter((r) => !paired.has(r.key) && renameSimilarity(r.name, scored[0].to.name) > 0);
      if (rivals.length !== 1) continue;
      suppressed.push({ kind: 'RENAMED', from, to: scored[0].to, similarity: scored[0].s });
      paired.add(from.key).add(scored[0].to.key);
    }
  }

  return {
    added: added.filter((o) => !paired.has(o.key)),
    removed: removed.filter((o) => !paired.has(o.key)),
    ratingChanged,
    suppressed,
  };
}

/* -------------------------------------------------------------- watchlist */

/**
 * Optional watchlist: companies to star. Matching is by normalised name (the
 * register has no company number); a Companies House number, when given,
 * resolves the spine entity instead of leaving it unresolved.
 */
export function buildWatchMatcher(watchlist = {}) {
  const byName = new Map();
  for (const c of watchlist.companies ?? []) {
    let registryId = null;
    let spineId = null;
    if (c.registrationNumber) {
      try {
        spineId = normalizeEntityId(c.registrationNumber, 'UK');
        registryId = spineId.slice(3);
      } catch {
        // invalid number: keep the name match, leave the entity unresolved
      }
    }
    for (const label of [c.name, ...(c.aliases ?? [])]) byName.set(match.nameNorm(label), { name: c.name, registryId, spineId });
  }
  return (org) => byName.get(match.nameNorm(org.name)) ?? null;
}

/* ---------------------------------------------------------------- process */

const snap = (o) => (o ? JSON.stringify({ ratings: o.ratings, routes: o.routes }) : null);

function loadActive(db) {
  return new Map(db.prepare(`SELECT * FROM sponsors WHERE active = 1`).all().map((r) => [r.org_key, {
    key: r.org_key, name: r.name, town: r.town, county: r.county,
    ratings: JSON.parse(r.ratings), routes: JSON.parse(r.routes),
  }]));
}

/**
 * Process one stored snapshot.
 *
 * Idempotent: a snapshot already processed returns { outcome: 'already-processed' }.
 * Anomalies (0 rows, too few rows, > maxDropRatio shrink, HTML instead of CSV,
 * missing columns) record a 'rejected' row and throw AnomalyError.
 *
 * Order of writes: spine events first (idempotent), then the bot's own state in
 * one transaction. A crash in between cannot duplicate events on the next run.
 *
 * @returns {{ outcome: 'baseline'|'diffed'|'already-processed', stats: object, publishedDate: string|null }}
 */
export function processSnapshot({ db, spine, store, snapshotId, watchMatch = () => null, settings, now = new Date().toISOString(), log }) {
  const meta = store.get(snapshotId);
  if (!meta) throw new Error(`Snapshot ${snapshotId} not found in the store`);
  const publishedDate = meta.meta.publishedDate ?? null;

  const already = db.prepare(`SELECT outcome FROM processed_snapshots WHERE snapshot_id = ?`).get(snapshotId);
  if (already) return { outcome: 'already-processed', previousOutcome: already.outcome, stats: {}, publishedDate };

  const previous = db.prepare(`
    SELECT * FROM processed_snapshots WHERE outcome != 'rejected' ORDER BY processed_at DESC, snapshot_id DESC LIMIT 1`).get();

  const reject = (reason, counts = { rowCount: 0, orgCount: 0 }) => {
    db.prepare(`INSERT INTO processed_snapshots
        (snapshot_id, sha256, source_url, filename, published_date, row_count, org_count, outcome, note, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?)`)
      .run(snapshotId, meta.sha256, meta.url, meta.ref, publishedDate, counts.rowCount, counts.orgCount, reason, now);
    throw new AnomalyError(reason, { snapshotId, filename: meta.ref, previousOrgCount: previous?.org_count ?? null, ...counts });
  };

  const text = decode(store.readRaw(snapshotId));
  if (looksLikeHtml(text)) reject(`expected CSV but snapshot ${snapshotId} is an HTML page`);

  let parsed;
  try {
    parsed = parseRegister(text);
  } catch (err) {
    if (err instanceof AnomalyError) reject(err.message);
    throw err;
  }
  const { orgs, rowCount, skipped } = parsed;
  const reason = anomalyReason({ orgCount: orgs.size, previousOrgCount: previous?.org_count, minOrgs: settings.minOrgs, maxDropRatio: settings.maxDropRatio });
  if (reason) reject(reason, { rowCount, orgCount: orgs.size });

  const isBaseline = !previous;
  const delta = isBaseline ? { added: [], removed: [], ratingChanged: [], suppressed: [] } : computeDelta(loadActive(db), orgs);
  const eventDate = publishedDate ?? now.slice(0, 10);
  const eventSource = `${BOT}:${meta.source}`;

  // 1. Spine: entities + events (idempotent: UNIQUE(source, type, entity_id, event_date)).
  const links = new Map(); // `${orgKey}|${diffType}` -> { entityId, eventId, watch }
  const link = (org, diffType, eventType, extra = {}) => {
    const watch = watchMatch(org);
    const entityId = spine.upsertEntity({
      jurisdiction: 'UK',
      registryId: watch?.registryId ?? null,
      spineId: watch?.spineId ?? null,
      name: org.name,
      locality: watch?.registryId ? null : org.town,
      source: BOT,
      seenAt: now,
    });
    const eventId = eventType
      ? spine.linkEvent({
        entityId, type: eventType, date: eventDate, source: eventSource, detectedAt: now,
        payload: { name: org.name, town: org.town, county: org.county, ratings: org.ratings, routes: org.routes, snapshotId, ...extra },
      }).eventId
      : null;
    links.set(`${org.key}|${diffType}`, { entityId, eventId, watch });
  };

  if (!isBaseline) {
    spine.db.transaction(() => {
      for (const org of delta.added) link(org, 'ADDED', EVENT_TYPES.ADDED);
      for (const org of delta.removed) link(org, 'REMOVED', EVENT_TYPES.REMOVED, { note: 'no longer listed; the register does not publish a reason' });
      for (const c of delta.ratingChanged) {
        link(c.after, 'RATING_CHANGED', c.direction === 'downgrade' ? EVENT_TYPES.DOWNGRADED : null, { previousRatings: c.before.ratings });
      }
    })();
  }

  // 2. Bot state, diffs and audit rows in one transaction.
  const upsert = db.prepare(`
    INSERT INTO sponsors (org_key, name, name_norm, town, county, ratings, routes, first_seen, last_seen, active, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
    ON CONFLICT (org_key) DO UPDATE SET
      name = excluded.name, name_norm = excluded.name_norm, town = excluded.town, county = excluded.county,
      ratings = excluded.ratings, routes = excluded.routes, last_seen = excluded.last_seen,
      first_seen = CASE WHEN sponsors.active = 0 THEN excluded.first_seen ELSE sponsors.first_seen END,
      active = 1, removed_at = NULL`);
  const deactivate = db.prepare(`UPDATE sponsors SET active = 0, removed_at = ? WHERE org_key = ?`);
  const insertDiff = db.prepare(`
    INSERT OR IGNORE INTO sponsor_diffs
      (snapshot_id, org_key, diff_type, direction, name, town, county, old, new, watch_match, entity_id, event_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSuppressed = db.prepare(`
    INSERT OR IGNORE INTO suppressed_changes (snapshot_id, kind, from_key, to_key, from_label, to_label, similarity, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const label = (o) => `${o.name}${o.town ? `, ${o.town}` : ''}`;

  db.transaction(() => {
    for (const org of orgs.values()) {
      upsert.run(org.key, org.name, org.nameNorm, org.town, org.county, JSON.stringify(org.ratings), JSON.stringify(org.routes), now, now);
    }
    for (const s of delta.suppressed) {
      deactivate.run(now, s.from.key);
      insertSuppressed.run(snapshotId, s.kind, s.from.key, s.to.key, label(s.from), label(s.to), s.similarity, now);
    }
    for (const org of delta.added) {
      const l = links.get(`${org.key}|ADDED`);
      insertDiff.run(snapshotId, org.key, 'ADDED', null, org.name, org.town, org.county, null, snap(org), l.watch?.name ?? null, l.entityId, l.eventId, now);
    }
    for (const org of delta.removed) {
      deactivate.run(now, org.key);
      const l = links.get(`${org.key}|REMOVED`);
      insertDiff.run(snapshotId, org.key, 'REMOVED', null, org.name, org.town, org.county, snap(org), null, l.watch?.name ?? null, l.entityId, l.eventId, now);
    }
    for (const c of delta.ratingChanged) {
      const l = links.get(`${c.after.key}|RATING_CHANGED`);
      insertDiff.run(snapshotId, c.after.key, 'RATING_CHANGED', c.direction, c.after.name, c.after.town, c.after.county,
        snap(c.before), snap(c.after), l.watch?.name ?? null, l.entityId, l.eventId, now);
    }
    db.prepare(`INSERT INTO processed_snapshots
        (snapshot_id, sha256, source_url, filename, published_date, row_count, org_count, outcome, note, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshotId, meta.sha256, meta.url, meta.ref, publishedDate, rowCount, orgs.size,
        isBaseline ? 'baseline' : 'diffed', isBaseline ? 'first snapshot; no diffs emitted' : null, now);
  })();

  const stats = {
    rowCount,
    orgCount: orgs.size,
    skipped,
    added: delta.added.length,
    removed: delta.removed.length,
    downgraded: delta.ratingChanged.filter((c) => c.direction === 'downgrade').length,
    otherRatingChanges: delta.ratingChanged.filter((c) => c.direction !== 'downgrade').length,
    relocated: delta.suppressed.filter((s) => s.kind === 'RELOCATED').length,
    renamed: delta.suppressed.filter((s) => s.kind === 'RENAMED').length,
    events: [...links.values()].filter((l) => l.eventId).length,
  };
  log?.info(`${isBaseline ? 'Baseline' : 'Diffed'} snapshot ${snapshotId}`, stats);
  return { outcome: isBaseline ? 'baseline' : 'diffed', stats, publishedDate };
}

/* ----------------------------------------------------------- notification */

/** Diffs not yet delivered to Slack (includes ones left over from a failed post). */
export function pendingDiffs(db) {
  return db.prepare(`
    SELECT d.*, p.published_date, p.source_url FROM sponsor_diffs d
    JOIN processed_snapshots p ON p.snapshot_id = d.snapshot_id
    WHERE d.notified_at IS NULL
    ORDER BY (d.watch_match IS NULL), d.diff_type, d.name`).all();
}

export function markNotified(db, ids, now = new Date().toISOString()) {
  const update = db.prepare(`UPDATE sponsor_diffs SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}