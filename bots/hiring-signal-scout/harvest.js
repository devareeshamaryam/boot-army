/**
 * B5 harvester: network → core.snapshot only. Nothing here interprets data
 * beyond what pagination needs.
 *
 *   Awards    Contracts Finder + Find a Tender (OCDS, keyless), TED v3 search (keyless),
 *             GeBIZ on data.gov.sg, HK departmental datasets, Etimad and an MEA
 *             aggregator through endpoints you are authorised for.
 *   Boards    Greenhouse, Lever, Workable public board APIs. Workday only for
 *             companies with "optIn": true (undocumented API); others are
 *             reported as unsupported, never skipped silently.
 *   Feeds     Licensed LinkedIn / Indeed feeds you supply (no scraping of either).
 *   Funding   RSS/Atom feeds you list.
 *
 * Every snapshot's meta carries what process.js needs to parse it.
 */
import { http } from '@botarmy/core';

export const SOURCE = Object.freeze({
  contractsFinder: 'uk-contracts-finder',
  findATender: 'uk-find-a-tender',
  ted: 'eu-ted',
  gebiz: 'sg-gebiz',
  hk: 'hk-awards',
  etimad: 'sa-etimad',
  meaAggregator: 'mea-aggregator',
  board: (type) => `ats-${type}`,
  jobFeed: (id) => `jobfeed-${id}`,
  funding: 'funding-rss',
});

/** Sources whose first read is a full historical dataset: baseline, no alerts. */
export const FULL_DATASET_SOURCES = Object.freeze(['gebiz', 'hk', 'etimad', 'meaAggregator']);

export class SourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

const DAY_MS = 86_400_000;
const isoNoMs = (d) => new Date(d).toISOString().slice(0, 19);
/** Window start: cursor minus 1 h overlap (duplicates are ignored on insert), else lookback. */
const windowFrom = (cursor, now, lookbackDays) =>
  (cursor && Number.isFinite(Date.parse(cursor)) ? new Date(Date.parse(cursor) - 3_600_000) : new Date(Date.parse(now) - lookbackDays * DAY_MS));

const json = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

/* ================================================================= awards */

async function ocdsPages({ store, source, sourceId, firstUrl, maxPages, meta }) {
  const snapshotIds = [];
  let url = firstUrl;
  while (url && snapshotIds.length < maxPages) {
    const res = await http.fetch(url, { headers: { Accept: 'application/json' }, minIntervalMs: 500, maxRetryAfterMs: 150_000 });
    snapshotIds.push(store.writeRaw(source, `page-${snapshotIds.length + 1}.json`, res.body,
      { url: res.url, contentType: res.contentType, kind: 'awards', sourceId, format: 'ocds', ...meta }).id);
    url = json(res.body)?.links?.next ?? null;
  }
  return { snapshotIds, truncated: Boolean(url) };
}

const AWARD_HARVESTERS = {
  async contractsFinder({ store, cfg, cursor, now }) {
    const qs = new URLSearchParams({ publishedFrom: isoNoMs(windowFrom(cursor, now, cfg.lookbackDays)), publishedTo: isoNoMs(now), limit: '100' });
    const r = await ocdsPages({ store, source: SOURCE.contractsFinder, sourceId: 'contractsFinder', maxPages: cfg.maxPages ?? 30,
      firstUrl: `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?${qs}`, meta: { noticeBase: 'cf' } });
    return { ...r, nextCursor: r.truncated ? cursor : now };
  },

  async findATender({ store, cfg, cursor, now }) {
    const qs = new URLSearchParams({ updatedFrom: isoNoMs(windowFrom(cursor, now, cfg.lookbackDays)), updatedTo: isoNoMs(now) });
    const r = await ocdsPages({ store, source: SOURCE.findATender, sourceId: 'findATender', maxPages: cfg.maxPages ?? 20,
      firstUrl: `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?${qs}`, meta: { noticeBase: 'fts' } });
    return { ...r, nextCursor: r.truncated ? cursor : now };
  },

  /** TED tenderers are usually, not always, the winners: parsed with confidence "tenderer". */
  async ted({ store, cfg, cursor, now }) {
    const from = windowFrom(cursor, now, cfg.lookbackDays).toISOString().slice(0, 10).replaceAll('-', '');
    const clauses = [`notice-type IN (${(cfg.noticeTypes ?? ['can-standard', 'can-social']).join(' ')})`, `publication-date>=${from}`];
    if (cfg.buyerCountries?.length) clauses.push(`buyer-country IN (${cfg.buyerCountries.join(' ')})`);
    // "classification-cpv" is the expected TED field name but was not verified against the live API.
    // If TED rejects the query, set sources.ted.cpvField to the right name, or to null to omit it.
    const cpvField = cfg.cpvField === undefined ? 'classification-cpv' : cfg.cpvField;
    const fields = ['publication-number', 'publication-date', 'notice-title', 'notice-type', 'buyer-name',
      'organisation-name-tenderer', ...(cpvField ? [cpvField] : []), ...(cfg.extraFields ?? [])];
    const snapshotIds = [];
    const maxPages = cfg.maxPages ?? 20;
    for (let page = 1; page <= maxPages; page++) {
      const body = JSON.stringify({ query: clauses.join(' AND '), fields, page, limit: 250, scope: 'ALL', paginationMode: 'PAGE_NUMBER' });
      const res = await http.fetch('https://api.ted.europa.eu/v3/notices/search', {
        method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, minIntervalMs: 500,
      });
      snapshotIds.push(store.writeRaw(SOURCE.ted, `page-${page}.json`, res.body, { url: res.url, contentType: res.contentType, kind: 'awards', sourceId: 'ted', format: 'ted', cpvField }).id);
      if ((json(res.body)?.notices ?? []).length < 250) return { snapshotIds, truncated: false, nextCursor: now };
    }
    return { snapshotIds, truncated: true, nextCursor: cursor };
  },

  /** Refreshed in batches months apart: the full dataset is re-read only when its size changes. */
  async gebiz({ store, cfg, cursor, env }) {
    const resource = cfg.resourceId ?? 'd_acde1106003906a75c3fa052592f2fcb';
    const headers = { Accept: 'application/json', ...(env.DATA_GOV_SG_API_KEY ? { 'x-api-key': env.DATA_GOV_SG_API_KEY } : {}) };
    const url = (offset) => `https://data.gov.sg/api/action/datastore_search?${new URLSearchParams({ resource_id: resource, limit: '1000', offset: String(offset) })}`;
    const first = await http.fetch(url(0), { headers, minIntervalMs: 500 });
    const total = Number(json(first.body)?.result?.total);
    if (!Number.isFinite(total)) throw new Error('gebiz: response has no numeric result.total');
    let previous = null;
    try {
      previous = cursor ? JSON.parse(cursor).total : null;
    } catch {
      previous = null;
    }
    if (previous === total) return { snapshotIds: [], truncated: false, nextCursor: cursor, note: 'dataset unchanged' };
    const meta = { kind: 'awards', sourceId: 'gebiz', format: 'gebiz' };
    const snapshotIds = [store.writeRaw(SOURCE.gebiz, 'offset-0.json', first.body, { url: first.url, ...meta }).id];
    for (let off = 1000; off < total; off += 1000) {
      const res = await http.fetch(url(off), { headers, minIntervalMs: 500 });
      snapshotIds.push(store.writeRaw(SOURCE.gebiz, `offset-${off}.json`, res.body, { url: res.url, ...meta }).id);
    }
    return { snapshotIds, truncated: false, nextCursor: JSON.stringify({ total }) };
  },

  /** No consolidated HK feed: each department's "tenders awarded" dataset is configured. */
  async hk({ store, cfg, log }) {
    const snapshotIds = [];
    for (const ds of cfg.datasets ?? []) {
      if (!ds.name || !ds.url) throw new SourceConfigError('hk: each dataset needs "name" and "url"');
      if (!(await http.allowedByRobots(ds.url))) {
        log?.warn(`hk:${ds.name}: robots.txt disallows ${new URL(ds.url).origin}; skipped`);
        continue;
      }
      const res = await http.fetch(ds.url, { minIntervalMs: 1000 });
      snapshotIds.push(store.writeRaw(SOURCE.hk, ds.name, res.body, {
        url: res.url, contentType: res.contentType, kind: 'awards', sourceId: 'hk',
        format: ds.format ?? (ds.url.toLowerCase().endsWith('.json') ? 'json' : 'csv'),
        dataset: { name: ds.name, itemsPath: ds.itemsPath ?? null, fields: ds.fields ?? null, buyerName: ds.buyerName ?? null, pageUrl: ds.pageUrl ?? null },
      }).id);
    }
    return { snapshotIds, truncated: false, nextCursor: null };
  },

  etimad: ({ store, cfg, env }) => configuredEndpoint({ store, source: SOURCE.etimad, sourceId: 'etimad', kind: 'awards', def: { currency: 'SAR', ...cfg }, env }),
  meaAggregator: ({ store, cfg, env }) => configuredEndpoint({ store, source: SOURCE.meaAggregator, sourceId: 'meaAggregator', kind: 'awards', def: cfg, env }),
};

/**
 * Authenticated JSON/CSV endpoint (Etimad, MEA aggregator, licensed job feeds).
 * Secrets come from the env variable named in auth.env, never from the watchlist.
 */
async function configuredEndpoint({ store, source, sourceId, kind, def, env }) {
  if (!def?.url) throw new SourceConfigError(`${sourceId}: no "url" configured`);
  const headers = { Accept: def.format === 'csv' ? 'text/csv' : 'application/json', ...(def.headers ?? {}) };
  if (def.auth?.env) {
    const secret = env[def.auth.env]?.trim();
    if (!secret) throw new SourceConfigError(`${sourceId}: environment variable ${def.auth.env} is not set`);
    headers[def.auth.header ?? 'Authorization'] = def.auth.scheme ? `${def.auth.scheme} ${secret}` : secret;
  }
  const pages = def.pagination ? Math.max(1, Number(def.pagination.maxPages) || 5) : 1;
  const parseMeta = { kind, sourceId, format: def.format ?? 'json', itemsPath: def.itemsPath ?? null, fields: def.fields ?? null, currency: def.currency ?? null };
  const snapshotIds = [];
  for (let i = 0; i < pages; i++) {
    const u = new URL(def.url);
    if (def.pagination) u.searchParams.set(def.pagination.param ?? 'page', String((Number(def.pagination.start) || 1) + i));
    const res = await http.fetch(u.toString(), {
      method: def.method ?? 'GET', headers, body: def.body ? JSON.stringify(def.body) : undefined, minIntervalMs: 500,
    });
    snapshotIds.push(store.writeRaw(source, `page-${i + 1}`, res.body, { url: res.url, contentType: res.contentType, ...parseMeta }).id);
    if (def.pagination) {
      const body = json(res.body);
      const rows = parseMeta.itemsPath ? parseMeta.itemsPath.split('.').reduce((a, k) => (a == null ? a : a[k]), body) : body;
      if (!Array.isArray(rows) || rows.length === 0) break;
    }
  }
  return { snapshotIds, truncated: false, nextCursor: null };
}

/* ================================================================= boards */

const BOARD_URLS = {
  greenhouse: (a) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(a.token)}/jobs`,
  lever: (a) => `${a.region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co'}/v0/postings/${encodeURIComponent(a.slug)}?mode=json`,
  workable: (a) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(a.account)}`,
};
const WORKDAY_PAGE = 20; // Workday silently returns nothing above 20

async function harvestWorkday(company, store) {
  const a = company.ats;
  const endpoint = `https://${a.host}/wday/cxs/${encodeURIComponent(a.tenant)}/${encodeURIComponent(a.site)}/jobs`;
  if (!(await http.allowedByRobots(endpoint))) throw new SourceConfigError(`workday ${a.host}: robots.txt disallows the jobs endpoint`);
  const snapshotIds = [];
  let total = null;
  let seen = 0;
  const maxPages = Math.max(1, Number(a.maxPages) || 50);
  for (let page = 0; page < maxPages; page++) {
    const body = JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: '' });
    const res = await http.fetch(endpoint, {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'en-US' }, minIntervalMs: 300,
    });
    const parsed = json(res.body);
    if (page === 0) {
      const t = Number(parsed?.total);
      total = Number.isFinite(t) ? t : null; // only reliable on page 1
    }
    const n = Array.isArray(parsed?.jobPostings) ? parsed.jobPostings.length : 0;
    seen += n;
    snapshotIds.push(store.writeRaw(SOURCE.board('workday'), `${company.id}/page-${page + 1}.json`, res.body,
      { url: res.url, kind: 'board', companyId: company.id, atsType: 'workday', host: a.host, site: a.site }).id);
    if (n < WORKDAY_PAGE || (total !== null && seen >= total)) break;
  }
  return { snapshotIds, complete: total !== null && seen >= total };
}

/**
 * @returns {{ status: 'fetched'|'unsupported'|'none', snapshotIds?: number[], complete?: boolean, reason?: string }}
 */
async function harvestBoard(company, store) {
  const a = company.ats;
  if (!a) return { status: 'none' };
  if (a.type === 'workday') {
    if (a.optIn !== true) return { status: 'unsupported', reason: 'Workday career-site API is undocumented; set "optIn": true on this company to poll it' };
    return { status: 'fetched', ...(await harvestWorkday(company, store)) };
  }
  const url = BOARD_URLS[a.type]?.(a);
  if (!url) return { status: 'unsupported', reason: `ATS type "${a.type}" is not supported` };
  const res = await http.fetch(url, { headers: { Accept: 'application/json' }, minIntervalMs: 250 });
  const id = store.writeRaw(SOURCE.board(a.type), `${company.id}.json`, res.body, { url: res.url, kind: 'board', companyId: company.id, atsType: a.type }).id;
  return { status: 'fetched', snapshotIds: [id], complete: true };
}

/* ==================================================================== run */

/**
 * Fetch everything. One source failing never stops the others.
 * @param {object} watchlist  validated watchlist (process.validateWatchlist)
 * @param {{ store, getCursor(id): string|null, now: string, env?: object, log?: object }} ctx
 */
export async function harvestAll(watchlist, { store, getCursor, now, env = process.env, log }) {
  const out = { awards: [], boards: [], jobFeeds: [], funding: [], unsupported: [], failures: [], notes: [] };
  const fail = (source, err) => {
    out.failures.push({ source, error: err.message, config: err instanceof SourceConfigError });
    log?.error(`${source}: ${err.message}`);
  };

  for (const [id, harvestSource] of Object.entries(AWARD_HARVESTERS)) {
    const cfg = { lookbackDays: 3, ...(watchlist.sources[id] ?? {}) };
    if (cfg.enabled === false) continue;
    if (id === 'hk' && !cfg.datasets?.length) continue;
    if ((id === 'etimad' || id === 'meaAggregator') && !cfg.url) continue;
    try {
      const r = await harvestSource({ store, cfg, cursor: getCursor(id), now, env, log });
      out.awards.push({ sourceId: id, ...r });
      if (r.truncated) out.notes.push(`${id}: stopped at the page limit; the rest is collected next run`);
      if (r.note) out.notes.push(`${id}: ${r.note}`);
    } catch (err) {
      fail(id, err);
    }
  }

  for (const company of watchlist.companies) {
    try {
      const r = await harvestBoard(company, store);
      if (r.status === 'unsupported') out.unsupported.push({ companyId: company.id, name: company.name, atsType: company.ats.type, reason: r.reason });
      else if (r.status === 'fetched') out.boards.push({ companyId: company.id, atsType: company.ats.type, snapshotIds: r.snapshotIds, complete: r.complete });
    } catch (err) {
      fail(`${company.ats?.type}:${company.id}`, err);
    }
  }

  for (const [id, def] of Object.entries(watchlist.jobFeeds)) {
    if (!def || typeof def !== 'object' || def.enabled === false || !def.url) continue;
    try {
      out.jobFeeds.push({ feedId: id, ...(await configuredEndpoint({ store, source: SOURCE.jobFeed(id), sourceId: id, kind: 'jobFeed', def, env })) });
    } catch (err) {
      fail(`jobfeed:${id}`, err);
    }
  }

  for (const feed of watchlist.funding.feeds) {
    try {
      const res = await http.fetch(feed.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' }, minIntervalMs: 500 });
      out.funding.push({ feed: feed.name, snapshotId: store.writeRaw(SOURCE.funding, feed.name, res.body, { url: res.url, kind: 'funding', feedName: feed.name }).id });
    } catch (err) {
      fail(`funding:${feed.name}`, err);
    }
  }
  return out;
}