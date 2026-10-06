/**
 * Harvest: fetch OCDS releases for a time window from each source adapter, store
 * them, and advance that adapter's watermark only once the whole window is in.
 *
 * An adapter is { source, stages, searchUrl({ stage, from, to }), classify(release, stage) }.
 * classify says what a release is: 'tender' (-> notices), 'award' (-> awards) or null
 * (raw only, e.g. planning). Paging, window splitting and rate-limit handling are shared.
 */
import { http } from '@botarmy/core';
import { extractAwards, normaliseTender } from './normalise.js';
import { getWatermark, insertRelease, setWatermark, upsertAward, upsertNotice } from './db.js';

export const DEFAULT_LOOKBACK_DAYS = 7;
export const OVERLAP_HOURS = 1;
const MAX_PAGES = 1000; // a safety stop, far above a normal day (CF ~2 pages, FTS ~5)
export const PAGE_SIZE = 100; // both APIs return at most 100 releases a page
const MIN_SPLIT_MS = 60_000; // stop splitting below one minute

export function userAgent(env = process.env) {
  const contact = env.BOTARMY_CONTACT?.trim();
  return `bot-army-tender-scout/1.0${contact ? ` (+${contact})` : ''}`;
}

/** 2026-10-01T12:34:56.789Z -> 2026-10-01T12:34:56Z (the APIs' datetime format). */
export const apiTime = (iso) => `${iso.slice(0, 19)}Z`;

/* ------------------------------------------------------------- paging */

/**
 * One page as JSON. Spacing between requests is core.http's shared host policy.
 * Also waits out Contracts Finder's plain-text "Rate limit of 12 exceeded" reply (seen live).
 */
async function getPage(url, httpOptions = {}, log) {
  const opts = {
    headers: { Accept: 'application/json' },
    userAgent: userAgent(),
    timeoutMs: 90_000,
    retries: 4, // 429/5xx/network errors, exponential backoff (core.http)
    rateLimitWaitMs: 125_000,
    ...httpOptions,
  };
  for (let attempt = 0; ; attempt++) {
    let text;
    try {
      text = (await http.fetch(url, opts)).text();
    } catch (err) {
      if (!/rate limit/i.test(err.message) || attempt >= 2) throw err;
      text = err.message;
    }
    if (/^\s*[{[]/.test(text)) return JSON.parse(text);
    if (!/rate limit/i.test(text) || attempt >= 2) throw new Error(`${new URL(url).host} returned non-JSON: ${text.slice(0, 120)}`);
    log?.warn?.(`Rate limit hit on ${new URL(url).host}; waiting ${Math.round(opts.rateLimitWaitMs / 1000)}s`);
    await http.penalizeHost(new URL(url).host, opts.rateLimitWaitMs); // other bots back off too
    await new Promise((r) => setTimeout(r, opts.rateLimitWaitMs));
  }
}

/**
 * Every release in the window, following links.next. Contracts Finder sometimes returns a
 * full page (100) with NO links.next although more exist (seen live: 5 Oct awards = 119,
 * whole-day query gave 100). So a full page without a next link means "split the window in
 * half and fetch both halves" (done for every adapter; harmless when the API behaves).
 * @returns {Promise<object[]>}
 */
export async function fetchReleases(adapter, { stage, from, to, log, httpOptions }) {
  const seen = new Set();
  const releases = [];
  let url = adapter.searchUrl({ stage, from, to });
  for (let pages = 0; url; pages++) {
    if (seen.has(url)) throw new Error(`${adapter.source} returned the same next link twice (page ${pages + 1}); stopping`);
    if (pages >= MAX_PAGES) throw new Error(`More than ${MAX_PAGES} pages for ${adapter.source} ${stage} ${from}..${to}; stopping`);
    seen.add(url);
    const body = await getPage(url, httpOptions, log);
    if (!Array.isArray(body?.releases)) throw new Error(`${adapter.source} page ${pages + 1} has no releases array`);
    releases.push(...body.releases);
    log?.debug?.(`${adapter.source} ${stage} ${from}..${to} page ${pages + 1}: ${body.releases.length} releases`);
    url = body.links?.next ?? null;
    if (!url && body.releases.length >= PAGE_SIZE) {
      const span = Date.parse(to) - Date.parse(from);
      if (span <= MIN_SPLIT_MS) {
        log?.warn?.(`${adapter.source} ${stage} ${from}..${to}: full page and no next link, window too small to split; some releases may be missing`);
        break;
      }
      const mid = new Date(Date.parse(from) + Math.floor(span / 2 / 1000) * 1000).toISOString();
      log?.info?.(`${adapter.source} ${stage} ${from}..${to}: full page without a next link; splitting at ${mid}`);
      // The halves replace this window's results; dedupe on release id handles the shared boundary.
      return [
        ...await fetchReleases(adapter, { stage, from, to: mid, log, httpOptions }),
        ...await fetchReleases(adapter, { stage, from: mid, to, log, httpOptions }),
      ];
    }
  }
  return releases;
}

/* ---------------------------------------------------- Contracts Finder */

/**
 * Contracts Finder OCDS search. Verified against the live API (2026-10-06):
 * - the response is an OCDS release package; there is no hitsCount/maxPage
 * - `page` and `size` are ignored; pages are 100 releases, chained by links.next (a cursor URL)
 * - links.next is sometimes missing although more releases exist (handled by splitting the window)
 * - results come newest first whatever `order` says
 * - over ~12 requests in a short time it answers "Rate limit of 12 exceeded. Please retry after 120 seconds."
 */
export const contractsFinder = {
  source: 'contracts-finder',
  stages: ['tender', 'award'],
  baseUrl: 'https://www.contractsfinder.service.gov.uk',

  searchUrl({ stage, from, to }) {
    const q = new URLSearchParams({ publishedFrom: apiTime(from), publishedTo: apiTime(to), stages: stage, limit: '100' });
    return `${this.baseUrl}/Published/Notices/OCDS/Search?${q}`;
  },

  /** The stage asked for is what the release is (tender stage also returns tenderAmendment). */
  classify: (_release, stage) => stage,
};

/* ------------------------------------------------------- Find a Tender */

const FTS_TENDER_TAGS = new Set(['tender', 'tenderUpdate', 'tenderAmendment', 'tenderCancellation']);

/**
 * Find a Tender OCDS release packages. Verified against the live API (2026-10-06):
 * - filters by UPDATE time (updatedFrom/updatedTo); "...Z" datetimes accepted
 * - pages of 100 chained by links.next (cursor); a full day (452 releases) paged cleanly
 * - the `stages` filter returned far fewer tenders than the unfiltered feed, so we fetch
 *   everything and sort by tag: tender*, award/contract*, planning* (raw only)
 */
export const findATender = {
  source: 'find-a-tender',
  stages: ['all'],
  baseUrl: 'https://www.find-tender.service.gov.uk',

  searchUrl({ from, to }) {
    const q = new URLSearchParams({ updatedFrom: apiTime(from), updatedTo: apiTime(to), limit: '100' });
    return `${this.baseUrl}/api/1.0/ocdsReleasePackages?${q}`;
  },

  classify(release) {
    const tags = release?.tag ?? [];
    if (tags.some((t) => FTS_TENDER_TAGS.has(t))) return 'tender';
    if (release?.awards?.length) return 'award'; // award, awardUpdate, contract*, contractAmendment, contractTermination
    return null; // planning, planningUpdate, contract-only changes without awards
  },
};

export const ADAPTERS = Object.freeze({ [contractsFinder.source]: contractsFinder, [findATender.source]: findATender });

/* ----------------------------------------------------------- windowing */

/**
 * The window to fetch for one adapter stage.
 * - --since given: from that date (00:00 UTC)
 * - else a watermark: from 1 hour before it (overlap; dedupe makes it safe)
 * - else: the last 7 days
 */
export function windowFor(db, source, stage, { since, now }) {
  const nowMs = Date.parse(now);
  let from;
  if (since) from = new Date(`${since}T00:00:00Z`).toISOString();
  else {
    const mark = getWatermark(db, source, stage);
    from = mark
      ? new Date(Date.parse(mark) - OVERLAP_HOURS * 3_600_000).toISOString()
      : new Date(nowMs - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
  }
  return { from, to: new Date(nowMs).toISOString() };
}

/* ------------------------------------------------------------- storing */

/**
 * Store one fetched window. Every release is kept raw; tender-kind ones update notices
 * (latest release per ocid), award-kind ones update awards (per ocid + award + supplier).
 * Idempotent: re-running with the same releases changes no row counts.
 */
export function ingest(db, adapter, stage, releases, now) {
  const counts = { fetched: releases.length, newReleases: 0, notices: 0, awards: 0, other: 0 };
  db.transaction(() => {
    for (const release of releases) {
      if (!release?.ocid || !release?.id) continue;
      const kind = adapter.classify(release, stage);
      if (insertRelease(db, { source: adapter.source, stage: kind ?? 'other', release }, now)) counts.newReleases++;
      if (kind === 'tender') {
        const n = normaliseTender(release, { source: adapter.source });
        if (n) { upsertNotice(db, n, now); counts.notices++; }
      } else if (kind === 'award') {
        for (const a of extractAwards(release, { source: adapter.source })) { upsertAward(db, a, now); counts.awards++; }
      } else counts.other++;
    }
  })();
  return counts;
}

/**
 * Fetch and store each adapter's stages. A watermark moves to the window's end only after
 * all its pages are fetched and stored; a failure leaves it untouched.
 * `stages` (tender, award) applies to Contracts Finder; Find a Tender always fetches everything
 * in one window, because its stage filter is unreliable.
 * @returns {Promise<Record<string, Record<string, object>>>} counts by source, then stage
 */
export async function runHarvest(db, { adapters = Object.values(ADAPTERS), stages, since, now, log, httpOptions } = {}) {
  const result = {};
  for (const adapter of adapters) {
    const wanted = adapter.stages.includes('all') ? adapter.stages : adapter.stages.filter((s) => !stages || stages.includes(s));
    result[adapter.source] = {};
    for (const stage of wanted) {
      const { from, to } = windowFor(db, adapter.source, stage, { since, now });
      log?.info?.(`Harvesting ${adapter.source} ${stage}`, { from, to });
      const releases = await fetchReleases(adapter, { stage, from, to, log, httpOptions });
      const counts = ingest(db, adapter, stage, releases, now);
      setWatermark(db, adapter.source, stage, to, now);
      log?.info?.(`Stored ${adapter.source} ${stage}`, counts);
      result[adapter.source][stage] = { from, to, ...counts };
    }
  }
  return result;
}
