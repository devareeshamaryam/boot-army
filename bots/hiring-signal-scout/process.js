/**
 * B5 processor: raw snapshots → awards / postings / velocity / funding → signals
 * (bot DB + spine events). Reads only the snapshot store, never the network.
 * Every write path is idempotent: re-processing the same snapshots changes nothing.
 */
import { match, normalizeEntityId } from '@botarmy/core';
import { FULL_DATASET_SOURCES } from './harvest.js';
import { scoreAward, scoreFunding, scoreSpike, suggestAngle, toNumberOrNull } from './score.js';

export const BOT = 'hiring-signal-scout';
export const SIGNAL_TYPES = Object.freeze(['contract_award', 'hiring_spike', 'funding']);
export const SPINE_EVENT = Object.freeze({ contract_award: 'TENDER_AWARD', hiring_spike: 'HIRING_SPIKE', funding: 'FUNDING_ROUND' });
/** Absolute floor for "new postings in the window": a 0 → 1 (or 0 → 2) change is never a spike. */
export const MIN_SPIKE_FLOOR = 3;
const ATS_TYPES = ['greenhouse', 'lever', 'workable', 'workday'];
const SPINE_COUNTRIES = Object.freeze({ UK: 'UK', SG: 'SG', DIFC: 'DIFC', ADGM: 'ADGM' });
const ENTITY_JURISDICTION = Object.freeze({ UK: 'UK', SG: 'SG', HK: 'HK', DIFC: 'AE-DIFC', ADGM: 'AE-ADGM', SA: 'SA', AE: 'AE' });

const DAY_MS = 86_400_000;
export const dayOffset = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** ISO week key: the Monday (UTC) of the week containing `iso`. */
export function weekOf(iso) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return dayOffset(iso.slice(0, 10), -((d.getUTCDay() + 6) % 7));
}

/* ========================================================== safe parsing */

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

/** First non-empty value among candidate keys (case-insensitive; dotted paths allowed). */
export function pick(row, candidates = []) {
  if (!row || typeof row !== 'object') return null;
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const v = c.includes('.') ? getPath(row, c) : row[lower.get(c.toLowerCase())];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function calendarDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** "YYYY-MM-DD" from ISO, yyyymmdd, dd/mm/yyyy or "12 Mar 2024"; null when unparseable or impossible. */
export function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return calendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return calendarDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
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

const decodeXml = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const stripTags = (s) => decodeXml(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const clean = (s) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim() || null);

/** Minimal RSS 2.0 / Atom parser for news and alert feeds. */
export function parseFeed(xml) {
  const tag = (b, n) => b.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i'))?.[1] ?? '';
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    items.push({ title: stripTags(tag(b, 'title')), link: stripTags(tag(b, 'link')), guid: stripTags(tag(b, 'guid')),
      published: stripTags(tag(b, 'pubDate')) || stripTags(tag(b, 'dc:date')), summary: stripTags(tag(b, 'description')).slice(0, 600) });
  }
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const b = m[1];
    items.push({ title: stripTags(tag(b, 'title')), link: decodeXml(b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? ''),
      guid: stripTags(tag(b, 'id')), published: stripTags(tag(b, 'published')) || stripTags(tag(b, 'updated')),
      summary: stripTags(tag(b, 'summary') || tag(b, 'content')).slice(0, 600) });
  }
  return items.filter((i) => i.title);
}

/* ============================================================= watchlist */

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);

/**
 * Validate watchlist.json, reporting every problem at once, and fill defaults.
 * New in 0.3: "filters" { cpvPrefixes, awardKeywords, stackKeywords } and
 * "optIn": true for Workday companies.
 */
export function validateWatchlist(raw) {
  const problems = [];
  const companies = Array.isArray(raw?.companies) ? raw.companies : [];
  if (!companies.length) problems.push('"companies" must list at least one company');
  const ids = new Set();
  const required = { greenhouse: ['token'], lever: ['slug'], workable: ['account'], workday: ['host', 'tenant', 'site'] };
  companies.forEach((c, i) => {
    const at = `companies[${i}]`;
    if (!isSlug(c?.id)) problems.push(`${at}.id must be a lowercase slug`);
    if (ids.has(c?.id)) problems.push(`${at}.id "${c.id}" is duplicated`);
    ids.add(c?.id);
    if (!c?.name) problems.push(`${at}.name is required`);
    if (c?.ats) {
      if (!ATS_TYPES.includes(c.ats.type)) problems.push(`${at}.ats.type must be one of ${ATS_TYPES.join(', ')}`);
      for (const k of required[c.ats.type] ?? []) if (!c.ats[k]) problems.push(`${at}.ats.${k} is required for ${c.ats.type}`);
      if (c.ats.type === 'workday' && c.ats.host && !/\.myworkdayjobs\.com$/i.test(c.ats.host)) problems.push(`${at}.ats.host must be a *.myworkdayjobs.com host`);
    }
  });

  const filters = { cpvPrefixes: [], awardKeywords: [], stackKeywords: [], ...(raw?.filters ?? {}) };
  for (const p of filters.cpvPrefixes) if (!/^\d{2,8}$/.test(String(p))) problems.push(`filters.cpvPrefixes: "${p}" must be 2–8 digits`);
  for (const k of ['awardKeywords', 'stackKeywords']) {
    if (!Array.isArray(filters[k]) || filters[k].some((x) => typeof x !== 'string' || !x.trim())) problems.push(`filters.${k} must be a list of non-empty strings`);
  }

  const spikes = { windowDays: 7, baselineWeeks: 8, multiplier: 2, minNewJobs: 5, ...(raw?.spikes ?? {}) };
  for (const k of ['windowDays', 'baselineWeeks', 'multiplier', 'minNewJobs']) {
    if (toNumberOrNull(spikes[k]) === null || spikes[k] <= 0) problems.push(`spikes.${k} must be a positive number`);
  }

  const feeds = Array.isArray(raw?.funding?.feeds) ? raw.funding.feeds : [];
  feeds.forEach((f, i) => { if (!f?.url || !URL.canParse(f.url)) problems.push(`funding.feeds[${i}].url must be a valid URL`); });

  if (problems.length) throw new Error(`watchlist.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);

  return {
    companies: companies.map((c) => ({ ...c, aliases: c.aliases ?? [] })),
    filters: {
      cpvPrefixes: filters.cpvPrefixes.map(String),
      allowUnknownCpv: filters.allowUnknownCpv !== false,
      awardKeywords: filters.awardKeywords.map((s) => s.trim()),
      stackKeywords: filters.stackKeywords.map((s) => s.trim()),
    },
    thresholds: {
      majorAward: { default: 1_000_000, ...(raw?.thresholds?.majorAward ?? {}) },
      includeUnknownAwardValue: raw?.thresholds?.includeUnknownAwardValue === true,
      majorFunding: { default: 5_000_000, ...(raw?.thresholds?.majorFunding ?? {}) },
      includeUnknownFundingAmount: raw?.thresholds?.includeUnknownFundingAmount !== false,
    },
    spikes: { ...spikes, minNewJobs: Math.max(MIN_SPIKE_FLOOR, Number(spikes.minNewJobs)) },
    sources: raw?.sources ?? {},
    jobFeeds: Object.fromEntries(Object.entries(raw?.jobFeeds ?? {}).filter(([, v]) => v && typeof v === 'object')),
    funding: { feeds: feeds.map((f) => ({ name: f.name ?? new URL(f.url).hostname, url: f.url })) },
  };
}

export function companySpineId(c) {
  const j = SPINE_COUNTRIES[c.country];
  if (!c.registrationNumber || !j) return null;
  try {
    return normalizeEntityId(c.registrationNumber, j);
  } catch {
    return null;
  }
}

/** Mirror the watchlist into the bot DB and resolve each company on the spine. */
export function syncWatchlist({ db, spine, watchlist, unsupported = [], now }) {
  const unsupportedIds = new Set(unsupported.map((u) => u.companyId));
  const up = db.prepare(`
    INSERT INTO watchlist_companies (id, name, spine_id, entity_id, domain, country, ats_type, ats_status, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, spine_id = excluded.spine_id, entity_id = excluded.entity_id,
      domain = excluded.domain, country = excluded.country, ats_type = excluded.ats_type, ats_status = excluded.ats_status,
      active = 1, updated_at = excluded.updated_at`);
  const entities = new Map();
  spine.db.transaction(() => {
    for (const c of watchlist.companies) {
      const spineId = companySpineId(c);
      entities.set(c.id, spine.upsertEntity({
        jurisdiction: ENTITY_JURISDICTION[c.country] ?? (c.country || 'UNKNOWN'),
        registryId: spineId ? spineId.slice(spineId.indexOf(':') + 1) : null, spineId, name: c.name, source: BOT, seenAt: now,
      }));
    }
  })();
  db.transaction(() => {
    db.prepare(`UPDATE watchlist_companies SET active = 0`).run();
    for (const c of watchlist.companies) {
      const status = !c.ats ? 'none' : unsupportedIds.has(c.id) ? 'unsupported' : 'supported';
      up.run(c.id, c.name, companySpineId(c), entities.get(c.id), c.domain ?? null, c.country ?? null, c.ats?.type ?? null, status, now);
    }
  })();
}

/* ======================================================= company matching */

const SCHEMES = { 'GB-COH': 'UK', 'SG-ACRA': 'SG' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exact matching only (identifying name core, aliases, registration ids): never substring. */
export function buildMatcher(companies) {
  const byCore = new Map();
  const byEntity = new Map();
  const text = [];
  for (const c of companies) {
    for (const [label, via] of [[c.name, 'name'], ...c.aliases.map((a) => [a, 'alias'])]) {
      const core = match.companyCore(label);
      if (core) byCore.set(core, c);
      // Free text (news headlines) rarely carries "Ltd" or "plc": match the full label and, when it is
      // distinctive enough (2+ words or 8+ characters), its core name too. Single short words never match alone.
      const terms = new Set([label.trim()]);
      if (core && (core.includes(' ') || core.length >= 8)) terms.add(core);
      for (const term of terms) {
        if (term.length >= 4) text.push({ c, via, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}($|[^\\p{L}\\p{N}])`, 'iu') });
      }
    }
    const sid = companySpineId(c);
    if (sid) byEntity.set(sid, c);
  }
  return {
    supplier(s) {
      for (const id of s.identifiers ?? []) {
        const j = SCHEMES[String(id.scheme ?? '').toUpperCase()];
        if (!j || !id.id) continue;
        try {
          const c = byEntity.get(normalizeEntityId(id.id, j));
          if (c) return { company: c, method: 'registration' };
        } catch { /* malformed id in the notice */ }
      }
      const c = byCore.get(match.companyCore(s.name));
      return c ? { company: c, method: 'name' } : null;
    },
    name: (n) => byCore.get(match.companyCore(n)) ?? null,
    text: (t) => {
      const hits = new Map();
      for (const x of text) if (x.re.test(t) && !hits.has(x.c.id)) hits.set(x.c.id, { company: x.c, via: x.via });
      return [...hits.values()];
    },
  };
}

/* ================================================================= awards */

const DEAD_AWARD = /cancel|unsuccessful|withdrawn/i;
const AWARD_TAGS = new Set(['award', 'awardUpdate', 'contract', 'contractUpdate']);
const cpvOf = (classifications) => [...new Set(classifications
  .filter((c) => c && (/cpv/i.test(c.scheme ?? '') || /^\d{8}(-\d)?$/.test(String(c.id ?? ''))))
  .map((c) => String(c.id).replace(/-\d$/, '')))];

function parseOcds(buffer, meta) {
  const out = [];
  for (const release of json(buffer, meta.sourceId)?.releases ?? []) {
    const tags = [release.tag].flat();
    if (!tags.some((t) => AWARD_TAGS.has(t)) && !(release.awards ?? []).length) continue;
    const parties = new Map((release.parties ?? []).map((p) => [p.id, p]));
    const tenderCpv = [release.tender?.classification, ...(release.tender?.additionalClassifications ?? []),
      ...(release.tender?.items ?? []).flatMap((i) => [i.classification, ...(i.additionalClassifications ?? [])])];
    for (const award of release.awards ?? []) {
      if (DEAD_AWARD.test(award.status ?? '')) continue;
      const suppliers = (award.suppliers ?? []).map((s) => {
        const party = parties.get(s.id) ?? {};
        return { name: s.name ?? party.name ?? '', identifiers: [party.identifier, ...(party.additionalIdentifiers ?? [])].filter(Boolean).map((i) => ({ scheme: i.scheme, id: i.id })) };
      }).filter((s) => s.name);
      if (!suppliers.length) continue;
      const guid = String(release.id ?? '').match(/^[0-9a-f-]{36}/i)?.[0];
      out.push({
        noticeId: `${release.id}#${award.id ?? '0'}`,
        title: award.title ?? release.tender?.title ?? null,
        buyer: release.buyer?.name ?? null,
        value: toNumberOrNull(award.value?.amount),
        currency: award.value?.currency ?? null,
        cpv: cpvOf([...tenderCpv, ...(award.items ?? []).map((i) => i.classification)]),
        awardDate: toIsoDate(award.date ?? release.date),
        url: meta.noticeBase === 'cf' ? (guid ? `https://www.contractsfinder.service.gov.uk/Notice/${guid}` : null)
          : (/^\d{6}-\d{4}$/.test(release.id ?? '') ? `https://www.find-tender.service.gov.uk/Notice/${release.id}` : null),
        confidence: 'awarded',
        suppliers,
      });
    }
  }
  return out;
}

/** @param {{ cpvField?: string|null }} meta  the CPV field name the harvester requested (null = none) */
function parseTed(buffer, meta = {}) {
  const cpvField = meta.cpvField === undefined ? 'classification-cpv' : meta.cpvField;
  return (json(buffer, 'ted')?.notices ?? []).map((n) => {
    const pubNo = firstText(n['publication-number']);
    const names = [...new Set(allTexts(n['organisation-name-tenderer']).map((s) => s.trim()).filter(Boolean))];
    if (!pubNo || !names.length) return null;
    return {
      noticeId: pubNo, title: firstText(n['notice-title']), buyer: firstText(n['buyer-name']),
      value: toNumberOrNull(firstText(n['total-value'])), currency: firstText(n['total-value-cur']),
      cpv: cpvField ? [...new Set(allTexts(n[cpvField]).map((c) => c.replace(/-\d$/, '')).filter((c) => /^\d{8}$/.test(c)))] : [],
      awardDate: toIsoDate(firstText(n['publication-date'])), url: `https://ted.europa.eu/en/notice/-/detail/${pubNo}`,
      confidence: 'tenderer', suppliers: names.map((name) => ({ name, identifiers: [] })),
    };
  }).filter(Boolean);
}

function parseGebiz(buffer) {
  return (json(buffer, 'gebiz')?.result?.records ?? [])
    .filter((r) => /award/i.test(String(pick(r, ['tender_detail_status', 'Tender Detail Status']) ?? '')))
    .map((r) => {
      const supplier = clean(pick(r, ['supplier_name', 'Supplier Name']));
      const tenderNo = clean(pick(r, ['tender_no', 'Tender No']));
      return supplier && tenderNo ? {
        noticeId: `${tenderNo}|${supplier}`, title: clean(pick(r, ['tender_description', 'Tender Description'])), buyer: clean(pick(r, ['agency', 'Agency'])),
        value: toNumberOrNull(pick(r, ['awarded_amt', 'awarded_amount', 'Awarded Amt'])), currency: 'SGD', cpv: [],
        awardDate: toIsoDate(pick(r, ['award_date', 'Award Date'])), url: null, confidence: 'awarded', suppliers: [{ name: supplier, identifiers: [] }],
      } : null;
    }).filter(Boolean);
}

const HK_FIELDS = {
  noticeId: ['Tender Reference', 'Tender Ref. No.', 'Contract No.', 'Tender No.', 'Reference No.'],
  title: ['Subject', 'Description', 'Tender Title', 'Contract Title', 'Title'],
  buyer: ['Department', 'Procuring Department', 'Bureau/Department'],
  supplier: ['Contractor', 'Successful Tenderer', 'Name of Contractor', 'Supplier', 'Awardee'],
  value: ['Contract Sum', 'Contract Value', 'Contract Amount', 'Award Value', 'Amount (HK$)'],
  awardDate: ['Date of Award', 'Award Date', 'Contract Award Date'],
};
const CONFIGURED_FIELDS = {
  noticeId: ['id', 'tenderId', 'tender_id', 'referenceNumber', 'reference', 'noticeId'],
  title: ['title', 'tenderName', 'tender_name', 'name', 'subject'],
  buyer: ['agency', 'agencyName', 'buyer', 'buyerName', 'entity', 'governmentEntity'],
  supplier: ['supplier', 'supplierName', 'awardedSupplier', 'awardedSupplierName', 'winner', 'winnerName', 'vendor'],
  value: ['value', 'awardValue', 'awardedValue', 'amount', 'contractValue'],
  currency: ['currency', 'currencyCode'],
  awardDate: ['awardDate', 'award_date', 'awardedAt', 'date', 'publishedAt'],
  url: ['url', 'link', 'noticeUrl'],
  cpv: ['cpv', 'cpvCode', 'cpv_codes'],
};

function rowsOf(buffer, meta, itemsPath) {
  const rows = meta.format === 'csv' ? parseCsv(decode(buffer)) : getPath(json(buffer, meta.sourceId), itemsPath);
  if (!Array.isArray(rows)) throw new Error(`${meta.sourceId}: expected an array of rows${itemsPath ? ` at "${itemsPath}"` : ''}`);
  return rows;
}

function parseTabularAwards(buffer, meta, defaults, extra = {}) {
  const fields = { ...defaults, ...(meta.fields ?? meta.dataset?.fields ?? {}) };
  return rowsOf(buffer, meta, meta.itemsPath ?? meta.dataset?.itemsPath).map((row) => {
    const supplier = clean(pick(row, fields.supplier));
    const ref = clean(pick(row, fields.noticeId));
    if (!supplier || !ref) return null;
    const cpvRaw = fields.cpv ? pick(row, fields.cpv) : null;
    const value = toNumberOrNull(pick(row, fields.value));
    return {
      noticeId: `${ref}|${supplier}`, title: clean(pick(row, fields.title)),
      buyer: clean(pick(row, fields.buyer)) ?? meta.dataset?.buyerName ?? null,
      value: value !== null && value > 0 ? value : null,
      currency: clean(fields.currency ? pick(row, fields.currency) : null) ?? extra.currency ?? meta.currency ?? null,
      cpv: cpvRaw ? String(cpvRaw).split(/[,;\s]+/).map((c) => c.replace(/-\d$/, '')).filter((c) => /^\d{8}$/.test(c)) : [],
      awardDate: toIsoDate(pick(row, fields.awardDate)), url: clean(fields.url ? pick(row, fields.url) : null) ?? meta.dataset?.pageUrl ?? null,
      confidence: 'awarded', suppliers: [{ name: supplier, identifiers: [] }],
    };
  }).filter(Boolean);
}

/** Parse one award snapshot by the format recorded in its meta. */
export function parseAwardSnapshot(buffer, meta) {
  switch (meta.format) {
    case 'ocds': return parseOcds(buffer, meta);
    case 'ted': return parseTed(buffer, meta);
    case 'gebiz': return parseGebiz(buffer);
    default:
      return meta.sourceId === 'hk'
        ? parseTabularAwards(buffer, meta, HK_FIELDS, { currency: 'HKD' })
        : parseTabularAwards(buffer, meta, CONFIGURED_FIELDS);
  }
}

/**
 * CPV and keyword filters.
 *  - CPV prefixes configured and the notice has CPV codes → pass only on a prefix match.
 *  - Otherwise, award keywords configured → pass only if the title matches one.
 *  - Nothing configured → pass ("unfiltered").
 * @returns {{ passed: boolean, reason: 'cpv'|'keyword'|'unfiltered'|'cpv-not-published'|'cpv-mismatch'|'keyword-mismatch' }}
 */
export function applyAwardFilters(award, filters) {
  const cpvConfigured = filters.cpvPrefixes.length > 0;
  if (cpvConfigured && award.cpv.length) {
    return award.cpv.some((c) => filters.cpvPrefixes.some((p) => c.startsWith(p))) ? { passed: true, reason: 'cpv' } : { passed: false, reason: 'cpv-mismatch' };
  }
  // CPV filtering is on but this notice publishes no CPV codes: fall back to keywords if any,
  // otherwise label the gap rather than pretending the award was checked.
  if (filters.awardKeywords.length) {
    const title = String(award.title ?? '').toLowerCase();
    return filters.awardKeywords.some((k) => title.includes(k.toLowerCase())) ? { passed: true, reason: 'keyword' } : { passed: false, reason: 'keyword-mismatch' };
  }
  if (cpvConfigured) return { passed: filters.allowUnknownCpv, reason: 'cpv-not-published' };
  return { passed: true, reason: 'unfiltered' };
}

const thresholdFor = (map, currency) => {
  const v = toNumberOrNull(map[String(currency ?? '').toUpperCase()] ?? map.default);
  return v !== null && v > 0 ? v : null;
};

/* ============================================================ state helpers */

export const getCursor = (db, source) => db.prepare(`SELECT cursor FROM harvest_state WHERE source = ?`).get(source)?.cursor ?? null;

export function setCursor(db, source, cursor, now) {
  db.prepare(`INSERT INTO harvest_state (source, cursor, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(source, cursor, now);
}

const alreadyProcessed = (db, id) => Boolean(db.prepare(`SELECT 1 FROM processed_snapshots WHERE snapshot_id = ?`).get(id));
const markProcessed = (db, { snapshotId, source, kind, outcome, items, note = null, now }) =>
  db.prepare(`INSERT OR IGNORE INTO processed_snapshots (snapshot_id, source, kind, outcome, items, note, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(snapshotId, source, kind, outcome, items, note, now);

/**
 * Parse award snapshots, store awards at watchlist companies, return signal
 * candidates. A full-dataset source read for the first time is a BASELINE:
 * awards stored, no candidates.
 */
export function processAwards({ db, store, fetches, watchlist, matcher, now = new Date().toISOString(), log }) {
  const candidates = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO contract_awards (source, notice_id, company_id, supplier_name, match_method, confidence, buyer, title,
      value, currency, cpv, award_date, url, filter_passed, filter_reason, snapshot_id, first_seen)
    VALUES (@source, @noticeId, @companyId, @supplierName, @matchMethod, @confidence, @buyer, @title,
      @value, @currency, @cpv, @awardDate, @url, @filterPassed, @filterReason, @snapshotId, @now)`);
  const stats = { awards: 0, matched: 0, filteredOut: 0, baselineSources: [], failures: [] };

  for (const fetch of fetches) {
    const isBaseline = FULL_DATASET_SOURCES.includes(fetch.sourceId)
      && !db.prepare(`SELECT 1 FROM processed_snapshots WHERE kind = 'awards' AND source = ? LIMIT 1`).get(fetch.sourceId);
    if (isBaseline && fetch.snapshotIds.length) stats.baselineSources.push(fetch.sourceId);
    for (const snapshotId of fetch.snapshotIds) {
      if (alreadyProcessed(db, snapshotId)) continue;
      const meta = store.get(snapshotId).meta;
      let awards;
      try {
        awards = parseAwardSnapshot(store.readRaw(snapshotId), meta);
      } catch (err) {
        // Not marked processed: the stored snapshot is retried next run (e.g. after a parser fix)
        // and the failure is reported every run until it parses.
        stats.failures.push(`${fetch.sourceId} snapshot ${snapshotId}: ${err.message}`);
        log?.warn(`${fetch.sourceId} snapshot ${snapshotId}: ${err.message}`);
        continue;
      }
      db.transaction(() => {
        for (const a of awards) {
          stats.awards += 1;
          for (const supplier of a.suppliers) {
            const hit = matcher.supplier(supplier);
            if (!hit) continue;
            const filter = applyAwardFilters(a, watchlist.filters);
            const info = insert.run({
              ...a, source: fetch.sourceId, companyId: hit.company.id, supplierName: supplier.name, matchMethod: hit.method,
              cpv: JSON.stringify(a.cpv), filterPassed: filter.passed ? 1 : 0, filterReason: filter.reason, snapshotId, now,
            });
            if (!info.changes) continue;
            stats.matched += 1;
            if (!filter.passed) { stats.filteredOut += 1; continue; }
            if (isBaseline) continue;
            const threshold = thresholdFor(watchlist.thresholds.majorAward, a.currency);
            const major = a.value !== null ? threshold !== null && a.value >= threshold : watchlist.thresholds.includeUnknownAwardValue;
            if (!major) continue;
            const { score, rationale } = scoreAward({ ...a, filterReason: filter.reason }, { threshold });
            const evidence = {
              company: hit.company.name, source: fetch.sourceId, title: a.title, buyer: a.buyer, value: a.value, currency: a.currency,
              cpv: a.cpv, url: a.url, confidence: a.confidence, matchMethod: hit.method, filter: filter.reason, awardDate: a.awardDate,
            };
            candidates.push({ type: 'contract_award', companyId: hit.company.id, refKey: `award:${fetch.sourceId}|${a.noticeId}`, score, rationale, evidence });
          }
        }
        markProcessed(db, { snapshotId, source: fetch.sourceId, kind: 'awards', outcome: isBaseline ? 'baseline' : 'parsed', items: awards.length, now });
      })();
    }
  }
  return { candidates, stats };
}

/* ================================================================= boards */

function parseAtsJobs(atsType, bodies, meta) {
  const jobs = [];
  for (const body of bodies) {
    const b = json(body, `ats-${atsType}`);
    if (atsType === 'greenhouse') {
      for (const j of b?.jobs ?? []) jobs.push({ key: String(j.id), title: clean(j.title), location: clean(j.location?.name), url: j.absolute_url ?? null });
    } else if (atsType === 'lever') {
      if (!Array.isArray(b)) throw new Error('lever: unexpected response shape');
      for (const j of b) jobs.push({ key: String(j.id), title: clean(j.text), location: clean(j.categories?.location), url: j.hostedUrl ?? null });
    } else if (atsType === 'workable') {
      for (const j of b?.jobs ?? []) jobs.push({ key: String(j.shortcode ?? j.id ?? j.url), title: clean(j.title), location: clean([j.city, j.country].filter(Boolean).join(', ')), url: j.url ?? null });
    } else if (atsType === 'workday') {
      for (const p of b?.jobPostings ?? []) {
        if (p.externalPath) jobs.push({ key: p.externalPath, title: clean(p.title), location: clean(p.locationsText), url: `https://${meta.host}/${meta.site}${p.externalPath}` });
      }
    }
  }
  return jobs.filter((j) => j.key && j.title);
}

const JOB_FIELDS = {
  id: ['id', 'jobId', 'job_id', 'jobKey', 'jobkey', 'reference'],
  company: ['company', 'companyName', 'company_name', 'employer', 'hiringOrganization.name', 'organization'],
  title: ['title', 'jobTitle', 'job_title', 'name', 'position'],
  location: ['location', 'formattedLocation', 'city', 'jobLocation'],
  url: ['url', 'link', 'jobUrl', 'applyUrl'],
};

/** Licensed feed rows → per-company job lists (partial: closures never inferred). */
export function parseJobFeedSnapshots(store, snapshotIds, feedId, matcher) {
  const byCompany = new Map();
  for (const id of snapshotIds) {
    const meta = store.get(id).meta;
    const fields = { ...JOB_FIELDS, ...(meta.fields ?? {}) };
    for (const row of rowsOf(store.readRaw(id), meta, meta.itemsPath)) {
      const company = matcher.name(String(pick(row, fields.company) ?? ''));
      const title = clean(pick(row, fields.title));
      if (!company || !title) continue;
      const list = byCompany.get(company.id) ?? [];
      list.push({ key: String(pick(row, fields.id) ?? pick(row, fields.url) ?? `${company.id}|${title}`), title, location: clean(pick(row, fields.location)), url: clean(pick(row, fields.url)) });
      byCompany.set(company.id, list);
    }
  }
  return [...byCompany.entries()].map(([companyId, jobs]) => ({ companyId, source: feedId, jobs, complete: false }));
}

export const matchesStack = (title, stackKeywords) => {
  const t = String(title ?? '').toLowerCase();
  return stackKeywords.some((k) => t.includes(k.toLowerCase()));
};

/**
 * Record one board (or feed) poll.
 *  - First sight: BASELINE (postings stored, none counted as new).
 *  - Drop guard: an empty board, or a complete board of 10+ falling by more than
 *    maxDropRatio, is REJECTED: nothing changes, a warning is returned.
 *  - Truncated / partial feeds add new postings but never close missing ones.
 * @returns {{ outcome: string, newCount: number, newStack: number, closed: number, note?: string }}
 */
export function recordBoard({ db, board, fetchKey, stackKeywords, settings, now = new Date().toISOString() }) {
  const { companyId, source, jobs, complete } = board;
  if (db.prepare(`SELECT 1 FROM board_fetches WHERE fetch_key = ?`).get(fetchKey)) return { outcome: 'already-processed', newCount: 0, newStack: 0, closed: 0 };
  const day = now.slice(0, 10);
  const prev = db.prepare(`SELECT 1 FROM board_fetches WHERE company_id = ? AND source = ? AND outcome != 'rejected' LIMIT 1`).get(companyId, source);
  const active = new Set(db.prepare(`SELECT job_key FROM job_postings WHERE company_id = ? AND source = ? AND active = 1`).pluck().all(companyId, source));
  const insertFetch = db.prepare(`INSERT INTO board_fetches (company_id, source, fetch_key, job_count, complete, outcome, note, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  const unique = [...new Map(jobs.map((j) => [j.key, j])).values()];
  if (prev && active.size) {
    let note = null;
    if (unique.length === 0) note = `board empty (previously ${active.size} open)`;
    else if (complete && active.size >= 10 && unique.length < active.size * (1 - settings.maxDropRatio)) {
      note = `board fell from ${active.size} to ${unique.length} postings, more than the ${Math.round(settings.maxDropRatio * 100)}% drop limit`;
    }
    if (note) {
      insertFetch.run(companyId, source, fetchKey, unique.length, complete ? 1 : 0, 'rejected', note, now);
      return { outcome: 'rejected', newCount: 0, newStack: 0, closed: 0, note };
    }
  }

  const isBaseline = !prev;
  const current = new Set(unique.map((j) => j.key));
  const fresh = isBaseline ? [] : unique.filter((j) => !active.has(j.key));
  const closedKeys = isBaseline || !complete ? [] : [...active].filter((k) => !current.has(k));
  const newStack = fresh.filter((j) => matchesStack(j.title, stackKeywords)).length;

  const upsert = db.prepare(`
    INSERT INTO job_postings (company_id, source, job_key, title, location, url, matches_stack, first_seen, last_seen, active, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (company_id, source, job_key) DO UPDATE SET title = excluded.title, location = excluded.location, url = excluded.url,
      matches_stack = excluded.matches_stack, last_seen = excluded.last_seen,
      first_seen = CASE WHEN job_postings.active = 0 THEN excluded.first_seen ELSE job_postings.first_seen END,
      is_baseline = CASE WHEN job_postings.active = 0 THEN 0 ELSE job_postings.is_baseline END, active = 1`);
  const close = db.prepare(`UPDATE job_postings SET active = 0 WHERE company_id = ? AND source = ? AND job_key = ?`);
  const velocity = db.prepare(`
    INSERT INTO job_velocity (company_id, source, day, open_count, new_count, new_stack_count, closed_count, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, source, day) DO UPDATE SET open_count = excluded.open_count,
      new_count = job_velocity.new_count + excluded.new_count,
      new_stack_count = job_velocity.new_stack_count + excluded.new_stack_count,
      closed_count = job_velocity.closed_count + excluded.closed_count`);

  db.transaction(() => {
    for (const j of unique) upsert.run(companyId, source, j.key, j.title, j.location ?? null, j.url ?? null, matchesStack(j.title, stackKeywords) ? 1 : 0, now, now, isBaseline ? 1 : 0);
    for (const k of closedKeys) close.run(companyId, source, k);
    velocity.run(companyId, source, day, unique.length, fresh.length, newStack, closedKeys.length, isBaseline ? 1 : 0);
    insertFetch.run(companyId, source, fetchKey, unique.length, complete ? 1 : 0, isBaseline ? 'baseline' : 'diffed', isBaseline ? 'first sight; existing postings are the baseline' : null, now);
  })();
  return { outcome: isBaseline ? 'baseline' : 'diffed', newCount: fresh.length, newStack, closed: closedKeys.length, sampleTitles: fresh.slice(0, 8).map((j) => j.title) };
}

/** Parse + record every board fetch and licensed feed. */
export function processBoards({ db, store, boards, jobFeeds, watchlist, matcher, settings, now = new Date().toISOString(), log }) {
  const results = [];
  const warnings = [];
  const run = (board, fetchKey) => {
    const r = recordBoard({ db, board, fetchKey, stackKeywords: watchlist.filters.stackKeywords, settings, now });
    if (r.outcome === 'rejected') {
      warnings.push(`${board.companyId} (${board.source}): snapshot rejected, ${r.note}`);
      log?.warn(`${board.companyId} (${board.source}): ${r.note}`);
    }
    results.push({ ...board, ...r });
  };
  for (const b of boards) {
    try {
      const meta = store.get(b.snapshotIds[0]).meta;
      const jobs = parseAtsJobs(b.atsType, b.snapshotIds.map((id) => store.readRaw(id)), meta);
      run({ companyId: b.companyId, source: b.atsType, jobs, complete: b.complete }, `${b.companyId}|${b.atsType}|${[...b.snapshotIds].sort((x, y) => x - y).join(',')}`);
    } catch (err) {
      warnings.push(`${b.companyId} (${b.atsType}): ${err.message}`);
    }
  }
  for (const f of jobFeeds) {
    if (f.snapshotIds.every((id) => alreadyProcessed(db, id))) continue;
    try {
      for (const board of parseJobFeedSnapshots(store, f.snapshotIds, f.feedId, matcher)) {
        run(board, `${board.companyId}|${f.feedId}|${[...f.snapshotIds].sort((x, y) => x - y).join(',')}`);
      }
      for (const id of f.snapshotIds) markProcessed(db, { snapshotId: id, source: f.feedId, kind: 'jobFeed', outcome: 'parsed', items: 0, now });
    } catch (err) {
      warnings.push(`jobfeed ${f.feedId}: ${err.message}`);
    }
  }
  return { results, warnings };
}

/* ================================================================= spikes */

/**
 * Pure spike rule.
 *   newInWindow  = new postings in the last windowDays (stack-matching only when stack keywords are set)
 *   baseline     = average new postings per week over the previous baselineWeeks (needs ≥ 7 days of history)
 *   threshold    = baseline known ? max(minNewJobs, ceil(baseline × multiplier)) : minNewJobs × 2
 * minNewJobs is never below MIN_SPIKE_FLOOR, so 0 → 1 is never a spike.
 */
export function evaluateSpike({ newInWindow, baselineNew, trackedDays }, rules) {
  const minNew = Math.max(MIN_SPIKE_FLOOR, Number(rules.minNewJobs) || MIN_SPIKE_FLOOR);
  const baselineDays = Math.min(rules.baselineWeeks * 7, Math.max(0, trackedDays - rules.windowDays));
  const baselineWeekly = baselineDays >= 7 ? baselineNew / (baselineDays / 7) : null;
  const threshold = baselineWeekly === null ? minNew * 2 : Math.max(minNew, Math.ceil(baselineWeekly * rules.multiplier));
  return {
    isSpike: newInWindow >= threshold,
    threshold,
    baselineWeekly: baselineWeekly === null ? null : Math.round(baselineWeekly * 10) / 10,
  };
}

/**
 * Velocity inputs for one company across its sources, including today's rows.
 * Baseline polls record 0 new postings, so no is_baseline filter is needed here;
 * filtering on it would drop postings from a second run on the baseline day.
 */
export function velocityStats(db, companyId, { day, windowDays, baselineWeeks, stackOnly }) {
  const col = stackOnly ? 'new_stack_count' : 'new_count';
  const windowStart = dayOffset(day, -(windowDays - 1));
  const baselineStart = dayOffset(windowStart, -baselineWeeks * 7);
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN ${col} END), 0) AS in_window,
           COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN new_stack_count END), 0) AS stack_in_window,
           COALESCE(SUM(CASE WHEN day >= ? AND day < ? THEN ${col} END), 0) AS baseline_new,
           MIN(day) AS first_day
    FROM job_velocity WHERE company_id = ?`).get(windowStart, day, windowStart, day, baselineStart, windowStart, companyId);
  return {
    newInWindow: row.in_window,
    newStack: row.stack_in_window,
    baselineNew: row.baseline_new,
    trackedDays: row.first_day ? Math.round((Date.parse(day) - Date.parse(row.first_day)) / DAY_MS) : 0,
  };
}

/** Spike candidates for companies whose boards gained postings this run. */
export function spikeCandidates({ db, boardResults, watchlist, now = new Date().toISOString() }) {
  const day = now.slice(0, 10);
  const stackOnly = watchlist.filters.stackKeywords.length > 0;
  const titles = new Map();
  const sources = new Map();
  for (const r of boardResults) {
    if (r.outcome !== 'diffed' || !r.newCount) continue;
    titles.set(r.companyId, [...(titles.get(r.companyId) ?? []), ...(r.sampleTitles ?? [])]);
    sources.set(r.companyId, new Set([...(sources.get(r.companyId) ?? []), r.source]));
  }
  const byId = new Map(watchlist.companies.map((c) => [c.id, c]));
  const candidates = [];
  for (const [companyId, sample] of titles) {
    const stats = velocityStats(db, companyId, { day, windowDays: watchlist.spikes.windowDays, baselineWeeks: watchlist.spikes.baselineWeeks, stackOnly });
    const verdict = evaluateSpike(stats, watchlist.spikes);
    if (!verdict.isSpike) continue;
    const spike = { newInWindow: stats.newInWindow, threshold: verdict.threshold, newStack: stackOnly ? stats.newStack : null, baselineWeekly: verdict.baselineWeekly };
    const { score, rationale } = scoreSpike(spike);
    candidates.push({
      type: 'hiring_spike', companyId, refKey: `spike:${companyId}:${day}`, score, rationale,
      evidence: {
        company: byId.get(companyId)?.name ?? companyId, newInWindow: stats.newInWindow, windowDays: watchlist.spikes.windowDays,
        threshold: verdict.threshold, baselineWeekly: verdict.baselineWeekly, stackOnly, stackKeywords: watchlist.filters.stackKeywords,
        sources: [...sources.get(companyId)], sampleTitles: sample.slice(0, 8),
      },
    });
  }
  return candidates;
}

/* ================================================================ funding */

const FUNDING_RE = /\b(rais(es|ed|ing)|secur(es|ed)|clos(es|ed)|lands?|bags?)\b[^.]{0,80}\b(funding|round|investment|series\s+[a-f]|seed|pre-seed|growth\s+equity)\b|\bseries\s+[a-f]\b[^.]{0,40}\b(round|funding)\b/i;
const AMOUNT_RE = /(US\$|S\$|HK\$|A\$|\$|£|€|SAR|AED|USD|GBP|EUR)\s?(\d+(?:\.\d+)?)\s?(bn|billion|m|mn|million|k)?\b/i;
const CURRENCY = { 'US$': 'USD', $: 'USD', '£': 'GBP', '€': 'EUR', 'S$': 'SGD', 'HK$': 'HKD', 'A$': 'AUD' };

/** Amount from a headline, or { amount: null } — never guessed. */
export function parseAmount(text) {
  const m = String(text ?? '').match(AMOUNT_RE);
  if (!m) return { amount: null, currency: null };
  const base = toNumberOrNull(m[2]);
  if (base === null) return { amount: null, currency: null };
  const mult = { bn: 1e9, billion: 1e9, m: 1e6, mn: 1e6, million: 1e6, k: 1e3 }[m[3]?.toLowerCase()] ?? 1;
  return { amount: base * mult, currency: CURRENCY[m[1]] ?? m[1].toUpperCase() };
}

export function processFunding({ db, store, fetches, watchlist, matcher, now = new Date().toISOString() }) {
  const candidates = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO funding_items (item_key, company_id, title, link, feed, amount, currency, published, snapshot_id, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const f of fetches) {
    if (alreadyProcessed(db, f.snapshotId)) continue;
    const items = parseFeed(decode(store.readRaw(f.snapshotId)));
    db.transaction(() => {
      for (const item of items) {
        const text = `${item.title} ${item.summary}`;
        if (!FUNDING_RE.test(text)) continue;
        for (const { company, via } of matcher.text(text)) {
          const itemKey = `${item.guid || item.link || item.title}|${company.id}`;
          const { amount, currency } = parseAmount(text);
          if (!insert.run(itemKey, company.id, item.title, item.link || null, f.feed, amount, currency, toIsoDate(item.published), f.snapshotId, now).changes) continue;
          const threshold = thresholdFor(watchlist.thresholds.majorFunding, currency);
          const major = amount !== null ? threshold !== null && amount >= threshold : watchlist.thresholds.includeUnknownFundingAmount;
          if (!major) continue;
          const { score, rationale } = scoreFunding({ amount, currency, matchedBy: via }, { threshold });
          candidates.push({
            type: 'funding', companyId: company.id, refKey: `funding:${itemKey}`, score, rationale,
            evidence: { company: company.name, title: item.title, link: item.link || null, feed: f.feed, amount, currency, published: toIsoDate(item.published) },
          });
        }
      }
      markProcessed(db, { snapshotId: f.snapshotId, source: 'funding', kind: 'funding', outcome: 'parsed', items: items.length, now });
    })();
  }
  return candidates;
}

/* ================================================================ signals */

/**
 * Store candidates with at most ONE signal per company per type per ISO week.
 *  - None this week: insert and emit a spine event.
 *  - Unsent one this week with a lower score: replaced by the stronger candidate.
 *  - Already sent this week: the candidate is dropped (counted as deduplicated).
 * @returns {{ inserted: number, upgraded: number, deduplicated: number }}
 */
export function upsertSignals({ db, spine, candidates, now = new Date().toISOString(), log }) {
  const week = weekOf(now);
  const counts = { inserted: 0, upgraded: 0, deduplicated: 0 };
  const find = db.prepare(`SELECT * FROM signals WHERE company_id = ? AND signal_type = ? AND week = ?`);
  const insert = db.prepare(`
    INSERT INTO signals (signal_type, company_id, week, score, evidence, rationale, angle, ref_key, entity_id, event_id, detected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upgrade = db.prepare(`UPDATE signals SET score = ?, evidence = ?, rationale = ?, angle = ?, ref_key = ?, updated_at = ? WHERE id = ? AND notified_at IS NULL`);
  const entityOf = db.prepare(`SELECT entity_id FROM watchlist_companies WHERE id = ?`);

  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.refKey.localeCompare(b.refKey));
  for (const c of sorted) {
    const existing = find.get(c.companyId, c.type, week);
    const angle = suggestAngle(c.type, c.evidence);
    if (!existing) {
      const entityId = entityOf.pluck().get(c.companyId) ?? null;
      const { eventId } = spine.linkEvent({
        entityId, type: SPINE_EVENT[c.type], date: week, source: BOT, detectedAt: now,
        payload: { refKey: c.refKey, score: c.score, evidence: c.evidence },
      });
      insert.run(c.type, c.companyId, week, c.score, JSON.stringify(c.evidence), JSON.stringify(c.rationale), angle, c.refKey, entityId, eventId, now, now);
      counts.inserted += 1;
    } else if (!existing.notified_at && c.score > existing.score) {
      upgrade.run(c.score, JSON.stringify(c.evidence), JSON.stringify(c.rationale), angle, c.refKey, now, existing.id);
      counts.upgraded += 1;
    } else {
      counts.deduplicated += 1;
    }
  }
  if (candidates.length) log?.info('Signals', counts);
  return counts;
}

export function pendingSignals(db) {
  return db.prepare(`SELECT * FROM signals WHERE notified_at IS NULL ORDER BY score DESC, id`).all()
    .map((s) => ({ ...s, evidence: JSON.parse(s.evidence), rationale: JSON.parse(s.rationale) }));
}

export function markNotified(db, ids, now = new Date().toISOString()) {
  const update = db.prepare(`UPDATE signals SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}