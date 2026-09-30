import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));

const REGULATORS = ['FCA', 'MAS', 'SFC', 'DFSA', 'FSRA'];
const MARKETS = ['UK', 'SG', 'HK', 'DIFC', 'ADGM'];

const bool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Read settings from the environment. This is a function, not a top-level
 * constant, because ES module imports are evaluated before the entry point's
 * dotenv call runs; reading process.env at import time would see nothing.
 */
export function loadConfig(env = process.env) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(BOT_DIR, p));

  return Object.freeze({
    dbPath: resolve(env.MANDATE_MATCHER_DB_PATH || 'data/mandate-matcher.db'),
    watchlistPath: resolve(env.MANDATE_MATCHER_WATCHLIST || 'watchlist.json'),
    slackWebhookUrl: env.MANDATE_MATCHER_SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || '',
    healthchecksBaseUrl: env.HEALTHCHECKS_BASE_URL || '',
    healthcheckUuid: env.MANDATE_MATCHER_HC_UUID || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    aiSummary: bool(env.MANDATE_MATCHER_AI_SUMMARY, false),
    sendEmptyDigest: bool(env.MANDATE_MATCHER_SEND_EMPTY, false),
    minScore: int(env.MANDATE_MATCHER_MIN_SCORE, 40),
    maxMovers: int(env.MANDATE_MATCHER_MAX_MOVERS, 15),
    maxNews: int(env.MANDATE_MATCHER_MAX_NEWS, 8),
    digestWindowDays: int(env.MANDATE_MATCHER_WINDOW_DAYS, 7),
    moveLookbackDays: int(env.MANDATE_MATCHER_MOVE_LOOKBACK_DAYS, 90),
    maxDropRatio: Number(env.MANDATE_MATCHER_MAX_DROP_RATIO ?? 0.5),
    maxDestinationLookups: int(env.MANDATE_MATCHER_MAX_DESTINATION_LOOKUPS, 25),
    fetchRetries: int(env.MANDATE_MATCHER_FETCH_RETRIES, 2),
    fetchRetryDelayMs: int(env.MANDATE_MATCHER_FETCH_RETRY_DELAY_MS, 2000),
    env,
  });
}

/**
 * Load and validate the watchlist: the firms to monitor and the RSS feeds to read.
 * All problems are reported together so the file can be fixed in one pass.
 */
export function loadWatchlist(watchlistPath) {
  if (!existsSync(watchlistPath)) {
    throw new Error(
      `Watchlist not found at ${watchlistPath}. Copy watchlist.example.json to watchlist.json and edit it.`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(watchlistPath, 'utf8'));
  } catch (err) {
    throw new Error(`Watchlist is not valid JSON: ${err.message}`);
  }

  const problems = [];
  const firms = Array.isArray(raw.firms) ? raw.firms : [];
  const feeds = Array.isArray(raw.feeds) ? raw.feeds : [];
  const seen = new Set();

  if (!Array.isArray(raw.firms)) problems.push('"firms" must be an array');

  firms.forEach((firm, i) => {
    const at = `firms[${i}]`;
    const regulator = String(firm.regulator ?? '').toUpperCase();
    if (!REGULATORS.includes(regulator)) problems.push(`${at}.regulator must be one of ${REGULATORS.join(', ')}`);
    if (typeof firm.ref !== 'string' || firm.ref.trim() === '') problems.push(`${at}.ref must be a non-empty string`);
    if (typeof firm.name !== 'string' || firm.name.trim() === '') problems.push(`${at}.name must be a non-empty string`);
    if (!MARKETS.includes(firm.market)) problems.push(`${at}.market must be one of ${MARKETS.join(', ')}`);
    if (![1, 2, 3].includes(firm.tier)) problems.push(`${at}.tier must be 1, 2 or 3`);
    if (firm.aliases !== undefined && !Array.isArray(firm.aliases)) problems.push(`${at}.aliases must be an array`);

    const key = `${regulator}:${firm.ref}`;
    if (seen.has(key)) problems.push(`${at} duplicates ${key}`);
    seen.add(key);
  });

  feeds.forEach((feed, i) => {
    if (typeof feed.url !== 'string' || !URL.canParse(feed.url)) problems.push(`feeds[${i}].url must be a valid URL`);
  });

  if (problems.length) {
    throw new Error(`Watchlist has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }

  return {
    firms: firms.map((f) => ({
      ...f,
      regulator: f.regulator.toUpperCase(),
      ref: f.ref.trim(),
      aliases: f.aliases ?? [],
    })),
    feeds: feeds.map((f) => ({ name: f.name || new URL(f.url).hostname, url: f.url })),
  };
}