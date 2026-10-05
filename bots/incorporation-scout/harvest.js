/**
 * B7 harvester: Companies House → core.snapshot. Nothing here interprets data
 * beyond what paging and stream resumption need.
 *
 *   Advanced search (primary)  GET /advanced-search/companies?incorporated_from&incorporated_to
 *                              &sic_codes&size&start_index — REST API key (CH_API_KEY).
 *   Officers                   GET /company/{n}/officers — fetched only for matched companies.
 *   Streaming API (optional)   https://stream.companieshouse.gov.uk/companies?timepoint=N —
 *                              stream key (CH_STREAM_KEY). Newline-delimited JSON events.
 *
 * The stream is the one place this bot calls fetch directly: core.http buffers
 * whole responses and cannot read an endless stream. Sessions are bounded
 * (events / seconds), reconnect on a dropped connection, and resume from the
 * last timepoint seen (inclusive: re-reading one event is harmless because
 * companies are upserted by number; skipping one would lose it).
 */
import { http } from '@botarmy/core';

export const CH_API = 'https://api.company-information.service.gov.uk';
export const STREAM_URL = 'https://stream.companieshouse.gov.uk/companies';
export const SOURCES = Object.freeze({
  search: 'uk-ch-advanced-search',
  officers: 'uk-ch-officers',
  stream: 'uk-ch-stream-companies',
});

export class SourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const basic = (key) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

function apiHeaders(env) {
  const key = env.CH_API_KEY?.trim();
  if (!key) throw new SourceConfigError('Companies House: set CH_API_KEY in the root .env');
  return { Authorization: basic(key), Accept: 'application/json' };
}

/* ======================================================= advanced search */

export function searchUrl({ from, to }, { sicCodes = [], size = 100, startIndex = 0 } = {}) {
  const qs = new URLSearchParams({ incorporated_from: from, incorporated_to: to, size: String(size), start_index: String(startIndex) });
  if (sicCodes.length) qs.set('sic_codes', sicCodes.join(','));
  return `${CH_API}/advanced-search/companies?${qs}`;
}

/**
 * Every page of one incorporation-date window. `sicCodes` filters at query
 * time (5-digit codes only); pass [] to fetch all and filter locally.
 * @returns {Promise<{ snapshotIds: number[], items: number, hits: number|null, truncated: boolean }>}
 */
export async function harvestSearch({ store, window, sicCodes = [], cfg = {}, env = process.env }) {
  const headers = apiHeaders(env);
  const size = cfg.pageSize ?? 100;
  const maxPages = cfg.maxPages ?? 50;
  const snapshotIds = [];
  let items = 0;
  let hits = null;
  for (let page = 0; page < maxPages; page++) {
    const url = searchUrl(window, { sicCodes, size, startIndex: page * size });
    let res;
    try {
      res = await http.fetch(url, { headers, minIntervalMs: 550 });
    } catch (err) {
      if (err.status === 404 && page === 0) {
        // Companies House answers 404 when a search has no hits: an empty result, not a failure.
        snapshotIds.push(store.writeRaw(SOURCES.search, `${window.from}_${window.to}_p0.json`, '{"items":[],"hits":"0"}', { url, kind: 'search', window, emptyBy404: true }).id);
        return { snapshotIds, items: 0, hits: 0, truncated: false };
      }
      throw err;
    }
    snapshotIds.push(store.writeRaw(SOURCES.search, `${window.from}_${window.to}_p${page}.json`, res.body, { url, contentType: res.contentType, kind: 'search', window, page }).id);
    const body = parseJson(res.body);
    const n = Array.isArray(body?.items) ? body.items.length : 0;
    const h = Number.parseInt(String(body?.hits ?? ''), 10);
    if (page === 0 && Number.isFinite(h)) hits = h;
    items += n;
    if (n < size || (hits !== null && items >= hits)) return { snapshotIds, items, hits, truncated: false };
  }
  return { snapshotIds, items, hits, truncated: true };
}

/* ============================================================= officers */

/** @returns {Promise<{ companyNumber, status: 'fetched'|'not-found'|'failed', snapshotId?, error? }[]>} */
export async function harvestOfficers(companyNumbers, { store, env = process.env, log }) {
  const headers = apiHeaders(env);
  const out = [];
  for (const n of companyNumbers) {
    const url = `${CH_API}/company/${encodeURIComponent(n)}/officers?items_per_page=35`;
    try {
      const res = await http.fetch(url, { headers, minIntervalMs: 550 });
      out.push({ companyNumber: n, status: 'fetched', snapshotId: store.writeRaw(SOURCES.officers, `${n}.json`, res.body, { url, kind: 'officers', companyNumber: n }).id });
    } catch (err) {
      out.push({ companyNumber: n, status: err.status === 404 ? 'not-found' : 'failed', error: err.message });
      if (err.status !== 404) log?.warn(`Officers ${n}: ${err.message}`);
    }
  }
  return out;
}

/* =============================================================== stream */

/**
 * One bounded streaming session.
 * @param {object} o
 * @param {string|null} o.timepoint  resume point (inclusive); null starts at the live edge
 * @param {Function} [o.fetchImpl]   injectable for tests
 * @returns {Promise<{ snapshotIds, events, lastTimepoint, reconnects, endedBy: 'max-events'|'max-seconds'|'gave-up' }>}
 */
export async function streamSession({
  store, timepoint = null, env = process.env, fetchImpl = (...a) => globalThis.fetch(...a),
  maxEvents = 20000, maxSeconds = 300, maxReconnects = 5, chunkLines = 2000, log, userAgent = http.defaultUserAgent(),
  backoffMs = 1000, rateLimitWaitMs = 60_000,
}) {
  const key = env.CH_STREAM_KEY?.trim();
  if (!key) throw new SourceConfigError('Companies House streaming: set CH_STREAM_KEY in the root .env (a stream key, not the REST key)');
  const deadline = Date.now() + maxSeconds * 1000;
  const snapshotIds = [];
  let lastTimepoint = timepoint;
  let events = 0;
  let reconnects = 0;
  let chunk = [];
  let chunkFirst = null;

  const flush = () => {
    if (!chunk.length) return;
    const last = lastTimepoint;
    snapshotIds.push(store.writeRaw(SOURCES.stream, `tp-${chunkFirst}-${last}.ndjson`, `${chunk.join('\n')}\n`,
      { kind: 'stream', firstTimepoint: chunkFirst, lastTimepoint: last, contentType: 'application/x-ndjson' }).id);
    chunk = [];
    chunkFirst = null;
  };

  for (;;) {
    if (events >= maxEvents) { flush(); return { snapshotIds, events, lastTimepoint, reconnects, endedBy: 'max-events' }; }
    if (Date.now() >= deadline) { flush(); return { snapshotIds, events, lastTimepoint, reconnects, endedBy: 'max-seconds' }; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('session time limit')), Math.max(0, deadline - Date.now()));
    const url = lastTimepoint ? `${STREAM_URL}?timepoint=${encodeURIComponent(lastTimepoint)}` : STREAM_URL;
    let dropped = null;
    try {
      const res = await fetchImpl(url, { headers: { Authorization: basic(key), 'User-Agent': userAgent }, signal: controller.signal });
      if (!res.ok) {
        const wait = res.status === 429 ? rateLimitWaitMs : null;
        throw Object.assign(new Error(`stream -> ${res.status} ${res.statusText ?? ''}`.trim()), { status: res.status, wait });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { dropped = new Error('stream closed by server'); break; }
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue; // heartbeat
          let tp = null;
          try {
            tp = JSON.parse(line)?.event?.timepoint ?? null;
          } catch {
            // malformed line: kept raw, skipped by the processor
          }
          if (tp !== null) {
            lastTimepoint = String(tp);
            chunkFirst ??= lastTimepoint;
          }
          chunk.push(line);
          events += 1;
          if (chunk.length >= chunkLines) flush();
          if (events >= maxEvents) {
            controller.abort(new Error('max events'));
            break;
          }
        }
        if (events >= maxEvents) break;
      }
    } catch (err) {
      if (Date.now() >= deadline || events >= maxEvents) continue; // our own limit
      dropped = err;
    } finally {
      clearTimeout(timer);
    }
    if (dropped) {
      flush(); // never lose what was read before the drop
      if (reconnects >= maxReconnects) {
        log?.warn(`Stream gave up after ${reconnects} reconnects: ${dropped.message}`);
        return { snapshotIds, events, lastTimepoint, reconnects, endedBy: 'gave-up', error: dropped.message };
      }
      reconnects += 1;
      log?.warn(`Stream dropped (${dropped.message}); reconnect ${reconnects}/${maxReconnects} from timepoint ${lastTimepoint ?? 'live edge'}`);
      await sleep(dropped.wait ?? Math.min(30_000, backoffMs * 2 ** (reconnects - 1)));
    }
  }
}