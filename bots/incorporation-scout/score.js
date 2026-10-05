/**
 * B7 scoring. Pure and deterministic: the same company, watchlist and
 * officer summary always give the same score and the same reasons.
 *
 * score = round(100 × Σ weight·factor / Σ weight), every factor 0–1:
 *   sic        how precisely the company's SIC codes hit the watchlist
 *              (exact 5-digit code 1.0 · 4-digit class 0.7 · 2-digit division 0.4)
 *   directors  the board setup: individual directors suggest a real venture;
 *              corporate-only or nominee directors suggest a vehicle or shell
 *   geography  registered office against the watchlist's regions. A known
 *              formation-agent address says nothing about where the business is,
 *              so it scores low rather than matching
 *
 * New incorporations are mostly shells, so this scores lightly: a lead needs a
 * good SIC fit AND a credible board to reach the top of a digest. Missing data
 * is an explicit "unknown" with a fixed neutral value; nothing is estimated.
 */

export const DEFAULT_WEIGHTS = Object.freeze({ sic: 45, directors: 30, geography: 25 });
export const UNKNOWN = Object.freeze({ sic: 0.3, directors: 0.5, geography: 0.5 });
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- SIC */

/** Only 5-digit codes, 4-digit classes and 2-digit divisions are meaningful SIC entries. */
export const isSicEntry = (s) => /^\d{2}$|^\d{4}$|^\d{5}$/.test(String(s));
const SIC_LEVEL = { 5: { value: 1.0, label: 'exact code' }, 4: { value: 0.7, label: 'class' }, 2: { value: 0.4, label: 'division' } };

/**
 * Best match between a company's SIC codes and a watchlist's entries.
 * @returns {{ entry: string, code: string, value: number, label: string } | null}
 */
export function bestSicMatch(companyCodes, entries) {
  let best = null;
  for (const code of companyCodes ?? []) {
    const c = String(code);
    if (!/^\d{5}$/.test(c)) continue;
    for (const entry of entries ?? []) {
      const e = String(entry);
      if (!isSicEntry(e) || !c.startsWith(e)) continue;
      const level = SIC_LEVEL[e.length];
      if (!best || level.value > best.value || (level.value === best.value && e.localeCompare(best.entry) < 0)) {
        best = { entry: e, code: c, value: level.value, label: level.label };
      }
    }
  }
  return best;
}

function sicFactor(company, watchlist) {
  if (!company.sicCodes?.length) return { value: UNKNOWN.sic, unknown: true, input: [], note: 'no SIC codes published' };
  const m = bestSicMatch(company.sicCodes, watchlist.sicCodes);
  if (!m) return { value: 0, unknown: false, input: company.sicCodes, note: 'no SIC code on the watchlist' };
  return { value: m.value, unknown: false, input: company.sicCodes, matched: m.entry, note: `${m.code} matches ${m.entry} (${m.label})` };
}

/* ----------------------------------------------------------- directors */

/**
 * Summarise an officer list into counts by role. Names are deliberately dropped.
 * @param {{ officer_role?: string, resigned_on?: string }[]} officers
 */
export function summariseOfficers(officers) {
  const current = (officers ?? []).filter((o) => !o?.resigned_on);
  const role = (o) => String(o?.officer_role ?? '');
  const isDirector = (o) => /director/.test(role(o));
  return {
    directors: current.filter(isDirector).length,
    individualDirectors: current.filter((o) => isDirector(o) && !/corporate/.test(role(o)) && !/nominee/.test(role(o))).length,
    corporateDirectors: current.filter((o) => /corporate/.test(role(o)) && isDirector(o)).length,
    nomineeDirectors: current.filter((o) => /nominee/.test(role(o)) && isDirector(o)).length,
    secretaries: current.filter((o) => /secretary/.test(role(o))).length,
  };
}

function directorsFactor(summary) {
  if (!summary) return { value: UNKNOWN.directors, unknown: true, input: null, note: 'officers not looked up yet' };
  const s = summary;
  if (!s.directors) return { value: 0.2, unknown: false, input: s, note: 'no current directors listed' };
  if (s.nomineeDirectors) return { value: 0.2, unknown: false, input: s, note: `${s.nomineeDirectors} nominee director(s): likely a vehicle` };
  if (!s.individualDirectors) return { value: 0.3, unknown: false, input: s, note: 'corporate directors only: likely a vehicle or subsidiary' };
  if (s.corporateDirectors) return { value: 0.6, unknown: false, input: s, note: `${s.individualDirectors} individual + ${s.corporateDirectors} corporate director(s)` };
  if (s.individualDirectors > 5) return { value: 0.7, unknown: false, input: s, note: `${s.individualDirectors} individual directors: unusually large founding board` };
  return { value: 0.9, unknown: false, input: s, note: `${s.individualDirectors} individual director(s)` };
}

/* ----------------------------------------------------------- geography */

const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Postcode area ("EC") and district ("EC1A") of a UK postcode, or null. */
export function postcodeParts(postcode) {
  const m = norm(postcode).replace(/\s+/g, '').match(/^([A-Z]{1,2})(\d[A-Z\d]?)(\d[A-Z]{2})$/);
  return m ? { area: m[1], district: `${m[1]}${m[2]}` } : null;
}

/**
 * A region entry matches a postcode district/area ("EC1A", "EC", "M"),
 * or a town/region name as a whole word ("Manchester", "Greater London").
 */
export function regionMatch(company, regions) {
  const pc = postcodeParts(company.roPostcode);
  const text = ` ${norm([company.roLocality, company.roRegion].filter(Boolean).join(' '))} `;
  for (const r of regions ?? []) {
    const e = norm(r);
    if (!e) continue;
    if (pc && /^[A-Z]{1,2}(\d[A-Z\d]?)?$/.test(e) && (pc.district === e || pc.area === e)) return { entry: r, via: 'postcode' };
    if (text.includes(` ${e} `)) return { entry: r, via: 'name' };
  }
  return null;
}

const UK_COUNTRIES = /^(UNITED KINGDOM|UK|ENGLAND|WALES|SCOTLAND|NORTHERN IRELAND|ENGLAND AND WALES|GREAT BRITAIN)$/;

function geographyFactor(company, watchlist) {
  if (company.formationAgent) return { value: 0.2, unknown: false, input: company.roPostcode ?? null, note: `registered at a formation agent's address (${company.formationAgent}): location unknown` };
  if (!company.roPostcode && !company.roLocality && !company.roRegion) return { value: UNKNOWN.geography, unknown: true, input: null, note: 'registered office not published' };
  if (!watchlist.regions?.length) return { value: 0.6, unknown: false, input: company.roPostcode ?? company.roLocality, note: 'watchlist has no regions: any UK location' };
  const m = regionMatch(company, watchlist.regions);
  if (m) return { value: 1.0, unknown: false, input: company.roPostcode ?? company.roLocality, matched: m.entry, note: `registered office in ${m.entry}` };
  const country = norm(company.roCountry);
  if (country && !UK_COUNTRIES.test(country)) return { value: 0.2, unknown: false, input: company.roCountry, note: `registered office outside the UK (${company.roCountry})` };
  return { value: 0.4, unknown: false, input: company.roPostcode ?? company.roLocality, note: 'UK, outside the watchlist regions' };
}

/* --------------------------------------------------------------- score */

/**
 * @param {object} company    { sicCodes, roPostcode, roLocality, roRegion, roCountry, formationAgent }
 * @param {object} watchlist  { sicCodes, regions, weights }
 * @param {object|null} officersSummary  from summariseOfficers(), or null if not looked up
 * @returns {{ score: number, reasons: object }}
 */
export function scoreLead(company, watchlist, officersSummary) {
  const weights = { ...DEFAULT_WEIGHTS, ...(watchlist.weights ?? {}) };
  const factors = {
    sic: sicFactor(company, watchlist),
    directors: directorsFactor(officersSummary),
    geography: geographyFactor(company, watchlist),
  };
  const total = Object.keys(factors).reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  const reasons = {};
  let raw = 0;
  for (const [k, f] of Object.entries(factors)) {
    const contribution = (100 * (weights[k] ?? 0) * f.value) / total;
    raw += contribution;
    reasons[k] = { ...f, value: round2(f.value), weight: weights[k] ?? 0, points: round2(contribution) };
  }
  return { score: Math.max(0, Math.min(100, Math.round(raw))), reasons };
}