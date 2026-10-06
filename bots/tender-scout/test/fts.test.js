/**
 * Find a Tender adapter against REAL releases from 1 Oct 2026 (test/fixtures/fts-2026-10-01.json,
 * 28 releases, anonymised). Anything synthetic is built inline and says so.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { http } from '@botarmy/core';
import { fetchReleases, findATender, ingest, runHarvest } from '../harvest.js';
import { extractAwards, normaliseTender, supplierIdentifier } from '../normalise.js';
import { getWatermark, newAwardsSince, openDb, openNotices } from '../db.js';
import { fixture, response } from './helpers.js';

const pkg = fixture('fts-2026-10-01.json');
const rel = (id) => pkg.releases.find((r) => r.id === id);
const FTS = { source: 'find-a-tender' };
const NOW = '2026-10-02T06:00:00.000Z';
const freshDb = () => openDb({ dryRun: true, dataDir: mkdtempSync(path.join(tmpdir(), 'tender-scout-')) });
const count = (db, sql, ...args) => db.prepare(sql).pluck().get(...args);

afterEach(() => http.setFetch());

test('classify by tag: tender*, award/contract with awards, everything else raw only', () => {
  const kinds = pkg.releases.reduce((m, r) => { const k = findATender.classify(r) ?? 'other'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  assert.deepEqual(kinds, { award: 14, tender: 12, other: 2 });
  assert.equal(findATender.classify(rel('093027-2026')), null);       // planning
  assert.equal(findATender.classify(rel('092635-2026')), 'tender');   // tenderCancellation
  assert.equal(findATender.classify(rel('093035-2026')), 'award');    // awardUpdate,contractUpdate
});

test('search URL: update-time window, no stage filter', () => {
  const u = new URL(findATender.searchUrl({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }));
  assert.equal(u.pathname, '/api/1.0/ocdsReleasePackages');
  assert.equal(u.searchParams.get('updatedFrom'), '2026-10-01T00:00:00Z');
  assert.equal(u.searchParams.get('updatedTo'), '2026-10-02T00:00:00Z');
  assert.equal(u.searchParams.get('stages'), null);
});

test('tender: value, deadline, CPV from items[].additionalClassifications, NUTS codes -> regions, link', () => {
  const n = normaliseTender(rel('093062-2026'), FTS); // tenderUpdate, no tender.classification
  assert.deepEqual(n.cpv_codes, ['72000000']);
  assert.deepEqual(n.regions, ['Wales']);
  assert.deepEqual(n.regions_raw, ['UKL']);
  assert.equal(n.value_amount, 220000);
  assert.equal(n.deadline, null);
  assert.equal(n.link, 'https://www.find-tender.service.gov.uk/Notice/093062-2026');
  assert.equal(n.release_seq, 2026093062);

  assert.deepEqual(normaliseTender(rel('093024-2026'), FTS).regions, ['Scotland']);      // UKM75 = Edinburgh
  assert.deepEqual(normaliseTender(rel('092959-2026'), FTS).regions, ['United Kingdom']); // "UK"
  assert.equal(normaliseTender(rel('093054-2026'), FTS).regions.length, 9);              // every English region
  assert.equal(normaliseTender(rel('093032-2026'), FTS).deadline, '2026-11-06T12:00:00.000Z');
});

test('tender: £1 placeholder, missing value, and cancellation statuses', () => {
  assert.equal(normaliseTender(rel('092671-2026'), FTS).value_placeholder, true);
  assert.equal(normaliseTender(rel('093024-2026'), FTS).value_amount, null);
  assert.equal(normaliseTender(rel('092635-2026'), FTS).status, 'cancelled'); // tenderCancellation with no status
  assert.equal(normaliseTender(rel('092782-2026'), FTS).status, 'withdrawn');
});

test('tender: value summed from lots when tender.value is absent (SYNTHETIC: not seen on 1 Oct)', () => {
  const r = { ocid: 'ocds-x', id: '000001-2026', tag: ['tender'], tender: { lots: [{ value: { amount: 100, currency: 'GBP' }, tenderPeriod: { endDate: '2026-11-02T12:00:00Z' } }, { value: { amount: 250, currency: 'GBP' } }] } };
  const n = normaliseTender(r, FTS);
  assert.equal(n.value_amount, 350);
  assert.equal(n.deadline, '2026-11-02T12:00:00.000Z');
});

test('ingest: tender then tenderUpdate on one ocid keeps the update; cancelled tenders are not open', () => {
  const db = freshDb();
  ingest(db, findATender, 'all', pkg.releases, NOW);
  assert.equal(count(db, `SELECT tag FROM notices WHERE release_id = '093053-2026'`), 'tenderUpdate');
  assert.equal(count(db, `SELECT COUNT(*) FROM notices WHERE ocid = ?`, rel('093043-2026').ocid), 1);
  const open = openNotices(db, NOW).map((n) => n.release_id);
  for (const closed of ['092635-2026', '092782-2026', '092929-2026']) assert.ok(!open.includes(closed), closed);
  assert.equal(count(db, `SELECT COUNT(*) FROM releases WHERE stage = 'other'`), 2); // planning + contractTermination kept raw
  db.close();
});

test('awards: Companies House preferred, PPON otherwise, an id without a scheme is not guessed', () => {
  const coh = extractAwards(rel('093047-2026'), FTS)[0];
  assert.equal(coh.supplier_scheme, 'GB-COH');
  assert.equal(coh.supplier_name, 'TURNER & TOWNSEND PROJECT MANAGEMENT LIMITED');
  assert.equal(coh.supplier_identifier, '02165592');

  const ppon = extractAwards(rel('093049-2026'), FTS)[0];
  assert.equal(ppon.supplier_scheme, 'GB-PPON');
  assert.equal(ppon.status, 'pending');

  const bare = extractAwards(rel('092971-2026'), FTS)[0];
  assert.equal(bare.supplier_scheme, null);
  assert.equal(bare.supplier_identifier, '00928555');

  assert.deepEqual(supplierIdentifier({ identifier: { scheme: 'GB-PPON', id: 'P1' }, additionalIdentifiers: [{ scheme: 'GB-COH', id: '123' }] }), { scheme: 'GB-COH', id: '123' });
});

test('awards: value and date fall back to the contract; many suppliers per award', () => {
  const contractOnly = extractAwards(rel('093061-2026'), FTS)[0];
  assert.equal(contractOnly.award_date, '2026-09-25T00:00:00.000Z');
  const big = extractAwards(rel('093037-2026'), FTS);
  assert.equal(big.length, 63);
  assert.equal(new Set(big.map((a) => a.award_id)).size, 2);
  assert.equal(big.filter((a) => a.supplier_name.endsWith('(anonymised)')).length, 14);
});

test('awards: several award notices under one ocid are all kept', () => {
  const db = freshDb();
  ingest(db, findATender, 'all', ['093068-2026', '093067-2026', '093066-2026'].map(rel), NOW);
  // 34 + 11 award/supplier rows (093066 names no suppliers). Some award ids appear in both
  // notices with different suppliers, so there are fewer distinct award ids than rows.
  assert.equal(count(db, `SELECT COUNT(*) FROM awards`), 45);
  assert.equal(count(db, `SELECT COUNT(DISTINCT award_id) FROM awards`), 41);
  db.close();
});

test('newAwardsSince leaves out cancelled/unsuccessful awards unless asked (SYNTHETIC statuses)', () => {
  const db = freshDb();
  const base = rel('093047-2026');
  const withStatus = (status, id) => ({ ...base, id, awards: base.awards.map((a) => ({ ...a, id: `${a.id}-${status}`, status })) });
  ingest(db, findATender, 'all', [withStatus('active', '900001-2026'), withStatus('cancelled', '900002-2026'), withStatus('unsuccessful', '900003-2026')], NOW);
  assert.deepEqual(newAwardsSince(db, '2026-01-01T00:00:00Z').map((a) => a.status), ['active']);
  assert.equal(newAwardsSince(db, '2026-01-01T00:00:00Z', { includeNotWon: true }).length, 3);
  db.close();
});

test('runHarvest: one "all" window per run, cursor paging, own watermark', async () => {
  const db = freshDb();
  const calls = [];
  http.setFetch(async (url) => {
    calls.push(url);
    const cursor = new URL(url).searchParams.get('cursor');
    return cursor
      ? response({ releases: pkg.releases.slice(14) })
      : response({ releases: pkg.releases.slice(0, 14), links: { next: `${findATender.baseUrl}/api/1.0/ocdsReleasePackages?cursor=abc` } });
  });
  const r = await runHarvest(db, { adapters: [findATender], stages: ['award'], now: NOW, httpOptions: { minIntervalMs: 0 } });
  assert.equal(calls.length, 2);
  assert.equal(r['find-a-tender'].all.fetched, 28);
  assert.equal(getWatermark(db, 'find-a-tender', 'all'), NOW);
  assert.ok(count(db, `SELECT COUNT(*) FROM notices`) > 0); // --stages does not filter Find a Tender
  db.close();
});

test('the shared window splitter also guards Find a Tender', async () => {
  let n = 0;
  http.setFetch(async () => response({ releases: Array.from({ length: ++n === 1 ? 100 : 5 }, (_, i) => ({ ...pkg.releases[0], id: `${n}-${i}` })) }));
  const got = await fetchReleases(findATender, { stage: 'all', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', httpOptions: { minIntervalMs: 0 } });
  assert.equal(got.length, 10);
});
