/**
 * UK Home Office "Register of licensed sponsors: workers".
 *
 * The CSV's URL and filename change with every publication, and the naming
 * scheme itself has changed over time, e.g.
 *   .../media/<id>/2026-03-27_-_Worker_and_Temporary_Worker.csv
 *   .../media/<id>/SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-09-29.csv
 * so the link is discovered every run and matched loosely:
 *   1. GOV.UK Content API attachments
 *   2. the publication's HTML page (anchor hrefs, anchor text, raw asset URLs,
 *      and "View online" csv-preview links mapped back to the asset)
 *   3. SPONSOR_CSV_URL from the environment, if set
 *
 * CSV columns: Organisation Name, Town/City, County, Type & Rating, Route.
 * One row per organisation per route; values often carry stray whitespace.
 */
import { createHash } from 'node:crypto';

export const PUBLICATION_PATH = '/government/publications/register-of-licensed-sponsors-workers';
const CONTENT_API = `https://www.gov.uk/api/content${PUBLICATION_PATH}`;
const PUBLICATION_PAGE = `https://www.gov.uk${PUBLICATION_PATH}`;
const ASSET_ORIGIN = 'https://assets.publishing.service.gov.uk';
const REQUIRED_COLUMNS = ['Organisation Name', 'Town/City', 'County', 'Type & Rating', 'Route'];

/** Browser-like headers; override the User-Agent with SLS_USER_AGENT if you prefer. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ACCEPT = {
  html: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  json: 'application/json,text/plain;q=0.9,*/*;q=0.8',
  csv: 'text/csv,application/csv,text/plain;q=0.9,*/*;q=0.8',
};

function headers(accept) {
  return {
    'User-Agent': process.env.SLS_USER_AGENT || BROWSER_UA,
    Accept: accept,
    'Accept-Language': 'en-GB,en;q=0.9',
  };
}

async function get(url, { accept = ACCEPT.html, timeoutMs = 60_000 } = {}) {
  const res = await fetch(url, { headers: headers(accept), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

/* ------------------------------------------------------------- discovery */

const dateFromFilename = (name) => String(name ?? '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

const decodeEntities = (s) => String(s ?? '')
  .replace(/&amp;/gi, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/gi, '"');

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Turn any link we might see into a canonical asset URL, or null.
 *  - absolute or protocol-relative assets.publishing.service.gov.uk URLs
 *  - relative "/media/<id>/<file>.csv" paths
 *  - www.gov.uk/csv-preview/<id>/<file>.csv ("View online" pages)
 */
export function toAssetUrl(href) {
  const raw = decodeEntities(href).trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw, `${ASSET_ORIGIN}/`);
  } catch {
    return null;
  }
  if (!/\.csv$/i.test(url.pathname)) return null;

  const preview = url.pathname.match(/^\/csv-preview\/([^/]+)\/(.+\.csv)$/i);
  if (/(^|\.)gov\.uk$/i.test(url.hostname) && preview) return `${ASSET_ORIGIN}/media/${preview[1]}/${preview[2]}`;
  if (url.hostname.toLowerCase() === 'assets.publishing.service.gov.uk' && url.pathname.startsWith('/media/')) {
    return `${ASSET_ORIGIN}${url.pathname}`;
  }
  return null;
}

/**
 * Score how likely a candidate is to be the workers register, using both the
 * filename and any link text. 0 means "not a candidate at all".
 */
export function scoreCandidate({ url, text = '' }) {
  const filename = decodeURIComponent(url.split('/').pop() ?? '');
  const haystack = `${filename} ${text}`.replace(/[_-]+/g, ' ');
  if (/student/i.test(haystack)) return 0; // the separate student sponsor register
  if (/worker.*temporary|temporary.*worker/i.test(haystack)) return 3;
  if (/register.*sponsor|sponsor.*register/i.test(haystack)) return 2;
  return 1; // any CSV under assets.publishing.service.gov.uk
}

function rankCandidates(candidates) {
  const seen = new Map();
  for (const c of candidates) {
    const url = toAssetUrl(c.url);
    if (!url) continue;
    const score = scoreCandidate({ url, text: c.text });
    if (!score) continue;
    const filename = decodeURIComponent(url.split('/').pop());
    const prev = seen.get(url);
    if (!prev || score > prev.score) {
      seen.set(url, { url, filename, publishedDate: dateFromFilename(filename), score, via: c.via });
    }
  }
  return [...seen.values()].sort((a, b) =>
    b.score - a.score || (b.publishedDate ?? '').localeCompare(a.publishedDate ?? ''));
}

async function candidatesFromContentApi() {
  const body = await (await get(CONTENT_API, { accept: ACCEPT.json })).json();
  const details = body?.details ?? {};
  const attachments = [
    ...(Array.isArray(details.attachments) ? details.attachments : []),
    ...(Array.isArray(details.documents) ? details.documents : []),
  ];
  const out = [];
  for (const a of attachments) {
    if (typeof a === 'object' && a) {
      for (const key of ['url', 'preview_url', 'file_url']) {
        if (a[key]) out.push({ url: a[key], text: `${a.title ?? ''} ${a.filename ?? ''}`, via: 'content-api' });
      }
    } else if (typeof a === 'string') {
      // Some publications embed attachments as rendered HTML strings.
      for (const c of candidatesFromHtml(a)) out.push({ ...c, via: 'content-api' });
    }
  }
  return out;
}

export function candidatesFromHtml(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ url: m[2], text: stripTags(m[3]), via: 'html' });
  }
  // Bare URLs in the page (link text, data attributes, JSON-LD).
  for (const m of html.matchAll(/(?:https?:)?\/\/assets\.publishing\.service\.gov\.uk\/media\/[^"'\s<>)]+?\.csv/gi)) {
    out.push({ url: m[0].startsWith('//') ? `https:${m[0]}` : m[0], text: '', via: 'html' });
  }
  return out;
}

/**
 * Find the current register CSV.
 * @returns {Promise<{ url: string, filename: string, publishedDate: string|null, via: string }>}
 */
export async function discoverRegisterCsv() {
  const attempts = [];

  try {
    const hit = rankCandidates(await candidatesFromContentApi())[0];
    if (hit) return hit;
    attempts.push('Content API: no CSV attachment matched');
  } catch (err) {
    attempts.push(`Content API: ${err.message}`);
  }

  try {
    const html = await (await get(PUBLICATION_PAGE, { accept: ACCEPT.html })).text();
    const ranked = rankCandidates(candidatesFromHtml(html));
    if (ranked[0]) return ranked[0];
    const csvCount = (html.match(/\.csv\b/gi) ?? []).length;
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 80);
    attempts.push(`Publication page ("${title}"): ${csvCount} ".csv" mentions, none under ${ASSET_ORIGIN}/media/`);
  } catch (err) {
    attempts.push(`Publication page: ${err.message}`);
  }

  const override = process.env.SPONSOR_CSV_URL?.trim();
  if (override) {
    if (!/^https:\/\//i.test(override)) throw new Error('SPONSOR_CSV_URL must be an https:// URL');
    const filename = decodeURIComponent(new URL(override).pathname.split('/').pop() || 'sponsor-register.csv');
    return { url: override, filename, publishedDate: dateFromFilename(filename), score: 0, via: 'SPONSOR_CSV_URL' };
  }

  throw new Error(
    `Could not find the Worker and Temporary Worker CSV on GOV.UK.\n  - ${attempts.join('\n  - ')}\n`
    + `  Set SPONSOR_CSV_URL to the CSV link from ${PUBLICATION_PAGE} to run anyway.`,
  );
}

/** Download the CSV, decoding as UTF-8 (falling back to Windows-1252 if it isn't). */
export async function downloadCsv(url) {
  const res = await get(url, { accept: ACCEPT.csv, timeoutMs: 120_000 });
  const buffer = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  // An HTML error or consent page served with 200 must not reach the parser as "CSV".
  if (/^\s*<(!doctype|html)/i.test(text.slice(0, 200))) {
    throw new Error(`Expected CSV from ${url} but received an HTML page`);
  }
  return { text, sha256, bytes: buffer.length };
}

/* --------------------------------------------------------------- parsing */

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

const SUFFIX_VARIANTS = [
  [/\bpublic limited company\b/g, 'plc'],
  [/\blimited\b/g, 'ltd'],
  [/\bcompany\b/g, 'co'],
  [/\band\b/g, '&'],
];

/** Normalise for identity: case, accents, punctuation, and Ltd/Limited-style variants. */
export function normalizeName(name) {
  let s = squash(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9&]+/g, ' ');
  for (const [re, to] of SUFFIX_VARIANTS) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

export const orgKey = (name, town) => `${normalizeName(name)}|${normalizeName(town)}`;

/**
 * "Worker (A rating)" -> { type: "Worker", rating: "A" }
 * "Worker (A (Premium))" -> { type: "Worker", rating: "A (Premium)" }
 * "Temporary Worker (B rating)" -> { type: "Temporary Worker", rating: "B" }
 */
export function parseTypeAndRating(value) {
  const s = squash(value);
  const open = s.indexOf('(');
  if (open === -1 || !s.endsWith(')')) return { type: s || 'Unknown', rating: 'Unknown' };
  const type = s.slice(0, open).trim();
  const rating = s.slice(open + 1, -1).replace(/\s*rating$/i, '').trim();
  return { type: type || 'Unknown', rating: rating || 'Unknown' };
}

/**
 * Parse the register into one record per organisation.
 * @returns {{ orgs: Map<string, object>, rowCount: number, skipped: number }}
 */
export function parseRegister(text) {
  const [header = [], ...rows] = parseCsvRows(text);
  const columns = header.map(squash);
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`Register CSV is missing column(s): ${missing.join(', ')}. Found: ${columns.join(', ')}`);

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

    const key = orgKey(name, town ?? '');
    const org = orgs.get(key) ?? { key, name, town, county, ratings: {}, routes: [] };
    // If the same org lists different ratings for one type, keep the worse one.
    if (!org.ratings[type] || ratingRank(rating) < ratingRank(org.ratings[type])) org.ratings[type] = rating;
    if (route && !org.routes.includes(route)) org.routes.push(route);
    orgs.set(key, org);
  }

  for (const org of orgs.values()) org.routes.sort();
  return { orgs, rowCount, skipped };
}

/* ----------------------------------------------------------------- delta */

/** Higher is better. B means the sponsor is on a Home Office action plan. */
export function ratingRank(rating) {
  const r = String(rating ?? '').toLowerCase();
  if (r.startsWith('a')) return r.includes('premium') ? 4 : r.includes('sme') ? 3 : 2;
  if (r.startsWith('b')) return 0;
  if (r.includes('provisional')) return 1;
  return 1;
}

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

const ratingsDiffer = (before, after) =>
  Object.keys(after).some((type) => type in before && before[type] !== after[type]);

/**
 * Compare the previous active set with today's register.
 *
 * An organisation whose town changed would otherwise look like a removal plus
 * an addition. Those are paired by name (one-to-one only) and reported as
 * relocations, not as diffs.
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

  const byName = (list) => {
    const m = new Map();
    for (const o of list) {
      const n = normalizeName(o.name);
      m.set(n, m.has(n) ? null : o); // null marks an ambiguous name
    }
    return m;
  };
  const addedByName = byName(added);
  const removedByName = byName(removed);
  const relocated = [];
  for (const [name, from] of removedByName) {
    const to = addedByName.get(name);
    if (from && to) relocated.push({ from, to });
  }
  const movedFrom = new Set(relocated.map((r) => r.from.key));
  const movedTo = new Set(relocated.map((r) => r.to.key));

  return {
    added: added.filter((o) => !movedTo.has(o.key)),
    removed: removed.filter((o) => !movedFrom.has(o.key)),
    ratingChanged,
    relocated,
  };
}