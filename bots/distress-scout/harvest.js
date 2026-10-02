/**
 * B4 harvester: network → core.snapshot only. Nothing here interprets data
 * beyond what pagination needs.
 *
 *   The Gazette   documented notice-feed API (github.com/TheGazette/DevDocs):
 *                 /insolvency/notice/data.json?categorycode=24 (corporate insolvency),
 *                 windowed by start-publish-date / end-publish-date. Notice codes are
 *                 filtered locally. Full notice pages are fetched only when a feed
 *                 snippet carries no company number (capped, robots.txt checked).
 *   Companies House  REST API, free key (CH_API_KEY): /company/{n} and
 *                 /company/{n}/insolvency. Limit 600 requests / 5 minutes.
 *   CSV feeds     files you export, or robots-permitted URLs (e.g. a credit
 *                 bureau's CCJ extract you are licensed to use).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { http } from '@botarmy/core';

export const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SOURCES = Object.freeze({
  gazetteFeed: 'uk-gazette-insolvency-feed',
  gazetteNotice: 'uk-gazette-notice',
  chProfile: 'uk-ch-company-profile',
  chInsolvency: 'uk-ch-insolvency',
  csv: (name) => `distress-csv-${name}`,
});

export const GAZETTE_FEED = 'https://www.thegazette.co.uk/insolvency/notice/data.json';
export const GAZETTE_NOTICE = (id) => `https://www.thegazette.co.uk/notice/${encodeURIComponent(id)}`;
export const CH_API = 'https://api.company-information.service.gov.uk';
const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

export class SourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

/* ============================================================== Gazette */

/** Publication-date window: from the cursor day (inclusive: duplicates are ignored), else the lookback. */
export function gazetteWindow(cursor, now, lookbackDays = 3) {
  const from = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor) ? cursor : isoDay(Date.parse(now) - lookbackDays * DAY_MS);
  return { from, to: isoDay(now) };
}

export function gazetteUrl({ from, to }, page) {
  const qs = new URLSearchParams({
    categorycode: '24', 'start-publish-date': from, 'end-publish-date': to,
    'results-page-size': String(PAGE_SIZE), 'results-page': String(page), 'sort-by': 'oldest-date',
  });
  return `${GAZETTE_FEED}?${qs}`;
}

/** True if the window contains a Monday–Friday (the Gazette does not publish at weekends). */
export function windowHasWeekday({ from, to }) {
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).getUTCDay();
    if (d >= 1 && d <= 5) return true;
  }
  return false;
}

export async function harvestGazette({ store, cursor, now, cfg = {} }) {
  const window = gazetteWindow(cursor, now, cfg.lookbackDays ?? 3);
  const maxPages = cfg.maxPages ?? 30;
  const snapshotIds = [];
  let items = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = gazetteUrl(window, page);
    const res = await http.fetch(url, { headers: { Accept: 'application/json' }, minIntervalMs: 1000 });
    snapshotIds.push(store.writeRaw(SOURCES.gazetteFeed, `${window.from}_${window.to}_p${page}.json`, res.body,
      { url, contentType: res.contentType, kind: 'gazette-feed', window, page }).id);
    const entries = parseJson(res.body)?.entry;
    const n = Array.isArray(entries) ? entries.length : 0;
    items += n;
    if (n < PAGE_SIZE) return { snapshotIds, items, window, truncated: false, nextCursor: window.to };
  }
  return { snapshotIds, items, window, truncated: true, nextCursor: cursor ?? window.from };
}

/** Full notice pages for notices whose feed snippet had no company number. */
export async function harvestNotices(noticeIds, { store, log }) {
  const out = new Map();
  for (const id of noticeIds) {
    const url = GAZETTE_NOTICE(id);
    try {
      if (!(await http.allowedByRobots(url))) {
        log?.warn(`Gazette robots.txt disallows ${url}; notice left unresolved`);
        continue;
      }
      const res = await http.fetch(url, { headers: { Accept: 'text/html' }, minIntervalMs: 1000 });
      out.set(id, store.writeRaw(SOURCES.gazetteNotice, `${id}.html`, res.body, { url, contentType: res.contentType, kind: 'gazette-notice', noticeId: id }).id);
    } catch (err) {
      log?.warn(`Gazette notice ${id}: ${err.message}`);
    }
  }
  return out;
}

/* ====================================================== Companies House */

function chHeaders(env) {
  const key = env.CH_API_KEY?.trim();
  if (!key) throw new SourceConfigError('Companies House: set CH_API_KEY in the root .env');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, Accept: 'application/json' };
}

/**
 * Profile + insolvency for each company number. A 404 on the profile means the
 * number does not exist; a 404 on /insolvency means no insolvency history.
 * @returns {Promise<{ companyNumber, status: 'ok'|'not-found'|'failed', profileSnapshotId?, insolvencySnapshotId?, error? }[]>}
 */
export async function harvestCompaniesHouse(companyNumbers, { store, env = process.env, log }) {
  const headers = chHeaders(env);
  const results = [];
  for (const n of companyNumbers) {
    try {
      const profileUrl = `${CH_API}/company/${encodeURIComponent(n)}`;
      let profile;
      try {
        profile = await http.fetch(profileUrl, { headers, minIntervalMs: 550 });
      } catch (err) {
        if (err.status === 404) { results.push({ companyNumber: n, status: 'not-found' }); continue; }
        throw err;
      }
      const profileSnapshotId = store.writeRaw(SOURCES.chProfile, `${n}.json`, profile.body, { url: profileUrl, kind: 'ch-profile', companyNumber: n }).id;

      const insUrl = `${CH_API}/company/${encodeURIComponent(n)}/insolvency`;
      let insolvencySnapshotId = null;
      try {
        const ins = await http.fetch(insUrl, { headers, minIntervalMs: 550 });
        insolvencySnapshotId = store.writeRaw(SOURCES.chInsolvency, `${n}.json`, ins.body, { url: insUrl, kind: 'ch-insolvency', companyNumber: n }).id;
      } catch (err) {
        if (err.status !== 404) throw err; // 404: no insolvency history
      }
      results.push({ companyNumber: n, status: 'ok', profileSnapshotId, insolvencySnapshotId });
    } catch (err) {
      results.push({ companyNumber: n, status: 'failed', error: err.message });
      log?.warn(`Companies House ${n}: ${err.message}`);
    }
  }
  return results;
}

/* ============================================================ CSV feeds */

export async function harvestCsvFeeds(feeds, { store, baseDir = BOT_DIR }) {
  const fetched = [];
  const failures = [];
  for (const feed of feeds) {
    try {
      let body;
      let origin;
      if (feed.path) {
        const abs = path.isAbsolute(feed.path) ? feed.path : path.join(baseDir, feed.path);
        body = await readFile(abs);
        origin = `file:${path.basename(abs)}`;
      } else if (feed.url) {
        if (!(await http.allowedByRobots(feed.url))) throw new SourceConfigError(`robots.txt disallows ${new URL(feed.url).origin}`);
        const res = await http.fetch(feed.url, { headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.5' }, minIntervalMs: 1000 });
        body = res.body;
        origin = res.url;
      } else {
        throw new SourceConfigError(`csv feed "${feed.name}" needs "path" or "url"`);
      }
      fetched.push({ feed: feed.name, snapshotId: store.writeRaw(SOURCES.csv(feed.name), `${feed.name}.csv`, body, { kind: 'csv', feed: feed.name, origin }).id });
    } catch (err) {
      failures.push({ source: `csv:${feed.name}`, error: err.message });
    }
  }
  return { fetched, failures };
}