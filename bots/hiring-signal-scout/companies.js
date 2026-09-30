import { normalizeEntityId } from '@botarmy/core';

/** Trailing tokens that don't distinguish one company from another. */
const LEGAL_SUFFIXES = new Set([
  'limited', 'ltd', 'plc', 'llp', 'lp', 'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'pte', 'pty', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'spa', 'srl',
  'ab', 'as', 'oy', 'kk', 'holdings', 'holding', 'group', 'uk', 'international', 'services',
]);

/** Registration-number schemes in OCDS/TED identifiers that normalizeEntityId understands. */
const SCHEME_JURISDICTION = { 'GB-COH': 'UK', 'SG-ACRA': 'SG' };
const SPINE_COUNTRIES = new Set(['UK', 'SG', 'DIFC', 'ADGM']);

export function normalizeCompanyName(name) {
  const tokens = String(name ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1))) tokens.pop();
  return tokens.join(' ');
}

export function companyEntityId(company) {
  if (!company.registrationNumber || !SPINE_COUNTRIES.has(company.country)) return null;
  try {
    return normalizeEntityId(company.registrationNumber, company.country);
  } catch {
    return null;
  }
}

/**
 * Index watchlist companies for matching award suppliers. Matching is exact on
 * the normalised name (or an alias) or on a registration number, never
 * substring, so "Access" never matches "Access Bank".
 */
export function buildCompanyIndex(companies) {
  const byName = new Map();
  const byEntity = new Map();
  const collisions = [];

  for (const company of companies) {
    for (const label of [company.name, ...(company.aliases ?? [])]) {
      const key = normalizeCompanyName(label);
      if (!key) continue;
      const existing = byName.get(key);
      if (existing && existing.id !== company.id) collisions.push(`"${label}" matches both ${existing.id} and ${company.id}`);
      else byName.set(key, company);
    }
    const entityId = companyEntityId(company);
    if (entityId) byEntity.set(entityId, company);
  }

  return {
    collisions,
    /**
     * @param {{ name: string, identifiers?: { scheme?: string, id?: string }[] }} supplier
     * @returns {{ company: object, method: 'registration'|'name' } | null}
     */
    match(supplier) {
      for (const ident of supplier.identifiers ?? []) {
        const jurisdiction = SCHEME_JURISDICTION[String(ident.scheme ?? '').toUpperCase()];
        if (!jurisdiction || !ident.id) continue;
        try {
          const company = byEntity.get(normalizeEntityId(ident.id, jurisdiction));
          if (company) return { company, method: 'registration' };
        } catch {
          // malformed identifier in the notice; fall through to name matching
        }
      }
      const company = byName.get(normalizeCompanyName(supplier.name));
      return company ? { company, method: 'name' } : null;
    },
  };
}