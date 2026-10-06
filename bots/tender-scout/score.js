/**
 * Winnability score, 0-100. Pure: (notice, profile, context) -> result, no I/O.
 *
 * Components and their maximums come from profile.weights (default 40/20/20/15/5).
 * A missing field is never scored as zero or guessed: it gets half the component's
 * points and is listed in `gaps`, so the digest can say "value not published".
 *
 * Some notices are dropped before scoring (`excluded` is set, score 0): an excluded
 * keyword or buyer, a deadline that has passed, or no keyword and no CPV match at all.
 */

import { regionMatches } from './regions.js';

export const NEUTRAL = 0.5; // share of a component's points when its data is missing

const DAY = 86_400_000;
const round1 = (n) => Math.round(n * 10) / 10;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (text, phrase) => Boolean(text) && new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i').test(text);
const lower = (s) => String(s ?? '').trim().toLowerCase();

export function formatMoney(amount, currency = 'GBP') {
  if (amount == null) return null;
  const symbol = { GBP: '£', EUR: '€', USD: '$' }[currency ?? 'GBP'];
  const n = Math.round(amount).toLocaleString('en-GB');
  return symbol ? `${symbol}${n}` : `${n} ${currency}`;
}

/* ------------------------------------------------------------ components */

function relevance(n, p, max, gaps) {
  const include = p.keywords.include;
  const inTitle = include.filter((k) => matches(n.title, k));
  const inDesc = include.filter((k) => !inTitle.includes(k) && matches(n.description, k));
  const kw = Math.min(1, (2 * inTitle.length + inDesc.length) / 3);

  const cpvHits = n.cpv_codes.filter((c) => p.cpvPrefixes.some((pre) => c.startsWith(pre)));
  let cpv;
  let cpvReason;
  if (!p.cpvPrefixes.length) { cpv = kw; cpvReason = null; }
  else if (!n.cpv_codes.length) { cpv = NEUTRAL; cpvReason = 'CPV not published'; gaps.push('CPV code not published'); }
  else if (cpvHits.length) { cpv = 1; cpvReason = `CPV ${cpvHits[0]} in your categories`; }
  else { cpv = 0; cpvReason = `CPV ${n.cpv_codes[0]} outside your categories`; }

  // No region (or one we cannot map) is a gap, never a mismatch.
  let region = 1;
  let regionReason = null;
  if (p.regions.length) {
    const raw = n.regions_raw ?? [];
    if (!n.regions.length) {
      region = NEUTRAL;
      regionReason = raw.length ? `region not recognised (${raw.join(', ')})` : 'region not published';
      gaps.push(regionReason);
    } else if (n.regions.some((r) => p.regions.some((pr) => regionMatches(r, pr)))) regionReason = `in ${n.regions.join(', ')}`;
    else { region = 0; regionReason = `region ${n.regions.join(', ')} not in your list`; }
  }

  const parts = [];
  if (inTitle.length) parts.push(`"${inTitle.join('", "')}" in title`);
  if (inDesc.length) parts.push(`"${inDesc.join('", "')}" in description`);
  if (cpvReason) parts.push(cpvReason);
  if (regionReason) parts.push(regionReason);
  return {
    component: 'relevance', max, points: round1(max * (0.6 * kw + 0.3 * cpv + 0.1 * region)),
    reason: parts.join('; ') || 'weak keyword match',
    hits: inTitle.length + inDesc.length + cpvHits.length,
  };
}

function valueFit(n, p, max, gaps) {
  const { min, max: top } = p.value;
  if (n.value_amount == null) {
    const why = n.value_placeholder ? 'value published as a placeholder (e.g. £1)' : 'value not published';
    gaps.push(why);
    return { component: 'value', max, points: round1(max * NEUTRAL), reason: why };
  }
  const v = formatMoney(n.value_amount, n.value_currency);
  if (min == null && top == null) return { component: 'value', max, points: max, reason: `${v} (no value range set)` };
  let share = 1;
  let reason = `${v} within your range`;
  if (min != null && n.value_amount < min) { share = n.value_amount / min; reason = `${v} below your minimum ${formatMoney(min)}`; }
  if (top != null && n.value_amount > top) { share = top / n.value_amount; reason = `${v} above your maximum ${formatMoney(top)}`; }
  return { component: 'value', max, points: round1(max * share), reason };
}

function runway(n, p, max, gaps, now) {
  if (!n.deadline) {
    gaps.push('deadline not published');
    return { component: 'deadline', max, points: round1(max * NEUTRAL), reason: 'deadline not published' };
  }
  const days = (Date.parse(n.deadline) - Date.parse(now)) / DAY;
  const { minDays, fullDays } = p.runway;
  const share = days < minDays ? 0 : Math.min(1, (days - minDays) / (fullDays - minDays));
  const d = Math.floor(days);
  const reason = days < minDays ? `only ${d} day${d === 1 ? '' : 's'} to bid` : `${d} days to bid`;
  return { component: 'deadline', max, points: round1(max * share), reason };
}

function buyerFamiliarity(max, gaps, history) {
  if (!history || history.total === 0) {
    gaps.push('no award history for this buyer in our data');
    return { component: 'buyer', max, points: round1(max * NEUTRAL), reason: 'buyer unknown: no award history yet' };
  }
  if (history.inCategory > 0) {
    return {
      component: 'buyer', max, points: round1(max * Math.min(1, 0.6 + 0.2 * history.inCategory)),
      reason: `buyer has awarded ${history.inCategory} contract${history.inCategory === 1 ? '' : 's'} in your categories`,
    };
  }
  return { component: 'buyer', max, points: round1(max * 0.4), reason: `buyer known (${history.total} awards), none in your categories` };
}

function recency(n, max, gaps, now) {
  if (!n.published_at) {
    gaps.push('publication date not published');
    return { component: 'recency', max, points: round1(max * NEUTRAL), reason: 'publication date unknown' };
  }
  const hours = (Date.parse(now) - Date.parse(n.published_at)) / 3_600_000;
  const share = hours <= 24 ? 1 : hours <= 72 ? 0.6 : hours <= 168 ? 0.3 : 0;
  return { component: 'recency', max, points: round1(max * share), reason: hours <= 24 ? 'published in the last 24h' : `published ${Math.floor(hours / 24)} days ago` };
}

/* ------------------------------------------------------------------ main */

/** Why a notice is dropped for this profile, or null. */
export function exclusion(n, p, now) {
  if (p.excludedBuyers.some((b) => lower(b) === lower(n.buyer_name))) return `excluded buyer: ${n.buyer_name}`;
  const kw = p.keywords.exclude.find((k) => matches(n.title, k) || matches(n.description, k));
  if (kw) return `excluded keyword: ${kw}`;
  if (n.deadline && Date.parse(n.deadline) <= Date.parse(now)) return 'deadline has passed';
  return null;
}

/**
 * @param {object} notice   notices row (cpv_codes / regions as arrays)
 * @param {object} profile  validated profile (profiles.js)
 * @param {{ now: string, buyerHistory?: { total: number, inCategory: number } | null }} context
 * @returns {{ score: number, breakdown: { component, points, max, reason }[], gaps: string[], excluded: string|null }}
 */
export function score(notice, profile, { now, buyerHistory = null }) {
  const excluded = exclusion(notice, profile, now);
  if (excluded) return { score: 0, breakdown: [], gaps: [], excluded };

  const w = profile.weights;
  const gaps = [];
  const rel = relevance(notice, profile, w.relevance, gaps);
  if (rel.hits === 0) return { score: 0, breakdown: [], gaps: [], excluded: 'no keyword or CPV match' };
  delete rel.hits;

  const breakdown = [
    rel,
    valueFit(notice, profile, w.value, gaps),
    runway(notice, profile, w.deadline, gaps, now),
    buyerFamiliarity(w.buyer, gaps, buyerHistory),
    recency(notice, w.recency, gaps, now),
  ];
  const total = Math.round(breakdown.reduce((sum, b) => sum + b.points, 0));
  return { score: Math.max(0, Math.min(100, total)), breakdown, gaps, excluded: null };
}

/** The strongest components, for the digest: highest share of their maximum first. */
export function topReasons(breakdown, n = 2) {
  return [...breakdown]
    .filter((b) => b.max > 0 && b.points > 0)
    .sort((a, b) => b.points / b.max - a.points / a.max || b.max - a.max)
    .slice(0, n)
    .map((b) => b.reason);
}
