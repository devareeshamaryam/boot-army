import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));

const ATS_TYPES = ['greenhouse', 'lever', 'workable', 'workday'];

const bool = (v, fallback = false) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));
const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Read settings from the environment. A function, not a top-level constant:
 * ES module imports run before the entry point's dotenv call.
 */
export function loadConfig(env = process.env) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(BOT_DIR, p));

  return Object.freeze({
    env,
    dbPath: resolve(env.HSS_DB_PATH || 'data/hiring-signal-scout.db'),
    watchlistPath: resolve(env.HSS_WATCHLIST || 'watchlist.json'),
    templatesPath: resolve(env.HSS_TEMPLATES || 'templates.json'),

    slackWebhookUrl: env.HSS_SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || '',
    slackSigningSecret: env.SLACK_SIGNING_SECRET || '',
    slackApproverIds: list(env.SLACK_APPROVER_IDS),
    approvalsPort: int(env.HSS_PORT, 3000),

    healthchecksBaseUrl: env.HEALTHCHECKS_BASE_URL || '',
    healthcheckUuid: env.HSS_HC_UUID || '',

    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    apolloApiKey: env.APOLLO_API_KEY || '',
    lushaApiKey: env.LUSHA_API_KEY || '',
    dataGovSgApiKey: env.DATA_GOV_SG_API_KEY || '',

    outreachTransport: env.HSS_OUTREACH_TRANSPORT || 'manual', // manual | webhook
    outreachWebhookUrl: env.HSS_OUTREACH_WEBHOOK_URL || '',
    outreachWebhookSecret: env.HSS_OUTREACH_WEBHOOK_SECRET || '',

    lookbackDays: int(env.HSS_LOOKBACK_DAYS, 3),
    atsConcurrency: int(env.HSS_ATS_CONCURRENCY, 4),
    maxDropRatio: Number(env.HSS_MAX_DROP_RATIO ?? 0.6),
    maxEnrichmentCredits: int(env.HSS_MAX_ENRICHMENT_CREDITS, 20),
    contactCacheDays: int(env.HSS_CONTACT_CACHE_DAYS, 90),
    maxProposalsPerRun: int(env.HSS_MAX_PROPOSALS_PER_RUN, 10),
    companyCooldownDays: int(env.HSS_COMPANY_COOLDOWN_DAYS, 30),
    fetchRetries: int(env.HSS_FETCH_RETRIES, 2),
    fetchRetryDelayMs: int(env.HSS_FETCH_RETRY_DELAY_MS, 2000),
    sendEmptyDigest: bool(env.HSS_SEND_EMPTY, false),
  });
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label} at ${filePath} is not valid JSON: ${err.message}`);
  }
}

function validateAts(ats, at, problems) {
  if (!ats) return;
  if (!ATS_TYPES.includes(ats.type)) {
    problems.push(`${at}.ats.type must be one of ${ATS_TYPES.join(', ')}`);
    return;
  }
  const required = {
    greenhouse: ['token'],
    lever: ['slug'],
    workable: ['account'],
    workday: ['host', 'tenant', 'site'],
  }[ats.type];
  for (const key of required) {
    if (typeof ats[key] !== 'string' || ats[key].trim() === '') problems.push(`${at}.ats.${key} is required for ${ats.type}`);
  }
  if (ats.type === 'workday' && ats.host && !/\.myworkdayjobs\.com$/i.test(ats.host)) {
    problems.push(`${at}.ats.host must be a *.myworkdayjobs.com host`);
  }
}

/**
 * Load the watchlist: target companies, award-source settings, spike rules,
 * decision-maker titles and sender details. All problems are reported together.
 */
export function loadWatchlist(watchlistPath) {
  if (!existsSync(watchlistPath)) {
    throw new Error(`Watchlist not found at ${watchlistPath}. Copy watchlist.example.json to watchlist.json.`);
  }
  const raw = readJson(watchlistPath, 'Watchlist');
  const problems = [];
  const companies = Array.isArray(raw.companies) ? raw.companies : [];
  const ids = new Set();

  if (!Array.isArray(raw.companies)) problems.push('"companies" must be an array');

  companies.forEach((c, i) => {
    const at = `companies[${i}]`;
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) problems.push(`${at}.id must be a lowercase slug`);
    if (ids.has(c.id)) problems.push(`${at}.id "${c.id}" is duplicated`);
    ids.add(c.id);
    if (typeof c.name !== 'string' || c.name.trim() === '') problems.push(`${at}.name is required`);
    if (c.domain !== undefined && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.domain)) problems.push(`${at}.domain must be a bare domain like "example.com"`);
    if (c.aliases !== undefined && !Array.isArray(c.aliases)) problems.push(`${at}.aliases must be an array`);
    validateAts(c.ats, at, problems);
  });

  const sender = raw.sender ?? {};
  for (const key of ['name', 'firm', 'offering']) {
    if (typeof sender[key] !== 'string' || sender[key].trim() === '') problems.push(`sender.${key} is required`);
  }

  let focusPattern = null;
  if (raw.spikes?.roleFocus) {
    try {
      focusPattern = new RegExp(raw.spikes.roleFocus, 'i');
    } catch (err) {
      problems.push(`spikes.roleFocus is not a valid regex: ${err.message}`);
    }
  }

  if (problems.length) {
    throw new Error(`Watchlist has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }

  return {
    companies: companies.map((c) => ({ ...c, aliases: c.aliases ?? [] })),
    awards: raw.awards ?? {},
    spikes: {
      windowDays: 7,
      baselineWeeks: 8,
      multiplier: 2,
      minNewJobs: 5,
      cooldownDays: 14,
      ...raw.spikes,
      focusPattern,
    },
    contactTitles: raw.contactTitles ?? [
      'Head of Talent Acquisition',
      'Talent Acquisition Director',
      'Head of Recruitment',
      'Chief People Officer',
      'HR Director',
    ],
    sender,
  };
}