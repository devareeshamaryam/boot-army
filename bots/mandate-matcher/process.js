/**
 * B2 processor: raw roster snapshots → roster state → joiners/leavers → movers
 * (with spine persons, person_history, events, review_queue) → scores.
 *
 * Reads only the snapshot store, never the network. Every write path is
 * idempotent, so re-running for the same snapshots changes nothing.
 */
import { match, normalizeEntityId } from '@botarmy/core';
import { bandAtLeast, scoreMover, seniorityOf } from './score.js';
import { SOURCES } from './harvest.js';

export const BOT = 'mandate-matcher';
export const REGULATORS = Object.freeze(['FCA', 'MAS', 'SFC', 'DFSA', 'FSRA']);
export const MARKETS = Object.freeze(['UK', 'SG', 'HK', 'DIFC', 'ADGM']);
/** Spine jurisdiction of each regulator's registers. */
export const JURISDICTIONS = Object.freeze({ FCA: 'UK', MAS: 'SG', SFC: 'HK', DFSA: 'AE-DIFC', FSRA: 'AE-ADGM' });
/** Markets whose company numbers normalizeEntityId understands. */
const SPINE_MARKETS = Object.freeze({ UK: 'UK', SG: 'SG', DIFC: 'DIFC', ADGM: 'ADGM' });
const ENTITY_JURISDICTION = Object.freeze({ UK: 'UK', SG: 'SG', HK: 'HK', DIFC: 'AE-DIFC', ADGM: 'AE-ADGM' });

export const EVENT = Object.freeze({ MOVE: 'MOVER', LEFT: 'MOVER_LEFT', JOINED: 'MOVER_JOINED' });

/** UK GDPR: recorded against every person this bot processes. */
export const LAWFUL_BASIS = 'legitimate_interests';
export const PURPOSE = 'Executive search: identifying regulated professionals changing employer, using public regulator registers only.';
export const REGISTER_NAMES = Object.freeze({
  FCA: 'FCA Financial Services Register', MAS: 'MAS public registers', SFC: 'SFC public register (manual export)',
  DFSA: 'DFSA public register', FSRA: 'FSRA public register',
});

const DAY_MS = 86_400_000;
const daysBetween = (fromIso, toIso) => {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / DAY_MS)) : null;
};
const isoMinusDays = (now, days) => new Date(Date.parse(now) - days * DAY_MS).toISOString();

/* =============================================================== parsing */

export function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
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

const getPath = (obj, dotted) => (dotted ? dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), obj) : obj);

/** First non-empty value among candidate column names (case-insensitive). */
export function pick(row, candidates = []) {
  if (!row || typeof row !== 'object') return null;
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const key = lower.get(String(c).toLowerCase());
    const v = key === undefined ? undefined : row[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

/** A real calendar date as "YYYY-MM-DD", or null (31/02 is rejected, never rolled over). */
function calendarDate(y, mo, d) {
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** "YYYY-MM-DD" from dd/mm/yyyy, ISO or "12 Mar 2024"; null when unparseable or impossible (never guessed). */
export function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return calendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return calendarDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  return null;
}

const json = (buffer, what) => {
  try {
    return JSON.parse(decode(buffer));
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const irnFromUrl = (url) => String(url ?? '').match(/\/Individuals\/([A-Z0-9]+)/i)?.[1]?.toUpperCase() ?? null;
const frnFromUrl = (url) => String(url ?? '').match(/\/Firm\/(\d+)/)?.[1] ?? null;

/** FCA /Firm/{FRN}/CF pages → roster records. Only current, un-ended roles. */
export function parseFcaRoster(buffers, today) {
  const people = new Map();
  for (const buffer of buffers) {
    const body = json(buffer, 'FCA roster');
    const data = Array.isArray(body?.Data) ? body.Data : [];
    for (const block of data) {
      for (const [key, entry] of Object.entries(block?.Current ?? {})) {
        if (!entry) continue;
        const end = toIsoDate(entry['End Date']);
        if (end && end <= today) continue;
        const personRef = irnFromUrl(entry.URL);
        if (!personRef) continue;
        const person = people.get(personRef) ?? { personRef, name: clean(entry['Individual Name']) || personRef, roles: [] };
        const title = clean(entry.Name ?? key.replace(/^\(\d+\)/, ''));
        if (title && !person.roles.some((r) => r.title === title)) {
          person.roles.push({ title, code: key.match(/^\((\d+)\)/)?.[1] ?? null, since: toIsoDate(entry['Effective Date']) });
        }
        people.set(personRef, person);
      }
    }
  }
  return [...people.values()];
}

export function parseFcaProfile(buffer) {
  const data = json(buffer, 'FCA firm profile')?.Data?.[0];
  if (!data) return null;
  return { name: clean(data['Organisation Name']) || null, registrationNumber: clean(data['Companies House Number']) || null, status: data.Status ?? null };
}

/** Where an FCA leaver now holds a current role, excluding the firm they left. */
export function parseFcaDestination(buffer, fromFrn) {
  const blocks = json(buffer, 'FCA individual')?.Data ?? [];
  return blocks
    .flatMap((b) => Object.values(b?.Current ?? {}))
    .map((e) => ({ firmName: clean(e?.['Firm Name']) || null, firmRef: frnFromUrl(e?.URL), since: toIsoDate(e?.['Effective Date']) }))
    .filter((c) => c.firmName && c.firmRef !== fromFrn)
    .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''))[0] ?? null;
}

/** Column guesses per register. Override per source with "fields" in watchlist.json. */
export const FIELD_MAPS = Object.freeze({
  MAS: {
    personRef: ['Representative Number', 'Representative No', 'RNF Number', 'repNo', 'representativeNumber', 'Individual Reference'],
    name: ['Name', 'Representative Name', 'representativeName', 'Full Name'],
    role: ['Role', 'Designation', 'Regulated Activity', 'Type of Regulated Activity', 'Activity'],
    since: ['Date of Appointment', 'Start Date', 'Effective Date', 'appointmentDate', 'startDate'],
    status: ['Status', 'Representative Status', 'status'],
  },
  SFC: {
    personRef: ['CE Reference', 'CE No.', 'CE No', 'CE Number', 'ceRef', 'ceNo'],
    name: ['Name', 'English Name', 'Name in English', 'fullName', 'name'],
    role: ['Role', 'Capacity', 'Position'],
    since: ['Effective Date', 'Date of Approval', 'Start Date', 'effectiveDate'],
    status: ['Status', 'Licence Status'],
  },
  DFSA: {
    personRef: ['Individual Reference', 'Individual Reference Number', 'Reference Number', 'Individual ID', 'Approved Person Number', 'id'],
    name: ['Name', 'Individual Name', 'Full Name', 'name'],
    role: ['Function', 'Role', 'Controlled Function', 'Licensed Function', 'Authorised Function', 'Position'],
    since: ['Effective Date', 'Date of Approval', 'Approval Date', 'Start Date', 'effectiveDate'],
    status: ['Status', 'Individual Status'],
  },
});
/** FSRA publishes the same kind of authorised-individual register as the DFSA. */
const FSRA_FIELDS = FIELD_MAPS.DFSA;
const INACTIVE_STATUS = /cease|revok|inactive|terminat|withdrawn|former|lapsed|suspend/i;

export class RosterFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RosterFormatError';
  }
}

/** File/URL exports (CSV or JSON) → roster records, merged across parts. */
export function parseTabularRoster(parts, regulator) {
  const people = new Map();
  for (const { buffer, meta } of parts) {
    const fields = { ...(regulator === 'FSRA' ? FSRA_FIELDS : FIELD_MAPS[regulator]), ...(meta.fields ?? {}) };
    const rows = meta.format === 'json' ? getPath(json(buffer, `${regulator} export`), meta.jsonPath) : parseCsv(decode(buffer));
    if (!Array.isArray(rows)) throw new RosterFormatError(`${regulator} export did not yield an array${meta.jsonPath ? ` at "${meta.jsonPath}"` : ''}`);
    let missingRef = 0;
    let kept = 0;
    for (const row of rows) {
      const status = fields.status ? pick(row, fields.status) : null;
      if (status && INACTIVE_STATUS.test(status)) continue;
      const rawRef = pick(row, fields.personRef);
      if (!rawRef) { missingRef += 1; continue; }
      const personRef = rawRef.toUpperCase().replace(/\s+/g, '');
      const person = people.get(personRef) ?? { personRef, name: pick(row, fields.name) ?? personRef, roles: [] };
      const title = pick(row, fields.role) ?? meta.defaultRole ?? 'Registered individual';
      if (!person.roles.some((r) => r.title === title)) person.roles.push({ title, code: null, since: toIsoDate(pick(row, fields.since)) });
      people.set(personRef, person);
      kept += 1;
    }
    if (rows.length && !kept && missingRef) {
      throw new RosterFormatError(`${regulator}: no person reference column found. Columns: ${Object.keys(rows[0]).join(', ')}. Set "fields.personRef" in watchlist.json.`);
    }
  }
  return [...people.values()];
}

/** Parse one roster fetch from the snapshot store. */
export function parseRosterSnapshots(store, snapshotIds, regulator, today) {
  const parts = snapshotIds.map((id) => ({ buffer: store.readRaw(id), meta: store.get(id).meta }));
  return regulator === 'FCA' ? parseFcaRoster(parts.map((p) => p.buffer), today) : parseTabularRoster(parts, regulator);
}

/* ============================================================= watchlist */

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(s);

/**
 * Validate watchlist.json. Every problem is reported at once.
 * @returns {{ firms: object[], mandates: object[], scoring: object }}
 */
export function validateWatchlist(raw) {
  const problems = [];
  const firms = Array.isArray(raw?.firms) ? raw.firms : [];
  if (!Array.isArray(raw?.firms) || !firms.length) problems.push('"firms" must list at least one firm');
  const keys = new Set();
  const outFirms = firms.map((f, i) => {
    const at = `firms[${i}]`;
    const regulator = String(f?.regulator ?? '').toUpperCase();
    if (!REGULATORS.includes(regulator)) problems.push(`${at}.regulator must be one of ${REGULATORS.join(', ')}`);
    const ref = typeof f?.ref === 'string' ? f.ref.trim() : '';
    if (!ref) problems.push(`${at}.ref must be a non-empty string`);
    if (!f?.name || typeof f.name !== 'string') problems.push(`${at}.name is required`);
    if (!MARKETS.includes(f?.market)) problems.push(`${at}.market must be one of ${MARKETS.join(', ')}`);
    if (![1, 2, 3].includes(f?.tier)) problems.push(`${at}.tier must be 1, 2 or 3`);
    if (regulator !== 'FCA' && !f?.source) problems.push(`${at}.source is required for ${regulator}`);
    const key = `${regulator}:${ref}`;
    if (keys.has(key)) problems.push(`${at} duplicates ${key}`);
    keys.add(key);
    return { ...f, regulator, ref, aliases: f?.aliases ?? [] };
  });

  const mandates = (Array.isArray(raw?.mandates) ? raw.mandates : []).map((m, i) => {
    const at = `mandates[${i}]`;
    if (!isSlug(m?.id)) problems.push(`${at}.id must be a slug`);
    if (!m?.client || !m?.title) problems.push(`${at} needs "client" and "title"`);
    for (const re of m?.licenceCategories ?? []) {
      try { new RegExp(re, 'i'); } catch { problems.push(`${at}.licenceCategories: "${re}" is not a valid regex`); }
    }
    if (m?.minSeniority && !bandAtLeast(m.minSeniority, 'other')) problems.push(`${at}.minSeniority "${m.minSeniority}" is not a seniority band`);
    return {
      mandateId: m?.id, client: m?.client, title: m?.title,
      markets: m?.markets ?? [], minSeniority: m?.minSeniority ?? null, licenceCategories: m?.licenceCategories ?? [],
      firmTiers: m?.firmTiers ?? [], exclusions: m?.exclusions ?? {}, active: m?.active !== false,
    };
  });

  if (problems.length) throw new Error(`watchlist.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return { firms: outFirms, mandates, scoring: raw?.scoring ?? {} };
}

/** Mirror the watchlist firms and mandates into the bot database. */
export function syncWatchlist(db, { firms, mandates }, now) {
  const upFirm = db.prepare(`
    INSERT INTO watchlist_firms (firm_key, regulator, firm_ref, name, market, tier, registration_number, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (firm_key) DO UPDATE SET name = excluded.name, market = excluded.market, tier = excluded.tier,
      registration_number = COALESCE(excluded.registration_number, watchlist_firms.registration_number), active = 1, updated_at = excluded.updated_at`);
  const upMandate = db.prepare(`
    INSERT INTO matrix (mandate_id, client, title, market, seniority, licence_category, firm_tier, exclusions, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (mandate_id) DO UPDATE SET client = excluded.client, title = excluded.title, market = excluded.market,
      seniority = excluded.seniority, licence_category = excluded.licence_category, firm_tier = excluded.firm_tier,
      exclusions = excluded.exclusions, active = excluded.active, updated_at = excluded.updated_at`);
  db.transaction(() => {
    db.prepare(`UPDATE watchlist_firms SET active = 0`).run();
    for (const f of firms) upFirm.run(`${f.regulator}:${f.ref}`, f.regulator, f.ref, f.name, f.market, f.tier, f.registrationNumber ?? null, now);
    db.prepare(`UPDATE matrix SET active = 0`).run();
    for (const m of mandates) {
      upMandate.run(m.mandateId, m.client, m.title, JSON.stringify(m.markets), m.minSeniority, JSON.stringify(m.licenceCategories),
        JSON.stringify(m.firmTiers), JSON.stringify(m.exclusions), m.active ? 1 : 0, now);
    }
  })();
}

export function activeMandates(db) {
  return db.prepare(`SELECT * FROM matrix WHERE active = 1 ORDER BY mandate_id`).all().map((r) => ({
    mandateId: r.mandate_id, client: r.client, title: r.title, markets: JSON.parse(r.market), minSeniority: r.seniority,
    licenceCategories: JSON.parse(r.licence_category), firmTiers: JSON.parse(r.firm_tier), exclusions: JSON.parse(r.exclusions),
  }));
}

/* ================================================================= spine */

/** Firm entity in the spine; uses the company number when known (watchlist, or FCA profile). */
export function resolveFirmEntity({ db, spine, store, firm, profileSnapshotId, now }) {
  const key = `${firm.regulator}:${firm.ref}`;
  let registrationNumber = firm.registrationNumber ?? null;
  let name = firm.name;
  if (profileSnapshotId) {
    const profile = parseFcaProfile(store.readRaw(profileSnapshotId));
    registrationNumber = registrationNumber || profile?.registrationNumber || null;
  }
  let registryId = null;
  let spineId = null;
  const j = SPINE_MARKETS[firm.market];
  if (registrationNumber && j) {
    try {
      spineId = normalizeEntityId(registrationNumber, j);
      registryId = spineId.slice(spineId.indexOf(':') + 1);
    } catch {
      // malformed number: the firm stays an unresolved entity
    }
  }
  const entityId = spine.upsertEntity({
    jurisdiction: ENTITY_JURISDICTION[firm.market], registryId, spineId, name, source: BOT, seenAt: now,
  });
  db.prepare(`UPDATE watchlist_firms SET entity_id = ?, registration_number = COALESCE(registration_number, ?) WHERE firm_key = ?`)
    .run(entityId, registrationNumber, key);
  return entityId;
}

/**
 * Person helpers over the spine's own connection. (core.spine has no person
 * API yet; these use the Section 4 tables directly and should move into core.)
 */
export function personStore(spine) {
  const db = spine.db;
  const find = db.prepare(`SELECT * FROM persons WHERE jurisdiction = ? AND registry_person_id = ? ORDER BY person_id LIMIT 1`);
  const insert = db.prepare(`
    INSERT INTO persons (jurisdiction, registry_person_id, name, name_norm, current_firm_entity_id, role_category, licence_types, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const touch = db.prepare(`
    UPDATE persons SET name = ?, name_norm = ?, current_firm_entity_id = COALESCE(?, current_firm_entity_id),
      role_category = ?, licence_types = ?, last_seen = ? WHERE person_id = ?`);
  const openRow = db.prepare(`SELECT rowid FROM person_history WHERE person_id = ? AND firm_entity_id IS ? AND to_date IS NULL LIMIT 1`);
  const insertHist = db.prepare(`INSERT INTO person_history (person_id, firm_entity_id, role, from_date, to_date, source) VALUES (?, ?, ?, ?, NULL, ?)`);
  const closeHist = db.prepare(`UPDATE person_history SET to_date = ? WHERE person_id = ? AND firm_entity_id IS ? AND to_date IS NULL`);
  const clearCurrent = db.prepare(`UPDATE persons SET current_firm_entity_id = NULL WHERE person_id = ? AND current_firm_entity_id IS ?`);

  return {
    /** @returns {number} person_id */
    upsert({ jurisdiction, ref, name, firmEntityId, roles, seenAt }) {
      const band = seniorityOf(roles).band;
      const licences = JSON.stringify(roles.map((r) => r.title));
      const existing = find.get(jurisdiction, ref);
      if (existing) {
        touch.run(name, match.nameNorm(name), firmEntityId, band, licences, seenAt, existing.person_id);
        return existing.person_id;
      }
      return Number(insert.run(jurisdiction, ref, name, match.nameNorm(name), firmEntityId, band, licences, seenAt, seenAt).lastInsertRowid);
    },
    find: (jurisdiction, ref) => find.get(jurisdiction, ref) ?? null,
    openHistory(personId, firmEntityId, roles, fromDate, source) {
      if (openRow.get(personId, firmEntityId)) return;
      insertHist.run(personId, firmEntityId, roles.map((r) => r.title).join('; '), fromDate, source);
    },
    closeHistory(personId, firmEntityId, toDate) {
      closeHist.run(toDate, personId, firmEntityId);
      clearCurrent.run(personId, firmEntityId);
    },
  };
}

/** Event source includes the person so two people joining one firm on one day stay distinct. */
export const eventSource = (regulator, personRef) => `${BOT}:${regulator}:${personRef}`;

/* ======================================================== roster process */

const earliest = (roles) => roles.map((r) => r.since).filter(Boolean).sort()[0] ?? null;

/**
 * Process one roster fetch for one firm.
 *
 * - Already processed (same snapshots): returns 'already-processed', no writes.
 * - First accepted fetch for the firm: BASELINE. State stored, 0 changes.
 * - Drop guard: an empty roster, or a fall of more than maxDropRatio on a
 *   roster of 10+, is REJECTED: recorded, state untouched, nothing emitted.
 *
 * Spine writes run first (idempotent by lookup), then bot state in one transaction.
 * @returns {{ outcome: string, joiners: number, leavers: number, records: number, note?: string, fetchId?: number }}
 */
export function processRoster({ db, spine, store, fetch, settings, now = new Date().toISOString(), log }) {
  const { firm, snapshotIds, complete = true, profileSnapshotId = null } = fetch;
  const key = `${firm.regulator}:${firm.ref}`;
  const fetchKey = `${key}|${[...snapshotIds].sort((a, b) => a - b).join(',')}`;
  if (db.prepare(`SELECT 1 FROM roster_fetches WHERE fetch_key = ?`).get(fetchKey)) {
    return { outcome: 'already-processed', joiners: 0, leavers: 0, records: 0 };
  }

  const today = now.slice(0, 10);
  const records = parseRosterSnapshots(store, snapshotIds, firm.regulator, today);
  const previous = db.prepare(`SELECT id FROM roster_fetches WHERE firm_key = ? AND outcome != 'rejected' ORDER BY id DESC LIMIT 1`).get(key);
  const active = db.prepare(`SELECT * FROM roster_people WHERE firm_key = ? AND active = 1`).all(key);
  const insertFetch = db.prepare(`
    INSERT INTO roster_fetches (firm_key, fetch_key, snapshot_ids, record_count, complete, outcome, note, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  if (previous && active.length) {
    let note = null;
    if (records.length === 0) note = `empty roster (previously ${active.length} active)`;
    else if (complete && active.length >= 10 && records.length < active.length * (1 - settings.maxDropRatio)) {
      note = `roster fell from ${active.length} to ${records.length}, more than the ${Math.round(settings.maxDropRatio * 100)}% drop limit`;
    }
    if (note) {
      insertFetch.run(key, fetchKey, JSON.stringify(snapshotIds), records.length, complete ? 1 : 0, 'rejected', note, now);
      log?.warn(`${key}: snapshot rejected, ${note}`);
      return { outcome: 'rejected', joiners: 0, leavers: 0, records: records.length, note };
    }
  }

  const isBaseline = !previous;
  const jurisdiction = JURISDICTIONS[firm.regulator];
  const activeByRef = new Map(active.map((p) => [p.person_ref, p]));
  const currentRefs = new Set(records.map((r) => r.personRef));
  const joiners = isBaseline ? [] : records.filter((r) => !activeByRef.has(r.personRef));
  const leavers = isBaseline || !complete ? [] : active.filter((p) => !currentRefs.has(p.person_ref));

  // 1. Spine: firm entity, persons, history.
  const persons = personStore(spine);
  const personIds = new Map();
  spine.db.transaction(() => {
    const entityId = resolveFirmEntity({ db, spine, store, firm, profileSnapshotId, now });
    for (const r of records) {
      const personId = persons.upsert({ jurisdiction, ref: r.personRef, name: r.name, firmEntityId: entityId, roles: r.roles, seenAt: now });
      personIds.set(r.personRef, personId);
      persons.openHistory(personId, entityId, r.roles, earliest(r.roles) ?? today, `${BOT}:${firm.regulator}`);
    }
    for (const p of leavers) persons.closeHistory(p.person_id, entityId, today);
  })();

  // 2. Bot state, changes and GDPR registry in one transaction.
  const upsertPerson = db.prepare(`
    INSERT INTO roster_people (firm_key, person_ref, person_id, name, roles, start_date, first_seen, last_seen, active, left_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
    ON CONFLICT (firm_key, person_ref) DO UPDATE SET person_id = excluded.person_id, name = excluded.name, roles = excluded.roles,
      start_date = COALESCE(excluded.start_date, roster_people.start_date), last_seen = excluded.last_seen,
      first_seen = CASE WHEN roster_people.active = 0 THEN excluded.first_seen ELSE roster_people.first_seen END,
      active = 1, left_at = NULL`);
  const deactivate = db.prepare(`UPDATE roster_people SET active = 0, left_at = ? WHERE firm_key = ? AND person_ref = ?`);
  const insertChange = db.prepare(`
    INSERT OR IGNORE INTO roster_changes (fetch_id, firm_key, regulator, person_ref, person_id, change_type, name, roles, tenure_days, tenure_estimate, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const register = db.prepare(`
    INSERT INTO person_registry (person_id, jurisdiction, registry_person_id, lawful_basis, purpose, source, first_seen, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (person_id) DO UPDATE SET last_active_at = excluded.last_active_at`);

  const fetchId = db.transaction(() => {
    const id = Number(insertFetch.run(key, fetchKey, JSON.stringify(snapshotIds), records.length, complete ? 1 : 0,
      isBaseline ? 'baseline' : 'diffed', isBaseline ? 'first sight of this firm; no changes emitted' : null, now).lastInsertRowid);
    for (const r of records) {
      const personId = personIds.get(r.personRef);
      upsertPerson.run(key, r.personRef, personId, r.name, JSON.stringify(r.roles), earliest(r.roles), now, now);
      register.run(personId, jurisdiction, r.personRef, LAWFUL_BASIS, PURPOSE, REGISTER_NAMES[firm.regulator], now, now);
    }
    for (const r of joiners) {
      insertChange.run(id, key, firm.regulator, r.personRef, personIds.get(r.personRef), 'joiner', r.name, JSON.stringify(r.roles), null, 0, now);
    }
    for (const p of leavers) {
      const since = p.start_date ?? p.first_seen;
      insertChange.run(id, key, firm.regulator, p.person_ref, p.person_id, 'leaver', p.name, p.roles, daysBetween(since, now), p.start_date ? 0 : 1, now);
      deactivate.run(now, key, p.person_ref);
      register.run(p.person_id, jurisdiction, p.person_ref, LAWFUL_BASIS, PURPOSE, REGISTER_NAMES[firm.regulator], now, now);
    }
    return id;
  })();

  const result = { outcome: isBaseline ? 'baseline' : 'diffed', joiners: joiners.length, leavers: leavers.length, records: records.length, fetchId };
  log?.info(`${key}: ${records.length} people, ${result.outcome}${isBaseline ? '' : ` (+${joiners.length} / -${leavers.length})`}`);
  return result;
}

/* ================================================================ movers */

const firmRow = (db, key) => (key ? db.prepare(`SELECT * FROM watchlist_firms WHERE firm_key = ?`).get(key) : null);
const parseRoles = (s) => {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * Cross-register identity confidence for a joiner vs an earlier leaver in a
 * different register: name similarity, minus 10 when seniority bands differ.
 * Registers publish no dates of birth, so name + role continuity is all there is.
 */
export function crossRegisterConfidence(joiner, leaver) {
  const { score } = match.fuzzyPerson({ name: joiner.name }, { name: leaver.name });
  const a = seniorityOf(parseRoles(joiner.roles)).band;
  const b = seniorityOf(parseRoles(leaver.roles)).band;
  return Math.max(0, score - (a === b ? 0 : 10));
}

/**
 * Turn pending roster changes into movers.
 *
 *   leaver                      → 'leaver' mover (signal: backfill)
 *   joiner + same-register leaver (same person ref, other firm, within lookback)
 *                               → 'move' (confidence 100)
 *   joiner + different-register leaver
 *     confidence ≥ matchThreshold and unambiguous → 'move' (method cross-register-name)
 *     reviewFloor ≤ confidence < matchThreshold   → review_queue; stays a 'joiner'. Never auto-merged.
 *   otherwise                   → 'joiner' mover
 *
 * Paired leaver/joiner movers are superseded by the move. Each mover emits one
 * spine event. Idempotent: a change becomes a mover once.
 * @returns {{ moves: number, leavers: number, joiners: number, reviews: number }}
 */
export function recordMovers({ db, spine, settings, now = new Date().toISOString(), log }) {
  const since = isoMinusDays(now, settings.moveLookbackDays);
  const today = now.slice(0, 10);
  const pending = db.prepare(`SELECT * FROM roster_changes WHERE mover_id IS NULL ORDER BY change_type DESC, id`).all(); // leavers first
  const counts = { moves: 0, leavers: 0, joiners: 0, reviews: 0 };

  const insertMover = db.prepare(`
    INSERT INTO movers (kind, person_id, regulator, person_ref, name, from_firm_key, to_firm_key, roles, prev_roles,
      tenure_days, tenure_estimate, match_method, match_confidence, detected_at)
    VALUES (@kind, @personId, @regulator, @personRef, @name, @fromFirmKey, @toFirmKey, @roles, @prevRoles,
      @tenureDays, @tenureEstimate, @matchMethod, @matchConfidence, @now)`);
  const linkChange = db.prepare(`UPDATE roster_changes SET mover_id = ? WHERE id = ?`);
  const setEvent = db.prepare(`UPDATE movers SET event_id = ? WHERE id = ?`);
  const supersede = db.prepare(`UPDATE movers SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL`);
  const openLeavers = db.prepare(`
    SELECT * FROM movers WHERE kind = 'leaver' AND superseded_by IS NULL AND detected_at >= ? ORDER BY detected_at DESC, id DESC`);

  const emit = (moverId, type, firmKey, change, payload) => {
    const entityId = firmRow(db, firmKey)?.entity_id ?? null;
    const { eventId } = spine.linkEvent({
      entityId, personId: change.person_id, type, date: today, detectedAt: now,
      source: eventSource(change.regulator, change.person_ref), payload,
    });
    setEvent.run(eventId, moverId);
  };

  for (const change of pending) {
    db.transaction(() => {
      if (change.change_type === 'leaver') {
        const id = Number(insertMover.run({
          kind: 'leaver', personId: change.person_id, regulator: change.regulator, personRef: change.person_ref, name: change.name,
          fromFirmKey: change.firm_key, toFirmKey: null, roles: change.roles, prevRoles: null,
          tenureDays: change.tenure_days, tenureEstimate: change.tenure_estimate, matchMethod: null, matchConfidence: null, now,
        }).lastInsertRowid);
        linkChange.run(id, change.id);
        emit(id, EVENT.LEFT, change.firm_key, change, { name: change.name, firm: change.firm_key, tenureDays: change.tenure_days });
        counts.leavers += 1;
        return;
      }

      // Joiner: same-register pairing first, by exact person reference.
      const leaversOpen = openLeavers.all(since).filter((l) => l.from_firm_key !== change.firm_key);
      let partner = leaversOpen.find((l) => l.regulator === change.regulator && l.person_ref === change.person_ref);
      let method = partner ? 'registry-id' : null;
      let confidence = partner ? 100 : null;

      if (!partner) {
        const scored = leaversOpen
          .filter((l) => l.regulator !== change.regulator)
          .map((l) => ({ l, c: crossRegisterConfidence(change, l) }))
          .filter((x) => x.c >= settings.reviewFloor)
          .sort((a, b) => b.c - a.c);
        const [best, second] = scored;
        const unambiguous = best && (!second || second.c < best.c - 3);
        if (best && best.c >= settings.matchThreshold && unambiguous) {
          partner = best.l;
          method = 'cross-register-name';
          confidence = best.c;
        } else if (best && !db.prepare(`SELECT 1 FROM identity_reviews WHERE joiner_change_id = ?`).get(change.id)) {
          const itemId = spine.queueReview({
            kind: 'mover_identity',
            payload: {
              bot: BOT,
              question: 'Is this joiner the same person as an earlier leaver on another register?',
              joiner: { regulator: change.regulator, personRef: change.person_ref, name: change.name, firm: change.firm_key },
              candidates: scored.slice(0, 5).map((x) => ({ regulator: x.l.regulator, personRef: x.l.person_ref, name: x.l.name, firm: x.l.from_firm_key, confidence: x.c })),
              threshold: settings.matchThreshold,
            },
          });
          db.prepare(`INSERT INTO identity_reviews (joiner_change_id, review_item_id, best_confidence, created_at) VALUES (?, ?, ?, ?)`)
            .run(change.id, itemId, best.c, now);
          counts.reviews += 1;
        }
      }

      if (partner) {
        const id = Number(insertMover.run({
          kind: 'move', personId: change.person_id, regulator: change.regulator, personRef: change.person_ref, name: change.name,
          fromFirmKey: partner.from_firm_key, toFirmKey: change.firm_key, roles: change.roles, prevRoles: partner.roles,
          tenureDays: partner.tenure_days, tenureEstimate: partner.tenure_estimate, matchMethod: method, matchConfidence: confidence, now,
        }).lastInsertRowid);
        supersede.run(id, partner.id);
        linkChange.run(id, change.id);
        emit(id, EVENT.MOVE, change.firm_key, change, {
          name: change.name, from: partner.from_firm_key, to: change.firm_key, method, confidence, previousPersonRef: partner.person_ref,
        });
        counts.moves += 1;
        return;
      }

      const id = Number(insertMover.run({
        kind: 'joiner', personId: change.person_id, regulator: change.regulator, personRef: change.person_ref, name: change.name,
        fromFirmKey: null, toFirmKey: change.firm_key, roles: change.roles, prevRoles: null,
        tenureDays: null, tenureEstimate: 0, matchMethod: null, matchConfidence: null, now,
      }).lastInsertRowid);
      linkChange.run(id, change.id);
      emit(id, EVENT.JOINED, change.firm_key, change, { name: change.name, firm: change.firm_key });
      counts.joiners += 1;
    })();
  }
  log?.info(`Movers: ${counts.moves} moves, ${counts.leavers} leavers, ${counts.joiners} joiners, ${counts.reviews} identity reviews queued`);
  return counts;
}

/** FCA leavers created this run that still need a destination lookup. */
export function fcaLeaversNeedingDestination(db, limit) {
  return db.prepare(`
    SELECT id, person_ref, from_firm_key FROM movers
    WHERE kind = 'leaver' AND regulator = 'FCA' AND superseded_by IS NULL AND dest_firm_name IS NULL AND notified_at IS NULL
    ORDER BY id LIMIT ?`).all(limit);
}

/** Apply stored /Individuals/{IRN}/CF snapshots to leaver movers. */
export function applyDestinations(db, store, snapshotByIrn) {
  const update = db.prepare(`UPDATE movers SET dest_firm_name = ?, dest_firm_ref = ? WHERE id = ?`);
  let applied = 0;
  for (const m of fcaLeaversNeedingDestination(db, 10_000)) {
    const snapId = snapshotByIrn.get(m.person_ref);
    if (!snapId) continue;
    const dest = parseFcaDestination(store.readRaw(snapId), m.from_firm_key.split(':')[1]);
    if (dest) {
      update.run(dest.firmName, dest.firmRef, m.id);
      applied += 1;
    }
  }
  return applied;
}

/* ================================================================ scoring */

export function moverForScoring(db, row) {
  const from = firmRow(db, row.from_firm_key);
  const to = firmRow(db, row.to_firm_key);
  const marketFirm = row.kind === 'leaver' ? from : to ?? from;
  return {
    kind: row.kind, roles: parseRoles(row.roles), prevRoles: parseRoles(row.prev_roles),
    market: marketFirm?.market ?? null, fromFirmKey: row.from_firm_key, toFirmKey: row.to_firm_key,
    fromTier: from?.tier ?? null, toTier: to?.tier ?? null, tenureDays: row.tenure_days, tenureEstimate: Boolean(row.tenure_estimate),
  };
}

/** Score every current mover not yet scored today. Deterministic. */
export function scorePending(db, { mandates, scoring, now = new Date().toISOString() }) {
  const date = now.slice(0, 10);
  const rows = db.prepare(`
    SELECT m.* FROM movers m
    WHERE m.superseded_by IS NULL AND m.notified_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.mover_id = m.id AND s.date = ?)`).all(date);
  const insert = db.prepare(`INSERT OR REPLACE INTO scores (mover_id, date, score, rationale) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const row of rows) {
      const { score, rationale } = scoreMover(moverForScoring(db, row), mandates, scoring);
      insert.run(row.id, date, score, JSON.stringify(rationale));
    }
  })();
  return rows.length;
}

/** Top movers for the digest: current, not yet notified, latest score first. */
export function digestMovers(db, limit = 20) {
  return db.prepare(`
    SELECT m.*, s.score, s.rationale,
           ff.name AS from_firm_name, ft.name AS to_firm_name, ff.market AS from_market, ft.market AS to_market
    FROM movers m
    JOIN scores s ON s.mover_id = m.id AND s.date = (SELECT MAX(date) FROM scores WHERE mover_id = m.id)
    LEFT JOIN watchlist_firms ff ON ff.firm_key = m.from_firm_key
    LEFT JOIN watchlist_firms ft ON ft.firm_key = m.to_firm_key
    WHERE m.superseded_by IS NULL AND m.notified_at IS NULL
    ORDER BY s.score DESC, m.id
    LIMIT ?`).all(limit).map((r) => ({ ...r, rationale: JSON.parse(r.rationale) }));
}

export function markNotified(db, ids, now = new Date().toISOString()) {
  const update = db.prepare(`UPDATE movers SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}

/** Pending cross-register identity questions (for the weekly review summary). */
export function pendingIdentityReviews(spine) {
  return spine.pendingReviews({ kind: 'mover_identity' }).filter((r) => r.payload?.bot === BOT);
}

/* ============================================================== retention */

/**
 * UK GDPR storage limitation: purge everything this bot holds about persons not
 * listed on any watchlist roster for more than retentionDays (default 365).
 *
 * Removed: roster rows, changes, movers (scores cascade), identity reviews,
 * this bot's spine events and history for the person, and the registry entry.
 * The spine person row itself is removed only if no other bot's events refer
 * to it; otherwise it is kept and counted as kept_shared.
 * @returns {{ cutoff: string, purgedPersons: number, purgedMovers: number, keptShared: number }}
 */
export function purgeExpired({ db, spine, now = new Date().toISOString(), retentionDays = 365, log }) {
  const cutoff = isoMinusDays(now, retentionDays);
  const expired = db.prepare(`
    SELECT r.* FROM person_registry r
    WHERE r.last_active_at < ?
      AND NOT EXISTS (SELECT 1 FROM roster_people p WHERE p.person_id = r.person_id AND p.active = 1)`).all(cutoff);
  let purgedMovers = 0;
  let keptShared = 0;

  for (const person of expired) {
    const pid = person.person_id;
    spine.db.transaction(() => {
      spine.db.prepare(`DELETE FROM events WHERE person_id = ? AND source LIKE ?`).run(pid, `${BOT}:%`);
      spine.db.prepare(`DELETE FROM person_history WHERE person_id = ? AND source LIKE ?`).run(pid, `${BOT}:%`);
      const shared = spine.db.prepare(`SELECT COUNT(*) FROM events WHERE person_id = ?`).pluck().get(pid)
        + spine.db.prepare(`SELECT COUNT(*) FROM person_history WHERE person_id = ?`).pluck().get(pid);
      if (shared) keptShared += 1;
      else spine.db.prepare(`DELETE FROM persons WHERE person_id = ?`).run(pid);
    })();
    db.transaction(() => {
      db.prepare(`UPDATE movers SET superseded_by = NULL WHERE superseded_by IN (SELECT id FROM movers WHERE person_id = ?)`).run(pid);
      db.prepare(`DELETE FROM identity_reviews WHERE joiner_change_id IN (SELECT id FROM roster_changes WHERE person_id = ?)`).run(pid);
      db.prepare(`UPDATE roster_changes SET mover_id = NULL WHERE person_id = ?`).run(pid);
      purgedMovers += db.prepare(`DELETE FROM movers WHERE person_id = ?`).run(pid).changes;
      db.prepare(`DELETE FROM roster_changes WHERE person_id = ?`).run(pid);
      db.prepare(`DELETE FROM roster_people WHERE person_id = ?`).run(pid);
      db.prepare(`DELETE FROM person_registry WHERE person_id = ?`).run(pid);
    })();
  }

  db.prepare(`INSERT INTO retention_log (run_at, cutoff, purged_persons, purged_movers, kept_shared) VALUES (?, ?, ?, ?, ?)`)
    .run(now, cutoff, expired.length, purgedMovers, keptShared);
  if (expired.length) log?.info(`Retention: purged ${expired.length} persons inactive since before ${cutoff.slice(0, 10)}`, { purgedMovers, keptShared });
  return { cutoff, purgedPersons: expired.length, purgedMovers, keptShared };
}

export { SOURCES };