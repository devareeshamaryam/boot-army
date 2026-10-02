/**
 * B4 processor: raw snapshots → distress_records → company states → tier
 * transitions (+ tags) → spine DISTRESS_EVENTs.
 *
 * Reads only the snapshot store. Every write is idempotent: the same notice,
 * case or CSV row is recorded once, and re-running changes nothing.
 */
import { match, normalizeEntityId } from '@botarmy/core';
import { CH_CASE_TYPES, EVENT_TYPES, GAZETTE_CODES, SOLVENT_GAZETTE_CODES, TIERS, applyTagRules, evaluateState, transitionKind } from './score.js';
import { SOURCES } from './harvest.js';

export const BOT = 'distress-scout';
export const EVENT_TYPE = 'DISTRESS_EVENT';
export const ACTION_TAGS = Object.freeze(['ACQUIRE', 'ASSETS', 'APPROACH', 'PROPERTY', 'TALENT']);

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

const json = (buffer, what) => {
  try {
    return JSON.parse(decode(buffer));
  } catch {
    throw new Error(`${what}: response is not valid JSON`);
  }
};

export const stripHtml = (s) => String(s ?? '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

const pad = (n) => String(n).padStart(2, '0');
function calendarDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** "YYYY-MM-DD" from ISO or dd/mm/yyyy; null when unparseable or impossible. */
export function toIsoDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return calendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

export function parseCsv(text) {
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
  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.trim());
  return body.filter((r) => r.some((v) => v.trim() !== '')).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function pick(row, candidates = []) {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const key = lower.get(String(c).toLowerCase());
    const v = key === undefined ? undefined : row[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/* =============================================== company identification */

const CN_RE = /\bCompany\s+(?:Registration\s+)?(?:No|Number|Reg(?:istration)?\.?\s*No)\.?\s*[:.]?\s*((?:SC|NI|OC|SO|NC|R0|FC|LP|SL|NL|SE)?\s?\d{5,8})\b/i;

/**
 * Companies House number from notice text, normalised ("UK:01234567"), or null.
 * Only an explicit "Company Number …" label is trusted: bare digits never are.
 */
export function extractCompanyKey(text) {
  const m = String(text ?? '').match(CN_RE);
  if (!m) return null;
  try {
    return normalizeEntityId(m[1].replace(/\s+/g, ''), 'UK');
  } catch {
    return null;
  }
}

const nameKey = (name) => `name:${match.nameNorm(name)}`;
const numberOf = (key) => (key?.startsWith('UK:') ? key.slice(3) : null);

/* ============================================================= Gazette */

/**
 * Feed page → entries. The JSON form may give a single entry as an object.
 * @returns {{ noticeId, noticeCode, title, published, url, text }[]}
 */
export function parseGazetteFeed(buffer) {
  const body = json(buffer, 'gazette feed');
  if (!body || typeof body !== 'object') throw new Error('gazette feed: unexpected response');
  const raw = body.entry === undefined || body.entry === null ? [] : [body.entry].flat();
  return raw.map((e) => {
    const id = String(e?.id ?? '');
    const noticeId = id.split('/').pop() || null;
    const links = [e?.link].flat().filter(Boolean);
    const url = links.find((l) => !l['@rel'] && /\/notice\//.test(l['@href'] ?? ''))?.['@href'] ?? (noticeId ? `https://www.thegazette.co.uk/notice/${noticeId}` : null);
    const code = Number.parseInt(String(e?.['f:notice-code'] ?? ''), 10);
    return {
      noticeId, noticeCode: Number.isFinite(code) ? code : null, title: stripHtml(e?.title) || null,
      published: toIsoDate(e?.published), url, text: stripHtml(e?.content),
    };
  }).filter((e) => e.noticeId);
}

const CASE_RE = /\b(CR-\d{4}-\d{3,6}|BL-\d{4}-\d{3,6}|\d{1,6}\s+of\s+(?:19|20)\d{2})\b/i;

/** Gazette distress entries that need the full notice page to find a company number. */
export function entriesNeedingFullText(store, snapshotIds, { db, limit }) {
  const seen = new Set(db.prepare(`SELECT source_ref FROM distress_records WHERE source = 'gazette'`).pluck().all());
  const out = [];
  for (const id of snapshotIds) {
    let entries;
    try { entries = parseGazetteFeed(store.readRaw(id)); } catch { continue; }
    for (const e of entries) {
      if (out.length >= limit) return out;
      if (!GAZETTE_CODES[e.noticeCode] || seen.has(e.noticeId) || extractCompanyKey(e.text)) continue;
      out.push(e.noticeId);
    }
  }
  return out;
}

/**
 * Entries → records. Solvent (members' voluntary) and unknown codes are counted, never mapped.
 * @param {Map<string, string>} fullTextById  notice id → full page text (optional)
 */
export function gazetteToRecords(entries, fullTextById = new Map()) {
  const records = [];
  const skipped = { solvent: 0, otherCodes: 0 };
  for (const e of entries) {
    if (SOLVENT_GAZETTE_CODES.includes(e.noticeCode)) { skipped.solvent += 1; continue; }
    const eventType = GAZETTE_CODES[e.noticeCode];
    if (!eventType) { skipped.otherCodes += 1; continue; }
    const text = `${e.text} ${fullTextById.get(e.noticeId) ?? ''}`;
    const companyKey = extractCompanyKey(text);
    const name = e.title || 'Unnamed company';
    records.push({
      source: 'gazette', sourceRef: e.noticeId, companyKey: companyKey ?? nameKey(name), companyNumber: numberOf(companyKey),
      companyName: name, eventType, eventDate: e.published, dateBasis: e.published ? 'published' : 'unknown',
      noticeCode: String(e.noticeCode), reference: text.match(CASE_RE)?.[1] ?? null, url: e.url,
    });
  }
  return { records, skipped };
}

/* ===================================================== Companies House */

/**
 * Profile (+ insolvency) → records. Resolutions (filed accounts, dropped
 * strike-off) need the company's open records, so they are derived here from
 * `openTypes` rather than guessed.
 */
export function companiesHouseToRecords({ profile, insolvency, companyKey, openTypes = new Set(), today }) {
  const n = numberOf(companyKey);
  const name = String(profile?.company_name ?? '').trim() || n;
  const records = [];
  const unknownCaseTypes = [];
  const rec = (eventType, eventDate, dateBasis, refSuffix, extra = {}) => records.push({
    source: 'companies-house', sourceRef: `${n}:${refSuffix}`, companyKey, companyNumber: n, companyName: name,
    eventType, eventDate, dateBasis, noticeCode: null, reference: extra.reference ?? null,
    url: `https://find-and-update.company-information.service.gov.uk/company/${n}${extra.path ?? ''}`,
  });

  const accountsOverdue = profile?.accounts?.overdue === true;
  const nextDue = toIsoDate(profile?.accounts?.next_due);
  if (accountsOverdue) rec('accounts_overdue', nextDue, nextDue ? 'due' : 'observed', `accounts_overdue:${nextDue ?? today}`, { path: '/filing-history' });
  else if (openTypes.has('accounts_overdue') && profile?.accounts) rec('accounts_filed', today, 'observed', `accounts_filed:${today}`, { path: '/filing-history' });

  const csOverdue = profile?.confirmation_statement?.overdue === true;
  const csDue = toIsoDate(profile?.confirmation_statement?.next_due);
  if (csOverdue) rec('confirmation_overdue', csDue, csDue ? 'due' : 'observed', `confirmation_overdue:${csDue ?? today}`, { path: '/filing-history' });
  else if (openTypes.has('confirmation_overdue') && profile?.confirmation_statement) rec('confirmation_filed', today, 'observed', `confirmation_filed:${today}`, { path: '/filing-history' });

  const strikeOff = profile?.company_status_detail === 'active-proposal-to-strike-off';
  // One record per proposal: only when none is open, keyed to the day it was first seen, so a
  // strike-off that is discontinued and later re-proposed is recorded (and alerted) again.
  if (strikeOff && !openTypes.has('strike_off_proposed')) rec('strike_off_proposed', today, 'observed', `strike_off_proposed:${today}`);
  else if (openTypes.has('strike_off_proposed') && profile?.company_status === 'active') rec('strike_off_discontinued', today, 'observed', `strike_off_discontinued:${today}`);

  if (profile?.company_status === 'dissolved') {
    const d = toIsoDate(profile?.date_of_cessation);
    rec('dissolved', d ?? today, d ? 'case' : 'observed', 'dissolved');
  }

  for (const c of insolvency?.cases ?? []) {
    if (!Object.hasOwn(CH_CASE_TYPES, c?.type)) { unknownCaseTypes.push(String(c?.type)); continue; }
    const eventType = CH_CASE_TYPES[c.type];
    if (!eventType) continue; // members' voluntary liquidation: solvent
    const dates = (c.dates ?? []).map((d) => toIsoDate(d?.date)).filter(Boolean).sort();
    rec(eventType, dates[0] ?? null, dates[0] ? 'case' : 'unknown', `case:${c.number ?? dates[0] ?? 'x'}:${c.type}`, { reference: c.number ? `CH insolvency case ${c.number}` : null, path: '/insolvency' });
  }
  const sicCodes = (profile?.sic_codes ?? []).map(String);
  return { records, unknownCaseTypes, company: { name, sicCodes, status: profile?.company_status ?? null } };
}

/* ================================================================== CSV */

const CSV_FIELDS = {
  companyNumber: ['company_number', 'Company Number', 'CompanyNumber', 'crn'],
  companyName: ['company_name', 'Company Name', 'Company', 'Name'],
  eventType: ['event_type', 'Event Type', 'Type'],
  eventDate: ['event_date', 'Event Date', 'Date'],
  reference: ['reference', 'Reference', 'Case Number', 'Ref'],
  url: ['url', 'URL', 'Link'],
};

/** CSV rows → records. Event types must map to a known type; unknown ones are counted, not guessed. */
export function csvToRecords(buffer, feed) {
  const fields = { ...CSV_FIELDS, ...(feed.fields ?? {}) };
  const records = [];
  const problems = { unknownType: 0, noCompany: 0 };
  for (const [i, row] of parseCsv(decode(buffer)).entries()) {
    const rawType = pick(row, fields.eventType);
    const eventType = feed.eventTypeMap?.[rawType] ?? (EVENT_TYPES[rawType] ? rawType : null) ?? feed.defaultEventType ?? null;
    if (!eventType || !EVENT_TYPES[eventType]) { problems.unknownType += 1; continue; }
    let companyKey = null;
    const rawNumber = pick(row, fields.companyNumber);
    if (rawNumber) { try { companyKey = normalizeEntityId(rawNumber, 'UK'); } catch { companyKey = null; } }
    const name = pick(row, fields.companyName);
    if (!companyKey && !name) { problems.noCompany += 1; continue; }
    const date = toIsoDate(pick(row, fields.eventDate));
    records.push({
      source: `csv:${feed.name}`, sourceRef: pick(row, fields.reference) ?? `${companyKey ?? nameKey(name)}:${eventType}:${date ?? `row${i}`}`,
      companyKey: companyKey ?? nameKey(name), companyNumber: numberOf(companyKey), companyName: name ?? numberOf(companyKey),
      eventType, eventDate: date, dateBasis: date ? 'reported' : 'unknown', noticeCode: null,
      reference: pick(row, fields.reference), url: pick(row, fields.url),
    });
  }
  return { records, problems };
}

/* =============================================================== config */

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(s);

/** Validate distress.json. Every problem is reported at once. */
export function validateConfig(raw) {
  const problems = [];
  const watchlist = (Array.isArray(raw?.watchlist) ? raw.watchlist : []).map((w, i) => {
    let companyKey = null;
    try { companyKey = normalizeEntityId(String(w?.companyNumber ?? ''), 'UK'); } catch { problems.push(`watchlist[${i}].companyNumber "${w?.companyNumber}" is not a Companies House number`); }
    if (!w?.name) problems.push(`watchlist[${i}].name is required`);
    return { companyKey, companyNumber: numberOf(companyKey), name: w?.name, note: w?.note ?? null };
  });

  const tagRules = (Array.isArray(raw?.tagRules) ? raw.tagRules : []).map((r, i) => {
    const at = `tagRules[${i}]`;
    if (!isSlug(r?.id)) problems.push(`${at}.id must be a slug`);
    if (!ACTION_TAGS.includes(r?.tag)) problems.push(`${at}.tag must be one of ${ACTION_TAGS.join(', ')}`);
    for (const t of r?.tiers ?? []) if (!TIERS.includes(t)) problems.push(`${at}.tiers: "${t}" is not a tier`);
    for (const t of r?.eventTypes ?? []) if (!EVENT_TYPES[t]) problems.push(`${at}.eventTypes: "${t}" is not an event type`);
    return { id: r?.id, tag: r?.tag, tiers: r?.tiers ?? [], eventTypes: r?.eventTypes ?? [], sicPrefixes: (r?.sicPrefixes ?? []).map(String), nameKeywords: r?.nameKeywords ?? [] };
  });

  const routes = raw?.routes ?? {};
  for (const [tag, channels] of Object.entries(routes)) {
    if (!ACTION_TAGS.includes(tag)) problems.push(`routes.${tag}: not an action tag`);
    if (!Array.isArray(channels) || channels.some((c) => !isSlug(c))) problems.push(`routes.${tag} must be a list of channel names`);
  }

  const csvFeeds = (raw?.sources?.csvFeeds ?? []).map((f, i) => {
    if (!isSlug(f?.name)) problems.push(`sources.csvFeeds[${i}].name must be a slug`);
    if (!f?.path && !f?.url) problems.push(`sources.csvFeeds[${i}] needs "path" or "url"`);
    for (const t of Object.values(f?.eventTypeMap ?? {})) if (!EVENT_TYPES[t]) problems.push(`sources.csvFeeds[${i}].eventTypeMap: "${t}" is not an event type`);
    return f;
  });

  if (problems.length) throw new Error(`distress.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return {
    watchlist, tagRules, routes,
    gazette: { enabled: true, lookbackDays: 3, maxPages: 30, fetchFullNotices: true, maxNoticeFetches: 150, ...(raw?.sources?.gazette ?? {}) },
    companiesHouse: { enabled: true, refreshDays: 7, maxLookups: 200, lookupGazetteCompanies: true, ...(raw?.sources?.companiesHouse ?? {}) },
    csvFeeds,
    volumeGuard: { minExpected: 20, lookbackRuns: 5, ...(raw?.volumeGuard ?? {}) },
    alertWindowDays: Number.isInteger(raw?.alertWindowDays) && raw.alertWindowDays > 0 ? raw.alertWindowDays : 30,
  };
}

export function syncWatchlist(db, watchlist, now) {
  const up = db.prepare(`
    INSERT INTO watchlist_companies (company_key, company_number, name, note, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (company_key) DO UPDATE SET name = excluded.name, note = excluded.note, active = 1, updated_at = excluded.updated_at`);
  db.transaction(() => {
    db.prepare(`UPDATE watchlist_companies SET active = 0`).run();
    for (const w of watchlist) up.run(w.companyKey, w.companyNumber, w.name, w.note, now);
  })();
}

/* ======================================================== state helpers */

export const getCursor = (db, source) => db.prepare(`SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;
export function setCursor(db, source, cursor, now) {
  db.prepare(`INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(source, cursor, now);
}
const alreadyProcessed = (db, id) => Boolean(db.prepare(`SELECT 1 FROM processed_snapshots WHERE snapshot_id = ?`).get(id));
const markProcessed = (db, id, source, items, now) =>
  db.prepare(`INSERT OR IGNORE INTO processed_snapshots (snapshot_id, source, items, processed_at) VALUES (?, ?, ?, ?)`).run(id, source, items, now);

/**
 * Drop guard: a Gazette window that held a publishing day but returned nothing,
 * when recent weekday runs averaged ≥ minExpected, is an anomaly. Weekend-only
 * windows are never judged (the Gazette does not publish then).
 * @returns {string|null}
 */
export function volumeAnomaly(db, source, items, hadWeekday, { minExpected, lookbackRuns }) {
  if (items > 0 || !hadWeekday) return null;
  const recent = db.prepare(`SELECT items FROM source_runs WHERE source = ? AND outcome = 'ok' AND weekday = 1 ORDER BY id DESC LIMIT ?`).pluck().all(source, lookbackRuns);
  if (recent.length < Math.min(3, lookbackRuns)) return null;
  const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
  return avg >= minExpected ? `${source} returned 0 notices for a publishing day; the last ${recent.length} weekday runs averaged ${Math.round(avg)}` : null;
}

export function recordSourceRun(db, { runId, source, items, weekday, outcome, note = null, now }) {
  db.prepare(`INSERT INTO source_runs (run_id, source, items, weekday, outcome, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, source, items, weekday ? 1 : 0, outcome, note, now);
}

/* ============================================================== storage */

/**
 * Store records (idempotent on source + source_ref) and emit one DISTRESS_EVENT
 * each to the spine. Spine first (idempotent), then the bot table.
 * @returns {string[]} company keys that gained at least one new record
 */
export function storeRecords({ db, spine, records, snapshotId, now }) {
  const exists = db.prepare(`SELECT 1 FROM distress_records WHERE source = ? AND source_ref = ?`);
  const fresh = records.filter((r) => !exists.get(r.source, r.sourceRef));
  if (!fresh.length) return [];

  const links = new Map();
  spine.db.transaction(() => {
    const entities = new Map();
    for (const r of fresh) {
      let entityId = entities.get(r.companyKey);
      if (entityId === undefined) {
        entityId = spine.upsertEntity({
          jurisdiction: 'UK', registryId: r.companyNumber, spineId: r.companyNumber ? r.companyKey : null,
          name: r.companyName, source: BOT, seenAt: now,
        });
        entities.set(r.companyKey, entityId);
      }
      const def = EVENT_TYPES[r.eventType];
      const { eventId } = spine.linkEvent({
        entityId, type: EVENT_TYPE, date: r.eventDate, detectedAt: now,
        // The source ref keeps two notices for one company on one day distinct.
        source: `${BOT}:${r.source}:${r.sourceRef}`,
        payload: { eventType: r.eventType, label: def.label, tier: def.tier ?? null, stage: def.stage ?? null, dateBasis: r.dateBasis, noticeCode: r.noticeCode, reference: r.reference, url: r.url },
      });
      links.set(`${r.source}|${r.sourceRef}`, eventId);
    }
  })();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO distress_records
      (source, source_ref, company_key, company_number, company_name, event_type, tier, stage, event_date, date_basis, notice_code, reference, url, snapshot_id, event_id, detected_at)
    VALUES (@source, @sourceRef, @companyKey, @companyNumber, @companyName, @eventType, @tier, @stage, @eventDate, @dateBasis, @noticeCode, @reference, @url, @snapshotId, @eventId, @now)`);
  db.transaction(() => {
    for (const r of fresh) {
      const def = EVENT_TYPES[r.eventType];
      insert.run({ ...r, tier: def.tier ?? null, stage: def.stage ?? null, snapshotId, eventId: links.get(`${r.source}|${r.sourceRef}`), now });
    }
  })();
  return [...new Set(fresh.map((r) => r.companyKey))];
}

/** Parse + store Gazette feed pages. Snapshots that fail to parse are not marked processed (retried, reported). */
export function processGazette({ db, spine, store, snapshotIds, fullTextById = new Map(), now }) {
  const touched = new Set();
  const stats = { entries: 0, records: 0, solvent: 0, otherCodes: 0, unresolved: 0 };
  const failures = [];
  for (const id of snapshotIds) {
    if (alreadyProcessed(db, id)) continue;
    let entries;
    try {
      entries = parseGazetteFeed(store.readRaw(id));
    } catch (err) {
      failures.push(`gazette snapshot ${id}: ${err.message}`);
      continue;
    }
    const { records, skipped } = gazetteToRecords(entries, fullTextById);
    stats.entries += entries.length;
    stats.records += records.length;
    stats.solvent += skipped.solvent;
    stats.otherCodes += skipped.otherCodes;
    stats.unresolved += records.filter((r) => !r.companyNumber).length;
    storeRecords({ db, spine, records, snapshotId: id, now }).forEach((k) => touched.add(k));
    markProcessed(db, id, SOURCES.gazetteFeed, entries.length, now);
  }
  return { touched: [...touched], stats, failures };
}

/** Full-text map from stored notice pages. */
export function noticeTexts(store, snapshotByNoticeId) {
  return new Map([...snapshotByNoticeId].map(([noticeId, snapId]) => [noticeId, stripHtml(decode(store.readRaw(snapId)))]));
}

/**
 * Company numbers due a Companies House lookup: watchlist companies plus (if
 * enabled) companies seen in new Gazette records, not looked up within refreshDays.
 */
export function companiesDueLookup(db, { extraKeys = [], refreshDays, limit, now }) {
  const cutoff = new Date(Date.parse(now) - refreshDays * DAY_MS).toISOString();
  const keys = [...new Set([...db.prepare(`SELECT company_key FROM watchlist_companies WHERE active = 1`).pluck().all(), ...extraKeys.filter((k) => k.startsWith('UK:'))])];
  const recent = db.prepare(`SELECT 1 FROM ch_lookups WHERE company_key = ? AND looked_up_at >= ?`);
  return keys.filter((k) => !recent.get(k, cutoff)).slice(0, limit);
}

/** Store one Companies House lookup's records and remember the lookup. */
export function processCompaniesHouse({ db, spine, store, lookup, now }) {
  const companyKey = `UK:${lookup.companyNumber}`;
  const remember = db.prepare(`
    INSERT INTO ch_lookups (company_key, company_name, sic_codes, company_status, looked_up_at, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_key) DO UPDATE SET company_name = COALESCE(excluded.company_name, ch_lookups.company_name),
      sic_codes = excluded.sic_codes, company_status = COALESCE(excluded.company_status, ch_lookups.company_status),
      looked_up_at = excluded.looked_up_at, status = excluded.status, note = excluded.note`);
  if (lookup.status !== 'ok') {
    remember.run(companyKey, null, '[]', null, now, lookup.status, lookup.error ?? null);
    return { touched: [], warnings: lookup.status === 'not-found' ? [`Companies House has no company ${lookup.companyNumber}`] : [`Companies House ${lookup.companyNumber}: ${lookup.error}`] };
  }
  const profile = json(store.readRaw(lookup.profileSnapshotId), 'companies house profile');
  const insolvency = lookup.insolvencySnapshotId ? json(store.readRaw(lookup.insolvencySnapshotId), 'companies house insolvency') : { cases: [] };
  const state = evaluateState(db.prepare(`SELECT id, event_type AS eventType, event_date AS eventDate FROM distress_records WHERE company_key = ?`).all(companyKey));
  const openTypes = new Set(state.open.map((o) => o.eventType));
  const { records, unknownCaseTypes, company } = companiesHouseToRecords({ profile, insolvency, companyKey, openTypes, today: isoDay(now) });
  const touched = storeRecords({ db, spine, records, snapshotId: lookup.profileSnapshotId, now });
  remember.run(companyKey, company.name, JSON.stringify(company.sicCodes), company.status, now, 'ok', unknownCaseTypes.length ? `unknown case types: ${unknownCaseTypes.join(', ')}` : null);
  return {
    touched: touched.length ? touched : [companyKey],
    warnings: unknownCaseTypes.map((t) => `Companies House ${lookup.companyNumber}: unknown insolvency case type "${t}" not mapped`),
  };
}

export function processCsv({ db, spine, store, fetched, feeds, now }) {
  const touched = new Set();
  const warnings = [];
  for (const f of fetched) {
    if (alreadyProcessed(db, f.snapshotId)) continue;
    const feed = feeds.find((x) => x.name === f.feed);
    const { records, problems } = csvToRecords(store.readRaw(f.snapshotId), feed);
    if (problems.unknownType) warnings.push(`csv:${f.feed}: ${problems.unknownType} row(s) with an unmapped event type skipped`);
    if (problems.noCompany) warnings.push(`csv:${f.feed}: ${problems.noCompany} row(s) without a company skipped`);
    storeRecords({ db, spine, records, snapshotId: f.snapshotId, now }).forEach((k) => touched.add(k));
    markProcessed(db, f.snapshotId, `csv:${f.feed}`, records.length, now);
  }
  return { touched: [...touched], warnings };
}

/* ============================================================ evaluation */

/**
 * Recompute state for each touched company and record tier transitions + tags.
 * A transition driven by an event older than alertWindowDays is recorded but
 * not alerted (e.g. a first Companies House lookup finding a 2015 liquidation).
 * @returns {{ transitions: number, historic: number }}
 */
export function evaluateCompanies({ db, companyKeys, tagRules, alertWindowDays = 30, now }) {
  const day = isoDay(now);
  const cutoff = isoDay(Date.parse(now) - alertWindowDays * DAY_MS);
  const events = db.prepare(`SELECT id, event_type AS eventType, event_date AS eventDate FROM distress_records WHERE company_key = ?`);
  const latestName = db.prepare(`SELECT company_name, company_number FROM distress_records WHERE company_key = ? ORDER BY id DESC LIMIT 1`);
  const lookup = db.prepare(`SELECT company_name, sic_codes FROM ch_lookups WHERE company_key = ?`);
  const getState = db.prepare(`SELECT * FROM company_states WHERE company_key = ?`);
  const upsertState = db.prepare(`
    INSERT INTO company_states (company_key, company_number, company_name, tier, stage, severity, open_signals, reasons, sic_codes, opened_at, updated_at)
    VALUES (@key, @number, @name, @tier, @stage, @severity, @open, @reasons, @sic, @now, @now)
    ON CONFLICT (company_key) DO UPDATE SET company_name = excluded.company_name, tier = excluded.tier, stage = excluded.stage,
      severity = excluded.severity, open_signals = excluded.open_signals, reasons = excluded.reasons, sic_codes = excluded.sic_codes, updated_at = excluded.updated_at`);
  const insertTransition = db.prepare(`
    INSERT OR IGNORE INTO transitions (company_key, from_tier, to_tier, kind, severity, reasons, at, at_day, notified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTag = db.prepare(`INSERT OR IGNORE INTO tags (transition_id, tag, rule_hit) VALUES (?, ?, ?)`);
  const counts = { transitions: 0, historic: 0 };

  db.transaction(() => {
    for (const key of companyKeys) {
      const state = evaluateState(events.all(key));
      const prev = getState.get(key);
      if (!prev && state.tier === 'none') continue;
      const info = lookup.get(key);
      const rec = latestName.get(key);
      const name = info?.company_name ?? rec?.company_name ?? key;
      const sic = info?.sic_codes ?? prev?.sic_codes ?? '[]';
      upsertState.run({ key, number: rec?.company_number ?? numberOf(key), name, tier: state.tier, stage: state.stage, severity: state.severity,
        open: JSON.stringify(state.open), reasons: JSON.stringify(state.reasons), sic, now });

      const from = prev?.tier ?? 'none';
      const kind = transitionKind(from, state.tier);
      if (kind === 'unchanged') continue;
      const driverDate = state.reasons.driver?.eventDate ?? state.reasons.dissolvedOn ?? day;
      const historic = kind === 'escalation' && driverDate < cutoff;
      const t = insertTransition.run(key, from, state.tier, kind, state.severity, JSON.stringify({ ...state.reasons, open: state.open, historic }), now, day, historic ? now : null);
      if (!t.changes) continue;
      counts.transitions += 1;
      if (historic) counts.historic += 1;
      if (kind === 'escalation') {
        for (const tag of applyTagRules(state, { name, sicCodes: JSON.parse(sic) }, tagRules)) insertTag.run(Number(t.lastInsertRowid), tag.tag, tag.ruleHit);
      }
    }
  })();
  return counts;
}

/* =========================================================== notification */

/** Unsent transitions with company, tags and the evidence behind each open signal. */
export function pendingTransitions(db) {
  const tags = db.prepare(`SELECT tag, rule_hit FROM tags WHERE transition_id = ? ORDER BY tag`);
  const evidence = db.prepare(`
    SELECT event_type, event_date, date_basis, notice_code, reference, url, source FROM distress_records
    WHERE company_key = ? AND event_type = ? ORDER BY event_date DESC, id DESC LIMIT 1`);
  const watch = db.prepare(`SELECT 1 FROM watchlist_companies WHERE company_key = ? AND active = 1`);
  return db.prepare(`
    SELECT t.*, s.company_name, s.company_number, s.stage, s.sic_codes FROM transitions t
    JOIN company_states s ON s.company_key = t.company_key
    WHERE t.notified_at IS NULL ORDER BY t.severity DESC, t.id`).all().map((t) => {
    const reasons = JSON.parse(t.reasons);
    return {
      ...t, reasons,
      watchlisted: Boolean(watch.get(t.company_key)),
      tags: tags.all(t.id).map((x) => ({ tag: x.tag, ruleHit: x.rule_hit })),
      evidence: (reasons.open ?? []).map((o) => evidence.get(t.company_key, o.eventType)).filter(Boolean),
    };
  });
}

export function markNotified(db, ids, now = new Date().toISOString()) {
  const update = db.prepare(`UPDATE transitions SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}