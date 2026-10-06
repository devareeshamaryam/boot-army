/** Region lookup: codes (NUTS / ITL) and names -> profile region names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGION_NAMES, canonicalRegion, regionFromCode, regionMatches, toRegion } from '../regions.js';
import { validateProfiles } from '../profiles.js';
import { score } from '../score.js';

// Official lists, fetched 2026-10-06:
//   ONS ITL1_JAN_2025_UK_NC                       Eurostat NUTS 2016 / 2021 level 1
const OFFICIAL = [
  ['TLC', 'North East (England)', 'UKC'], ['TLD', 'North West (England)', 'UKD'], ['TLE', 'Yorkshire and The Humber', 'UKE'],
  ['TLF', 'East Midlands (England)', 'UKF'], ['TLG', 'West Midlands (England)', 'UKG'], ['TLH', 'East (England)', 'UKH'],
  ['TLI', 'London', 'UKI'], ['TLJ', 'South East (England)', 'UKJ'], ['TLK', 'South West (England)', 'UKK'],
  ['TLL', 'Wales', 'UKL'], ['TLM', 'Scotland', 'UKM'], ['TLN', 'Northern Ireland', 'UKN'],
];

test('every official ITL1 code, its NUTS twin and its ONS name map to the same region', () => {
  for (const [itl, onsName, nuts] of OFFICIAL) {
    const name = regionFromCode(itl);
    assert.ok(name, itl);
    assert.equal(regionFromCode(nuts), name, nuts);
    assert.equal(canonicalRegion(onsName), name, onsName);
  }
  assert.equal(new Set(OFFICIAL.map(([c]) => regionFromCode(c))).size, 12);
});

test('deeper codes map by their ITL1 letter; UK is the whole country; unknown codes are null', () => {
  assert.equal(regionFromCode('UKM75'), 'Scotland');   // Edinburgh (seen in Find a Tender)
  assert.equal(regionFromCode('UKK24'), 'South West'); // NUTS 2021 only (seen in Find a Tender)
  assert.equal(regionFromCode('UKI45'), 'London');
  assert.equal(regionFromCode('TLI3'), 'London');
  assert.equal(regionFromCode('UK'), 'United Kingdom');
  assert.equal(regionFromCode('UKZ'), null);           // extra-regio
  assert.equal(regionFromCode('London'), null);
});

test('names: Contracts Finder spellings and aliases', () => {
  assert.equal(toRegion('Yorkshire and the Humber'), 'Yorkshire and The Humber');
  assert.equal(toRegion('East of England'), 'East of England');
  assert.equal(toRegion('england'), 'England');
  assert.equal(toRegion('Narnia'), null);
  assert.deepEqual(REGION_NAMES.slice(-2), ['England', 'United Kingdom']);
});

test('matching: equal, or one region contains the other', () => {
  assert.ok(regionMatches('London', 'London'));
  assert.ok(regionMatches('United Kingdom', 'London')); // UK-wide notice suits a London profile
  assert.ok(regionMatches('England', 'London'));
  assert.ok(regionMatches('London', 'England'));        // London notice suits an England profile
  assert.ok(!regionMatches('Scotland', 'England'));
  assert.ok(!regionMatches('England', 'Scotland'));
  assert.ok(!regionMatches('North West', 'London'));
});

test('profiles: region names are validated and canonicalised', () => {
  const base = { entity: 'x', name: 'X', slackWebhookEnv: 'X', keywords: { include: ['a'] } };
  assert.deepEqual(validateProfiles({ profiles: [{ ...base, regions: ['london', 'East (England)'] }] })[0].regions, ['London', 'East of England']);
  assert.throws(() => validateProfiles({ profiles: [{ ...base, regions: ['Londn'] }] }), /regions\[0\]: unknown region "Londn"/);
});

test('scoring: no region is a gap, an unmapped code is a gap, a different region is a mismatch', () => {
  const [p] = validateProfiles({ profiles: [{ entity: 'x', name: 'X', slackWebhookEnv: 'X', keywords: { include: ['cleaning'] }, regions: ['London'] }] });
  const n = (regions, raw = regions) => ({ title: 'Office cleaning', description: '', cpv_codes: [], regions, regions_raw: raw, published_at: '2026-10-05T00:00:00Z' });
  const now = '2026-10-06T00:00:00Z';
  const rel = (r) => r.breakdown.find((b) => b.component === 'relevance');

  const none = score(n([]), p, { now });
  assert.ok(none.gaps.includes('region not published'));
  const unmapped = score(n([], ['UKZ']), p, { now });
  assert.ok(unmapped.gaps.includes('region not recognised (UKZ)'));
  assert.equal(rel(none).points, rel(unmapped).points);

  const ukWide = score(n(['United Kingdom'], ['UK']), p, { now });
  assert.match(rel(ukWide).reason, /in United Kingdom/);
  const elsewhere = score(n(['Scotland'], ['UKM75']), p, { now });
  assert.match(rel(elsewhere).reason, /region Scotland not in your list/);
  assert.ok(rel(elsewhere).points < rel(none).points && rel(none).points < rel(ukWide).points);
});
