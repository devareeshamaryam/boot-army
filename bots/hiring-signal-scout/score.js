/**
 * B5 scoring. Pure and deterministic: the same evidence always gives the same
 * score, rationale and suggested angle. score = round(100 × Σ w·f / Σ w), each
 * factor 0–1. Missing values are explicit unknowns with a fixed neutral factor;
 * nothing is estimated.
 */

/** Strict number parse: null for empty, non-numeric or non-finite input. */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/,/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round2 = (n) => Math.round(n * 100) / 100;
const UNKNOWN = 0.4;

/** Ratio → 0–1 on a log scale: 1× threshold = 0.5, 10× = 1.0. Null ratio → null. */
export function ratioFactor(ratio) {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return null;
  return clamp01(0.5 + Math.log10(ratio) / 2);
}

function combine(factors, weights) {
  const keys = Object.keys(factors);
  const total = keys.reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  const sum = keys.reduce((s, k) => s + (weights[k] ?? 0) * factors[k], 0);
  return Math.max(0, Math.min(100, Math.round((100 * sum) / total)));
}

export const DEFAULT_WEIGHTS = Object.freeze({
  contract_award: { value: 50, confidence: 25, relevance: 25 },
  hiring_spike: { velocity: 50, stack: 30, history: 20 },
  funding: { amount: 70, relevance: 30 },
});

/* ---------------------------------------------------------------- awards */

/**
 * @param {{ value: number|null, currency: string|null, confidence: 'awarded'|'tenderer', filterReason: string }} award
 * @param {{ threshold: number|null }} ctx  per-currency "major award" threshold
 */
export function scoreAward(award, { threshold }, weights = DEFAULT_WEIGHTS.contract_award) {
  const value = toNumberOrNull(award.value);
  const t = toNumberOrNull(threshold);
  const ratio = value !== null && t ? value / t : null;
  const vf = ratioFactor(ratio);
  const factors = {
    value: vf ?? UNKNOWN,
    confidence: award.confidence === 'tenderer' ? 0.6 : 1,
    relevance: { cpv: 1, keyword: 0.8, unfiltered: 0.6, 'cpv-not-published': 0.5 }[award.filterReason] ?? 0.5,
  };
  return {
    score: combine(factors, weights),
    rationale: {
      value: { input: value, currency: award.currency ?? null, threshold: t, ratio: ratio === null ? null : round2(ratio), unknown: vf === null, factor: round2(factors.value) },
      confidence: { input: award.confidence, factor: factors.confidence },
      relevance: { input: award.filterReason, factor: factors.relevance },
    },
  };
}

/* ---------------------------------------------------------------- spikes */

/**
 * @param {{ newInWindow: number, threshold: number, newStack: number|null, baselineWeekly: number|null }} spike
 *   newStack is null when no stack keywords are configured.
 */
export function scoreSpike(spike, weights = DEFAULT_WEIGHTS.hiring_spike) {
  const ratio = spike.threshold > 0 ? spike.newInWindow / spike.threshold : null;
  const stackShare = spike.newStack === null || spike.newInWindow === 0 ? null : spike.newStack / spike.newInWindow;
  const factors = {
    velocity: ratioFactor(ratio) ?? UNKNOWN,
    stack: stackShare === null ? 0.5 : clamp01(stackShare),
    history: spike.baselineWeekly === null ? 0.6 : 1,
  };
  return {
    score: combine(factors, weights),
    rationale: {
      velocity: { newInWindow: spike.newInWindow, threshold: spike.threshold, ratio: ratio === null ? null : round2(ratio), factor: round2(factors.velocity) },
      stack: { matching: spike.newStack, share: stackShare === null ? null : round2(stackShare), unknown: stackShare === null, factor: round2(factors.stack) },
      history: { baselineWeekly: spike.baselineWeekly, limited: spike.baselineWeekly === null, factor: factors.history },
    },
  };
}

/* --------------------------------------------------------------- funding */

export function scoreFunding(item, { threshold }, weights = DEFAULT_WEIGHTS.funding) {
  const amount = toNumberOrNull(item.amount);
  const t = toNumberOrNull(threshold);
  const ratio = amount !== null && t ? amount / t : null;
  const af = ratioFactor(ratio);
  const factors = { amount: af ?? UNKNOWN, relevance: item.matchedBy === 'alias' ? 0.8 : 1 };
  return {
    score: combine(factors, weights),
    rationale: {
      amount: { input: amount, currency: item.currency ?? null, threshold: t, ratio: ratio === null ? null : round2(ratio), unknown: af === null, factor: round2(factors.amount) },
      relevance: { input: item.matchedBy, factor: factors.relevance },
    },
  };
}

/* ---------------------------------------------------------------- angles */

/**
 * Suggested outreach angle: fixed templates filled only with known evidence.
 * No outreach is sent from B5; this is a prompt for the human (B14 later).
 */
export function suggestAngle(type, evidence) {
  if (type === 'contract_award') {
    const won = evidence.confidence === 'tenderer' ? 'is named on the award notice for' : 'has won';
    return `${evidence.company} ${won} "${evidence.title ?? 'a public contract'}"${evidence.buyer ? ` from ${evidence.buyer}` : ''}. `
      + 'Delivery teams usually need to scale within 2–12 weeks of an award: offer to help staff the programme before roles are advertised.';
  }
  if (type === 'hiring_spike') {
    const roles = evidence.sampleTitles?.length ? ` (e.g. ${evidence.sampleTitles.slice(0, 2).join(', ')})` : '';
    return `${evidence.company} opened ${evidence.newInWindow} new roles in ${evidence.windowDays} days${roles}. `
      + 'Offer support with the hardest-to-fill roles while the in-house team is stretched.';
  }
  return `${evidence.company} appears in funding news: "${evidence.title}". `
    + 'Newly funded teams typically hire ahead of the next milestone: offer a short call about the senior hires the round pays for.';
}