const DEFAULT_TIMEOUT_MS = 25_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Misconfiguration. Retrying will not help. */
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

export function userAgent(env = process.env) {
  const contact = env.HSS_CONTACT;
  return `bot-army-hiring-signal-scout/0.1${contact ? ` (+${contact})` : ''}`;
}

const redact = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
};

function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * fetch with timeout, and polite handling of 429: honour Retry-After (Find a
 * Tender enforces a small, slowly refilling allowance) up to maxRetryAfterMs.
 */
export async function request(url, {
  method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS,
  max429Retries = 3, maxRetryAfterMs = 150_000,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': userAgent(), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429 && attempt < max429Retries) {
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? 5000 * 2 ** attempt;
      await res.body?.cancel().catch(() => {});
      if (wait > maxRetryAfterMs) {
        throw new HttpError(`${method} ${redact(url)} -> 429, Retry-After ${Math.round(wait / 1000)}s is too long`, { status: 429 });
      }
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new HttpError(`${method} ${redact(url)} -> ${res.status} ${res.statusText} ${text}`.trim(), {
        status: res.status,
        url: redact(url),
      });
    }
    return res;
  }
}

export async function getJson(url, options = {}) {
  return (await request(url, { ...options, headers: { Accept: 'application/json', ...options.headers } })).json();
}

export async function postJson(url, payload, options = {}) {
  const res = await request(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function getText(url, options = {}) {
  return (await request(url, options)).text();
}

/** Serialise calls so they are at least minIntervalMs apart. */
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

/** Run fn over items with bounded concurrency; returns results in input order. */
export async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------ robots.txt */

const robotsCache = new Map();

const toMatcher = (pattern) => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

export function parseRobots(text) {
  const rules = [];
  let inStar = false;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) inStar = false;
      if (value === '*') inStar = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (inStar && (key === 'allow' || key === 'disallow') && value) {
      rules.push({ allow: key === 'allow', length: value.length, test: toMatcher(value) });
    }
  }
  return rules;
}

/** RFC 9309: 4xx = allowed, 5xx/unreachable = disallowed. Longest match wins, Allow wins ties. */
export async function isAllowedByRobots(url) {
  const { origin, pathname, search } = new URL(url);
  let rules = robotsCache.get(origin);
  if (rules === undefined) {
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(10_000) });
      rules = res.ok ? parseRobots(await res.text()) : res.status < 500 ? [] : null;
    } catch {
      rules = null;
    }
    robotsCache.set(origin, rules);
  }
  if (rules === null) return false;
  const target = pathname + search;
  const best = rules.filter((r) => r.test.test(target)).sort((a, b) => b.length - a.length || b.allow - a.allow)[0];
  return best ? best.allow : true;
}

/* ------------------------------------------------------------ CSV, dates */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.trim());
  return body
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "YYYY-MM-DD" from ISO, dd/mm/yyyy, yyyymmdd, "12 Mar 2024", or epoch ms. */
export function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return null;
}

/** First non-empty value among candidate keys (case-insensitive). */
export function pick(row, candidates) {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const key = lower.get(c.toLowerCase());
    const v = key === undefined ? undefined : row[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}