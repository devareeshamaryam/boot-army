const DEFAULT_TIMEOUT_MS = 20_000;

/** Misconfiguration (missing key, missing source). Retrying will not help. */
export class SourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function userAgent(env = process.env) {
  const contact = env.MANDATE_MATCHER_CONTACT;
  return `bot-army-mandate-matcher/0.1${contact ? ` (+${contact})` : ''}`;
}

/** Strip query strings from URLs in error messages; they can carry tokens. */
const redact = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
};

export async function httpGet(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent(), ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new HttpError(`GET ${redact(url)} -> ${res.status} ${res.statusText} ${body}`.trim(), {
      status: res.status,
      url: redact(url),
    });
  }
  return res;
}

export async function fetchJson(url, options = {}) {
  const res = await httpGet(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  return res.json();
}

export async function fetchText(url, options = {}) {
  return (await httpGet(url, options)).text();
}

/** Serialise calls so consecutive requests are at least minIntervalMs apart. */
export function createThrottle(minIntervalMs) {
  let nextAt = 0;
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAt = Date.now() + minIntervalMs;
    });
    return chain;
  };
}

/* ------------------------------------------------------------ robots.txt */

const robotsCache = new Map();

const toMatcher = (pattern) => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

/** Rules from the "User-agent: *" group(s). Longest match wins; Allow wins ties (RFC 9309). */
export function parseRobots(text) {
  const rules = [];
  let inStarGroup = false;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, field, value] = match;
    const key = field.toLowerCase();

    if (key === 'user-agent') {
      if (!lastWasAgent) inStarGroup = false;
      if (value.trim() === '*') inStarGroup = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inStarGroup || (key !== 'allow' && key !== 'disallow') || value === '') continue;
    rules.push({ allow: key === 'allow', length: value.length, test: toMatcher(value) });
  }
  return rules;
}

export async function isAllowedByRobots(url) {
  const { origin, pathname, search } = new URL(url);
  let rules = robotsCache.get(origin);

  if (rules === undefined) {
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': userAgent() },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) rules = parseRobots(await res.text());
      else if (res.status >= 400 && res.status < 500) rules = []; // no robots.txt: allowed
      else rules = null; // server error: assume disallowed
    } catch {
      rules = null; // unreachable: assume disallowed
    }
    robotsCache.set(origin, rules);
  }

  if (rules === null) return false;
  const target = pathname + search;
  const best = rules
    .filter((r) => r.test.test(target))
    .sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow))[0];
  return best ? best.allow : true;
}

/* ----------------------------------------------------------------- dates */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

/**
 * Parse register dates to "YYYY-MM-DD". Accepts dd/mm/yyyy (FCA, and
 * common in SG/HK/UAE registers), yyyy-mm-dd, and "12 Mar 2024".
 */
export function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;

  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;

  return null;
}