/**
 * B3 processor: raw snapshots → tenders → profile filters → scores → spine events.
 *
 * Reads only the snapshot store, never the network. Idempotent: identical
 * snapshots are parsed once, notices are keyed by (source, notice id), and a
 * tender is rescored only when its content changes (an amendment).
 */
import { createHash } from 'node:crypto';
import { match } from '@botarmy/core';
import { SOURCE_IDS } from './harvest.js';
import { bestCpvMatch, daysUntil, keywordHits, scoreTender, toNumberOrNull } from './score.js';

export const BOT = 'tender-scout';
/** Channel for profiles that do not name one. */
export const DEFAULT_PROFILE_CHANNEL = 'tenders';
export const EVENT_TYPE = 'TENDER_OPPORTUNITY';

/* =========================================================== helpers */

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

const clean = (s) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v || null;
};

/** A valid ISO timestamp/date string, or null. Never invented. */
export function isoOrNull(value) {
  const s = clean(value);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}/.test(s) ? s : null;
}

const LANG = ['eng', 'ENG', 'en'];
function firstText(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(firstText).find(Boolean) ?? null;
  if (typeof v === 'object') { const k = LANG.find((x) => x in v) ?? Object.keys(v)[0]; return k ? firstText(v[k]) : null; }
  return null;
}
function allTexts(v) {
  if (v == null) return [];
  if (typeof v === 'string' || typeof v === 'number') return [String(v)];
  if (Array.isArray(v)) return v.flatMap(allTexts);
  if (typeof v === 'object') { const k = LANG.find((x) => x in v) ?? Object.keys(v)[0]; return k ? allTexts(v[k]) : []; }
  return [];
}

const cpvCodes = (values) => [...new Set(values.map((c) => String(c ?? '').trim().replace(/-\d$/, '')).filter((c) => /^\d{8}$/.test(c)))];

/* ======================================================== OCDS tenders */

const TENDER_TAG = /^tender/;
const DEAD = /cancel|withdrawn|unsuccessful/i;

/**
 * OCDS release package → tender notices. Award releases are ignored (B6 handles
 * those); if a package contains several releases for one ocid, the latest wins.
 */
export function parseOcdsTenders(buffer, meta) {
  const byOcid = new Map();
  for (const release of json(buffer, meta.sourceId)?.releases ?? []) {
    const tags = [release.tag].flat().filter(Boolean);
    if (!tags.some((t) => TENDER_TAG.test(t))) continue;
    const t = release.tender ?? {};
    const title = clean(t.title);
    const noticeId = clean(release.ocid) ?? clean(release.id);
    if (!title || !noticeId) continue;

    const items = Array.isArray(t.items) ? t.items : [];
    const lots = Array.isArray(t.lots) ? t.lots : [];
    const classifications = [t.classification, ...(t.additionalClassifications ?? []), ...items.flatMap((i) => [i.classification, ...(i.additionalClassifications ?? [])])]
      .filter((c) => c && (/cpv/i.test(c.scheme ?? '') || /^\d{8}(-\d)?$/.test(String(c.id ?? ''))))
      .map((c) => c.id);
    const lotValues = lots.map((l) => toNumberOrNull(l?.value?.amount)).filter((v) => v !== null);
    const places = [
      ...items.flatMap((i) => [...(i.deliveryAddresses ?? []), i.deliveryAddress].filter(Boolean)),
      ...(t.deliveryAddresses ?? []),
    ].flatMap((a) => [a.region, a.locality, a.countryName, a.postalCode]);
    const locationText = items.flatMap((i) => (i.deliveryLocations ?? []).map((l) => l.description));
    const buyerParty = (release.parties ?? []).find((p) => (p.roles ?? []).includes('buyer'));
    const guid = String(release.id ?? '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];

    const notice = {
      noticeId,
      title,
      description: clean(t.description),
      buyer: clean(release.buyer?.name) ?? clean(buyerParty?.name),
      valueMin: toNumberOrNull(t.minValue?.amount),
      valueMax: toNumberOrNull(t.value?.amount) ?? (lotValues.length ? Math.max(...lotValues) : null),
      currency: clean(t.value?.currency) ?? clean(t.minValue?.currency) ?? clean(lots.find((l) => l?.value?.currency)?.value?.currency),
      deadline: isoOrNull(t.tenderPeriod?.endDate),
      publishedAt: isoOrNull(release.date),
      cpv: cpvCodes(classifications),
      locations: [...new Set([...places, ...locationText].map(clean).filter(Boolean))],
      status: tags.includes('tenderCancellation') || DEAD.test(t.status ?? '') ? 'cancelled' : 'active',
      url: meta.sourceId === 'contractsFinder'
        ? (guid ? `https://www.contractsfinder.service.gov.uk/Notice/${guid}` : null)
        : (/^\d{6}-\d{4}$/.test(release.id ?? '') ? `https://www.find-tender.service.gov.uk/Notice/${release.id}` : null),
    };
    const prev = byOcid.get(noticeId);
    if (!prev || (notice.publishedAt ?? '') >= (prev.publishedAt ?? '')) byOcid.set(noticeId, notice);
  }
  return [...byOcid.values()];
}

/* ========================================================== TED notices */

/** TED search page → tender notices, reading the field names recorded at harvest time. */
export function parseTedTenders(buffer, meta) {
  const body = json(buffer, 'ted');
  if (!Array.isArray(body?.notices)) throw new Error('ted: response has no "notices" array');
  return body.notices.map((n) => {
    const pubNo = clean(firstText(n['publication-number']));
    const title = clean(firstText(n['notice-title']));
    if (!pubNo || !title) return null;
    const value = meta.valueField ? toNumberOrNull(firstText(n[meta.valueField])) : null;
    const country = meta.countryField ? clean(firstText(n[meta.countryField])) : null;
    return {
      noticeId: pubNo,
      title,
      description: null,
      buyer: clean(firstText(n['buyer-name'])),
      valueMin: null,
      valueMax: value,
      currency: meta.currencyField ? clean(firstText(n[meta.currencyField])) : null,
      deadline: meta.deadlineField ? isoOrNull(firstText(n[meta.deadlineField])) : null,
      publishedAt: isoOrNull(firstText(n['publication-date'])?.slice(0, 10)),
      cpv: meta.cpvField ? cpvCodes(allTexts(n[meta.cpvField])) : [],
      locations: country ? [country] : [],
      country,
      status: 'active',
      url: `https://ted.europa.eu/en/notice/-/detail/${pubNo}`,
    };
  }).filter(Boolean);
}

export function parseSnapshot(buffer, meta) {
  if (meta.format === 'ocds') return parseOcdsTenders(buffer, meta);
  if (meta.format === 'ted') return parseTedTenders(buffer, meta);
  throw new Error(`unknown snapshot format "${meta.format}"`);
}

/* ============================================================== config */

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);

/**
 * Validate profiles.json. Every problem is reported at once.
 * @returns {{ profiles: object[], sources: object, volumeGuard: { minExpected: number, lookbackRuns: number } }}
 */
export function validateConfig(raw) {
  const problems = [];
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  if (!profiles.length) problems.push('"profiles" must list at least one capability profile');
  const ids = new Set();
  const out = profiles.map((p, i) => {
    const at = `profiles[${i}]`;
    if (!isSlug(p?.id)) problems.push(`${at}.id must be a lowercase slug`);
    if (ids.has(p?.id)) problems.push(`${at}.id "${p?.id}" is duplicated`);
    ids.add(p?.id);
    if (!p?.name) problems.push(`${at}.name is required`);
    const cpv = (p?.cpvPrefixes ?? []).map(String);
    for (const c of cpv) if (!/^\d{2,8}$/.test(c)) problems.push(`${at}.cpvPrefixes: "${c}" must be 2–8 digits`);
    const keywords = p?.keywords ?? [];
    if (!cpv.length && !keywords.length) problems.push(`${at} needs cpvPrefixes or keywords (or both)`);
    for (const k of ['keywords', 'excludeKeywords', 'locations']) {
      const v = p?.[k] ?? [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) problems.push(`${at}.${k} must be a list of non-empty strings`);
    }
    const band = p?.valueBand ?? {};
    for (const k of ['min', 'max']) {
      if (band[k] !== undefined && band[k] !== null && (toNumberOrNull(band[k]) === null || band[k] < 0)) problems.push(`${at}.valueBand.${k} must be a non-negative number`);
    }
    if (band.min != null && band.max != null && Number(band.min) > Number(band.max)) problems.push(`${at}.valueBand.min exceeds max`);
    const minDays = p?.minDaysToDeadline ?? 10;
    if (!Number.isInteger(minDays) || minDays < 0) problems.push(`${at}.minDaysToDeadline must be a whole number ≥ 0`);
    if (p?.slackChannel !== undefined && !/^[a-z0-9][a-z0-9_-]*$/i.test(String(p.slackChannel))) {
      problems.push(`${at}.slackChannel must be a channel name like "tenders-ateca" (letters, digits, - or _)`);
    }
    return {
      profileId: p?.id, name: p?.name, cpvPrefixes: cpv, keywords: keywords.map((k) => k.trim()),
      excludeKeywords: (p?.excludeKeywords ?? []).map((k) => k.trim()), locations: (p?.locations ?? []).map((k) => k.trim()),
      valueMin: band.min ?? null, valueMax: band.max ?? null, valueCurrency: band.currency ?? null,
      // No channel given: the bot's shared "tenders" channel (SLACK_WEBHOOK_URL_TENDERS, else SLACK_WEBHOOK_URL).
      minDays, slackChannel: p?.slackChannel ?? DEFAULT_PROFILE_CHANNEL, weights: p?.weights ?? {},
    };
  });
  const sources = raw?.sources ?? {};
  for (const k of Object.keys(sources)) if (!SOURCE_IDS.includes(k)) problems.push(`sources.${k} is not a known source (${SOURCE_IDS.join(', ')})`);
  const guard = { minExpected: 20, lookbackRuns: 7, ...(raw?.volumeGuard ?? {}) };
  if (!Number.isInteger(guard.minExpected) || guard.minExpected < 1) problems.push('volumeGuard.minExpected must be a whole number ≥ 1');
  if (!Number.isInteger(guard.lookbackRuns) || guard.lookbackRuns < 1) problems.push('volumeGuard.lookbackRuns must be a whole number ≥ 1');
  if (problems.length) throw new Error(`profiles.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return { profiles: out, sources, volumeGuard: guard };
}

/** Mirror profiles into keyword_profiles / watchlist_cpvs. Removed profiles are deactivated, never deleted. */
export function syncProfiles(db, profiles, now) {
  const up = db.prepare(`
    INSERT INTO keyword_profiles (profile_id, name, keywords, exclude_keywords, value_min, value_max, value_currency, locations, min_days, slack_channel, weights, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (profile_id) DO UPDATE SET name = excluded.name, keywords = excluded.keywords, exclude_keywords = excluded.exclude_keywords,
      value_min = excluded.value_min, value_max = excluded.value_max, value_currency = excluded.value_currency, locations = excluded.locations,
      min_days = excluded.min_days, slack_channel = excluded.slack_channel, weights = excluded.weights, active = 1, updated_at = excluded.updated_at`);
  const delCpv = db.prepare(`DELETE FROM watchlist_cpvs WHERE profile_id = ?`);
  const addCpv = db.prepare(`INSERT OR IGNORE INTO watchlist_cpvs (profile_id, cpv_prefix) VALUES (?, ?)`);
  db.transaction(() => {
    db.prepare(`UPDATE keyword_profiles SET active = 0`).run();
    for (const p of profiles) {
      up.run(p.profileId, p.name, JSON.stringify(p.keywords), JSON.stringify(p.excludeKeywords), p.valueMin, p.valueMax, p.valueCurrency,
        JSON.stringify(p.locations), p.minDays, p.slackChannel, JSON.stringify(p.weights), now);
      delCpv.run(p.profileId);
      for (const c of p.cpvPrefixes) addCpv.run(p.profileId, c);
    }
  })();
}

export function activeProfiles(db) {
  const cpvs = db.prepare(`SELECT cpv_prefix FROM watchlist_cpvs WHERE profile_id = ? ORDER BY cpv_prefix`);
  return db.prepare(`SELECT * FROM keyword_profiles WHERE active = 1 ORDER BY profile_id`).all().map((r) => ({
    profileId: r.profile_id, name: r.name, keywords: JSON.parse(r.keywords), excludeKeywords: JSON.parse(r.exclude_keywords),
    valueMin: r.value_min, valueMax: r.value_max, valueCurrency: r.value_currency, locations: JSON.parse(r.locations),
    minDays: r.min_days, slackChannel: r.slack_channel, weights: JSON.parse(r.weights), cpvPrefixes: cpvs.pluck().all(r.profile_id),
  }));
}

/* ========================================================== cursors / guard */

export const getCursor = (db, source) => db.prepare(`SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;

export function setCursor(db, source, cursor, now) {
  db.prepare(`INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(source, cursor, now);
}

/**
 * Drop guard for incremental feeds. Zero notices can be a quiet day, so a run
 * is only an anomaly when it returns 0 while the source's recent accepted runs
 * averaged at least minExpected. An anomaly holds the cursor (the window is
 * fetched again next run) and is reported loudly.
 * @returns {string|null} reason, or null when the volume looks normal
 */
export function volumeAnomaly(db, sourceId, notices, { minExpected, lookbackRuns }) {
  if (notices > 0) return null;
  const recent = db.prepare(`SELECT notices FROM source_runs WHERE source = ? AND outcome = 'ok' ORDER BY id DESC LIMIT ?`).pluck().all(sourceId, lookbackRuns);
  if (recent.length < Math.min(3, lookbackRuns)) return null; // not enough history to judge
  const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
  return avg >= minExpected ? `${sourceId} returned 0 notices; the last ${recent.length} runs averaged ${Math.round(avg)}` : null;
}

export function recordSourceRun(db, { runId, sourceId, notices, outcome, note = null, now }) {
  db.prepare(`INSERT INTO source_runs (run_id, source, notices, outcome, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, sourceId, notices, outcome, note, now);
}

/* ============================================================== tenders */

export const fingerprintOf = (t) => `${match.nameNorm(t.title)}|${match.nameNorm(t.buyer ?? '')}|${t.deadline?.slice(0, 10) ?? ''}`;
const hashOf = (t) => createHash('sha256').update(JSON.stringify([t.title, t.description, t.buyer, t.valueMin, t.valueMax, t.currency, t.deadline, t.cpv, t.locations, t.status])).digest('hex').slice(0, 16);

/**
 * Parse and store every snapshot of one fetch.
 * @returns {{ changedIds: number[], parsed: number, failures: string[] }}
 */
export function storeTenders({ db, store, fetch, now = new Date().toISOString(), log }) {
  const changedIds = [];
  const failures = [];
  let parsed = 0;
  const find = db.prepare(`SELECT id, content_hash FROM tenders WHERE source = ? AND notice_id = ?`);
  const dupOf = db.prepare(`SELECT id FROM tenders WHERE fingerprint = ? AND source != ? AND duplicate_of IS NULL ORDER BY id LIMIT 1`);
  const insert = db.prepare(`
    INSERT INTO tenders (source, notice_id, title, description, buyer_raw, value_min, value_max, currency, deadline, published_at,
      cpv, locations, status, url, fingerprint, duplicate_of, content_hash, raw_snapshot_id, first_seen, updated_at)
    VALUES (@source, @noticeId, @title, @description, @buyer, @valueMin, @valueMax, @currency, @deadline, @publishedAt,
      @cpvJson, @locationsJson, @status, @url, @fingerprint, @duplicateOf, @hash, @snapshotId, @now, @now)`);
  const update = db.prepare(`
    UPDATE tenders SET title = @title, description = @description, buyer_raw = @buyer, value_min = @valueMin, value_max = @valueMax,
      currency = @currency, deadline = @deadline, published_at = @publishedAt, cpv = @cpvJson, locations = @locationsJson, status = @status,
      url = @url, fingerprint = @fingerprint, content_hash = @hash, raw_snapshot_id = @snapshotId, updated_at = @now
    WHERE id = @id`);
  const markDone = db.prepare(`INSERT INTO processed_snapshots (snapshot_id, source, notices, processed_at) VALUES (?, ?, ?, ?)`);

  for (const snapshotId of fetch.snapshotIds) {
    if (db.prepare(`SELECT 1 FROM processed_snapshots WHERE snapshot_id = ?`).get(snapshotId)) continue;
    let notices;
    try {
      notices = parseSnapshot(store.readRaw(snapshotId), store.get(snapshotId).meta);
    } catch (err) {
      // Not marked processed: retried next run (e.g. after a parser fix) and reported every run.
      failures.push(`${fetch.sourceId} snapshot ${snapshotId}: ${err.message}`);
      log?.warn(`${fetch.sourceId} snapshot ${snapshotId}: ${err.message}`);
      continue;
    }
    db.transaction(() => {
      for (const n of notices) {
        parsed += 1;
        const row = {
          ...n, source: fetch.sourceId, cpvJson: JSON.stringify(n.cpv), locationsJson: JSON.stringify(n.locations),
          fingerprint: fingerprintOf(n), hash: hashOf(n), snapshotId, now,
        };
        const existing = find.get(fetch.sourceId, n.noticeId);
        if (!existing) {
          const id = Number(insert.run({ ...row, duplicateOf: dupOf.get(row.fingerprint, fetch.sourceId)?.id ?? null }).lastInsertRowid);
          changedIds.push(id);
        } else if (existing.content_hash !== row.hash) {
          update.run({ ...row, id: existing.id });
          changedIds.push(existing.id);
        }
      }
      markDone.run(snapshotId, fetch.sourceId, notices.length, now);
    })();
  }
  return { changedIds, parsed, failures };
}

/* ============================================================ matching */

const rowToTender = (r) => ({
  id: r.id, source: r.source, noticeId: r.notice_id, title: r.title, description: r.description, buyer: r.buyer_raw,
  valueMin: r.value_min, valueMax: r.value_max, currency: r.currency, deadline: r.deadline, publishedAt: r.published_at,
  cpv: JSON.parse(r.cpv), locations: JSON.parse(r.locations), status: r.status, url: r.url, duplicateOf: r.duplicate_of, contentHash: r.content_hash,
});

/**
 * Profile filters, in order. A tender is an opportunity for a profile only if:
 *   active · not a duplicate · CPV prefix match OR a capability keyword · no exclude keyword ·
 *   value (when published) not below the floor · deadline (when published) not too close.
 * Unpublished values and deadlines pass, labelled unknown in the score; they are never assumed.
 * @returns {{ passed: boolean, reason: string|null }}
 */
export function applyFilters(tender, profile, now) {
  if (tender.status === 'cancelled') return { passed: false, reason: 'cancelled' };
  if (tender.duplicateOf) return { passed: false, reason: 'duplicate' };
  const cpv = bestCpvMatch(tender.cpv, profile.cpvPrefixes);
  const hits = keywordHits(tender.title, tender.description, profile.keywords);
  if (!cpv && !hits.length) return { passed: false, reason: tender.cpv.length ? 'cpv-mismatch-no-keywords' : 'no-cpv-no-keywords' };
  const excluded = keywordHits(tender.title, tender.description, profile.excludeKeywords);
  if (excluded.length) return { passed: false, reason: `excluded-keyword:${excluded[0].keyword}` };
  const value = toNumberOrNull(tender.valueMax) ?? toNumberOrNull(tender.valueMin);
  const floor = toNumberOrNull(profile.valueMin);
  const sameCurrency = !profile.valueCurrency || !tender.currency || tender.currency === profile.valueCurrency;
  if (value !== null && floor !== null && sameCurrency && value < floor) return { passed: false, reason: 'below-value-floor' };
  const days = daysUntil(tender.deadline, now);
  if (days !== null && days < 0) return { passed: false, reason: 'deadline-passed' };
  if (days !== null && days < profile.minDays) return { passed: false, reason: 'deadline-too-close' };
  // Passes record why they passed: the matching CPV prefix, or a capability keyword when no CPV matched.
  return { passed: true, reason: cpv ? `cpv:${cpv.prefix}` : 'keyword' };
}

const COUNTRY_JURISDICTION = { GBR: 'UK', GB: 'UK', UK: 'UK' };

/**
 * Filter and score changed tenders against every active profile, and emit one
 * TENDER_OPPORTUNITY spine event per tender that passes for at least one profile.
 * Amended tenders are rescored; a match already sent is not sent again.
 * @returns {{ scored: number, opportunities: number, events: number }}
 */
export function matchAndScore({ db, spine, profiles, tenderIds, now = new Date().toISOString(), log }) {
  const getTender = db.prepare(`SELECT * FROM tenders WHERE id = ?`);
  const upsert = db.prepare(`
    INSERT INTO scored_matches (tender_id, profile_id, passed, filter_reason, score, reasons, content_hash, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tender_id, profile_id) DO UPDATE SET passed = excluded.passed, filter_reason = excluded.filter_reason,
      score = excluded.score, reasons = excluded.reasons, content_hash = excluded.content_hash, scored_at = excluded.scored_at`);
  const setEvent = db.prepare(`UPDATE tenders SET buyer_entity_id = ?, event_id = ? WHERE id = ?`);
  const counts = { scored: 0, opportunities: 0, events: 0 };

  for (const id of [...new Set(tenderIds)]) {
    const tender = rowToTender(getTender.get(id));
    const passedFor = [];
    db.transaction(() => {
      for (const p of profiles) {
        const f = applyFilters(tender, p, now);
        const { score, reasons } = scoreTender(tender, p, now);
        upsert.run(id, p.profileId, f.passed ? 1 : 0, f.reason, f.passed ? score : null, JSON.stringify(reasons), tender.contentHash, now);
        counts.scored += 1;
        if (f.passed) passedFor.push({ profileId: p.profileId, score });
      }
    })();
    if (!passedFor.length) continue;
    counts.opportunities += 1;

    const jurisdiction = tender.source === 'ted' ? COUNTRY_JURISDICTION[tender.locations[0]] ?? (tender.locations[0] || 'EU') : 'UK';
    const entityId = tender.buyer ? spine.upsertEntity({ jurisdiction, name: tender.buyer, source: BOT, seenAt: now }) : null;
    const { eventId, isNew } = spine.linkEvent({
      entityId, type: EVENT_TYPE, date: (tender.publishedAt ?? now).slice(0, 10), detectedAt: now,
      source: `${BOT}:${tender.source}:${tender.noticeId}`, // per notice: two tenders from one buyer on one day stay distinct
      payload: { title: tender.title, buyer: tender.buyer, deadline: tender.deadline, valueMax: tender.valueMax, currency: tender.currency, url: tender.url, profiles: passedFor },
    });
    setEvent.run(entityId, eventId, id);
    if (isNew) counts.events += 1;
  }
  log?.info('Matching', counts);
  return counts;
}

/* ======================================================== notification */

/** A profile's unsent opportunities, best first (ties: soonest deadline, then id). */
export function pendingMatches(db, profileId) {
  return db.prepare(`
    SELECT m.id AS match_id, m.score, m.reasons, t.*
    FROM scored_matches m JOIN tenders t ON t.id = m.tender_id
    WHERE m.profile_id = ? AND m.passed = 1 AND m.notified_at IS NULL
    ORDER BY m.score DESC, (t.deadline IS NULL), t.deadline, t.id`).all(profileId)
    .map((r) => ({ ...rowToTender(r), matchId: r.match_id, score: r.score, reasons: JSON.parse(r.reasons) }));
}

export function markNotified(db, matchIds, now = new Date().toISOString()) {
  const update = db.prepare(`UPDATE scored_matches SET notified_at = ? WHERE id = ?`);
  db.transaction(() => matchIds.forEach((id) => update.run(now, id)))();
}