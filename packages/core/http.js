/**
 * core.http — the only place bots touch the network.
 *
 * - retries network errors, 5xx and 429 (honouring Retry-After), backoff 1s, 2s, 4s…
 * - per-host minimum interval between requests; hosts with a known API limit get a shared,
 *   cross-process interval (setHostPolicy), so concurrent bots don't trip it for each other
 * - fixture recording/replay for golden tests:
 *     BOTARMY_HTTP_RECORD=<dir>  write every response to <dir>/<key>.json
 *     BOTARMY_HTTP_REPLAY=<dir>  serve responses from <dir>, never touch the network
 * - robots.txt check (RFC 9309) for scrapers
 * - setFetch(fn) injects a fetch implementation for unit tests
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the underlying fetch (tests). Pass nothing to restore the global fetch. */
export function setFetch(fn) {
  fetchImpl = fn ?? ((...args) => globalThis.fetch(...args));
}

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const redact = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
};

export function defaultUserAgent() {
  const contact = process.env.BOTARMY_CONTACT?.trim();
  return `bot-army/0.1${contact ? ` (+${contact})` : ''}`;
}

/** Stable fixture key: method + URL + body. Headers are deliberately excluded. */
export function fixtureKey(method, url, body) {
  return createHash('sha256').update(`${method.toUpperCase()} ${url}\n${body ?? ''}`).digest('hex').slice(0, 24);
}

/* --------------------------------------------------------- rate limiting */

/**
 * Shared policies for hosts with known API limits. The interval is a floor over each
 * caller's minIntervalMs, and it is coordinated ACROSS PROCESSES: every request reserves
 * the next free slot in <dataDir>/.http-throttle/<host>.next (guarded by a mkdir lock),
 * so two bots calling the same API at the same time share one budget instead of
 * tripping its limit for each other. A 429 pushes the shared slot back for everyone.
 */
const HOST_POLICIES = new Map([
  // Verified 2026-10-06: ~12 requests in a short burst, then "Rate limit of 12 exceeded. Please retry after 120 seconds."
  ['www.contractsfinder.service.gov.uk', { minIntervalMs: 5_000 }],
  // Limit not published or observed; 1s matches what bots already used.
  ['www.find-tender.service.gov.uk', { minIntervalMs: 1_000 }],
]);

/** Set (or with null, remove) the shared policy for a host, e.g. in tests. */
export function setHostPolicy(host, policy) {
  if (policy) HOST_POLICIES.set(host, policy);
  else HOST_POLICIES.delete(host);
}

export const hostPolicy = (host) => HOST_POLICIES.get(host) ?? null;

const throttleDir = () => process.env.BOTARMY_THROTTLE_DIR?.trim() || path.join(dataDir(), '.http-throttle');
const LOCK_STALE_MS = 10_000;
const LOCK_GIVE_UP_MS = 30_000;

/** Run fn(next) -> newNext under the host's cross-process lock. Returns fn's input `next` and its result. */
async function withHostFile(host, fn) {
  const dir = throttleDir();
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, host.replace(/[^a-z0-9.-]/gi, '_'));
  const lock = `${base}.lock`;
  const giveUp = Date.now() + LOCK_GIVE_UP_MS;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(lock); // atomic: fails with EEXIST while another process holds it
      locked = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true }); // holder died
      } catch {
        // lock vanished between the checks: retry
      }
      if (Date.now() > giveUp) break; // never hang a bot on a stuck lock; pace in-process only
      await sleep(25);
    }
  }
  try {
    let next = 0;
    try {
      next = Number(readFileSync(`${base}.next`, 'utf8')) || 0;
    } catch {
      // first request to this host
    }
    const updated = fn(next);
    writeFileSync(`${base}.next`, String(updated));
    return next;
  } finally {
    if (locked) rmSync(lock, { recursive: true, force: true });
  }
}

/** Reserve the next shared slot for a host; resolves after waiting for it. */
async function sharedSlot(host, intervalMs) {
  let slot = 0;
  await withHostFile(host, (next) => {
    slot = Math.max(Date.now(), next);
    return slot + intervalMs;
  });
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);
}

/** Tell every process to keep off a host for `ms` (after a 429). */
export async function penalizeHost(host, ms) {
  if (!hostPolicy(host)) return;
  await withHostFile(host, (next) => Math.max(next, Date.now() + ms));
}

const hosts = new Map();
async function throttle(host, minIntervalMs) {
  const policy = hostPolicy(host);
  const interval = Math.max(minIntervalMs || 0, policy?.minIntervalMs || 0);
  if (!interval) return;
  const state = hosts.get(host) ?? { next: 0, chain: Promise.resolve() };
  hosts.set(host, state);
  state.chain = state.chain.then(async () => {
    if (policy?.minIntervalMs) {
      await sharedSlot(host, interval);
      return;
    }
    const wait = state.next - Date.now();
    if (wait > 0) await sleep(wait);
    state.next = Date.now() + interval;
  });
  return state.chain;
}

function retryAfterMs(header) {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

/* -------------------------------------------------------------- response */

function makeResponse({ url, status, headers, body }) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers,
    contentType: headers['content-type'] ?? null,
    body,
    text: () => body.toString('utf8'),
    json: () => JSON.parse(body.toString('utf8')),
  };
}

function replay(dir, method, url, body) {
  const file = path.join(dir, `${fixtureKey(method, url, body)}.json`);
  if (!existsSync(file)) throw new HttpError(`No recorded fixture for ${method} ${url} in ${dir}`, { url: redact(url) });
  const f = JSON.parse(readFileSync(file, 'utf8'));
  return makeResponse({ url: f.finalUrl ?? url, status: f.status, headers: f.headers ?? {}, body: Buffer.from(f.bodyBase64, 'base64') });
}

function record(dir, method, url, body, res) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fixtureKey(method, url, body)}.json`);
  writeFileSync(file, JSON.stringify({
    method, url, finalUrl: res.url, status: res.status, headers: res.headers,
    recordedAt: new Date().toISOString(), bodyBase64: res.body.toString('base64'),
  }, null, 2));
}

/**
 * @param {string} url
 * @param {object} [o]
 * @returns {Promise<{ url, status, ok, headers, contentType, body: Buffer, text(): string, json(): any }>}
 * @throws {HttpError} on a non-2xx final response
 */
export async function fetch(url, o = {}) {
  const {
    method = 'GET', headers = {}, body, timeoutMs = 30_000, retries = 3,
    minIntervalMs = 0, maxRetryAfterMs = 150_000, userAgent = defaultUserAgent(),
    replayDir = process.env.BOTARMY_HTTP_REPLAY, recordDir = process.env.BOTARMY_HTTP_RECORD,
  } = o;

  if (replayDir) {
    const res = replay(replayDir, method, url, body);
    if (!res.ok) throw new HttpError(`${method} ${redact(url)} -> ${res.status} (fixture)`, { status: res.status, url: redact(url) });
    return res;
  }

  const host = new URL(url).host;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, minIntervalMs);
    let raw;
    try {
      raw = await fetchImpl(url, {
        method, body, redirect: 'follow',
        headers: { 'User-Agent': userAgent, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err;
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw new HttpError(`${method} ${redact(url)} failed: ${err.message}`, { url: redact(url) });
    }

    const responseHeaders = Object.fromEntries(raw.headers.entries());
    const buffer = Buffer.from(await raw.arrayBuffer());
    const res = makeResponse({ url: raw.url || url, status: raw.status, headers: responseHeaders, body: buffer });

    const retryable = raw.status === 429 || raw.status >= 500;
    if (retryable && attempt < retries) {
      const wait = raw.status === 429 ? retryAfterMs(responseHeaders['retry-after']) ?? 5000 * 2 ** attempt : 1000 * 2 ** attempt;
      if (wait > maxRetryAfterMs) throw new HttpError(`${method} ${redact(url)} -> 429, Retry-After ${Math.round(wait / 1000)}s too long`, { status: 429, url: redact(url) });
      if (raw.status === 429) await penalizeHost(host, wait); // other processes back off too
      await sleep(wait);
      continue;
    }
    if (recordDir) record(recordDir, method, url, body, res);
    if (!res.ok) {
      throw new HttpError(`${method} ${redact(url)} -> ${raw.status} ${raw.statusText ?? ''} ${buffer.toString('utf8', 0, 200)}`.trim(), { status: raw.status, url: redact(url) });
    }
    return res;
  }
  throw lastError;
}

/* ------------------------------------------------------------ robots.txt */

const robotsCache = new Map();

export function parseRobots(text) {
  const rules = [];
  let star = false;
  let lastAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastAgent) star = false;
      if (value === '*') star = true;
      lastAgent = true;
      continue;
    }
    lastAgent = false;
    if (star && (key === 'allow' || key === 'disallow') && value) {
      const anchored = value.endsWith('$');
      const body = (anchored ? value.slice(0, -1) : value).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      rules.push({ allow: key === 'allow', length: value.length, test: new RegExp(`^${body}${anchored ? '$' : ''}`) });
    }
  }
  return rules;
}

/** RFC 9309: 4xx = allowed, 5xx/unreachable = disallowed; longest match wins, Allow wins ties. */
export async function allowedByRobots(url) {
  const { origin, pathname, search } = new URL(url);
  if (!robotsCache.has(origin)) {
    let rules;
    try {
      const res = await fetch(`${origin}/robots.txt`, { retries: 0, timeoutMs: 10_000 });
      rules = parseRobots(res.text());
    } catch (err) {
      rules = err instanceof HttpError && err.status >= 400 && err.status < 500 ? [] : null;
    }
    robotsCache.set(origin, rules);
  }
  const rules = robotsCache.get(origin);
  if (rules === null) return false;
  const best = rules.filter((r) => r.test.test(pathname + search)).sort((a, b) => b.length - a.length || b.allow - a.allow)[0];
  return best ? best.allow : true;
}