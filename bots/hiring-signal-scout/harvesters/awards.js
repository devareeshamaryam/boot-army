/**
 * Contract-award harvesters. Each returns normalised awards; matching them to
 * watchlist companies happens in index.js.
 *
 * Normalised award:
 *   { source, noticeId, title, buyer, value, currency, awardDate, publishedAt, url,
 *     confidence: 'awarded'|'tenderer', suppliers: [{ name, identifiers: [{ scheme, id }] }] }
 */
import {
  getJson, postJson, getText, isAllowedByRobots, parseCsv, toIsoDate, pick, SourceConfigError,
} from './http.js';

const CF_SEARCH = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const FTS_PACKAGES = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const TED_SEARCH = 'https://api.ted.europa.eu/v3/notices/search';
const GEBIZ_SEARCH = 'https://data.gov.sg/api/action/datastore_search';
const GEBIZ_RESOURCE = 'd_acde1106003906a75c3fa052592f2fcb';

const AWARD_TAGS = new Set(['award', 'awardUpdate', 'contract', 'contractUpdate']);
const DEAD_AWARD = /cancel|unsuccessful|withdrawn/i;

const DAY_MS = 86_400_000;

/** Number or null. Number(null) and Number('') are 0, which would invent a value. */
const toNumber = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isoNoMs = (d) => new Date(d).toISOString().slice(0, 19);

/* ------------------------------------------------------------------ OCDS */

/**
 * Flatten an OCDS release package into award records. Filtering is on the
 * release tag rather than the APIs' "stages" parameter, which has been
 * reported to drop Procurement Act 2023 notices on Find a Tender.
 */
export function parseOcdsPackage(pkg, { source, noticeUrl }) {
  const out = [];
  for (const release of pkg?.releases ?? []) {
    const tags = Array.isArray(release.tag) ? release.tag : [release.tag];
    if (!tags.some((t) => AWARD_TAGS.has(t)) && !(release.awards ?? []).length) continue;

    const parties = new Map((release.parties ?? []).map((p) => [p.id, p]));
    for (const award of release.awards ?? []) {
      if (DEAD_AWARD.test(award.status ?? '')) continue;
      const suppliers = (award.suppliers ?? []).map((s) => {
        const party = parties.get(s.id) ?? {};
        const identifiers = [party.identifier, ...(party.additionalIdentifiers ?? [])]
          .filter(Boolean)
          .map((i) => ({ scheme: i.scheme, id: i.id }));
        return { name: s.name ?? party.name ?? '', identifiers };
      }).filter((s) => s.name);
      if (!suppliers.length) continue;

      out.push({
        source,
        noticeId: `${release.id}#${award.id ?? '0'}`,
        title: award.title ?? release.tender?.title ?? null,
        buyer: release.buyer?.name ?? null,
        value: toNumber(award.value?.amount),
        currency: award.value?.currency ?? null,
        awardDate: toIsoDate(award.date ?? award.datePublished ?? release.date),
        publishedAt: release.date ?? null,
        url: noticeUrl(release),
        confidence: 'awarded',
        suppliers,
      });
    }
  }
  return out;
}

async function harvestOcds({ source, firstUrl, noticeUrl, maxPages, log }) {
  const awards = [];
  let url = firstUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    const pkg = await getJson(url);
    awards.push(...parseOcdsPackage(pkg, { source, noticeUrl }));
    url = pkg?.links?.next ?? null;
    pages += 1;
  }
  if (url) log.warn(`${source}: stopped after ${maxPages} pages; the rest will be picked up next run`);
  return { awards, truncated: Boolean(url) };
}

const windowFrom = (cursor, now, lookbackDays) =>
  cursor ? new Date(Date.parse(cursor) - 3_600_000) : new Date(Date.parse(now) - lookbackDays * DAY_MS);

export const contractsFinder = {
  source: 'contractsFinder',
  async harvest({ cursor, now, lookbackDays, options = {}, log }) {
    const from = windowFrom(cursor, now, lookbackDays);
    const qs = new URLSearchParams({ publishedFrom: isoNoMs(from), publishedTo: isoNoMs(now), limit: '100' });
    const result = await harvestOcds({
      source: this.source,
      firstUrl: `${CF_SEARCH}?${qs}`,
      maxPages: options.maxPages ?? 30,
      log,
      noticeUrl: (r) => {
        const guid = String(r.id ?? '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
        return guid ? `https://www.contractsfinder.service.gov.uk/Notice/${guid}` : null;
      },
    });
    return { ...result, nextCursor: result.truncated ? cursor : now };
  },
};

export const findATender = {
  source: 'findATender',
  async harvest({ cursor, now, lookbackDays, options = {}, log }) {
    const from = windowFrom(cursor, now, lookbackDays);
    const qs = new URLSearchParams({ updatedFrom: isoNoMs(from), updatedTo: isoNoMs(now) });
    const result = await harvestOcds({
      source: this.source,
      firstUrl: `${FTS_PACKAGES}?${qs}`,
      maxPages: options.maxPages ?? 20,
      log,
      noticeUrl: (r) => (/^\d{6}-\d{4}$/.test(r.id ?? '') ? `https://www.find-tender.service.gov.uk/Notice/${r.id}` : null),
    });
    return { ...result, nextCursor: result.truncated ? cursor : now };
  },
};

/* ------------------------------------------------------------------- TED */

const LANG_PREF = ['eng', 'ENG', 'en'];

function firstText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(firstText).find(Boolean) ?? null;
  if (typeof value === 'object') {
    const key = LANG_PREF.find((k) => k in value) ?? Object.keys(value)[0];
    return key ? firstText(value[key]) : null;
  }
  return null;
}

function allTexts(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allTexts);
  if (typeof value === 'object') {
    const key = LANG_PREF.find((k) => k in value) ?? Object.keys(value)[0];
    return key ? allTexts(value[key]) : [];
  }
  return [];
}

const tedDate = (d) => new Date(d).toISOString().slice(0, 10).replaceAll('-', '');

export const ted = {
  source: 'ted',
  /**
   * options: { noticeTypes?, buyerCountries? (ISO-3), cpvPrefixes?, extraFields?, maxPages? }
   * "organisation-name-tenderer" lists tenderers on the award notice. It is
   * usually the winners but can include other bidders, so these awards are
   * stored with confidence "tenderer" and drafted with softer wording.
   */
  async harvest({ cursor, now, lookbackDays, options = {}, log }) {
    const from = windowFrom(cursor, now, lookbackDays);
    const types = options.noticeTypes ?? ['can-standard', 'can-social', 'can-desg'];
    const clauses = [`notice-type IN (${types.join(' ')})`, `publication-date>=${tedDate(from)}`];
    if (options.buyerCountries?.length) clauses.push(`buyer-country IN (${options.buyerCountries.join(' ')})`);
    if (options.cpvPrefixes?.length) clauses.push(`classification-cpv IN (${options.cpvPrefixes.map((c) => `${c}*`).join(' ')})`);

    const fields = [
      'publication-number', 'publication-date', 'notice-title', 'notice-type', 'buyer-name',
      'organisation-name-tenderer', 'organisation-identifier-tenderer', ...(options.extraFields ?? []),
    ];
    const limit = 250;
    const maxPages = options.maxPages ?? 20;
    const awards = [];
    let page = 1;
    let truncated = false;

    for (;;) {
      const body = await postJson(TED_SEARCH, {
        query: clauses.join(' AND '), fields, page, limit, scope: 'ALL', paginationMode: 'PAGE_NUMBER',
      });
      const notices = body?.notices ?? [];
      for (const n of notices) {
        const pubNo = firstText(n['publication-number']);
        const names = [...new Set(allTexts(n['organisation-name-tenderer']).map((s) => s.trim()).filter(Boolean))];
        if (!pubNo || !names.length) continue;
        awards.push({
          source: this.source,
          noticeId: pubNo,
          title: firstText(n['notice-title']),
          buyer: firstText(n['buyer-name']),
          value: toNumber(firstText(n['total-value'])),
          currency: firstText(n['total-value-cur']),
          awardDate: toIsoDate(firstText(n['publication-date'])),
          publishedAt: firstText(n['publication-date']),
          url: `https://ted.europa.eu/en/notice/-/detail/${pubNo}`,
          confidence: 'tenderer',
          suppliers: names.map((name) => ({ name, identifiers: [] })),
        });
      }
      if (notices.length < limit) break;
      if (page >= maxPages) { truncated = true; break; }
      page += 1;
    }
    if (truncated) log.warn(`ted: stopped after ${maxPages} pages; narrow with buyerCountries or cpvPrefixes`);
    return { awards, truncated, nextCursor: truncated ? cursor : now };
  },
};

/* ----------------------------------------------------------------- GeBIZ */

export const gebiz = {
  source: 'gebiz',
  /**
   * data.gov.sg's GeBIZ award dataset is refreshed in batches (months apart),
   * not daily. The cursor stores the dataset's row count; the full dataset is
   * re-read only when it changes, and duplicates are dropped on insert.
   */
  async harvest({ cursor, options = {}, env }) {
    const pageSize = 1000;
    const headers = env.DATA_GOV_SG_API_KEY ? { 'x-api-key': env.DATA_GOV_SG_API_KEY } : {};
    const resource = options.resourceId ?? GEBIZ_RESOURCE;
    const fetchPage = (offset) =>
      getJson(`${GEBIZ_SEARCH}?${new URLSearchParams({ resource_id: resource, limit: String(pageSize), offset: String(offset) })}`, { headers });

    const first = await fetchPage(0);
    const total = Number(first?.result?.total ?? 0);
    const previous = cursor ? JSON.parse(cursor).total : null;
    if (previous === total) return { awards: [], truncated: false, nextCursor: cursor };

    const records = [...(first?.result?.records ?? [])];
    for (let offset = pageSize; offset < total; offset += pageSize) {
      records.push(...((await fetchPage(offset))?.result?.records ?? []));
    }

    const awards = records
      .filter((r) => /award/i.test(String(pick(r, ['tender_detail_status', 'Tender Detail Status']) ?? '')))
      .map((r) => {
        const supplier = String(pick(r, ['supplier_name', 'Supplier Name']) ?? '').trim();
        const tenderNo = String(pick(r, ['tender_no', 'Tender No']) ?? '').trim();
        return {
          source: 'gebiz',
          noticeId: `${tenderNo}|${supplier}`,
          title: pick(r, ['tender_description', 'Tender Description']),
          buyer: pick(r, ['agency', 'Agency']),
          value: toNumber(pick(r, ['awarded_amt', 'awarded_amount', 'Awarded Amt'])),
          currency: 'SGD',
          awardDate: toIsoDate(pick(r, ['award_date', 'Award Date'])),
          publishedAt: null,
          url: null,
          confidence: 'awarded',
          suppliers: supplier ? [{ name: supplier, identifiers: [] }] : [],
        };
      })
      .filter((a) => a.suppliers.length && a.noticeId !== '|');

    return { awards, truncated: false, nextCursor: JSON.stringify({ total }) };
  },
};

/* -------------------------------------------------------------------- HK */

/**
 * Hong Kong has no consolidated award API: departments publish their own
 * "tenders awarded" CSV/JSON datasets on data.gov.hk. Configure each one:
 *   { "name": "hyd", "url": "https://...csv", "format": "csv",
 *     "fields": { "noticeId": [...], "title": [...], "buyer": [...], "supplier": [...], "value": [...], "awardDate": [...] },
 *     "buyerName": "Highways Department" }
 */
const HK_DEFAULT_FIELDS = {
  noticeId: ['Tender Reference', 'Tender Ref. No.', 'Contract No.', 'Tender No.', 'Reference No.'],
  title: ['Subject', 'Description', 'Tender Title', 'Contract Title', 'Title'],
  buyer: ['Department', 'Procuring Department', 'Bureau/Department'],
  supplier: ['Contractor', 'Successful Tenderer', 'Name of Contractor', 'Supplier', 'Awardee'],
  value: ['Contract Sum', 'Contract Value', 'Contract Amount', 'Award Value', 'Amount (HK$)'],
  awardDate: ['Date of Award', 'Award Date', 'Contract Award Date'],
};

export const hk = {
  source: 'hk',
  async harvest({ options = {}, log }) {
    const awards = [];
    for (const src of options.sources ?? []) {
      if (!src.url || !src.name) throw new SourceConfigError('hk: each source needs "name" and "url"');
      if (!(await isAllowedByRobots(src.url))) {
        log.warn(`hk:${src.name}: robots.txt disallows ${new URL(src.url).origin}; skipped`);
        continue;
      }
      const text = await getText(src.url);
      const rows = (src.format ?? (src.url.endsWith('.json') ? 'json' : 'csv')) === 'json' ? JSON.parse(text) : parseCsv(text);
      if (!Array.isArray(rows)) throw new Error(`hk:${src.name}: expected an array of rows`);
      const f = { ...HK_DEFAULT_FIELDS, ...src.fields };

      for (const row of rows) {
        const supplier = String(pick(row, f.supplier) ?? '').trim();
        const ref = String(pick(row, f.noticeId) ?? '').trim();
        if (!supplier || !ref) continue;
        const value = toNumber(pick(row, f.value));
        awards.push({
          source: `hk:${src.name}`,
          noticeId: `${ref}|${supplier}`,
          title: pick(row, f.title),
          buyer: pick(row, f.buyer) ?? src.buyerName ?? null,
          value: value && value > 0 ? value : null,
          currency: 'HKD',
          awardDate: toIsoDate(pick(row, f.awardDate)),
          publishedAt: null,
          url: src.pageUrl ?? null,
          confidence: 'awarded',
          suppliers: [{ name: supplier, identifiers: [] }],
        });
      }
    }
    return { awards, truncated: false, nextCursor: null };
  },
};

export const AWARD_SOURCES = Object.freeze({ contractsFinder, findATender, ted, gebiz, hk });