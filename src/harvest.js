/**
 * B1 harvester: find the current GOV.UK register CSV and download it into
 * memory. Nothing is written to disk: the Google Sheet is the only store.
 *
 * Discovery order:
 *   1. GOV.UK Content API attachments
 *   2. the publication's HTML page (hrefs, link text, bare asset URLs, csv-preview links)
 *   3. SPONSOR_CSV_URL from the environment
 *
 * Runnable alone:  node src/harvest.js
 */
import { parse } from 'csv-parse/sync';
import { http } from './core/index.js';

export const PUBLICATION_PATH = '/government/publications/register-of-licensed-sponsors-workers';
export const CONTENT_API = `https://www.gov.uk/api/content${PUBLICATION_PATH}`;
export const PUBLICATION_PAGE = `https://www.gov.uk${PUBLICATION_PATH}`;
const ASSET_ORIGIN = 'https://assets.publishing.service.gov.uk';

/** Browser-like headers (as requested for GOV.UK); override the UA with SLS_USER_AGENT. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const headers = (accept) => ({ Accept: accept, 'Accept-Language': 'en-GB,en;q=0.9' });
const userAgent = () => process.env.SLS_USER_AGENT?.trim() || BROWSER_UA;

/* ------------------------------------------------------------- discovery */

const dateFromFilename = (name) => String(name ?? '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
const decodeEntities = (s) => String(s ?? '').replace(/&amp;/gi, '&').replace(/&#x2F;|&#47;/gi, '/').replace(/&quot;/gi, '"');
const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Canonical asset URL for any link we might see, or null. Handles absolute,
 * protocol-relative and relative /media/ links, and maps www.gov.uk/csv-preview
 * ("View online") pages back to the downloadable asset.
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

/** 3 = worker+temporary, 2 = register+sponsor, 1 = any asset CSV, 0 = excluded (student register). */
export function scoreCandidate({ url, text = '' }) {
  const filename = decodeURIComponent(url.split('/').pop() ?? '');
  const haystack = `${filename} ${text}`.replace(/[_-]+/g, ' ');
  if (/student/i.test(haystack)) return 0;
  if (/worker.*temporary|temporary.*worker/i.test(haystack)) return 3;
  if (/register.*sponsor|sponsor.*register/i.test(haystack)) return 2;
  return 1;
}

export function rankCandidates(candidates) {
  const byUrl = new Map();
  for (const c of candidates) {
    const url = toAssetUrl(c.url);
    if (!url) continue;
    const score = scoreCandidate({ url, text: c.text });
    if (!score) continue;
    const filename = decodeURIComponent(url.split('/').pop());
    const prev = byUrl.get(url);
    if (!prev || score > prev.score) byUrl.set(url, { url, filename, publishedDate: dateFromFilename(filename), score, via: c.via });
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score || (b.publishedDate ?? '').localeCompare(a.publishedDate ?? ''));
}

export function candidatesFromHtml(html, via = 'html') {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ url: m[2], text: stripTags(m[3]), via });
  }
  for (const m of html.matchAll(/(?:https?:)?\/\/assets\.publishing\.service\.gov\.uk\/media\/[^"'\s<>)]+?\.csv/gi)) {
    out.push({ url: m[0].startsWith('//') ? `https:${m[0]}` : m[0], text: '', via });
  }
  return out;
}

export function candidatesFromContentApi(body) {
  const details = body?.details ?? {};
  const attachments = [
    ...(Array.isArray(details.attachments) ? details.attachments : []),
    ...(Array.isArray(details.documents) ? details.documents : []),
  ];
  const out = [];
  for (const a of attachments) {
    if (a && typeof a === 'object') {
      for (const key of ['url', 'preview_url', 'file_url']) {
        if (a[key]) out.push({ url: a[key], text: `${a.title ?? ''} ${a.filename ?? ''}`, via: 'content-api' });
      }
    } else if (typeof a === 'string') {
      out.push(...candidatesFromHtml(a, 'content-api'));
    }
  }
  return out;
}

/**
 * Locate the current register CSV.
 * @returns {Promise<{ url, filename, publishedDate, via }>}
 */
export async function discoverRegisterCsv({ env = process.env } = {}) {
  const attempts = [];

  try {
    const res = await http.fetch(CONTENT_API, { headers: headers('application/json'), userAgent: userAgent() });
    const hit = rankCandidates(candidatesFromContentApi(res.json()))[0];
    if (hit) return hit;
    attempts.push('Content API: no CSV attachment matched');
  } catch (err) {
    attempts.push(`Content API: ${err.message}`);
  }

  try {
    const res = await http.fetch(PUBLICATION_PAGE, { headers: headers('text/html,application/xhtml+xml'), userAgent: userAgent() });
    const html = res.text();
    const hit = rankCandidates(candidatesFromHtml(html))[0];
    if (hit) return hit;
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 80);
    attempts.push(`Publication page ("${title}"): ${(html.match(/\.csv\b/gi) ?? []).length} ".csv" mentions, none under ${ASSET_ORIGIN}/media/`);
  } catch (err) {
    attempts.push(`Publication page: ${err.message}`);
  }

  const override = env.SPONSOR_CSV_URL?.trim();
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

/* --------------------------------------------------------------- harvest */

/**
 * Discover and download the register CSV.
 * @returns {Promise<{ csv: string, source: { url, filename, publishedDate, via } }>}
 */
export async function harvest({ log, env = process.env } = {}) {
  const source = await discoverRegisterCsv({ env });
  log?.info(`Register: ${source.filename}`, { via: source.via, url: source.url });

  const res = await http.fetch(source.url, {
    headers: headers('text/csv,application/csv,text/plain;q=0.9,*/*;q=0.8'),
    userAgent: userAgent(),
    timeoutMs: 120_000,
  });
  log?.info(`Downloaded ${(res.body.length / 1e6).toFixed(2)} MB`);
  return { csv: res.text(), source };
}

/* ------------------------------------------------------------------ rows */

export const COLUMNS = ['Organisation Name', 'Town/City', 'County', 'Type & Rating', 'Route'];

/**
 * Parse the register CSV into rows with the five register columns.
 * Throws if a column is missing, naming the columns actually found.
 * @returns {{ 'Organisation Name': string, 'Town/City': string, County: string, 'Type & Rating': string, Route: string }[]}
 */
export function parseRows(csvText) {
  const records = parse(csvText, { columns: true, bom: true, trim: true, skip_empty_lines: true, relax_column_count: true });
  const found = records.length ? Object.keys(records[0]) : parse(csvText, { bom: true, to_line: 1 })[0] ?? [];
  const missing = COLUMNS.filter((c) => !found.includes(c));
  if (missing.length) throw new Error(`Register CSV is missing column(s): ${missing.join(', ')}. Found: ${found.join(', ') || '(none)'}`);
  return records.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? ''])));
}

/* ---------------------------------------------------------- standalone run */

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  const { fileURLToPath } = await import('node:url');
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
  const { logger } = await import('./core/index.js');
  const log = logger.forBot('sponsor-licence-scout:harvest');
  try {
    const { csv, source } = await harvest({ log });
    console.log(JSON.stringify({ source, rows: parseRows(csv).length }, null, 2));
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
  }
}