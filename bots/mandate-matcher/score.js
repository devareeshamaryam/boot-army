/**
 * B2 scoring. Pure and deterministic: the same mover, firms, mandates and
 * weights always give the same score and the same rationale.
 *
 * score = round(100 × Σ weight·factor / Σ weight), every factor 0–1:
 *   market      how central the mover's market is
 *   seniority   proxy from regulated role titles (SMF codes, RO, SEO, …)
 *   firmTier    best watchlist tier of the firms involved (1 = top)
 *   tenure      time at the previous firm (mid-tenure moves score highest)
 *   mandateFit  best fit against an active mandate (omitted when no mandates are loaded)
 *
 * Unknown inputs are never invented: they get an explicit neutral value and
 * are flagged "unknown" in the rationale.
 */

export const DEFAULT_WEIGHTS = Object.freeze({ market: 20, seniority: 30, firmTier: 20, tenure: 10, mandateFit: 20 });

export const DEFAULT_MARKETS = Object.freeze({ UK: 1.0, DIFC: 0.9, ADGM: 0.9, SG: 0.85, HK: 0.8 });
export const UNKNOWN_MARKET = 0.4;

export const DEFAULT_TIERS = Object.freeze({ 1: 1.0, 2: 0.65, 3: 0.35 });
export const UNKNOWN_TIER = 0.2;

/** Seniority bands, most senior first. A mover takes the band of their most senior role. */
export const SENIORITY_BANDS = Object.freeze([
  { band: 'c-suite', value: 1.0, re: /\bSMF\s?(1|9)\b|chief executive|\bCEO\b|senior executive officer|\bSEO\b|\bchair(man|woman|person)?\b/i },
  { band: 'senior', value: 0.85, re: /\bSMF\s?(2|3|4|6|7|24)\b|chief (financial|risk|operating|operations|investment)|\bC[FRIO]O\b|managing director|licensed (director|partner)|senior manager/i },
  { band: 'control', value: 0.7, re: /\bSMF\s?(5|16|17|18)\b|compliance (officer|oversight)|money laundering reporting|\bMLRO\b|finance officer|head of|responsible officer/i },
  { band: 'board', value: 0.6, re: /\bSMF\s?(10|11|12|13|14)\b|non-executive|independent director|\bdirector\b/i },
  { band: 'partner', value: 0.55, re: /\bSMF\s?(27|29)\b|\bpartner\b|limited scope/i },
  { band: 'certified', value: 0.35, re: /material risk taker|significant risk taker|certification|certified|\[PRA CF\]|\[FCA CF\]/i },
  { band: 'representative', value: 0.25, re: /representative|registered individual|appointed/i },
]);
export const UNKNOWN_SENIORITY = { band: 'other', value: 0.2 };
const BAND_ORDER = ['other', ...SENIORITY_BANDS.map((b) => b.band).reverse()];

export const TENURE_BANDS = Object.freeze([
  { maxYears: 1, value: 0.35 },
  { maxYears: 3, value: 0.7 },
  { maxYears: 10, value: 1.0 },
  { maxYears: Infinity, value: 0.8 },
]);
export const UNKNOWN_TENURE = 0.5;

/** Strict number parse: null for empty, non-numeric or non-finite input. */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const round2 = (n) => Math.round(n * 100) / 100;
const roleText = (r) => `${r?.code ?? ''} ${r?.title ?? ''}`.trim();

/** Most senior band across roles. */
export function seniorityOf(roles = []) {
  let best = { ...UNKNOWN_SENIORITY, role: roles[0]?.title ?? null };
  for (const role of roles) {
    const hit = SENIORITY_BANDS.find((b) => b.re.test(roleText(role)));
    if (hit && hit.value > best.value) best = { band: hit.band, value: hit.value, role: role.title };
  }
  return best;
}

/** True if band a is at least as senior as band b. */
export const bandAtLeast = (a, b) => BAND_ORDER.indexOf(a) >= BAND_ORDER.indexOf(b);

export function tenureFactor(tenureDays) {
  const days = toNumberOrNull(tenureDays);
  if (days === null || days < 0) return { value: UNKNOWN_TENURE, years: null, unknown: true };
  const years = days / 365.25;
  return { value: TENURE_BANDS.find((b) => years <= b.maxYears).value, years: round2(years), unknown: false };
}

/* ------------------------------------------------------------- mandates */

/**
 * A mandate row (matrix table, parsed):
 *   { mandateId, client, title, markets: string[], minSeniority: band|null,
 *     licenceCategories: string[] (regex sources, case-insensitive), firmTiers: number[],
 *     exclusions: { firms?: string[] (firm keys), fromFirms?: string[] } }
 * Unset criteria are not counted; a mandate with no criteria never matches.
 */
export function mandateFit(mover, mandate) {
  const roles = [...(mover.roles ?? []), ...(mover.prevRoles ?? [])];
  const excludedFirms = new Set([...(mandate.exclusions?.firms ?? []), ...(mandate.exclusions?.fromFirms ?? [])]);
  if (mover.fromFirmKey && excludedFirms.has(mover.fromFirmKey)) return { excluded: true, met: 0, of: 0, fit: 0, criteria: {} };
  if ((mandate.exclusions?.firms ?? []).includes(mover.toFirmKey)) return { excluded: true, met: 0, of: 0, fit: 0, criteria: {} };

  const criteria = {};
  if (mandate.markets?.length) criteria.market = mandate.markets.includes(mover.market);
  if (mandate.minSeniority) criteria.seniority = bandAtLeast(seniorityOf(roles).band, mandate.minSeniority);
  if (mandate.licenceCategories?.length) {
    const patterns = mandate.licenceCategories.map((p) => new RegExp(p, 'i'));
    criteria.licence = roles.some((r) => patterns.some((re) => re.test(roleText(r))));
  }
  if (mandate.firmTiers?.length) criteria.firmTier = [mover.fromTier, mover.toTier].some((t) => mandate.firmTiers.includes(t));

  const of = Object.keys(criteria).length;
  const met = Object.values(criteria).filter(Boolean).length;
  return { excluded: false, met, of, fit: of ? met / of : 0, criteria };
}

/** Mandates the mover satisfies completely, best first (ties by mandate id for determinism). */
export function matchingMandates(mover, mandates) {
  return mandates
    .map((m) => ({ mandate: m, ...mandateFit(mover, m) }))
    .filter((r) => !r.excluded && r.of > 0)
    .sort((a, b) => b.fit - a.fit || String(a.mandate.mandateId).localeCompare(String(b.mandate.mandateId)));
}

/* ---------------------------------------------------------------- score */

/**
 * @param {object} mover   { kind, roles, prevRoles, market, fromFirmKey, toFirmKey, fromTier, toTier, tenureDays, tenureEstimate }
 * @param {object[]} mandates  parsed active mandates
 * @param {object} [scoring]  { weights, markets, tiers } overrides
 * @returns {{ score: number, rationale: object }}
 */
export function scoreMover(mover, mandates = [], scoring = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(scoring.weights ?? {}) };
  const markets = { ...DEFAULT_MARKETS, ...(scoring.markets ?? {}) };
  const tiers = { ...DEFAULT_TIERS, ...(scoring.tiers ?? {}) };

  const roles = [...(mover.roles ?? []), ...(mover.prevRoles ?? [])];
  const seniority = seniorityOf(roles);

  const marketKnown = Object.hasOwn(markets, mover.market ?? '');
  const market = { input: mover.market ?? null, value: marketKnown ? markets[mover.market] : UNKNOWN_MARKET, unknown: !marketKnown };

  const tierInputs = [mover.fromTier, mover.toTier].map(toNumberOrNull).filter((t) => t !== null);
  const tierValues = tierInputs.map((t) => tiers[t] ?? UNKNOWN_TIER);
  const firmTier = { input: tierInputs.length ? Math.min(...tierInputs) : null, value: tierValues.length ? Math.max(...tierValues) : UNKNOWN_TIER, unknown: !tierValues.length };

  const tenure = tenureFactor(mover.tenureDays);
  const matches = matchingMandates(mover, mandates);
  const best = matches[0];

  const factors = {
    market: market.value,
    seniority: seniority.value,
    firmTier: firmTier.value,
    tenure: tenure.value,
    ...(mandates.length ? { mandateFit: best ? best.fit : 0 } : {}),
  };
  const used = Object.keys(factors);
  const totalWeight = used.reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  const weighted = used.reduce((s, k) => s + (weights[k] ?? 0) * factors[k], 0);
  const score = Math.max(0, Math.min(100, Math.round((100 * weighted) / totalWeight)));

  return {
    score,
    rationale: {
      market: { ...market, value: round2(market.value) },
      seniority: { input: seniority.role, band: seniority.band, value: round2(seniority.value) },
      firmTier: { ...firmTier, value: round2(firmTier.value) },
      tenure: { input: toNumberOrNull(mover.tenureDays), years: tenure.years, estimate: Boolean(mover.tenureEstimate), unknown: tenure.unknown, value: round2(tenure.value) },
      ...(mandates.length ? { mandateFit: { value: round2(factors.mandateFit) } } : {}),
      weights: Object.fromEntries(used.map((k) => [k, weights[k] ?? 0])),
      mandates: matches.filter((m) => m.fit === 1).map((m) => ({ mandateId: m.mandate.mandateId, title: m.mandate.title, client: m.mandate.client })),
      nearMandates: matches.filter((m) => m.fit < 1 && m.fit >= 0.5).slice(0, 3)
        .map((m) => ({ mandateId: m.mandate.mandateId, title: m.mandate.title, met: m.met, of: m.of })),
    },
  };
}