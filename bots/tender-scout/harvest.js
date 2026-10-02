/**
 * B3 harvester: network → core.snapshot only. Nothing is interpreted beyond
 * what pagination needs.
 *
 *   Contracts Finder  OCDS search API, keyless       publishedFrom/publishedTo window, links.next paging
 *   Find a Tender     OCDS release packages, keyless updatedFrom/updatedTo window, links.next paging;
 *                     honours 429 Retry-After (small request allowance)
 *   TED v3            POST /v3/notices/search, keyless, 250 per page; filtered at query time by
 *                     notice type and, if configured, buyer country and CPV (TED volume is large)
 *
 * Each source returns the snapshots it stored and the cursor to use next time.
 * The cursor is committed by index.js only after the snapshots were processed.
 */
import { http } from '@botarmy/core';

export const SOURCES = Object.freeze({
  contractsFinder: 'uk-contracts-finder-tenders',
  findATender: 'uk-find-a-tender-tenders',
  ted: 'eu-ted-tenders',
});
export const SOURCE_IDS = Object.freeze(Object.keys(SOURCES));

const CF_SEARCH = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const FTS_PACKAGES = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const TED_SEARCH = 'https://api.ted.europa.eu/v3/notices/search';
const TED_PAGE_SIZE = 250;

/**
 * TED field names. Only "notice-title", "buyer-name", "publication-number" and
 * "publication-date" were confirmed in TED documentation; the others are
 * configurable because their exact names were not verified against the live API.
 * A null field is simply not requested, and its value is treated as unknown.
 */
export const TED_FIELD_DEFAULTS = Object.freeze({
  cpvField: 'classification-cpv',
  countryField: 'buyer-country',
  deadlineField: null,
  valueField: null,
  currencyField: null,
});

const DAY_MS = 86_400_000;
const isoNoMs = (d) => new Date(d).toISOString().slice(0, 19);

/** Window start: the cursor minus a one-hour overlap (duplicates are ignored on insert), else the lookback. */
export function windowFrom(cursor, now, lookbackDays) {
  const c = Date.parse(cursor ?? '');
  return Number.isFinite(c) ? new Date(c - 3_600_000) : new Date(Date.parse(now) - lookbackDays * DAY_MS);
}

const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

async function ocdsPages({ store, sourceId, firstUrl, maxPages }) {
  const snapshotIds = [];
  let url = firstUrl;
  let notices = 0;
  while (url && snapshotIds.length < maxPages) {
    const res = await http.fetch(url, { headers: { Accept: 'application/json' }, minIntervalMs: 500, maxRetryAfterMs: 150_000 });
    snapshotIds.push(store.writeRaw(SOURCES[sourceId], `page-${snapshotIds.length + 1}.json`, res.body,
      { url: res.url, contentType: res.contentType, sourceId, format: 'ocds' }).id);
    const body = parseJson(res.body);
    notices += Array.isArray(body?.releases) ? body.releases.length : 0;
    url = body?.links?.next ?? null;
  }
  return { snapshotIds, notices, truncated: Boolean(url) };
}

/* ------------------------------------------------- request builders */
/* Exported so tests (and fixture recording) build byte-identical requests. */

export function contractsFinderUrl(cfg, cursor, now) {
  const qs = new URLSearchParams({ publishedFrom: isoNoMs(windowFrom(cursor, now, cfg.lookbackDays ?? 2)), publishedTo: isoNoMs(now), limit: '100' });
  return `${CF_SEARCH}?${qs}`;
}

export function findATenderUrl(cfg, cursor, now) {
  const qs = new URLSearchParams({ updatedFrom: isoNoMs(windowFrom(cursor, now, cfg.lookbackDays ?? 2)), updatedTo: isoNoMs(now) });
  return `${FTS_PACKAGES}?${qs}`;
}

/** TED search request for one page: query filtered by notice type and, if configured, country and CPV. */
export function tedRequest(cfg, cursor, now, page = 1) {
  const fieldsCfg = { ...TED_FIELD_DEFAULTS, ...pickDefined(cfg, Object.keys(TED_FIELD_DEFAULTS)) };
  const from = windowFrom(cursor, now, cfg.lookbackDays ?? 2).toISOString().slice(0, 10).replaceAll('-', '');
  const types = cfg.noticeTypes ?? ['cn-standard', 'cn-social'];
  const clauses = [`notice-type IN (${types.join(' ')})`, `publication-date>=${from}`];
  if (cfg.buyerCountries?.length && fieldsCfg.countryField) clauses.push(`${fieldsCfg.countryField} IN (${cfg.buyerCountries.join(' ')})`);
  if (cfg.cpvPrefixes?.length && fieldsCfg.cpvField) clauses.push(`${fieldsCfg.cpvField} IN (${cfg.cpvPrefixes.map((c) => `${c}*`).join(' ')})`);
  const fields = [...new Set(['publication-number', 'publication-date', 'notice-title', 'buyer-name',
    ...Object.values(fieldsCfg).filter(Boolean), ...(cfg.extraFields ?? [])])];
  const query = clauses.join(' AND ');
  return { url: TED_SEARCH, query, fieldsCfg, body: JSON.stringify({ query, fields, page, limit: TED_PAGE_SIZE, scope: 'ALL', paginationMode: 'PAGE_NUMBER' }) };
}

const HARVESTERS = {
  async contractsFinder({ store, cfg, cursor, now }) {
    return ocdsPages({ store, sourceId: 'contractsFinder', firstUrl: contractsFinderUrl(cfg, cursor, now), maxPages: cfg.maxPages ?? 30 });
  },

  async findATender({ store, cfg, cursor, now }) {
    return ocdsPages({ store, sourceId: 'findATender', firstUrl: findATenderUrl(cfg, cursor, now), maxPages: cfg.maxPages ?? 20 });
  },

  async ted({ store, cfg, cursor, now }) {
    const snapshotIds = [];
    let notices = 0;
    const maxPages = cfg.maxPages ?? 20;
    for (let page = 1; page <= maxPages; page++) {
      const req = tedRequest(cfg, cursor, now, page);
      const res = await http.fetch(TED_SEARCH, { method: 'POST', body: req.body, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, minIntervalMs: 500 });
      snapshotIds.push(store.writeRaw(SOURCES.ted, `page-${page}.json`, res.body,
        { url: res.url, contentType: res.contentType, sourceId: 'ted', format: 'ted', query: req.query, ...req.fieldsCfg }).id);
      const count = parseJson(res.body)?.notices?.length ?? 0;
      notices += count;
      if (count < TED_PAGE_SIZE) return { snapshotIds, notices, truncated: false };
    }
    return { snapshotIds, notices, truncated: true };
  },
};

function pickDefined(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

/**
 * Harvest every enabled source. One failing source never stops the others.
 * @returns {Promise<{ fetches: { sourceId, snapshotIds, notices, truncated, nextCursor }[], failures: { sourceId, error }[] }>}
 */
export async function harvestAll({ sources = {}, store, getCursor, now, log }) {
  const fetches = [];
  const failures = [];
  for (const sourceId of SOURCE_IDS) {
    const cfg = { lookbackDays: 2, ...(sources[sourceId] ?? {}) };
    if (cfg.enabled === false) continue;
    const cursor = getCursor(sourceId);
    try {
      const r = await HARVESTERS[sourceId]({ store, cfg, cursor, now });
      // A truncated window keeps the old cursor so the remainder is fetched next run.
      fetches.push({ sourceId, ...r, nextCursor: r.truncated ? cursor : now });
      log?.info(`${sourceId}: ${r.notices} notices in ${r.snapshotIds.length} snapshot(s)${r.truncated ? ' (page limit reached)' : ''}`);
    } catch (err) {
      failures.push({ sourceId, error: err.message });
      log?.error(`${sourceId}: ${err.message}`);
    }
  }
  return { fetches, failures };
}