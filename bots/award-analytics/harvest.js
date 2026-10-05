/**
 * B6 harvester: award notices → core.snapshot. Network only; nothing here
 * interprets data beyond what pagination needs.
 *
 *   Contracts Finder  OCDS search, publishedFrom/publishedTo, links.next paging
 *   Find a Tender     OCDS release packages, updatedFrom/updatedTo, links.next paging;
 *                     small request allowance then 429 + Retry-After (honoured by core.http).
 *                     The "stages" parameter is not used: award releases are filtered locally.
 *   TED               Search API v3, award notice types, PAGE_NUMBER paging (250/page)
 *
 * Every call fetches one window [from, to). The daily run uses a cursor; the
 * backfill walks fixed windows planned in the database (see process.js).
 */
import { http } from '@botarmy/core';

export const SOURCES = Object.freeze({
  contractsFinder: 'aa-contracts-finder',
  findATender: 'aa-find-a-tender',
  ted: 'aa-ted',
});
export const SOURCE_IDS = Object.freeze(Object.keys(SOURCES));

export const CF_SEARCH = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
export const FTS_PACKAGES = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
export const TED_SEARCH = 'https://api.ted.europa.eu/v3/notices/search';
const TED_PAGE_SIZE = 250;

/** Field names requested from TED. Defaults follow TED's eForms names; override in awards.json if TED rejects one. */
export const TED_FIELD_DEFAULTS = Object.freeze({
  cpvField: 'classification-cpv',
  countryField: 'buyer-country',
  valueField: null,          // not requested by default: the eForms award-value field name is unconfirmed
  currencyField: null,
});

const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};
const isoNoMs = (d) => new Date(d).toISOString().slice(0, 19);
const tedDate = (d) => new Date(d).toISOString().slice(0, 10).replaceAll('-', '');

async function ocdsPages(sourceId, firstUrl, { store, maxPages, window, minIntervalMs }) {
  const snapshotIds = [];
  let url = firstUrl;
  let items = 0;
  while (url && snapshotIds.length < maxPages) {
    const res = await http.fetch(url, { headers: { Accept: 'application/json' }, minIntervalMs });
    snapshotIds.push(store.writeRaw(SOURCES[sourceId], `${window.from.slice(0, 10)}_p${snapshotIds.length + 1}.json`, res.body,
      { url: res.url, contentType: res.contentType, sourceId, format: 'ocds', window }).id);
    const body = parseJson(res.body);
    items += Array.isArray(body?.releases) ? body.releases.length : 0;
    url = body?.links?.next ?? null;
  }
  return { snapshotIds, items, truncated: Boolean(url) };
}

/** TED request for a window; field names travel in the snapshot meta so parsing reads exactly what was asked for. */
export function tedRequest(cfg = {}, window, page) {
  const fieldsCfg = { ...TED_FIELD_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([k]) => k in TED_FIELD_DEFAULTS)) };
  const types = cfg.noticeTypes ?? ['can-standard', 'can-social', 'can-desg'];
  const clauses = [`notice-type IN (${types.join(' ')})`, `publication-date>=${tedDate(window.from)}`, `publication-date<${tedDate(window.to)}`];
  if (cfg.buyerCountries?.length) clauses.push(`buyer-country IN (${cfg.buyerCountries.join(' ')})`);
  const fields = ['publication-number', 'publication-date', 'notice-title', 'notice-type', 'buyer-name', 'organisation-name-tenderer',
    ...Object.values(fieldsCfg).filter(Boolean)];
  return {
    fieldsCfg,
    query: clauses.join(' AND '),
    body: JSON.stringify({ query: clauses.join(' AND '), fields: [...new Set(fields)], page, limit: TED_PAGE_SIZE, scope: 'ALL', paginationMode: 'PAGE_NUMBER' }),
  };
}

const HARVESTERS = {
  contractsFinder: ({ store, window, cfg }) => {
    const qs = new URLSearchParams({ publishedFrom: isoNoMs(window.from), publishedTo: isoNoMs(window.to), limit: '100' });
    return ocdsPages('contractsFinder', `${CF_SEARCH}?${qs}`, { store, window, maxPages: cfg.maxPages ?? 50, minIntervalMs: 500 });
  },
  findATender: ({ store, window, cfg }) => {
    const qs = new URLSearchParams({ updatedFrom: isoNoMs(window.from), updatedTo: isoNoMs(window.to) });
    return ocdsPages('findATender', `${FTS_PACKAGES}?${qs}`, { store, window, maxPages: cfg.maxPages ?? 50, minIntervalMs: 1000 });
  },
  async ted({ store, window, cfg }) {
    const snapshotIds = [];
    let items = 0;
    const maxPages = cfg.maxPages ?? 40;
    for (let page = 1; page <= maxPages; page++) {
      const req = tedRequest(cfg, window, page);
      const res = await http.fetch(TED_SEARCH, { method: 'POST', body: req.body, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, minIntervalMs: 500 });
      snapshotIds.push(store.writeRaw(SOURCES.ted, `${window.from.slice(0, 10)}_p${page}.json`, res.body,
        { url: res.url, contentType: res.contentType, sourceId: 'ted', format: 'ted', window, query: req.query, ...req.fieldsCfg }).id);
      const n = parseJson(res.body)?.notices?.length ?? 0;
      items += n;
      if (n < TED_PAGE_SIZE) return { snapshotIds, items, truncated: false };
    }
    return { snapshotIds, items, truncated: true };
  },
};

/**
 * Fetch one window from one source.
 * @param {string} sourceId  contractsFinder | findATender | ted
 * @param {{ from: string, to: string }} window  ISO timestamps
 * @returns {Promise<{ sourceId, window, snapshotIds: number[], items: number, truncated: boolean }>}
 */
export async function harvestWindow(sourceId, window, { store, cfg = {} }) {
  const harvester = HARVESTERS[sourceId];
  if (!harvester) throw new Error(`unknown source "${sourceId}"`);
  const r = await harvester({ store, window, cfg });
  return { sourceId, window, ...r };
}