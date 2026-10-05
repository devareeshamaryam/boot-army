/**
 * B7 processor: raw search pages / stream chunks / officer lists →
 * incorporations → scored_leads → spine INCORPORATION_DETECTED.
 *
 * Reads only the snapshot store. Idempotent: companies are keyed on their
 * Companies House number, so re-reading a page or a stream event changes nothing.
 * Only companies matching at least one SIC watchlist are kept.
 */
import { normalizeEntityId } from '@botarmy/core';
import { bestSicMatch, isSicEntry, scoreLead, summariseOfficers } from './score.js';

export const BOT = 'incorporation-scout';
export const EVENT_TYPE = 'INCORPORATION_DETECTED';
const DAY_MS = 86_400_000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/* ========================================================= safe parsing */

export function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

const pad = (n) => String(n).padStart(2, '0');
export function toIsoDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}
const clean = (s) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim() || null);

/* ============================================================== config */

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(s);

/** Validate incorporations.json. Every problem is reported at once. */
export function validateConfig(raw = {}) {
  const problems = [];
  const ids = new Set();
  const watchlists = (Array.isArray(raw.watchlists) ? raw.watchlists : []).map((w, i) => {
    const at = `watchlists[${i}]`;
    if (!isSlug(w?.id)) problems.push(`${at}.id must be a slug`);
    if (ids.has(w?.id)) problems.push(`${at}.id "${w?.id}" is duplicated`);
    ids.add(w?.id);
    const sic = (w?.sicCodes ?? []).map(String);
    if (!sic.length) problems.push(`${at}.sicCodes must list at least one SIC code`);
    for (const c of sic) if (!isSicEntry(c)) problems.push(`${at}.sicCodes: "${c}" must be a 5-digit code, 4-digit class or 2-digit division`);
    const minScore = w?.minScore ?? 50;
    if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) problems.push(`${at}.minScore must be 0–100`);
    if (w?.slackChannel !== undefined && !isSlug(w.slackChannel)) problems.push(`${at}.slackChannel must be a channel name`);
    return { watchlistId: w?.id, name: w?.name ?? w?.id, sicCodes: sic, regions: (w?.regions ?? []).map(String), minScore, slackChannel: w?.slackChannel ?? 'incorporations', weights: w?.weights ?? {} };
  });
  if (!watchlists.length) problems.push('"watchlists" must list at least one SIC watchlist');

  const formationAgents = (Array.isArray(raw.formationAgents) ? raw.formationAgents : []).map((f, i) => {
    if (!isSlug(f?.id)) problems.push(`formationAgents[${i}].id must be a slug`);
    if (!f?.postcode && !f?.addressContains) problems.push(`formationAgents[${i}] needs "postcode" or "addressContains"`);
    return { id: f?.id, postcode: f?.postcode ? normPostcode(f.postcode) : null, addressContains: f?.addressContains ? normText(f.addressContains) : null };
  });

  if (problems.length) throw new Error(`incorporations.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return {
    watchlists, formationAgents,
    search: { enabled: true, lookbackDays: 3, lagDays: 2, pageSize: 100, maxPages: 50, ...(raw.sources?.search ?? {}) },
    stream: { enabled: false, maxEvents: 20000, maxSeconds: 300, maxReconnects: 5, chunkLines: 2000, maxAgeDays: 7, ...(raw.sources?.stream ?? {}) },
    officers: { enabled: true, maxLookups: 150, ...(raw.officers ?? {}) },
    volumeGuard: { minExpected: 5, lookbackRuns: 5, ...(raw.volumeGuard ?? {}) },
    digest: { maxPerWatchlist: 20, ...(raw.digest ?? {}) },
  };
}

export function syncWatchlists(db, watchlists, now) {
  const up = db.prepare(`
    INSERT INTO sic_watchlists (watchlist_id, name, sic_codes, regions, min_score, slack_channel, weights, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (watchlist_id) DO UPDATE SET name = excluded.name, sic_codes = excluded.sic_codes, regions = excluded.regions,
      min_score = excluded.min_score, slack_channel = excluded.slack_channel, weights = excluded.weights, active = 1, updated_at = excluded.updated_at`);
  db.transaction(() => {
    db.prepare(`UPDATE sic_watchlists SET active = 0`).run();
    for (const w of watchlists) up.run(w.watchlistId, w.name, JSON.stringify(w.sicCodes), JSON.stringify(w.regions), w.minScore, w.slackChannel, JSON.stringify(w.weights), now);
  })();
}

/**
 * SIC codes for the search query. Companies House filters on exact 5-digit
 * codes only, so if any watchlist uses a class/division prefix the search
 * fetches everything and filters locally ([] = no query filter).
 */
export function querySicCodes(watchlists) {
  const all = [...new Set(watchlists.flatMap((w) => w.sicCodes))];
  return all.every((c) => /^\d{5}$/.test(c)) ? all.sort() : [];
}

/* ========================================================== companies */

export const normPostcode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normText = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Blocklist rule id if the registered office is a known formation agent's address. */
export function formationAgentRule(company, rules) {
  const pc = normPostcode(company.roPostcode);
  const addr = normText(company.roAddress);
  for (const r of rules) {
    if (r.postcode && pc && r.postcode === pc && (!r.addressContains || addr.includes(r.addressContains))) return r.id;
    if (!r.postcode && r.addressContains && addr.includes(r.addressContains)) return r.id;
  }
  return null;
}

/** Search item or stream company profile → company record, or null if it has no valid number. */
export function companyFrom(item) {
  let companyKey;
  try {
    companyKey = normalizeEntityId(String(item?.company_number ?? ''), 'UK');
  } catch {
    return null;
  }
  const a = item?.registered_office_address ?? {};
  const parts = [a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code].map(clean).filter(Boolean);
  return {
    companyNumber: companyKey.slice(3), companyKey,
    name: clean(item?.company_name) ?? companyKey.slice(3),
    companyType: clean(item?.company_type ?? item?.type), companyStatus: clean(item?.company_status),
    dateOfCreation: toIsoDate(item?.date_of_creation),
    sicCodes: [...new Set((item?.sic_codes ?? []).map((c) => String(c).trim()).filter((c) => /^\d{5}$/.test(c)))],
    roAddress: parts.join(', ') || null, roPostcode: clean(a.postal_code), roLocality: clean(a.locality), roRegion: clean(a.region), roCountry: clean(a.country),
  };
}

export function parseSearchPage(buffer) {
  let body;
  try {
    body = JSON.parse(decode(buffer));
  } catch {
    throw new Error('advanced search: response is not valid JSON');
  }
  if (!body || (body.items !== undefined && !Array.isArray(body.items))) throw new Error('advanced search: unexpected response shape');
  return body.items ?? [];
}

/**
 * Stream chunk → company profiles that look like new incorporations: a
 * company-profile event, not a deletion, created within maxAgeDays of the event.
 * @returns {{ items: object[], events: number, malformed: number }}
 */
export function parseStreamChunk(buffer, { maxAgeDays = 7 } = {}) {
  const items = [];
  let events = 0;
  let malformed = 0;
  for (const line of decode(buffer).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    events += 1;
    if (ev?.resource_kind !== 'company-profile' || ev?.event?.type === 'deleted' || !ev?.data) continue;
    const created = toIsoDate(ev.data.date_of_creation);
    const published = Date.parse(ev.event?.published_at ?? '');
    if (!created || !Number.isFinite(published)) continue;
    const age = (published - Date.parse(`${created}T00:00:00Z`)) / DAY_MS;
    if (age >= 0 && age <= maxAgeDays) items.push(ev.data);
  }
  return { items, events, malformed };
}

const watchMatches = (company, watchlists) => watchlists.filter((w) => bestSicMatch(company.sicCodes, w.sicCodes));

/* ============================================================ helpers */

export const getCursor = (db, source) => db.prepare(`SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;
export function setCursor(db, source, cursor, now) {
  db.prepare(`INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(source, cursor, now);
}
const isProcessed = (db, id) => Boolean(db.prepare(`SELECT 1 FROM processed_snapshots WHERE snapshot_id = ?`).get(id));
const markProcessed = (db, id, source, items, now) =>
  db.prepare(`INSERT OR IGNORE INTO processed_snapshots (snapshot_id, source, items, processed_at) VALUES (?, ?, ?, ?)`).run(id, source, items, now);

/** Search window: from the cursor minus a lag (the register indexes new companies a day or two late) to today. */
export function searchWindow(cursor, now, { lookbackDays = 3, lagDays = 2 } = {}) {
  const today = isoDay(now);
  const from = cursor ? isoDay(Date.parse(`${cursor}T00:00:00Z`) - lagDays * DAY_MS) : isoDay(Date.parse(now) - lookbackDays * DAY_MS);
  return { from, to: today };
}

/** The days of a window, oldest first. The search runs one day at a time so a busy day can never stall the cursor. */
export function windowDays({ from, to }) {
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) days.push(isoDay(t));
  return days;
}

export function windowHasWeekday({ from, to }) {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).getUTCDay();
    if (d >= 1 && d <= 5) return true;
  }
  return false;
}

/**
 * Drop guard: a window holding a weekday that returned nothing, when recent
 * weekday runs averaged ≥ minExpected, is an anomaly (cursor held). Weekend-only
 * windows and thin history are not judged.
 */
export function volumeAnomaly(db, source, items, hadWeekday, { minExpected, lookbackRuns }) {
  if (items > 0 || !hadWeekday) return null;
  const recent = db.prepare(`SELECT items FROM source_runs WHERE source = ? AND outcome = 'ok' AND weekday = 1 ORDER BY id DESC LIMIT ?`).pluck().all(source, lookbackRuns);
  if (recent.length < Math.min(3, lookbackRuns)) return null;
  const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
  return avg >= minExpected ? `${source} returned 0 incorporations for a weekday window; the last ${recent.length} weekday runs averaged ${Math.round(avg)}` : null;
}

export function recordSourceRun(db, { runId, source, items, weekday, outcome, note = null, now }) {
  db.prepare(`INSERT INTO source_runs (run_id, source, items, weekday, outcome, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, source, items, weekday ? 1 : 0, outcome, note, now);
}

/* ============================================================== storage */

/**
 * Store matched companies; new ones get a spine entity and an
 * INCORPORATION_DETECTED event (spine first, then the bot table).
 * @returns {{ touched: string[], added: number }}
 */
function storeCompanies({ db, spine, records, source, snapshotId, watchlists, formationAgents, now }) {
  const get = db.prepare(`SELECT company_number FROM incorporations WHERE company_number = ?`);
  const matched = records
    .map((c) => ({ ...c, formationAgent: formationAgentRule(c, formationAgents), watchlists: watchMatches(c, watchlists).map((w) => w.watchlistId) }))
    .filter((c) => c.watchlists.length);
  const fresh = matched.filter((c) => !get.get(c.companyNumber));
  const links = new Map();
  spine.db.transaction(() => {
    for (const c of fresh) {
      const entityId = spine.upsertEntity({ jurisdiction: 'UK', registryId: c.companyNumber, spineId: c.companyKey, name: c.name, status: c.companyStatus, sic: c.sicCodes.join(','), postcode: c.roPostcode, source: BOT, seenAt: now });
      const { eventId } = spine.linkEvent({
        entityId, type: EVENT_TYPE, date: c.dateOfCreation, source: BOT, detectedAt: now,
        payload: { name: c.name, sicCodes: c.sicCodes, locality: c.roLocality, postcode: c.roPostcode, watchlists: c.watchlists, formationAgent: c.formationAgent, via: source },
      });
      links.set(c.companyNumber, { entityId, eventId });
    }
  })();

  const upsert = db.prepare(`
    INSERT INTO incorporations (company_number, company_key, name, company_type, company_status, date_of_creation, sic_codes, ro_address, ro_postcode,
      ro_locality, ro_region, ro_country, formation_agent, source, snapshot_id, entity_id, event_id, first_seen, updated_at)
    VALUES (@companyNumber, @companyKey, @name, @companyType, @companyStatus, @dateOfCreation, @sic, @roAddress, @roPostcode,
      @roLocality, @roRegion, @roCountry, @formationAgent, @source, @snapshotId, @entityId, @eventId, @now, @now)
    ON CONFLICT (company_number) DO UPDATE SET name = excluded.name, company_type = excluded.company_type, company_status = excluded.company_status,
      date_of_creation = COALESCE(excluded.date_of_creation, incorporations.date_of_creation), sic_codes = excluded.sic_codes,
      ro_address = excluded.ro_address, ro_postcode = excluded.ro_postcode, ro_locality = excluded.ro_locality, ro_region = excluded.ro_region,
      ro_country = excluded.ro_country, formation_agent = excluded.formation_agent, updated_at = excluded.updated_at`);
  db.transaction(() => {
    for (const c of matched) {
      const l = links.get(c.companyNumber) ?? {};
      upsert.run({ ...c, sic: JSON.stringify(c.sicCodes), source, snapshotId, entityId: l.entityId ?? null, eventId: l.eventId ?? null, now });
    }
  })();
  return { touched: matched.map((c) => c.companyNumber), added: fresh.length };
}

/** Parse + store advanced-search pages. Parse failures are not marked processed (retried, reported). */
export function processSearch({ db, spine, store, snapshotIds, watchlists, formationAgents, now }) {
  const touched = new Set();
  const failures = [];
  let added = 0;
  let items = 0;
  for (const id of snapshotIds) {
    if (isProcessed(db, id)) continue;
    let rows;
    try {
      rows = parseSearchPage(store.readRaw(id));
    } catch (err) {
      failures.push(`search snapshot ${id}: ${err.message}`);
      continue;
    }
    items += rows.length;
    const r = storeCompanies({ db, spine, records: rows.map(companyFrom).filter(Boolean), source: 'advanced-search', snapshotId: id, watchlists, formationAgents, now });
    r.touched.forEach((n) => touched.add(n));
    added += r.added;
    markProcessed(db, id, 'search', rows.length, now);
  }
  return { touched: [...touched], added, items, failures };
}

export function processStream({ db, spine, store, snapshotIds, watchlists, formationAgents, maxAgeDays, now }) {
  const touched = new Set();
  let added = 0;
  let events = 0;
  let malformed = 0;
  for (const id of snapshotIds) {
    if (isProcessed(db, id)) continue;
    const parsed = parseStreamChunk(store.readRaw(id), { maxAgeDays });
    events += parsed.events;
    malformed += parsed.malformed;
    const r = storeCompanies({ db, spine, records: parsed.items.map(companyFrom).filter(Boolean), source: 'stream', snapshotId: id, watchlists, formationAgents, now });
    r.touched.forEach((n) => touched.add(n));
    added += r.added;
    markProcessed(db, id, 'stream', parsed.events, now);
  }
  return { touched: [...touched], added, events, malformed };
}

/* ============================================================= officers */

export function companiesNeedingOfficers(db, limit) {
  return db.prepare(`SELECT company_number FROM incorporations WHERE officers_status IN ('pending', 'failed') ORDER BY first_seen DESC, company_number LIMIT ?`).pluck().all(limit);
}

/** Store officer summaries (counts by role only). @returns {string[]} company numbers updated */
export function processOfficers({ db, store, results, now }) {
  const update = db.prepare(`UPDATE incorporations SET officers_status = ?, officers_summary = ?, updated_at = ? WHERE company_number = ?`);
  const touched = [];
  db.transaction(() => {
    for (const r of results) {
      if (r.status !== 'fetched') {
        update.run(r.status, null, now, r.companyNumber);
        continue;
      }
      let body;
      try {
        body = JSON.parse(decode(store.readRaw(r.snapshotId)));
      } catch {
        update.run('failed', null, now, r.companyNumber);
        continue;
      }
      update.run('fetched', JSON.stringify(summariseOfficers(body?.items ?? [])), now, r.companyNumber);
      touched.push(r.companyNumber);
    }
  })();
  return touched;
}

/* ============================================================== scoring */

const rowToCompany = (r) => ({
  companyNumber: r.company_number, name: r.name, sicCodes: JSON.parse(r.sic_codes), roPostcode: r.ro_postcode, roLocality: r.ro_locality,
  roRegion: r.ro_region, roCountry: r.ro_country, formationAgent: r.formation_agent,
});

/**
 * Score each company against every watchlist it matches. Leads already sent are
 * never re-scored (a lead alerts once); unsent ones are refreshed, e.g. when
 * officers arrive.
 * @returns {number} leads scored
 */
export function scoreCompanies({ db, companyNumbers, watchlists, now }) {
  const getCo = db.prepare(`SELECT * FROM incorporations WHERE company_number = ?`);
  const sent = db.prepare(`SELECT 1 FROM scored_leads WHERE company_number = ? AND watchlist_id = ? AND notified_at IS NOT NULL`);
  const upsert = db.prepare(`
    INSERT INTO scored_leads (company_number, watchlist_id, matched_sic, score, reasons, scored_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_number, watchlist_id) DO UPDATE SET matched_sic = excluded.matched_sic, score = excluded.score,
      reasons = excluded.reasons, scored_at = excluded.scored_at WHERE scored_leads.notified_at IS NULL`);
  let n = 0;
  db.transaction(() => {
    for (const num of new Set(companyNumbers)) {
      const row = getCo.get(num);
      if (!row) continue;
      const company = rowToCompany(row);
      const officers = row.officers_summary ? JSON.parse(row.officers_summary) : null;
      for (const w of watchlists) {
        const m = bestSicMatch(company.sicCodes, w.sicCodes);
        if (!m || sent.get(num, w.watchlistId)) continue;
        const { score, reasons } = scoreLead(company, w, officers);
        upsert.run(num, w.watchlistId, m.entry, score, JSON.stringify(reasons), now);
        n += 1;
      }
    }
  })();
  return n;
}

/** Unsent leads for a watchlist at or above its minimum score, best first. */
export function pendingLeads(db, watchlist, limit) {
  return db.prepare(`
    SELECT l.*, i.name, i.company_type, i.date_of_creation, i.sic_codes, i.ro_locality, i.ro_postcode, i.ro_country,
           i.formation_agent, i.officers_status, i.officers_summary
    FROM scored_leads l JOIN incorporations i ON i.company_number = l.company_number
    WHERE l.watchlist_id = ? AND l.notified_at IS NULL AND l.score >= ?
    ORDER BY l.score DESC, i.date_of_creation DESC, l.company_number LIMIT ?`).all(watchlist.watchlistId, watchlist.minScore, limit)
    .map((r) => ({ ...r, reasons: JSON.parse(r.reasons), sic_codes: JSON.parse(r.sic_codes), officers_summary: r.officers_summary ? JSON.parse(r.officers_summary) : null }));
}

export function countPending(db, watchlist) {
  return db.prepare(`SELECT COUNT(*) FROM scored_leads WHERE watchlist_id = ? AND notified_at IS NULL AND score >= ?`).pluck().get(watchlist.watchlistId, watchlist.minScore);
}

/**
 * Mark the watchlist's qualifying leads (score ≥ minScore: shown, or counted in "and N more") as sent.
 * Leads below the threshold stay unsent, so they can still qualify later, e.g. once officers arrive.
 */
export function markNotified(db, watchlist, now) {
  return db.prepare(`UPDATE scored_leads SET notified_at = ? WHERE watchlist_id = ? AND notified_at IS NULL AND score >= ?`)
    .run(now, watchlist.watchlistId, watchlist.minScore).changes;
}