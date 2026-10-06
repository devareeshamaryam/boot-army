/**
 * Normaliser against REAL Contracts Finder releases (test/fixtures), plus one
 * synthetic multi-supplier award (none occurred in the real sample).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, extractAwards, normaliseTender, releaseSeq, toUtc } from '../normalise.js';
import { awardPackage, byOcid, tenderPackage } from './helpers.js';

const tenders = tenderPackage();
const awards = awardPackage();

test('every real tender release normalises with ocid, dates and a link', () => {
  for (const r of tenders.releases) {
    const n = normaliseTender(r);
    assert.ok(n.ocid && n.release_id && n.release_date && n.published_at && n.link, `incomplete: ${r.id}`);
    assert.ok(n.cpv_codes.length > 0, `real tenders carry CPV in tender.classification: ${r.id}`);
  }
});

test('tenderAmendment with value, deadline (BST -> UTC), CPV and notice link', () => {
  const n = normaliseTender(byOcid(tenders, '6fec036fe46d'));
  assert.equal(n.tag, 'tenderAmendment');
  assert.match(n.title, /^Radford House - Internal Refurbishment/);
  assert.equal(n.buyer_name, 'Ramsgate Town Council');
  assert.equal(n.buyer_key, 'ramsgate town council');
  assert.equal(n.value_amount, 500000);
  assert.equal(n.value_currency, 'GBP');
  assert.equal(n.deadline, '2026-10-14T22:00:00.000Z');
  assert.deepEqual(n.cpv_codes, ['45000000']);
  assert.match(n.link, /^https:\/\/www\.contractsfinder\.service\.gov\.uk\/Notice\/.*65eeb575e6f7$/);
  assert.equal(n.release_seq, 916296);
});

test('missing value is null and NOT a placeholder; £1 is a placeholder', () => {
  const none = normaliseTender(byOcid(tenders, '457080163247'));
  assert.equal(none.value_amount, null);
  assert.equal(none.value_placeholder, false);
  const pound = normaliseTender(byOcid(tenders, '6bebde6d7121')); // Chemonics, published as £1
  assert.equal(pound.value_amount, null);
  assert.equal(pound.value_placeholder, true);
});

test('regions: empty "" entries dropped, real ones kept', () => {
  assert.deepEqual(normaliseTender(byOcid(tenders, 'cdc9f700c2d9')).regions, []);
  assert.deepEqual(normaliseTender(byOcid(tenders, '0e37dd5f290b')).regions, ['England']);
  assert.deepEqual(normaliseTender(byOcid(tenders, 'a5a6797e780d')).regions, ['North West']);
});

test('zero-width characters are stripped from titles; Z deadlines stay UTC', () => {
  assert.match(normaliseTender(byOcid(tenders, '9016a7c75998')).title, /^Renewable Energy/);
  assert.equal(normaliseTender(byOcid(tenders, 'cdc9f700c2d9')).deadline, '2026-10-29T12:00:00.000Z');
});

test('a bare release does not throw and reports nulls, not zeros', () => {
  const n = normaliseTender({ ocid: 'ocds-x', id: 'r-1' });
  assert.equal(n.value_amount, null);
  assert.equal(n.deadline, null);
  assert.equal(n.title, null);
  assert.deepEqual(n.cpv_codes, []);
  assert.equal(normaliseTender({ id: 'no-ocid' }), null);
  assert.deepEqual(extractAwards({ ocid: 'ocds-x', id: 'r-1' }), []);
});

test('helpers: toUtc, cleanText, releaseSeq', () => {
  assert.equal(toUtc('2026-10-01T20:32:52+01:00'), '2026-10-01T19:32:52.000Z');
  assert.equal(toUtc('not a date'), null);
  assert.equal(cleanText('​​  a   b '), 'a b');
  assert.equal(releaseSeq('91ac2c18-297c-4746-a349-4c78d487a796-916299'), 916299);
});

test('awards: one row per real award release, Companies House number from parties[]', () => {
  const rows = awards.releases.flatMap((r) => extractAwards(r));
  assert.equal(rows.length, awards.releases.length); // every real award had exactly one supplier

  const rsk = extractAwards(byOcid(awards, '746d1fd6bce9'))[0];
  assert.equal(rsk.supplier_name, 'RSK ADAS LIMITED');
  assert.equal(rsk.supplier_scheme, 'GB-COH');
  assert.equal(rsk.supplier_identifier, '10486936');
  assert.equal(rsk.value_amount, 19948);
  assert.equal(rsk.award_date, '2026-08-13T23:00:00.000Z');
  assert.match(rsk.link, /contractsfinder\.service\.gov\.uk\/Notice\//);

  const llp = extractAwards(byOcid(awards, 'cd92c3fd7064'))[0];
  assert.equal(llp.supplier_identifier, 'OC369631');

  const noId = extractAwards(byOcid(awards, 'a472706dc85b'))[0]; // anonymised supplier: only legalName
  assert.equal(noId.supplier_scheme, null);
  assert.equal(noId.supplier_identifier, null);
  assert.equal(noId.supplier_key, 'ANON-SUPPLIER-1');
  assert.equal(noId.supplier_name, 'Sole Trader 1 (anonymised)');
});

test('awards: £0 award value is a placeholder -> null', () => {
  assert.equal(extractAwards(byOcid(awards, '7ca8d8db67b9'))[0].value_amount, null);
});

test('awards: two award notices under one ocid stay separate rows (award ids -1 and -2)', () => {
  const hologic = awards.releases.filter((r) => r.ocid.endsWith('9ebb62f4d39a')).flatMap((r) => extractAwards(r));
  assert.deepEqual(new Set(hologic.map((a) => a.award_id.slice(-2))), new Set(['-1', '-2']));
});

test('awards: multiple suppliers per award and multiple awards per release (SYNTHETIC)', () => {
  const release = {
    ocid: 'ocds-test-1', id: 'abc-100', date: '2026-10-01T10:00:00Z', tag: ['award'],
    buyer: { id: 'B1', name: 'Test Council' },
    tender: { title: 'Framework', classification: { scheme: 'CPV', id: '79620000' } },
    parties: [
      { id: 'GB-COH-00000001', name: 'One Ltd', identifier: { scheme: 'GB-COH', id: '00000001', legalName: 'One Ltd' }, roles: ['supplier'] },
      { id: 'GB-CFS-2', name: 'Two Ltd', identifier: { legalName: 'Two Ltd' }, roles: ['supplier'] },
    ],
    awards: [
      { id: 'ocds-test-1-1', value: { amount: 1000, currency: 'GBP' }, suppliers: [{ id: 'GB-COH-00000001', name: 'One Ltd' }, { id: 'GB-CFS-2', name: 'Two Ltd' }] },
      { id: 'ocds-test-1-2', suppliers: [{ name: 'Three Ltd' }] },
    ],
  };
  const rows = extractAwards(release);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.award_id, r.supplier_key, r.supplier_identifier]), [
    ['ocds-test-1-1', 'GB-COH-00000001', '00000001'],
    ['ocds-test-1-1', 'GB-CFS-2', null],
    ['ocds-test-1-2', 'three ltd', null],
  ]);
  assert.equal(rows[2].value_amount, null);
  assert.deepEqual(rows[0].cpv_codes, ['79620000']);
});
