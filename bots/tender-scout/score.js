/**
 * B3 scoring. Pure and deterministic: the same tender, profile and date always
 * give the same score and the same reasons.
 *
 * score = round(100 × Σ weight·factor / Σ weight), every factor 0–1:
 *   cpv       how specifically the notice's CPV codes match the profile's prefixes
 *   keywords  keyword density: distinct capability phrases found (title hits count double)
 *   value     position of the contract value against the profile's band
 *   location  delivery location against the profile's locations
 *   deadline  time left to prepare a bid
 *
 * Every factor reports its input, its value and the points it contributed, so
 * each point of the score is explained. Missing data is an explicit "unknown"
 * with a fixed neutral value; nothing is estimated.
 *
 * Not scored yet: buyer concentration and incumbent signals need B6 (award
 * analytics). They are listed in reasons.notScored rather than guessed.
 */

export const DEFAULT_WEIGHTS = Object.freeze({ cpv: 30, keywords: 25, value: 15, location: 15, deadline: 15 });
export const NOT_SCORED = Object.freeze(['buyerConcentration (needs B6 award analytics)', 'incumbent (needs B6 award analytics)']);

const UNKNOWN = Object.freeze({ cpv: 0.4, value: 0.5, location: 0.5, deadline: 0.4 });
const DAY_MS = 86_400_000;
const round2 = (n) => Math.round(n * 100) / 100;

/** Strict number parse: null for empty, non-numeric or non-finite input. */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/,/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Whole days from `now` to `deadline` (negative when past); null if the deadline is unknown. */
export function daysUntil(deadline, now) {
  const d = Date.parse(deadline ?? '');
  const n = Date.parse(now ?? '');
  if (!Number.isFinite(d) || !Number.isFinite(n)) return null;
  return Math.floor((d - n) / DAY_MS);
}

/** Longest matching CPV prefix across the notice's codes, or null. */
export function bestCpvMatch(cpvCodes, prefixes) {
  let best = null;
  for (const code of cpvCodes ?? []) {
    for (const p of prefixes ?? []) {
      if (String(code).startsWith(p) && (!best || p.length > best.prefix.length)) best = { code, prefix: p };
    }
  }
  return best;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (phrase) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(phrase.trim())}($|[^\\p{L}\\p{N}])`, 'iu');

/** Distinct profile phrases found in title (weight 2) and description (weight 1). */
export function keywordHits(title, description, keywords) {
  const hits = [];
  for (const k of keywords ?? []) {
    const re = phraseRe(k);
    if (re.test(title ?? '')) hits.push({ keyword: k, where: 'title', weight: 2 });
    else if (re.test(description ?? '')) hits.push({ keyword: k, where: 'description', weight: 1 });
  }
  return hits;
}

/** True if any delivery location string mentions one of the profile's locations. */
export function locationMatch(locations, profileLocations) {
  if (!profileLocations?.length) return { status: 'any' };
  if (!locations?.length) return { status: 'unknown' };
  for (const want of profileLocations) {
    const re = phraseRe(want);
    const hit = locations.find((l) => re.test(l));
    if (hit) return { status: 'match', matched: want, input: hit };
  }
  return { status: 'mismatch', input: locations.slice(0, 3) };
}

/* ------------------------------------------------------------- factors */

function cpvFactor(tender, profile) {
  if (!tender.cpv?.length) return { value: UNKNOWN.cpv, unknown: true, note: 'notice publishes no CPV codes' };
  const m = bestCpvMatch(tender.cpv, profile.cpvPrefixes);
  if (!m) return { value: 0, note: `CPV ${tender.cpv.slice(0, 3).join(', ')} outside profile prefixes` };
  const value = m.prefix.length >= 5 ? 1 : m.prefix.length >= 3 ? 0.85 : 0.7;
  return { value, input: m.code, matched: m.prefix, note: `CPV ${m.code} matches prefix ${m.prefix}` };
}

function keywordFactor(tender, profile) {
  if (!profile.keywords?.length) return { value: 0.5, unknown: true, note: 'profile has no keywords' };
  const hits = keywordHits(tender.title, tender.description, profile.keywords);
  const weighted = hits.reduce((s, h) => s + h.weight, 0);
  const target = Math.min(profile.keywords.length, 4) * 2; // two title hits on four phrases = full marks
  return {
    value: Math.min(1, weighted / target),
    input: hits.map((h) => `${h.keyword} (${h.where})`),
    note: hits.length ? `${hits.length} capability phrase(s) found` : 'no capability phrases found',
  };
}

function valueFactor(tender, profile) {
  const value = toNumberOrNull(tender.valueMax) ?? toNumberOrNull(tender.valueMin);
  if (value === null) return { value: UNKNOWN.value, unknown: true, note: 'value not published' };
  if (profile.valueCurrency && tender.currency && tender.currency !== profile.valueCurrency) {
    return { value: UNKNOWN.value, unknown: true, input: value, note: `value in ${tender.currency}, band in ${profile.valueCurrency}: not compared` };
  }
  const min = toNumberOrNull(profile.valueMin);
  const max = toNumberOrNull(profile.valueMax);
  if (max !== null && value > max) return { value: 0.6, input: value, note: `above the ${max.toLocaleString('en-GB')} band ceiling (stretch)` };
  if (min !== null && value < min) return { value: 0.3, input: value, note: `below the ${min.toLocaleString('en-GB')} floor` };
  return { value: 1, input: value, note: 'within the profile value band' };
}

function locationFactor(tender, profile) {
  const m = locationMatch(tender.locations, profile.locations);
  if (m.status === 'any') return { value: 1, note: 'profile accepts any location' };
  if (m.status === 'unknown') return { value: UNKNOWN.location, unknown: true, note: 'delivery location not published' };
  if (m.status === 'match') return { value: 1, input: m.input, note: `delivery in ${m.matched}` };
  return { value: 0.2, input: m.input, note: 'delivery outside profile locations' };
}

function deadlineFactor(tender, profile, now) {
  const days = daysUntil(tender.deadline, now);
  if (days === null) return { value: UNKNOWN.deadline, unknown: true, note: 'deadline not published' };
  const min = toNumberOrNull(profile.minDays) ?? 10;
  if (days < min) return { value: 0, input: days, note: `${days} day(s) left, below the ${min}-day minimum` };
  if (days < min + 7) return { value: 0.6, input: days, note: `${days} days left: tight` };
  if (days <= 60) return { value: 1, input: days, note: `${days} days left` };
  return { value: 0.8, input: days, note: `${days} days left: early` };
}

/**
 * @param {object} tender  { title, description, cpv, valueMin, valueMax, currency, locations, deadline }
 * @param {object} profile { cpvPrefixes, keywords, valueMin, valueMax, valueCurrency, locations, minDays, weights }
 * @param {string} now     ISO timestamp the score is computed for
 * @returns {{ score: number, reasons: object }}
 */
export function scoreTender(tender, profile, now) {
  const weights = { ...DEFAULT_WEIGHTS, ...(profile.weights ?? {}) };
  const factors = {
    cpv: cpvFactor(tender, profile),
    keywords: keywordFactor(tender, profile),
    value: valueFactor(tender, profile),
    location: locationFactor(tender, profile),
    deadline: deadlineFactor(tender, profile, now),
  };
  const total = Object.keys(factors).reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  const reasons = {};
  let raw = 0;
  for (const [k, f] of Object.entries(factors)) {
    const contribution = (100 * (weights[k] ?? 0) * f.value) / total;
    raw += contribution;
    reasons[k] = { ...f, value: round2(f.value), weight: weights[k] ?? 0, points: round2(contribution) };
  }
  reasons.notScored = [...NOT_SCORED];
  return { score: Math.max(0, Math.min(100, Math.round(raw))), reasons };
}