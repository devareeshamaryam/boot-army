/**
 * Entity search profiles (Ateca, Osbrooks, AMC/BME, Trading Co).
 *
 * profiles.json is gitignored; profiles.example.json is the committed template.
 * Every problem in the file is reported at once, with its path, e.g.
 *   profiles[1].cpvPrefixes[0]: must be a string of digits
 */
import { existsSync, readFileSync } from 'node:fs';
import { REGION_NAMES, canonicalRegion } from './regions.js';

export const PROFILES_FILE = new URL('./profiles.json', import.meta.url);
export const EXAMPLE_FILE = new URL('./profiles.example.json', import.meta.url);

export const DEFAULT_WEIGHTS = Object.freeze({ relevance: 40, value: 20, deadline: 20, buyer: 15, recency: 5 });
export const DEFAULT_RUNWAY = Object.freeze({ minDays: 5, fullDays: 14 });
export const MAX_DIGEST_SIZE = 20; // Slack allows 50 blocks; each tender uses 2

export class ProfileError extends Error {
  constructor(problems, file) {
    super(`Invalid profiles${file ? ` in ${file}` : ''}:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ProfileError';
    this.problems = problems;
  }
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim());
const isAmount = (v) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/**
 * Validate and fill defaults. Pure.
 * @returns {object[]} profiles with weights/runway/maxDigestSize filled in
 * @throws {ProfileError}
 */
export function validateProfiles(data) {
  const problems = [];
  const list = data?.profiles;
  if (!Array.isArray(list) || !list.length) throw new ProfileError(['"profiles" must be a non-empty array']);

  const entities = new Set();
  const out = list.map((p, i) => {
    const at = `profiles[${i}]${p?.entity ? ` (${p.entity})` : ''}`;
    const bad = (field, msg) => problems.push(`${at}.${field}: ${msg}`);
    if (!p || typeof p !== 'object') { problems.push(`${at}: must be an object`); return null; }

    if (typeof p.entity !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.entity)) bad('entity', 'must be a lower-case slug, e.g. "ateca"');
    else if (entities.has(p.entity)) bad('entity', `duplicate entity "${p.entity}"`);
    else entities.add(p.entity);
    if (typeof p.name !== 'string' || !p.name.trim()) bad('name', 'required');

    const include = p.keywords?.include ?? [];
    const exclude = p.keywords?.exclude ?? [];
    if (!isStringArray(include) && include.length) bad('keywords.include', 'must be an array of non-empty strings');
    if (!isStringArray(exclude) && exclude.length) bad('keywords.exclude', 'must be an array of non-empty strings');
    const cpv = p.cpvPrefixes ?? [];
    if (!Array.isArray(cpv)) bad('cpvPrefixes', 'must be an array');
    else cpv.forEach((c, j) => { if (typeof c !== 'string' || !/^\d{1,8}$/.test(c)) bad(`cpvPrefixes[${j}]`, 'must be a string of digits'); });
    if (!include.length && !cpv.length) bad('keywords.include', 'needs at least one keyword or CPV prefix, otherwise nothing is relevant');

    if (!isAmount(p.value?.min)) bad('value.min', 'must be a number >= 0 or null');
    if (!isAmount(p.value?.max)) bad('value.max', 'must be a number >= 0 or null');
    if (p.value?.min != null && p.value?.max != null && p.value.min > p.value.max) bad('value', 'min is greater than max');
    if (p.regions != null && !isStringArray(p.regions) && p.regions.length) bad('regions', 'must be an array of region names');
    else (p.regions ?? []).forEach((r, j) => {
      if (!canonicalRegion(r)) bad(`regions[${j}]`, `unknown region "${r}" (use one of: ${REGION_NAMES.join(', ')})`);
    });
    if (p.excludedBuyers != null && !isStringArray(p.excludedBuyers) && p.excludedBuyers.length) bad('excludedBuyers', 'must be an array of buyer names');

    if (typeof p.slackWebhookEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(p.slackWebhookEnv)) {
      bad('slackWebhookEnv', 'must be the NAME of an env var (e.g. SLACK_WEBHOOK_URL_TENDERS_ATECA), never the URL itself');
    }
    const size = p.maxDigestSize ?? 10;
    if (!Number.isInteger(size) || size < 1 || size > MAX_DIGEST_SIZE) bad('maxDigestSize', `must be a whole number from 1 to ${MAX_DIGEST_SIZE}`);

    const weights = { ...DEFAULT_WEIGHTS, ...(p.weights ?? {}) };
    const unknown = Object.keys(p.weights ?? {}).filter((k) => !(k in DEFAULT_WEIGHTS));
    if (unknown.length) bad('weights', `unknown component(s): ${unknown.join(', ')} (allowed: ${Object.keys(DEFAULT_WEIGHTS).join(', ')})`);
    if (Object.values(weights).some((w) => typeof w !== 'number' || w < 0)) bad('weights', 'each weight must be a number >= 0');
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum !== 100) bad('weights', `must add up to 100 (they add up to ${sum})`);

    const runway = { ...DEFAULT_RUNWAY, ...(p.runway ?? {}) };
    if (!(runway.minDays >= 0 && runway.fullDays > runway.minDays)) bad('runway', 'needs 0 <= minDays < fullDays');

    return {
      entity: p.entity,
      name: p.name,
      keywords: { include, exclude },
      cpvPrefixes: cpv,
      value: { min: p.value?.min ?? null, max: p.value?.max ?? null },
      regions: (p.regions ?? []).map((r) => canonicalRegion(r) ?? r),
      excludedBuyers: p.excludedBuyers ?? [],
      slackWebhookEnv: p.slackWebhookEnv,
      maxDigestSize: size,
      weights,
      runway,
    };
  });

  if (problems.length) throw new ProfileError(problems);
  return out;
}

/** True if any string in the profile still says PLACEHOLDER. */
export const hasPlaceholder = (profile) => JSON.stringify(profile).includes('PLACEHOLDER');

/**
 * Load profiles.json (or `file`). When it is missing and `allowExample` is set (dry runs),
 * fall back to profiles.example.json so the bot can be tried before real profiles exist.
 */
export function loadProfiles({ file = PROFILES_FILE, allowExample = false, log } = {}) {
  let source = file;
  if (!existsSync(file)) {
    if (!allowExample) throw new ProfileError([`${file instanceof URL ? file.pathname : file} not found: copy profiles.example.json to profiles.json and fill it in`]);
    log?.warn?.('profiles.json not found: using profiles.example.json (PLACEHOLDER values)');
    source = EXAMPLE_FILE;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(source, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new ProfileError([`not valid JSON: ${err.message}`], String(source));
  }
  try {
    return validateProfiles(data);
  } catch (err) {
    if (err instanceof ProfileError) throw new ProfileError(err.problems, String(source));
    throw err;
  }
}
