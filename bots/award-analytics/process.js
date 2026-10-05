/**
 * B6 processor: raw award snapshots → contract_awards + award_suppliers →
 * spine entities, review queue, AWARD_ANALYTICS_UPDATED events.
 *
 * Reads only the snapshot store. Idempotent: an award (source, notice, award id)
 * is stored once; re-processing changes nothing.
 */
import { match, normalizeEntityId } from '@botarmy/core';
import { buyerKeyOf, countryOf, cpvDivisionOf } from './analytics.js';
import { SOURCE_IDS } from './harvest.js';

export const BOT = 'award-analytics';
export const EVENT_TYPE = 'AWARD_ANALYTICS_UPDATED';
const DAY_MS = 86_400_000;

/* ========================================================= safe parsing */

export function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}
const json = (buffer, what) => {
  try {
    return JSON.parse(decode(buffer));
  } catch {
    throw new Error(`${what}: response is not valid JSON`);
  }
};

/** Finite number or null. Number(null) is 0, which would invent a value. */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).replace(/[,\s£€$]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const toIntOrNull = (v) => {
  const n = toNumberOrNull(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};

const pad = (n) => String(n).padStart(2, '0');
export function toIsoDate(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

const clean = (s) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const LANG = ['eng', 'ENG', 'en'];
function firstText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(firstText).find(Boolean) ?? null;
  if (typeof v === 'object') { const k = LANG.find((x) => x in v) ?? Object.keys(v)[0]; return k ? firstText(v[k]) : null; }
  return null;
}
function allTexts(v) {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(allTexts);
  if (typeof v === 'object') { const k = LANG.find((x) => x in v) ?? Object.keys(v)[0]; return k ? allTexts(v[k]) : []; }
  return [];
}
const cpvCodes = (values) => [...new Set(values.map((c) => String(c ?? '').replace(/-\d$/, '').trim()).filter((c) => /^\d{8}$/.test(c)))];

/* ============================================================ suppliers */

const JV_RE = /\b(joint venture|consortium|jv)\b|\b(ltd|limited|plc|llp|inc|gmbh|sa|bv)\b.*\s(and|&)\s.*\b(ltd|limited|plc|llp|inc|gmbh|sa|bv)\b/i;
export const isJointVenture = (name) => JV_RE.test(String(name ?? ''));

/**
 * Supplier identity: Companies House number when the notice carries one (GB-COH),
 * else the company's core name. The raw name is always kept alongside.
 */
export function supplierIdentity({ name, identifiers = [] }) {
  for (const id of identifiers) {
    if (String(id?.scheme ?? '').toUpperCase() !== 'GB-COH' || !id?.id) continue;
    try {
      return { supplierKey: normalizeEntityId(String(id.id), 'UK'), matchMethod: 'registry' };
    } catch {
      // malformed number in the notice: fall through to the name
    }
  }
  const core = match.companyCore(name) || match.nameNorm(name);
  return { supplierKey: `name:${core}`, matchMethod: 'name' };
}

/* ============================================================== parsers */

const AWARD_TAGS = new Set(['award', 'awardUpdate', 'contract', 'contractUpdate']);
const DEAD = /cancel|unsuccessful|withdrawn/i;

function noticeUrl(sourceId, release) {
  if (sourceId === 'contractsFinder') {
    const guid = String(release.id ?? '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    return guid ? `https://www.contractsfinder.service.gov.uk/Notice/${guid}` : null;
  }
  return /^\d{6}-\d{4}$/.test(release.id ?? '') ? `https://www.find-tender.service.gov.uk/Notice/${release.id}` : null;
}

function tenderersOf(release) {
  const direct = toIntOrNull(release.tender?.numberOfTenderers);
  if (direct !== null) return direct;
  const stat = (release.bids?.statistics ?? []).find((s) => /^(bids|validBids)$/.test(s?.measure ?? ''));
  return toIntOrNull(stat?.value);
}

/**
 * OCDS release package → awards. Framework agreements are flagged: their value is a ceiling,
 * not a contract value. Missing values, dates, CPV codes and tenderer counts stay null.
 */
export function parseOcdsAwards(buffer, sourceId) {
  const body = json(buffer, sourceId);
  if (!body || typeof body !== 'object' || (body.releases !== undefined && !Array.isArray(body.releases))) throw new Error(`${sourceId}: unexpected response shape`);
  const out = [];
  for (const release of body.releases ?? []) {
    const tags = [release.tag].flat();
    if (!tags.some((t) => AWARD_TAGS.has(t)) && !(release.awards ?? []).length) continue;
    const parties = new Map((release.parties ?? []).map((p) => [p.id, p]));
    const buyerParty = (release.parties ?? []).find((p) => (p.roles ?? []).includes('buyer'));
    const buyerName = clean(release.buyer?.name) ?? clean(buyerParty?.name);
    if (!buyerName) continue;
    const country = countryOf(buyerParty?.address?.countryName ?? 'UK');
    const tenderCpv = [release.tender?.classification?.id, ...(release.tender?.items ?? []).map((i) => i?.classification?.id)];
    const framework = release.tender?.techniques?.hasFrameworkAgreement === true
      || /framework/i.test(`${release.tender?.title ?? ''} ${release.tender?.procurementMethodDetails ?? ''}`);
    for (const award of release.awards ?? []) {
      if (DEAD.test(award.status ?? '')) continue;
      const suppliers = (award.suppliers ?? []).map((s) => {
        const party = parties.get(s.id) ?? {};
        const identifiers = [party.identifier, ...(party.additionalIdentifiers ?? [])].filter(Boolean).map((i) => ({ scheme: i.scheme, id: i.id }));
        return { name: clean(s.name ?? party.name), identifiers };
      }).filter((s) => s.name);
      if (!suppliers.length) continue;
      const value = toNumberOrNull(award.value?.amount);
      const cpv = cpvCodes([...(award.items ?? []).map((i) => i?.classification?.id), ...tenderCpv]);
      const isFramework = framework || /framework/i.test(award.title ?? '');
      out.push({
        source: sourceId, noticeId: String(release.ocid ?? release.id), awardRef: String(award.id ?? '0'),
        buyerName, buyerCountry: country, title: clean(award.title ?? release.tender?.title),
        value, currency: value === null ? null : clean(award.value?.currency),
        valueKind: value === null ? 'unknown' : isFramework ? 'framework_ceiling' : 'contract',
        awardDate: toIsoDate(award.date ?? award.datePublished ?? release.date), cpv, numberOfTenderers: tenderersOf(release),
        confidence: 'awarded', url: noticeUrl(sourceId, release), suppliers,
      });
    }
  }
  return out;
}

/**
 * TED notices → awards. TED lists tenderers on award notices, usually but not always the
 * winners: confidence "tenderer", excluded from win shares unless configured.
 */
export function parseTedAwards(buffer, meta = {}) {
  const body = json(buffer, 'ted');
  if (!body || !Array.isArray(body.notices ?? [])) throw new Error('ted: unexpected response shape');
  const cpvField = meta.cpvField === undefined ? 'classification-cpv' : meta.cpvField;
  const out = [];
  for (const n of body.notices ?? []) {
    const pubNo = firstText(n['publication-number']);
    const buyerName = clean(firstText(n['buyer-name']));
    const names = [...new Set(allTexts(n['organisation-name-tenderer']).map(clean).filter(Boolean))];
    if (!pubNo || !buyerName || !names.length) continue;
    const value = meta.valueField ? toNumberOrNull(firstText(n[meta.valueField])) : null;
    out.push({
      source: 'ted', noticeId: pubNo, awardRef: pubNo, buyerName,
      buyerCountry: countryOf(meta.countryField ? firstText(n[meta.countryField]) ?? 'EU' : 'EU'),
      title: clean(firstText(n['notice-title'])), value,
      currency: value !== null && meta.currencyField ? clean(firstText(n[meta.currencyField])) : null,
      valueKind: value === null ? 'unknown' : 'contract',
      awardDate: toIsoDate(firstText(n['publication-date'])), cpv: cpvField ? cpvCodes(allTexts(n[cpvField])) : [],
      numberOfTenderers: null, confidence: 'tenderer',
      url: `https://ted.europa.eu/en/notice/-/detail/${pubNo}`,
      suppliers: names.map((name) => ({ name, identifiers: [] })),
    });
  }
  return out;
}

export function parseSnapshot(buffer, meta) {
  return meta.format === 'ted' ? parseTedAwards(buffer, meta) : parseOcdsAwards(buffer, meta.sourceId);
}

/* =============================================================== config */

/** Validate awards.json. Every problem is reported at once. */
export function validateConfig(raw = {}) {
  const problems = [];
  const sources = raw.sources ?? {};
  for (const k of Object.keys(sources)) if (!SOURCE_IDS.includes(k)) problems.push(`sources.${k}: unknown source (use ${SOURCE_IDS.join(', ')})`);
  const majorAward = { default: 1000000, ...(raw.majorAward ?? {}) };
  for (const [cur, v] of Object.entries(majorAward)) if (!(toNumberOrNull(v) > 0)) problems.push(`majorAward.${cur} must be a positive number`);
  const analytics = { windowMonths: 24, minSample: 5, minIncumbentWins: 2, minIncumbentShare: 0.4, includeTenderers: false, ...(raw.analytics ?? {}) };
  if (!Number.isInteger(analytics.windowMonths) || analytics.windowMonths < 1) problems.push('analytics.windowMonths must be a whole number ≥ 1');
  if (!Number.isInteger(analytics.minSample) || analytics.minSample < 2) problems.push('analytics.minSample must be a whole number ≥ 2');
  if (!(analytics.minIncumbentShare > 0 && analytics.minIncumbentShare <= 1)) problems.push('analytics.minIncumbentShare must be between 0 and 1');
  const backfill = { months: 24, chunkDays: 7, maxWindowsPerRun: 40, ...(raw.backfill ?? {}) };
  if (!Number.isInteger(backfill.chunkDays) || backfill.chunkDays < 1 || backfill.chunkDays > 31) problems.push('backfill.chunkDays must be 1–31');
  if (problems.length) throw new Error(`awards.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return {
    sources: Object.fromEntries(SOURCE_IDS.map((id) => [id, { enabled: true, lookbackDays: 3, ...(sources[id] ?? {}) }])),
    majorAward: Object.fromEntries(Object.entries(majorAward).map(([k, v]) => [k.toUpperCase() === 'DEFAULT' ? 'default' : k.toUpperCase(), toNumberOrNull(v)])),
    analytics, backfill,
    volumeGuard: { minExpected: 10, lookbackRuns: 5, ...(raw.volumeGuard ?? {}) },
    digest: { topSuppliers: 10, maxAwards: 15, maxShifts: 15, ...(raw.digest ?? {}) },
  };
}

/* ========================================================== cursors etc. */

export const getCursor = (db, source) => db.prepare(`SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;
export function setCursor(db, source, cursor, now) {
  db.prepare(`INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(source, cursor, now);
}

/** Daily window: from the cursor (minus an hour of overlap; duplicates are ignored) to now. */
export function dailyWindow(cursor, now, lookbackDays = 3) {
  const from = cursor ? new Date(Date.parse(cursor) - 3_600_000) : new Date(Date.parse(now) - lookbackDays * DAY_MS);
  return { from: from.toISOString(), to: new Date(now).toISOString() };
}

/**
 * Plan backfill windows for the last `months` (idempotent: existing windows are kept with their status).
 * @returns {number} windows added
 */
export function planBackfill(db, { sources, months, chunkDays, now }) {
  const end = new Date(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - months);
  const insert = db.prepare(`INSERT OR IGNORE INTO backfill_windows (source, window_from, window_to, status, updated_at) VALUES (?, ?, ?, 'pending', ?)`);
  let added = 0;
  db.transaction(() => {
    for (const source of sources) {
      for (let t = start.getTime(); t < end.getTime(); t += chunkDays * DAY_MS) {
        const from = new Date(t).toISOString();
        const to = new Date(Math.min(t + chunkDays * DAY_MS, end.getTime())).toISOString();
        added += insert.run(source, from, to, now).changes;
      }
    }
  })();
  return added;
}

/** Pending backfill windows, oldest first, round-robin across sources. */
export function pendingWindows(db, limit) {
  return db.prepare(`SELECT source, window_from AS "from", window_to AS "to" FROM backfill_windows WHERE status = 'pending'
    ORDER BY window_from, source LIMIT ?`).all(limit);
}

export function markWindow(db, { source, from, status, items, now }) {
  db.prepare(`UPDATE backfill_windows SET status = ?, items = ?, updated_at = ? WHERE source = ? AND window_from = ?`).run(status, items, now, source, from);
}

export function backfillProgress(db) {
  return db.prepare(`SELECT status, COUNT(*) AS n FROM backfill_windows GROUP BY status`).all().reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
}

/**
 * Drop guard: a source returning 0 award releases when its recent runs averaged
 * ≥ minExpected is an anomaly; the cursor (or window) is held for a retry.
 * Fewer than three runs of history: not judged.
 */
export function volumeAnomaly(db, source, items, { minExpected, lookbackRuns }) {
  if (items > 0) return null;
  const recent = db.prepare(`SELECT items FROM source_runs WHERE source = ? AND outcome = 'ok' ORDER BY id DESC LIMIT ?`).pluck().all(source, lookbackRuns);
  if (recent.length < Math.min(3, lookbackRuns)) return null;
  const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
  return avg >= minExpected ? `${source} returned 0 award releases; its last ${recent.length} runs averaged ${Math.round(avg)}` : null;
}

export function recordSourceRun(db, { runId, source, items, outcome, note = null, now }) {
  db.prepare(`INSERT INTO source_runs (run_id, source, items, outcome, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`).run(runId, source, items, outcome, note, now);
}

/* ============================================================== storage */

/**
 * Parse + store award snapshots. Parse failures are not marked processed (retried, reported).
 * @returns {{ buyers: string[], suppliers: string[], newAwards: number, failures: string[] }}
 */
export function processSnapshots({ db, spine, store, snapshotIds, now }) {
  const buyers = new Set();
  const suppliers = new Set();
  const failures = [];
  let newAwards = 0;

  const done = db.prepare(`SELECT 1 FROM processed_snapshots WHERE snapshot_id = ?`);
  const exists = db.prepare(`SELECT 1 FROM contract_awards WHERE source = ? AND notice_id = ? AND award_ref = ?`);
  const insertAward = db.prepare(`
    INSERT INTO contract_awards (source, notice_id, award_ref, buyer_key, buyer_name, buyer_country, buyer_entity_id, title, value, currency,
      value_kind, award_date, cpv, cpv_division, number_of_tenderers, supplier_count, confidence, url, snapshot_id, first_seen)
    VALUES (@source, @noticeId, @awardRef, @buyerKey, @buyerName, @buyerCountry, @buyerEntityId, @title, @value, @currency,
      @valueKind, @awardDate, @cpvJson, @division, @numberOfTenderers, @supplierCount, @confidence, @url, @snapshotId, @now)`);
  const insertSupplier = db.prepare(`INSERT OR IGNORE INTO award_suppliers (award_id, supplier_key, raw_name, match_method, is_jv) VALUES (?, ?, ?, ?, ?)`);
  const markDone = db.prepare(`INSERT OR IGNORE INTO processed_snapshots (snapshot_id, source, awards, processed_at) VALUES (?, ?, ?, ?)`);

  for (const id of snapshotIds) {
    if (done.get(id)) continue;
    const meta = store.get(id)?.meta ?? {};
    let awards;
    try {
      awards = parseSnapshot(store.readRaw(id), meta);
    } catch (err) {
      failures.push(`${meta.sourceId ?? 'snapshot'} ${id}: ${err.message}`);
      continue;
    }
    const fresh = awards.filter((a) => !exists.get(a.source, a.noticeId, a.awardRef));
    // Spine first (idempotent upserts), then the bot tables in one transaction.
    const entityIds = new Map();
    spine.db.transaction(() => {
      for (const a of fresh) {
        const bKey = buyerKeyOf(a.buyerName, a.buyerCountry);
        if (!entityIds.has(bKey)) entityIds.set(bKey, spine.upsertEntity({ jurisdiction: a.buyerCountry, name: a.buyerName, source: BOT, seenAt: now }));
        for (const s of a.suppliers) {
          const { supplierKey, matchMethod } = supplierIdentity(s);
          if (entityIds.has(supplierKey)) continue;
          entityIds.set(supplierKey, spine.upsertEntity(matchMethod === 'registry'
            ? { jurisdiction: 'UK', registryId: supplierKey.slice(3), spineId: supplierKey, name: s.name, source: BOT, seenAt: now }
            : { jurisdiction: a.buyerCountry, name: s.name, source: BOT, seenAt: now }));
        }
      }
    })();
    db.transaction(() => {
      for (const a of fresh) {
        const buyerKey = buyerKeyOf(a.buyerName, a.buyerCountry);
        const ids = new Map(a.suppliers.map((s) => [supplierIdentity(s).supplierKey, s]));
        const awardId = Number(insertAward.run({
          ...a, buyerKey, buyerEntityId: entityIds.get(buyerKey), cpvJson: JSON.stringify(a.cpv), division: cpvDivisionOf(a.cpv[0]),
          supplierCount: ids.size, snapshotId: id, now,
        }).lastInsertRowid);
        for (const [key, s] of ids) {
          insertSupplier.run(awardId, key, s.name, supplierIdentity(s).matchMethod, isJointVenture(s.name) ? 1 : 0);
          suppliers.add(key);
        }
        buyers.add(buyerKey);
        newAwards += 1;
      }
      markDone.run(id, meta.sourceId ?? 'unknown', awards.length, now);
    })();
  }
  return { buyers: [...buyers], suppliers: [...suppliers], newAwards, failures };
}

/**
 * Near-duplicate supplier names (same first word, similarity ≥ 92, different keys) go to the
 * spine review_queue once per pair. Never auto-merged.
 * @returns {number} reviews queued
 */
export function queueSupplierReviews({ db, spine, supplierKeys, now }) {
  const nameKeys = supplierKeys.filter((k) => k.startsWith('name:'));
  if (!nameKeys.length) return 0;
  const candidates = db.prepare(`SELECT supplier_key, display_name FROM supplier_profiles WHERE supplier_key LIKE ? AND supplier_key != ?`);
  const nameOf = db.prepare(`SELECT display_name FROM supplier_profiles WHERE supplier_key = ?`);
  const seen = db.prepare(`SELECT 1 FROM supplier_reviews WHERE pair_key = ?`);
  const record = db.prepare(`INSERT INTO supplier_reviews (pair_key, review_item_id, similarity, created_at) VALUES (?, ?, ?, ?)`);
  let queued = 0;
  for (const key of nameKeys) {
    const first = key.slice(5).split(' ')[0];
    if (!first) continue;
    const name = nameOf.get(key)?.display_name ?? key.slice(5);
    for (const c of candidates.all(`name:${first}%`, key)) {
      const score = match.companySimilarity(name, c.display_name);
      // Identical core names already share a key, so any pair here is two keys. A score of 100
      // (one name's words a subset of the other's) is exactly the ambiguous case a human must judge.
      if (score < 92) continue;
      const pair = [key, c.supplier_key].sort().join('|');
      if (seen.get(pair)) continue;
      const itemId = spine.queueReview({ kind: 'supplier_identity', payload: { bot: BOT, question: 'Are these the same supplier?', a: { key, name }, b: { key: c.supplier_key, name: c.display_name }, similarity: score } });
      record.run(pair, itemId, score, now);
      queued += 1;
    }
  }
  return queued;
}

/** One AWARD_ANALYTICS_UPDATED event per buyer whose all-category analytics changed (idempotent per day). */
export function emitBuyerEvents({ db, spine, changedRows, now }) {
  const entity = db.prepare(`SELECT buyer_entity_id FROM contract_awards WHERE buyer_key = ? AND buyer_entity_id IS NOT NULL LIMIT 1`);
  let emitted = 0;
  for (const r of changedRows.filter((x) => x.division === '*')) {
    const { isNew } = spine.linkEvent({
      entityId: entity.get(r.buyerKey)?.buyer_entity_id ?? null, type: EVENT_TYPE, date: now.slice(0, 10), detectedAt: now,
      source: `${BOT}:buyer:${r.buyerKey}`,
      payload: { buyerKey: r.buyerKey, buyerName: r.buyerName, awards: r.awards, hhi: r.hhi, concentration: r.concentration, incumbent: r.incKey, windowMonths: r.windowMonths, shift: r.isShift },
    });
    if (isNew) emitted += 1;
  }
  return emitted;
}

/* ============================================================ digest data */

const thresholdFor = (majorAward, currency) => majorAward[String(currency ?? '').toUpperCase()] ?? majorAward.default;

/** New awards at or above the per-currency threshold, not yet announced. Framework ceilings are listed separately. */
export function pendingMajorAwards(db, majorAward, limit = 15) {
  const rows = db.prepare(`
    SELECT a.*, GROUP_CONCAT(COALESCE(p.display_name, s.raw_name), '; ') AS winners
    FROM contract_awards a JOIN award_suppliers s ON s.award_id = a.id LEFT JOIN supplier_profiles p ON p.supplier_key = s.supplier_key
    WHERE a.notified_at IS NULL AND a.value IS NOT NULL GROUP BY a.id ORDER BY a.value DESC`).all();
  return rows.filter((r) => r.value >= thresholdFor(majorAward, r.currency)).slice(0, limit);
}

export function markAwardsNotified(db, now) {
  return db.prepare(`UPDATE contract_awards SET notified_at = ? WHERE notified_at IS NULL`).run(now).changes;
}

/** Suppliers with the most wins first seen since `since` (confirmed winners only). */
export function topNewWinners(db, since, limit = 10) {
  return db.prepare(`
    SELECT s.supplier_key AS key, COALESCE(p.display_name, MAX(s.raw_name)) AS name, COUNT(*) AS wins, p.wins AS totalWins
    FROM award_suppliers s JOIN contract_awards a ON a.id = s.award_id LEFT JOIN supplier_profiles p ON p.supplier_key = s.supplier_key
    WHERE a.first_seen >= ? AND a.confidence = 'awarded'
    GROUP BY s.supplier_key ORDER BY wins DESC, key LIMIT ?`).all(since, limit);
}

/** Concentration or incumbent changes not yet announced (all-category rows). */
export function pendingShifts(db, limit = 15) {
  return db.prepare(`
    SELECT b.*, pi.display_name AS incumbent_name, pp.display_name AS prev_incumbent_name
    FROM buyer_analytics b
    LEFT JOIN supplier_profiles pi ON pi.supplier_key = b.incumbent_supplier_key
    LEFT JOIN supplier_profiles pp ON pp.supplier_key = b.prev_incumbent_key
    WHERE b.cpv_division = '*' AND b.changed_at IS NOT NULL AND b.shift_notified_at IS NULL
    ORDER BY b.awards DESC LIMIT ?`).all(limit);
}

export function markShiftsNotified(db, now) {
  return db.prepare(`UPDATE buyer_analytics SET shift_notified_at = ? WHERE changed_at IS NOT NULL AND shift_notified_at IS NULL`).run(now).changes;
}