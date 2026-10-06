/**
 * Anonymise real OCDS fixtures before they are committed. Idempotent; rewrites files in place.
 *
 *   node test/fixtures/anonymise.mjs test/fixtures/<file>.json [...]
 *
 * - every party's contactPoint (a named person, email, phone) is replaced
 * - email addresses and UK phone numbers anywhere in the text are replaced
 * - a SUPPLIER that may be an individual or sole trader is renamed "Sole Trader N (anonymised)",
 *   its ids/identifiers and address are removed, and its name is replaced throughout the release.
 *   "May be" = no company/charity/NHS/education register number AND no organisation word in the name.
 *   This errs on the side of anonymising real firms (e.g. a partnership trading under surnames).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ORG_SCHEMES = new Set(['GB-COH', 'GB-CHC', 'GB-SC', 'GB-NIC', 'GB-NHS', 'GB-UKPRN', 'GB-EDU', 'GB-GOR', 'GB-LAE', 'GB-LAS']);
const ORG_WORDS = /\b(ltd|limited|llp|plc|lp|inc|incorporated|gmbh|ag|sa|sas|srl|bv|nv|oy|ab|as|co|company|group|corporation|corp|trust|council|university|college|school|nhs|cic|cio|association|society|partnership|partners|services|solutions|consult\w*|holdings|international|foundation|charity|church|authority|agency|federation|institute|hospital|academy|systems|technologies|technology|engineering|enterprises|industries|laboratories|labs|health|care|trading|uk)\b\.?/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// UK numbers: +44 or a leading 0, then 9-10 more digits with optional single spaces. No hyphens,
// so Find a Tender ids like "093068-2026" never match; id/url fields are skipped as well.
const PHONE = /(?:\+44\s?(?:\(0\)\s?)?|\b0)(?:\d\s?){8,9}\d\b/g;
const SKIP_KEYS = new Set(['id', 'ocid', 'awardID', 'relatedLot', 'relatedLots', 'url', 'uri', 'date', 'datePublished', 'endDate', 'startDate', 'dateSigned']);
const ANON_EMAIL = 'anonymised@example.invalid';

const isAnonymised = (name) => /\(anonymised\)$/.test(name ?? '');
const idsOf = (p) => [p?.identifier, ...(p?.additionalIdentifiers ?? [])].filter((i) => i?.id);

// Found by hand review: a person's name plus a business word, no register number. Stored as
// sha256(lower-cased name), first 16 hex chars, so this file does not itself publish the names.
const REVIEWED_INDIVIDUALS = new Set(['b13ba50aa1a2a481', '502517286762e8d3']);
const nameHash = (name) => createHash('sha256').update(String(name ?? '').trim().toLowerCase()).digest('hex').slice(0, 16);

/** Could this supplier be a person? */
export function maybeIndividual(party) {
  if (!party || isAnonymised(party.name)) return false;
  if (REVIEWED_INDIVIDUALS.has(nameHash(party.name))) return true;
  if (idsOf(party).some((i) => ORG_SCHEMES.has(i.scheme))) return false;
  return !ORG_WORDS.test(party.name ?? '') && !ORG_WORDS.test(party.identifier?.legalName ?? '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scrubText(value, names, key) {
  if (typeof value === 'string') {
    if (SKIP_KEYS.has(key) || /^https?:\/\//i.test(value)) return value.replace(EMAIL, ANON_EMAIL); // ids, links, dates: emails only
    let s = value.replace(EMAIL, ANON_EMAIL).replace(PHONE, '[phone removed]');
    for (const [from, to] of names) s = s.replace(new RegExp(escapeRe(from), 'gi'), to);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrubText(v, names, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubText(v, names, k)]));
  return value;
}

export function anonymiseRelease(release, counter, report) {
  const names = new Map(); // original name -> replacement
  const ids = new Map();   // original party id -> replacement
  for (const p of release.parties ?? []) {
    if (p.contactPoint) p.contactPoint = { name: 'Contact (anonymised)', email: ANON_EMAIL };
    if (p.roles?.includes('supplier') && maybeIndividual(p)) {
      const n = ++counter.n;
      const label = `Sole Trader ${n} (anonymised)`;
      report.push(`${release.id}: "${p.name}" -> "${label}"`);
      for (const nm of [p.name, p.identifier?.legalName]) if (nm && nm.length > 2) names.set(nm, label);
      ids.set(p.id, `ANON-SUPPLIER-${n}`);
      p.id = `ANON-SUPPLIER-${n}`;
      p.name = label;
      p.identifier = { legalName: label };
      delete p.additionalIdentifiers;
      p.address = p.address?.countryName ? { countryName: p.address.countryName } : undefined;
      if (!p.address) delete p.address;
    }
  }
  for (const p of release.parties ?? []) {
    if (isAnonymised(p.name) && p.details?.url) delete p.details.url; // a personal website names the person
  }
  for (const a of release.awards ?? []) {
    for (const s of a.suppliers ?? []) {
      if (ids.has(s.id)) { s.id = ids.get(s.id); s.name = names.get(s.name) ?? s.name; }
    }
  }
  return scrubText(release, names);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  for (const file of process.argv.slice(2)) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const report = [];
    const counter = { n: 0 };
    pkg.releases = pkg.releases.map((r) => anonymiseRelease(r, counter, report));
    writeFileSync(file, `${JSON.stringify(pkg, null, 1)}\n`);
    console.log(`${file}: ${report.length} supplier(s) anonymised`);
    for (const line of report) console.log(`  ${line}`);
  }
}
