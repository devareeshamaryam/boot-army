/**
 * core.http — the only place bots touch the network.
 *
 * - retries network errors, 5xx and 429 (honouring Retry-After), backoff 1s, 2s, 4s…
 * - per-host minimum interval between requests
 * - fixture recording/replay for golden tests:
 *     BOTARMY_HTTP_RECORD=<dir>  write every response to <dir>/<key>.json
 *     BOTARMY_HTTP_REPLAY=<dir>  serve responses from <dir>, never touch the network
 * - robots.txt check (RFC 9309) for scrapers
 * - setFetch(fn) injects a fetch implementation for unit tests
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

const hosts = new Map();
async function throttle(host, minIntervalMs) {
  if (!minIntervalMs) return;
  const state = hosts.get(host) ?? { next: 0, chain: Promise.resolve() };
  hosts.set(host, state);
  state.chain = state.chain.then(async () => {
    const wait = state.next - Date.now();
    if (wait > 0) await sleep(wait);
    state.next = Date.now() + minIntervalMs;
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