/**
 * Scores a mover 0-100 against a matrix of four factors, each valued 0-1:
 *   market     how central the firm's market is to current mandates
 *   seniority  proxy from regulated role titles (SMF codes, RO, SEO, ...)
 *   firmTier   watchlist tier of the firm(s) involved (1 = top)
 *   tenure     time at the previous firm; mid-tenure moves score highest
 * score = 100 * sum(weight * factor) / sum(weight)
 */

export const DEFAULT_MATRIX = Object.freeze({
  weights: { market: 25, seniority: 35, firmTier: 25, tenure: 15 },

  markets: { UK: 1.0, DIFC: 0.9, ADGM: 0.9, SG: 0.85, HK: 0.8 },
  defaultMarket: 0.4,

  firmTiers: { 1: 1.0, 2: 0.65, 3: 0.35 },
  defaultTier: 0.2,

  // First match wins per role; the mover takes their most senior role.
  seniority: [
    [/\bSMF\s?(1|9)\b|chief executive|\bCEO\b|senior executive officer|\bSEO\b|\bchair(man|woman|person)?\b/i, 1.0],
    [/\bSMF\s?(2|3|4|6|7|24)\b|chief (financial|risk|operating|operations|investment)|\bC[FRIO]O\b|managing director|licensed (director|partner)|senior manager/i, 0.85],
    [/\bSMF\s?(5|16|17|18)\b|compliance (officer|oversight)|money laundering reporting|\bMLRO\b|finance officer|head of|responsible officer/i, 0.7],
    [/\bSMF\s?(10|11|12|13|14)\b|non-executive|independent director|\bdirector\b/i, 0.6],
    [/\bSMF\s?(27|29)\b|\bpartner\b|limited scope/i, 0.55],
    [/material risk taker|significant risk taker|certification|certified|\[PRA CF\]|\[FCA CF\]/i, 0.35],
    [/representative|registered individual|appointed/i, 0.25],
  ],
  defaultSeniority: 0.2,

  tenureBands: [
    { maxYears: 1, value: 0.35 },
    { maxYears: 3, value: 0.7 },
    { maxYears: 10, value: 1.0 },
    { maxYears: Infinity, value: 0.8 },
  ],
  unknownTenure: 0.5,
});

/** Shallow-merge overrides onto the default matrix (weights/markets/tiers merge by key). */
export function mergeMatrix(overrides = {}) {
  return {
    ...DEFAULT_MATRIX,
    ...overrides,
    weights: { ...DEFAULT_MATRIX.weights, ...overrides.weights },
    markets: { ...DEFAULT_MATRIX.markets, ...overrides.markets },
    firmTiers: { ...DEFAULT_MATRIX.firmTiers, ...overrides.firmTiers },
  };
}

const parseRoles = (json) => {
  if (!json) return [];
  try {
    const roles = JSON.parse(json);
    return Array.isArray(roles) ? roles : [];
  } catch {
    return [];
  }
};

export function seniorityOf(roles, matrix = DEFAULT_MATRIX) {
  let best = { value: matrix.defaultSeniority, role: roles[0]?.title ?? null };
  for (const role of roles) {
    const text = `${role.code ?? ''} ${role.title ?? ''}`;
    const hit = matrix.seniority.find(([pattern]) => pattern.test(text));
    if (hit && hit[1] > best.value) best = { value: hit[1], role: role.title };
  }
  return best;
}

export function tenureFactor(tenureDays, matrix = DEFAULT_MATRIX) {
  if (tenureDays === null || tenureDays === undefined) return matrix.unknownTenure;
  const years = tenureDays / 365.25;
  return matrix.tenureBands.find((band) => years <= band.maxYears)?.value ?? matrix.unknownTenure;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} mover - A row from the movers table.
 * @param {Map<string, {market: string, tier: number}>} firmsByKey - keyed "REGULATOR:REF".
 * @param {object} [matrix]
 * @returns {{ score: number, breakdown: object }}
 */
export function scoreMover(mover, firmsByKey, matrix = DEFAULT_MATRIX) {
  const key = (ref) => (ref ? `${mover.regulator}:${ref}` : null);
  const fromFirm = firmsByKey.get(key(mover.from_firm_ref));
  const toFirm = firmsByKey.get(key(mover.to_firm_ref));
  const primaryFirm = mover.change_type === 'leaver' ? fromFirm : toFirm ?? fromFirm;

  const market = primaryFirm?.market ?? null;
  const marketValue = matrix.markets[market] ?? matrix.defaultMarket;

  const tiers = [fromFirm?.tier, toFirm?.tier].filter((t) => t !== undefined);
  const tierValue = tiers.length
    ? Math.max(...tiers.map((t) => matrix.firmTiers[t] ?? matrix.defaultTier))
    : matrix.defaultTier;

  const roles = [...parseRoles(mover.roles_json), ...parseRoles(mover.prev_roles_json)];
  const seniority = seniorityOf(roles, matrix);
  const tenureValue = tenureFactor(mover.tenure_days, matrix);

  const factors = {
    market: marketValue,
    seniority: seniority.value,
    firmTier: tierValue,
    tenure: tenureValue,
  };

  const { weights } = matrix;
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const weighted = Object.entries(factors).reduce((sum, [k, v]) => sum + (weights[k] ?? 0) * v, 0);
  const score = Math.max(0, Math.min(100, Math.round((100 * weighted) / totalWeight)));

  return {
    score,
    breakdown: {
      market: { input: market, value: round2(marketValue) },
      seniority: { input: seniority.role, value: round2(seniority.value) },
      firmTier: { input: tiers.length ? Math.min(...tiers) : null, value: round2(tierValue) },
      tenure: {
        input: mover.tenure_days ?? null,
        estimate: Boolean(mover.tenure_is_estimate),
        value: round2(tenureValue),
      },
    },
  };
}