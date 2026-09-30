/**
 * Hiring-Signal Scout harvester.
 *
 * Two phases, so every source is captured before anything is interpreted:
 *   1. harvestAll()     fetch raw snapshots (JSON / HTML / CSV / XML bodies + metadata)
 *   2. parseSnapshots() turn snapshots into awards, job boards and funding items
 *
 * Sources
 *   UK         Contracts Finder OCDS API, Find a Tender OCDS API           (public, keyless)
 *   Europe     TED Search API v3, api.ted.europa.eu                        (public, keyless)
 *   Singapore  GeBIZ award dataset on data.gov.sg                          (public; optional key)
 *   Hong Kong  departmental "tenders awarded" datasets on data.gov.hk      (configured list)
 *   Saudi      Etimad via your authorised API access                       (configured endpoint)
 *   MEA        your aggregator subscription                                (configured endpoint)
 *   Jobs       Greenhouse, Lever, Workable, Workday public board APIs      (keyless)
 *              Indeed, LinkedIn via a licensed feed you supply             (configured endpoint)
 *   Funding    RSS/Atom news feeds you list (e.g. Google Alerts, wires)   (configured list)
 *
 * Nothing here scrapes LinkedIn or Indeed: both prohibit it in their terms.
 */
import { createHash } from 'node:crypto';

/* ================================================================ HTTP */

const DEFAULT_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class SourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

const userAgent = () =>
  process.env.HSS_USER_AGENT
  || `bot-army-hiring-signal-scout/0.2${process.env.HSS_CONTACT ? ` (+${process.env.HSS_CONTACT})` : ''}`;

const redact = (url) => {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '[url]'; }
};

function retryAfterMs(h) {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

/** fetch with timeout; honours 429 Retry-After (Find a Tender's allowance is small). */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method, body,
      headers: { 'User-Agent': userAgent(), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? 5000 * 2 ** attempt;
      await res.body?.cancel().catch(() => {});
      if (wait > 150_000) throw new HttpError(`${method} ${redact(url)} -> 429, Retry-After too long`, 429);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new HttpError(`${method} ${redact(url)} -> ${res.status} ${res.statusText} ${text}`.trim(), res.status);
    }
    return res;
  }
}

/** Fetch one raw snapshot: body plus the metadata db.js stores. */
async function snapshot(source, key, url, { method = 'GET', headers = {}, body, format = 'json', timeoutMs } = {}) {
  const res = await request(url, { method, headers, body, timeoutMs });
  const buffer = Buffer.from(await res.arrayBuffer());
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = new TextDecoder('windows-1252').decode(buffer); }
  return {
    source, key, url, method, format,
    status: res.status,
    contentType: res.headers.get('content-type'),
    fetchedAt: new Date().toISOString(),
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    body: text,
  };
}

const json = (snap) => {
  try { return JSON.parse(snap.body); } catch { throw new Error(`${snap.source}: response was not JSON (${snap.contentType})`); }
};

const createThrottle = (ms) => {
  let next = 0; let chain = Promise.resolve();
  return () => (chain = chain.then(async () => { const w = next - Date.now(); if (w > 0) await sleep(w); next = Date.now() + ms; }));
};

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------------------------------------------------------- robots.txt */

const robotsCache = new Map();
function parseRobots(text) {
  const rules = []; let star = false; let lastAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2].trim();
    if (k === 'user-agent') { if (!lastAgent) star = false; if (v === '*') star = true; lastAgent = true; continue; }
    lastAgent = false;
    if (star && (k === 'allow' || k === 'disallow') && v) {
      const re = new RegExp(`^${v.replace(/\$$/, '').split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${v.endsWith('$') ? '$' : ''}`);
      rules.push({ allow: k === 'allow', len: v.length, re });
    }
  }
  return rules;
}
async function robotsAllows(url) {
  const { origin, pathname, search } = new URL(url);
  if (!robotsCache.has(origin)) {
    let rules = null;
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(10_000) });
      rules = r.ok ? parseRobots(await r.text()) : r.status < 500 ? [] : null;
    } catch { rules = null; }
    robotsCache.set(origin, rules);
  }
  const rules = robotsCache.get(origin);
  if (rules === null) return false;
  const best = rules.filter((r) => r.re.test(pathname + search)).sort((a, b) => b.len - a.len || b.allow - a.allow)[0];
  return best ? best.allow : true;
}

/* ============================================================= helpers */

export function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [h = [], ...body] = rows;
  const keys = h.map((x) => x.trim());
  return body.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

export function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/); if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Number or null (Number(null) is 0, which would invent a value). */
export const toNumber = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

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

const getPath = (obj, dotted) => (dotted ? dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), obj) : obj);

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
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(allTexts);
  if (typeof v === 'object') { const k = LANG.find((x) => x in v) ?? Object.keys(v)[0]; return k ? allTexts(v[k]) : []; }
  return [];
}

const decodeXml = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const stripTags = (s) => decodeXml(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Minimal RSS 2.0 / Atom parser: enough for news and alert feeds. */
export function parseFeed(xml) {
  const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    items.push({ title: stripTags(tag(b, 'title')), link: stripTags(tag(b, 'link')), guid: stripTags(tag(b, 'guid')),
      published: stripTags(tag(b, 'pubDate')) || stripTags(tag(b, 'dc:date')), summary: stripTags(tag(b, 'description')).slice(0, 600) });
  }
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const b = m[1];
    const href = b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? '';
    items.push({ title: stripTags(tag(b, 'title')), link: decodeXml(href), guid: stripTags(tag(b, 'id')),
      published: stripTags(tag(b, 'published')) || stripTags(tag(b, 'updated')),
      summary: stripTags(tag(b, 'summary') || tag(b, 'content')).slice(0, 600) });
  }
  return items.filter((i) => i.title);
}

/* ====================================================== award sources */

const DAY_MS = 86_400_000;
const isoNoMs = (d) => new Date(d).toISOString().slice(0, 19);
const windowFrom = (cursor, now, lookbackDays) =>
  cursor ? new Date(Date.parse(cursor) - 3_600_000) : new Date(Date.parse(now) - lookbackDays * DAY_MS);

const AWARD_TAGS = new Set(['award', 'awardUpdate', 'contract', 'contractUpdate']);

/** OCDS release package -> awards. Filtered by release tag, not the API's "stages" parameter. */
function parseOcds(snap, noticeUrl) {
  const out = [];
  for (const release of json(snap)?.releases ?? []) {
    const tags = [release.tag].flat();
    if (!tags.some((t) => AWARD_TAGS.has(t)) && !(release.awards ?? []).length) continue;
    const parties = new Map((release.parties ?? []).map((p) => [p.id, p]));
    for (const award of release.awards ?? []) {
      if (/cancel|unsuccessful|withdrawn/i.test(award.status ?? '')) continue;
      const suppliers = (award.suppliers ?? []).map((s) => {
        const party = parties.get(s.id) ?? {};
        return {
          name: s.name ?? party.name ?? '',
          identifiers: [party.identifier, ...(party.additionalIdentifiers ?? [])].filter(Boolean).map((i) => ({ scheme: i.scheme, id: i.id })),
        };
      }).filter((s) => s.name);
      if (!suppliers.length) continue;
      out.push({
        source: snap.source,
        noticeId: `${release.id}#${award.id ?? '0'}`,
        title: award.title ?? release.tender?.title ?? null,
        buyer: release.buyer?.name ?? null,
        value: toNumber(award.value?.amount),
        currency: award.value?.currency ?? null,
        awardDate: toIsoDate(award.date ?? release.date),
        url: noticeUrl(release),
        confidence: 'awarded',
        suppliers,
      });
    }
  }
  return out;
}

async function harvestOcdsPages(source, firstUrl, maxPages) {
  const snaps = [];
  let url = firstUrl;
  while (url && snaps.length < maxPages) {
    const snap = await snapshot(source, `page-${snaps.length + 1}`, url);
    snaps.push(snap);
    url = json(snap)?.links?.next ?? null;
  }
  return { snaps, truncated: Boolean(url) };
}

const SOURCES = {};

SOURCES.contractsFinder = {
  kind: 'awards', region: 'UK',
  async fetch({ cursor, now, cfg }) {
    const qs = new URLSearchParams({ publishedFrom: isoNoMs(windowFrom(cursor, now, cfg.lookbackDays)), publishedTo: isoNoMs(now), limit: '100' });
    const { snaps, truncated } = await harvestOcdsPages('contractsFinder', `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?${qs}`, cfg.maxPages ?? 30);
    return { snaps, nextCursor: truncated ? cursor : now, truncated };
  },
  parse: (snap) => parseOcds(snap, (r) => {
    const guid = String(r.id ?? '').match(/^[0-9a-f-]{36}/i)?.[0];
    return guid ? `https://www.contractsfinder.service.gov.uk/Notice/${guid}` : null;
  }),
};

SOURCES.findATender = {
  kind: 'awards', region: 'UK',
  async fetch({ cursor, now, cfg }) {
    const qs = new URLSearchParams({ updatedFrom: isoNoMs(windowFrom(cursor, now, cfg.lookbackDays)), updatedTo: isoNoMs(now) });
    const { snaps, truncated } = await harvestOcdsPages('findATender', `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?${qs}`, cfg.maxPages ?? 20);
    return { snaps, nextCursor: truncated ? cursor : now, truncated };
  },
  parse: (snap) => parseOcds(snap, (r) => (/^\d{6}-\d{4}$/.test(r.id ?? '') ? `https://www.find-tender.service.gov.uk/Notice/${r.id}` : null)),
};

SOURCES.ted = {
  kind: 'awards', region: 'EU',
  /**
   * "organisation-name-tenderer" lists tenderers on award notices: usually the
   * winners, but not always, so TED awards carry confidence "tenderer".
   */
  async fetch({ cursor, now, cfg }) {
    const from = windowFrom(cursor, now, cfg.lookbackDays).toISOString().slice(0, 10).replaceAll('-', '');
    const clauses = [`notice-type IN (${(cfg.noticeTypes ?? ['can-standard', 'can-social']).join(' ')})`, `publication-date>=${from}`];
    if (cfg.buyerCountries?.length) clauses.push(`buyer-country IN (${cfg.buyerCountries.join(' ')})`);
    const fields = ['publication-number', 'publication-date', 'notice-title', 'notice-type', 'buyer-name', 'organisation-name-tenderer', ...(cfg.extraFields ?? [])];
    const snaps = [];
    const maxPages = cfg.maxPages ?? 20;
    for (let page = 1; page <= maxPages; page++) {
      const snap = await snapshot('ted', `page-${page}`, 'https://api.ted.europa.eu/v3/notices/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: clauses.join(' AND '), fields, page, limit: 250, scope: 'ALL', paginationMode: 'PAGE_NUMBER' }),
      });
      snaps.push(snap);
      if ((json(snap)?.notices ?? []).length < 250) return { snaps, nextCursor: now, truncated: false };
    }
    return { snaps, nextCursor: cursor, truncated: true };
  },
  parse(snap) {
    return (json(snap)?.notices ?? []).map((n) => {
      const pubNo = firstText(n['publication-number']);
      const names = [...new Set(allTexts(n['organisation-name-tenderer']).map((s) => s.trim()).filter(Boolean))];
      if (!pubNo || !names.length) return null;
      return {
        source: 'ted', noticeId: pubNo,
        title: firstText(n['notice-title']), buyer: firstText(n['buyer-name']),
        value: toNumber(firstText(n['total-value'])), currency: firstText(n['total-value-cur']),
        awardDate: toIsoDate(firstText(n['publication-date'])),
        url: `https://ted.europa.eu/en/notice/-/detail/${pubNo}`,
        confidence: 'tenderer',
        suppliers: names.map((name) => ({ name, identifiers: [] })),
      };
    }).filter(Boolean);
  },
};

SOURCES.gebiz = {
  kind: 'awards', region: 'SG',
  /** data.gov.sg refreshes this dataset in batches months apart: re-read only when its row count changes. */
  async fetch({ cursor, cfg, env }) {
    const resource = cfg.resourceId ?? 'd_acde1106003906a75c3fa052592f2fcb';
    const headers = env.DATA_GOV_SG_API_KEY ? { 'x-api-key': env.DATA_GOV_SG_API_KEY } : {};
    const url = (offset) => `https://data.gov.sg/api/action/datastore_search?${new URLSearchParams({ resource_id: resource, limit: '1000', offset: String(offset) })}`;
    const first = await snapshot('gebiz', 'offset-0', url(0), { headers });
    const total = Number(json(first)?.result?.total ?? 0);
    if (cursor && JSON.parse(cursor).total === total) return { snaps: [], nextCursor: cursor, truncated: false, note: 'dataset unchanged' };
    const snaps = [first];
    for (let off = 1000; off < total; off += 1000) snaps.push(await snapshot('gebiz', `offset-${off}`, url(off), { headers }));
    return { snaps, nextCursor: JSON.stringify({ total }), truncated: false };
  },
  parse(snap) {
    return (json(snap)?.result?.records ?? [])
      .filter((r) => /award/i.test(String(pick(r, ['tender_detail_status', 'Tender Detail Status']) ?? '')))
      .map((r) => {
        const supplier = String(pick(r, ['supplier_name', 'Supplier Name']) ?? '').trim();
        const tenderNo = String(pick(r, ['tender_no', 'Tender No']) ?? '').trim();
        return supplier && tenderNo ? {
          source: 'gebiz', noticeId: `${tenderNo}|${supplier}`,
          title: pick(r, ['tender_description', 'Tender Description']), buyer: pick(r, ['agency', 'Agency']),
          value: toNumber(pick(r, ['awarded_amt', 'awarded_amount', 'Awarded Amt'])), currency: 'SGD',
          awardDate: toIsoDate(pick(r, ['award_date', 'Award Date'])), url: null, confidence: 'awarded',
          suppliers: [{ name: supplier, identifiers: [] }],
        } : null;
      }).filter(Boolean);
  },
};

const HK_FIELDS = {
  noticeId: ['Tender Reference', 'Tender Ref. No.', 'Contract No.', 'Tender No.', 'Reference No.'],
  title: ['Subject', 'Description', 'Tender Title', 'Contract Title', 'Title'],
  buyer: ['Department', 'Procuring Department', 'Bureau/Department'],
  supplier: ['Contractor', 'Successful Tenderer', 'Name of Contractor', 'Supplier', 'Awardee'],
  value: ['Contract Sum', 'Contract Value', 'Contract Amount', 'Award Value', 'Amount (HK$)'],
  awardDate: ['Date of Award', 'Award Date', 'Contract Award Date'],
};

SOURCES.hk = {
  kind: 'awards', region: 'HK',
  /** No consolidated HK award API: each department publishes its own dataset on data.gov.hk. */
  async fetch({ cfg, log }) {
    const snaps = [];
    for (const ds of cfg.datasets ?? []) {
      if (!ds.name || !ds.url) throw new SourceConfigError('hk: each dataset needs "name" and "url"');
      if (!(await robotsAllows(ds.url))) { log.warn(`hk:${ds.name}: robots.txt disallows; skipped`); continue; }
      const snap = await snapshot('hk', ds.name, ds.url, { format: ds.format ?? (ds.url.endsWith('.json') ? 'json' : 'csv') });
      snap.config = ds;
      snaps.push(snap);
    }
    return { snaps, nextCursor: null, truncated: false };
  },
  parse(snap) {
    const ds = snap.config ?? {};
    const f = { ...HK_FIELDS, ...(ds.fields ?? {}) };
    const rows = snap.format === 'json' ? getPath(json(snap), ds.itemsPath) : parseCsv(snap.body);
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const supplier = String(pick(row, f.supplier) ?? '').trim();
      const ref = String(pick(row, f.noticeId) ?? '').trim();
      if (!supplier || !ref) return null;
      const value = toNumber(pick(row, f.value));
      return {
        source: `hk:${ds.name}`, noticeId: `${ref}|${supplier}`,
        title: pick(row, f.title), buyer: pick(row, f.buyer) ?? ds.buyerName ?? null,
        value: value && value > 0 ? value : null, currency: 'HKD',
        awardDate: toIsoDate(pick(row, f.awardDate)), url: ds.pageUrl ?? null, confidence: 'awarded',
        suppliers: [{ name: supplier, identifiers: [] }],
      };
    }).filter(Boolean);
  },
};

/* -------------------------------------------- configured endpoints */

/**
 * Generic authenticated JSON/CSV endpoint, used for Etimad (your authorised
 * API access), your MEA aggregator, and licensed LinkedIn/Indeed job feeds.
 * Secrets are read from environment variables named in watchlist.json,
 * never stored in the watchlist itself.
 *
 *   { "url": "https://...", "method": "GET", "format": "json", "itemsPath": "data.items",
 *     "auth": { "header": "Authorization", "scheme": "Bearer", "env": "ETIMAD_API_TOKEN" },
 *     "pagination": { "param": "page", "start": 1, "maxPages": 5 },
 *     "fields": { ... } }
 */
async function fetchConfigured(source, def, env) {
  if (!def?.url) throw new SourceConfigError(`${source}: no "url" configured in watchlist.json`);
  const headers = { Accept: def.format === 'csv' ? 'text/csv' : 'application/json', ...(def.headers ?? {}) };
  if (def.auth?.env) {
    const secret = env[def.auth.env];
    if (!secret) throw new SourceConfigError(`${source}: environment variable ${def.auth.env} is not set`);
    headers[def.auth.header ?? 'Authorization'] = def.auth.scheme ? `${def.auth.scheme} ${secret}` : secret;
  }
  const pages = def.pagination ? def.pagination.maxPages ?? 5 : 1;
  const snaps = [];
  for (let i = 0; i < pages; i++) {
    const u = new URL(def.url);
    if (def.pagination) u.searchParams.set(def.pagination.param ?? 'page', String((def.pagination.start ?? 1) + i));
    const snap = await snapshot(source, `page-${i + 1}`, u.toString(), {
      method: def.method ?? 'GET', headers, format: def.format ?? 'json',
      body: def.body ? JSON.stringify(def.body) : undefined,
    });
    snap.config = def;
    snaps.push(snap);
    if (def.pagination && configuredRows(snap).length === 0) break;
  }
  return snaps;
}

function configuredRows(snap) {
  const def = snap.config ?? {};
  const rows = snap.format === 'csv' ? parseCsv(snap.body) : getPath(json(snap), def.itemsPath);
  return Array.isArray(rows) ? rows : [];
}

const AWARD_FIELDS = {
  noticeId: ['id', 'tenderId', 'tender_id', 'referenceNumber', 'reference', 'noticeId'],
  title: ['title', 'tenderName', 'tender_name', 'name', 'subject'],
  buyer: ['agency', 'agencyName', 'buyer', 'buyerName', 'entity', 'governmentEntity'],
  supplier: ['supplier', 'supplierName', 'awardedSupplier', 'winner', 'winnerName', 'vendor'],
  value: ['value', 'awardValue', 'awardedValue', 'amount', 'contractValue'],
  currency: ['currency', 'currencyCode'],
  awardDate: ['awardDate', 'award_date', 'awardedAt', 'date', 'publishedAt'],
  url: ['url', 'link', 'noticeUrl'],
};

function parseConfiguredAwards(snap, defaultCurrency) {
  const f = { ...AWARD_FIELDS, ...(snap.config?.fields ?? {}) };
  return configuredRows(snap).map((row) => {
    const supplier = String(pick(row, f.supplier) ?? '').trim();
    const id = String(pick(row, f.noticeId) ?? '').trim();
    if (!supplier || !id) return null;
    return {
      source: snap.source, noticeId: `${id}|${supplier}`,
      title: pick(row, f.title), buyer: pick(row, f.buyer),
      value: toNumber(pick(row, f.value)), currency: pick(row, f.currency) ?? snap.config?.currency ?? defaultCurrency,
      awardDate: toIsoDate(pick(row, f.awardDate)), url: pick(row, f.url), confidence: 'awarded',
      suppliers: [{ name: supplier, identifiers: [] }],
    };
  }).filter(Boolean);
}

SOURCES.etimad = {
  kind: 'awards', region: 'SA',
  fetch: async ({ cfg, env }) => ({ snaps: await fetchConfigured('etimad', cfg, env), nextCursor: null, truncated: false }),
  parse: (snap) => parseConfiguredAwards(snap, 'SAR'),
};

SOURCES.meaAggregator = {
  kind: 'awards', region: 'MEA',
  fetch: async ({ cfg, env }) => ({ snaps: await fetchConfigured('meaAggregator', cfg, env), nextCursor: null, truncated: false }),
  parse: (snap) => parseConfiguredAwards(snap, null),
};

/* ========================================================== job boards */

const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const workdayThrottle = createThrottle(300);

const ATS = {
  greenhouse: {
    url: (a) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(a.token)}/jobs`,
    parse: (b) => (b?.jobs ?? []).map((j) => ({ key: String(j.id), title: clean(j.title), location: clean(j.location?.name), url: j.absolute_url ?? null })),
  },
  lever: {
    url: (a) => `${a.region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co'}/v0/postings/${encodeURIComponent(a.slug)}?mode=json`,
    parse: (b) => (Array.isArray(b) ? b : []).map((j) => ({ key: String(j.id), title: clean(j.text), location: clean(j.categories?.location), url: j.hostedUrl ?? null })),
  },
  workable: {
    url: (a) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(a.account)}`,
    parse: (b) => (b?.jobs ?? []).map((j) => ({ key: String(j.shortcode ?? j.id ?? j.url), title: clean(j.title), location: clean([j.city, j.country].filter(Boolean).join(', ')), url: j.url ?? null })),
  },
};

async function fetchWorkday(company) {
  const a = company.ats;
  const endpoint = `https://${a.host}/wday/cxs/${encodeURIComponent(a.tenant)}/${encodeURIComponent(a.site)}/jobs`;
  if (!(await robotsAllows(endpoint))) throw new SourceConfigError(`workday ${a.host}: robots.txt disallows the jobs endpoint`);
  const snaps = [];
  let total = null; let seen = 0;
  for (let page = 0; page < (a.maxPages ?? 50); page++) {
    await workdayThrottle();
    const snap = await snapshot('workday', `${company.id}#${page}`, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'en-US' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText: '' }), // >20 returns nothing
    });
    snap.companyId = company.id;
    snaps.push(snap);
    const b = json(snap);
    if (page === 0) total = Number(b?.total ?? 0);
    const n = (b?.jobPostings ?? []).length;
    seen += n;
    if (n < 20 || seen >= total) break;
  }
  snaps.forEach((s) => { s.complete = total !== null && seen >= total; });
  return snaps;
}

function parseWorkday(snaps, company) {
  const jobs = snaps.flatMap((s) => (json(s)?.jobPostings ?? []).filter((p) => p.externalPath).map((p) => ({
    key: p.externalPath, title: clean(p.title), location: clean(p.locationsText), url: `https://${company.ats.host}/${company.ats.site}${p.externalPath}`,
  })));
  return { jobs, complete: snaps.every((s) => s.complete) };
}

const JOB_FIELDS = {
  id: ['id', 'jobId', 'job_id', 'jobKey', 'jobkey', 'reference'],
  company: ['company', 'companyName', 'company_name', 'employer', 'hiringOrganization.name', 'organization'],
  title: ['title', 'jobTitle', 'job_title', 'name', 'position'],
  location: ['location', 'formattedLocation', 'city', 'jobLocation'],
  url: ['url', 'link', 'jobUrl', 'applyUrl'],
};

/* ============================================================ harvest */

/**
 * Phase 1: fetch raw snapshots from every enabled source.
 * @returns {Promise<{ snapshots: object[], cursors: object, failures: object[], notes: string[] }>}
 */
export async function harvestAll(watchlist, { getCursor, now, env, log, concurrency = 4 }) {
  const snapshots = []; const cursors = {}; const failures = []; const notes = [];
  const sources = watchlist.sources ?? {};

  for (const [id, source] of Object.entries(SOURCES)) {
    const cfg = { lookbackDays: 3, ...(sources[id] ?? {}) };
    if (cfg.enabled === false) continue;
    if (id === 'hk' && !cfg.datasets?.length) continue;
    if ((id === 'etimad' || id === 'meaAggregator') && !cfg.url) continue;
    try {
      const r = await source.fetch({ cursor: getCursor(id), now, cfg, env, log });
      snapshots.push(...r.snaps.map((s) => ({ ...s, kind: source.kind, region: source.region })));
      if (r.nextCursor !== undefined) cursors[id] = r.nextCursor;
      if (r.truncated) notes.push(`${id}: stopped at page limit; the rest is picked up next run`);
      if (r.note) notes.push(`${id}: ${r.note}`);
    } catch (err) {
      failures.push({ source: id, error: err.message });
      log.error(`${id}: ${err.message}`);
    }
  }

  // Company career boards.
  const boards = watchlist.companies.filter((c) => c.ats);
  await mapPool(boards, concurrency, async (company) => {
    try {
      if (company.ats.type === 'workday') {
        snapshots.push(...(await fetchWorkday(company)).map((s) => ({ ...s, kind: 'jobs', companyId: company.id })));
        return;
      }
      const ats = ATS[company.ats.type];
      if (!ats) throw new SourceConfigError(`unknown ATS type "${company.ats.type}"`);
      const snap = await snapshot(company.ats.type, company.id, ats.url(company.ats));
      snapshots.push({ ...snap, kind: 'jobs', companyId: company.id, complete: true });
    } catch (err) {
      failures.push({ source: `${company.ats.type}:${company.id}`, error: err.message });
      log.error(`${company.name} (${company.ats.type}): ${err.message}`);
    }
  });

  // Licensed job feeds (LinkedIn, Indeed, or any vendor feed).
  for (const [id, def] of Object.entries(watchlist.jobFeeds ?? {})) {
    if (def.enabled === false || !def.url) continue;
    try {
      const snaps = await fetchConfigured(id, def, env);
      snapshots.push(...snaps.map((s) => ({ ...s, kind: 'jobFeed' })));
    } catch (err) {
      failures.push({ source: id, error: err.message });
      log.error(`${id}: ${err.message}`);
    }
  }

  // Funding news feeds.
  for (const feed of watchlist.funding?.feeds ?? []) {
    try {
      const snap = await snapshot('funding', feed.name ?? new URL(feed.url).hostname, feed.url, { format: 'xml', headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' } });
      snapshots.push({ ...snap, kind: 'funding', feedName: feed.name ?? new URL(feed.url).hostname });
    } catch (err) {
      failures.push({ source: `funding:${feed.name ?? feed.url}`, error: err.message });
      log.error(`funding feed ${feed.name ?? feed.url}: ${err.message}`);
    }
  }

  return { snapshots, cursors, failures, notes };
}

/* ============================================================== parse */

/**
 * Phase 2: interpret snapshots.
 * @returns {{ awards: object[], boards: { companyId, source, jobs, complete }[], feedJobs: object[], funding: object[], parseErrors: object[] }}
 */
export function parseSnapshots(snapshots, watchlist) {
  const awards = []; const boards = []; const feedJobs = []; const funding = []; const parseErrors = [];
  const companies = new Map(watchlist.companies.map((c) => [c.id, c]));
  const guard = (snap, fn) => { try { fn(); } catch (err) { parseErrors.push({ source: snap.source, key: snap.key, error: err.message }); } };

  const workdayByCompany = new Map();
  for (const snap of snapshots) {
    if (snap.kind === 'awards') guard(snap, () => awards.push(...SOURCES[snap.source].parse(snap)));
    else if (snap.kind === 'jobs' && snap.source === 'workday') {
      if (!workdayByCompany.has(snap.companyId)) workdayByCompany.set(snap.companyId, []);
      workdayByCompany.get(snap.companyId).push(snap);
    } else if (snap.kind === 'jobs') {
      guard(snap, () => boards.push({ companyId: snap.companyId, source: snap.source, jobs: ATS[snap.source].parse(json(snap)).filter((j) => j.title), complete: true }));
    } else if (snap.kind === 'jobFeed') {
      guard(snap, () => {
        const f = { ...JOB_FIELDS, ...(snap.config?.fields ?? {}) };
        for (const row of configuredRows(snap)) {
          const company = clean(pick(row, f.company)); const title = clean(pick(row, f.title));
          if (!company || !title) continue;
          feedJobs.push({ source: snap.source, company, key: String(pick(row, f.id) ?? pick(row, f.url) ?? `${company}|${title}`), title, location: clean(pick(row, f.location)), url: pick(row, f.url) });
        }
      });
    } else if (snap.kind === 'funding') {
      guard(snap, () => funding.push(...parseFeed(snap.body).map((i) => ({ ...i, feed: snap.feedName }))));
    }
  }
  for (const [companyId, snaps] of workdayByCompany) {
    guard(snaps[0], () => boards.push({ companyId, source: 'workday', ...parseWorkday(snaps, companies.get(companyId)) }));
  }
  return { awards, boards, feedJobs, funding, parseErrors };
}

export const SOURCE_IDS = Object.keys(SOURCES);