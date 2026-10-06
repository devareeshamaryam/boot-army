/**
 * UK regions: one set of human names for profiles, and the code lookup for notices.
 *
 * Names are the 12 ITL1 regions plus England and United Kingdom. Codes map by their
 * first letter after the prefix, which is the same in both schemes we see:
 *   NUTS (Find a Tender, e.g. "UKM75")  and  ITL 2025 ("TLM...").
 * Verified 2026-10-06 against ONS ITL1_JAN_2025_UK_NC (TLC..TLN) and Eurostat
 * NUTS 2016/2021 (UKC..UKN, "UK" = United Kingdom). See README for what is not verified.
 */

export const UK = 'United Kingdom';
export const ENGLAND = 'England';

/** ITL1 / NUTS1 letter -> name used in profiles. */
const ITL1 = {
  C: 'North East', D: 'North West', E: 'Yorkshire and The Humber', F: 'East Midlands', G: 'West Midlands',
  H: 'East of England', I: 'London', J: 'South East', K: 'South West', L: 'Wales', M: 'Scotland', N: 'Northern Ireland',
};
const IN_ENGLAND = new Set('CDEFGHIJK'.split('').map((l) => ITL1[l]));

export const REGION_NAMES = Object.freeze([...Object.values(ITL1), ENGLAND, UK]);

// Other spellings seen in official lists (ONS uses "North East (England)", "East (England)")
// and in Contracts Finder ("Yorkshire and the Humber").
const ALIASES = new Map([
  ...REGION_NAMES.map((n) => [n.toLowerCase(), n]),
  ...Object.values(ITL1).filter((n) => IN_ENGLAND.has(n)).map((n) => [`${n.toLowerCase()} (england)`, n]),
  ['east (england)', ITL1.H], ['east', ITL1.H], ['eastern', ITL1.H],
  ['uk', UK], ['great britain', UK],
]);

/** A region name in any known spelling -> its canonical name, or null. */
export function canonicalRegion(name) {
  return ALIASES.get(String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()) ?? null;
}

/** "UKM75" / "TLI3" / "UK" -> region name, or null when the code is not recognised (e.g. UKZ extra-regio). */
export function regionFromCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (c === 'UK' || c === 'TL') return UK;
  const m = c.match(/^(?:UK|TL)([C-N])/);
  return m ? ITL1[m[1]] : null;
}

/** A notice's region value (code or name) -> canonical name, or null. */
export const toRegion = (value) => regionFromCode(value) ?? canonicalRegion(value);

const parentOf = (name) => (name === UK ? null : IN_ENGLAND.has(name) ? ENGLAND : UK);
const ancestors = (name) => {
  const out = [];
  for (let p = parentOf(name); p; p = parentOf(p)) out.push(p);
  return out;
};

/**
 * Does a notice region satisfy a profile region? Yes if equal, or if one contains the
 * other: a UK-wide or England-wide notice suits a "London" profile, and a London notice
 * suits an "England" profile.
 */
export function regionMatches(noticeRegion, profileRegion) {
  return noticeRegion === profileRegion
    || ancestors(profileRegion).includes(noticeRegion)
    || ancestors(noticeRegion).includes(profileRegion);
}
