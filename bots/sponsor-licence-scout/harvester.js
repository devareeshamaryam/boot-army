/**
 * UK Home Office "Register of licensed sponsors: workers".
 *
 * The CSV's URL changes on every publication
 * (assets.publishing.service.gov.uk/media/<id>/YYYY-MM-DD_-_Worker_and_Temporary_Worker.csv),
 * so it is discovered each run from the GOV.UK Content API, with the
 * publication's HTML page as a fallback.
 *
 * CSV columns: Organisation Name, Town/City, County, Type & Rating, Route.
 * One row per organisation per route; values often carry stray whitespace.
 */
import { createHash } from 'node:crypto';

export const PUBLICATION_PATH = '/government/publications/register-of-licensed-sponsors-workers';
const CONTENT_API = `https://www.gov.uk/api/content${PUBLICATION_PATH}`;
const PUBLICATION_PAGE = `https://www.gov.uk${PUBLICATION_PATH}`;
const CSV_NAME = /Worker_and_Temporary_Worker\.csv$/i;
const ASSET_HOST = /^https:\/\/assets\.publishing\.service\.gov\.uk\//;
const REQUIRED_COLUMNS = ['Organisation Name', 'Town/City', 'County', 'Type & Rating', 'Route'];

const USER_AGENT = `bot-army-sponsor-licence-scout/0.1${process.env.SLS_CONTACT ? ` (+${process.env.SLS_CONTACT})` : ''}`;

async function get(url, { accept = '*/*', timeoutMs = 60_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

const dateFromFilename = (name) => name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

function pickLatest(candidates) {
  const csvs = candidates
    .filter((c) => c.url && ASSET_HOST.test(c.url) && CSV_NAME.test(c.filename))
    .map((c) => ({ ...c, publishedDate: dateFromFilename(c.filename) }))
    .sort((a, b) => (b.publishedDate ?? '').localeCompare(a.publishedDate ?? ''));
  return csvs[0] ?? null;
}

/** Find the current register CSV. @returns {{ url, filename, publishedDate }} */
export async function discoverRegisterCsv() {
  try {
    const body = await (await get(CONTENT_API, { accept: 'application/json' })).json();
    const attachments = [...(body?.details?.attachments ?? []), ...(body?.details?.documents ?? [])]
      .filter((a) => typeof a === 'object' && a?.url)
      .map((a) => ({ url: a.url, filename: a.filename ?? decodeURIComponent(a.url.split('/').pop()) }));
    const hit = pickLatest(attachments);
    if (hit) return hit;
  } catch {
    // fall through to the HTML page
  }

  const html = await (await get(PUBLICATION_PAGE, { accept: 'text/html' })).text();
  const links = [...html.matchAll(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"'\s<>]+?\.csv/gi)]
    .map((m) => ({ url: m[0], filename: decodeURIComponent(m[0].split('/').pop()) }));
  const hit = pickLatest(links);
  if (!hit) throw new Error('Could not find the Worker and Temporary Worker CSV on GOV.UK');
  return hit;
}

/** Download the CSV, decoding as UTF-8 (falling back to Windows-1252 if it isn't). */
export async function downloadCsv(url) {
  const buffer = Buffer.from(await (await get(url, { accept: 'text/csv' })).arrayBuffer());
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer);
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