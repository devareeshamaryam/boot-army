/**
 * core.match — name normalisation and fuzzy matching (fuzzball).
 *
 * Scores are 0–100. Matching helpers return null below threshold rather than a
 * weak guess: callers decide, or send the case to spine.queueReview().
 */
import * as fuzzballModule from 'fuzzball';

const fuzz = fuzzballModule.default ?? fuzzballModule;

const SUFFIX_VARIANTS = [
  [/\bpublic limited company\b/g, 'plc'],
  [/\blimited liability partnership\b/g, 'llp'],
  [/\blimited\b/g, 'ltd'],
  [/\bcompany\b/g, 'co'],
  [/\bincorporated\b/g, 'inc'],
  [/\bcorporation\b/g, 'corp'],
];

/** Words that never identify a company on their own. */
export const LEGAL_WORDS = new Set([
  'ltd', 'plc', 'llp', 'lp', 'llc', 'inc', 'corp', 'co', 'and', 'the', 'of', 'uk', 'group', 'holdings', 'holding',
  'services', 'international', 'pte', 'pty', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'fze', 'fzco', 'wll',
]);

/** Lowercase, strip accents and punctuation, "&" → "and", unify legal-suffix spellings. */
export function nameNorm(name) {
  let s = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  for (const [re, to] of SUFFIX_VARIANTS) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

/** The identifying tokens of a company name (legal words removed). */
export function significantTokens(name) {
  return nameNorm(name).split(' ').filter((t) => t && !LEGAL_WORDS.has(t));
}

/** nameNorm without legal words: "The Acme Group Holdings Ltd" → "acme". */
export function companyCore(name) {
  return significantTokens(name).join(' ');
}

/* ----------------------------------------------------------- similarity */

const opts = { full_process: false };

export const ratio = (a, b) => fuzz.ratio(nameNorm(a), nameNorm(b), opts);
export const partialRatio = (a, b) => fuzz.partial_ratio(nameNorm(a), nameNorm(b), opts);
export const tokenSortRatio = (a, b) => fuzz.token_sort_ratio(nameNorm(a), nameNorm(b), opts);
export const tokenSetRatio = (a, b) => fuzz.token_set_ratio(nameNorm(a), nameNorm(b), opts);

/**
 * Company-name similarity on identifying tokens only, so "Acme Ltd" vs
 * "Acme Limited" is 100 and "Care Ltd" vs "Abc Care Ltd" is not inflated by
 * shared legal words. Uses the stricter of token-sort and token-set when the
 * names share fewer than two identifying tokens.
 */
export function companySimilarity(a, b) {
  const ca = companyCore(a);
  const cb = companyCore(b);
  if (!ca || !cb) return fuzz.token_sort_ratio(nameNorm(a), nameNorm(b), opts);
  if (ca === cb) return 100;
  const sort = fuzz.token_sort_ratio(ca, cb, opts);
  const set = fuzz.token_set_ratio(ca, cb, opts);
  const shared = ca.split(' ').filter((t) => cb.split(' ').includes(t)).length;
  return shared >= 2 ? Math.max(sort, set) : Math.min(sort, set);
}

/**
 * Best company match among candidates.
 * @param {string} name
 * @param {Array<string | { name: string, [k: string]: any }>} candidates
 * @param {{ threshold?: number }} [options]
 * @returns {{ candidate: any, score: number } | null}
 */
export function fuzzyCompany(name, candidates, { threshold = 90 } = {}) {
  let best = null;
  for (const candidate of candidates) {
    const label = typeof candidate === 'string' ? candidate : candidate?.name;
    if (!label) continue;
    const score = companySimilarity(name, label);
    if (score >= threshold && (!best || score > best.score)) best = { candidate, score };
  }
  return best;
}

/**
 * Person match: names compared order-insensitively; a known partial date of
 * birth (e.g. "1975-03") must agree when both sides have one.
 * @param {{ name: string, dobPartial?: string|null }} a
 * @param {{ name: string, dobPartial?: string|null }} b
 * @returns {{ score: number, dobAgrees: boolean|null }}
 */
export function fuzzyPerson(a, b) {
  const dobAgrees = a.dobPartial && b.dobPartial ? a.dobPartial === b.dobPartial : null;
  if (dobAgrees === false) return { score: 0, dobAgrees };
  const strip = (n) => nameNorm(n).split(' ').filter((t) => t.length > 1 && !['mr', 'mrs', 'ms', 'dr', 'sir', 'dame'].includes(t)).join(' ');
  const score = fuzz.token_sort_ratio(strip(a.name), strip(b.name), opts);
  return { score, dobAgrees };
}

/** Top-N matches for a query (thin wrapper over fuzzball.extract). */
export function extract(query, choices, { limit = 5, cutoff = 0, scorer = 'companySimilarity' } = {}) {
  const fn = scorer === 'companySimilarity' ? (q, c) => companySimilarity(q, c) : fuzz[scorer];
  if (typeof fn !== 'function') throw new Error(`match.extract: unknown scorer "${scorer}"`);
  return choices
    .map((c, i) => ({ choice: c, score: fn(query, c, opts), index: i }))
    .filter((x) => x.score >= cutoff)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}