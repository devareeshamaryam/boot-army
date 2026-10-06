/**
 * Harvest: pagination, retry/backoff, idempotency, watermark. No live network:
 * core.http.setFetch() serves pages built from the real fixtures.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { http } from '@botarmy/core';
import { apiTime, contractsFinder, fetchReleases, ingest, runHarvest, windowFor } from '../harvest.js';
import { getWatermark, newAwardsSince, openDb } from '../db.js';
import { awardPackage, response, tenderPackage } from './helpers.js';

const NO_DELAY = { minIntervalMs: 0 };
const T0 = '2026-10-06T06:17:00.000Z';
const freshDb = () => openDb({ dryRun: true, dataDir: mkdtempSync(path.join(tmpdir(), 'tender-scout-')) });
const count = (db, table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

afterEach(() => http.setFetch());

/** A mock Contracts Finder serving `pages` (arrays of releases) chained by links.next. */
function mockPages(pages, calls = []) {
  http.setFetch(async (url, init) => {
    calls.push({ url, init });
    const n = Number(new URL(url).searchParams.get('cursor') ?? 1);
    const body = { uri: 'x', releases: pages[n - 1] };
    if (n < pages.length) body.links = { next: `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?cursor=${n + 1}` };
    return response(body);
  });
  return calls;
}

test('pagination: follows links.next across 3 pages and stops when it is absent', async () => {
  const all = tenderPackage().releases;
  const calls = mockPages([all.slice(0, 10), all.slice(10, 20), all.slice(20)]);
  const got = await fetchReleases(contractsFinder, { stage: 'tender', from: '2026-09-29T00:00:00.000Z', to: T0, httpOptions: NO_DELAY });
  assert.equal(got.length, all.length);
  assert.equal(calls.length, 3);
  const first = new URL(calls[0].url);
  assert.equal(first.searchParams.get('publishedFrom'), '2026-09-29T00:00:00Z');
  assert.equal(first.searchParams.get('publishedTo'), '2026-10-06T06:17:00Z');
  assert.equal(first.searchParams.get('stages'), 'tender');
  assert.match(calls[0].init.headers['User-Agent'], /^bot-army-tender-scout\//);
});

test('pagination: a repeated next link is an error, not an endless loop', async () => {
  http.setFetch(async () => response({ releases: [], links: { next: 'https://www.contractsfinder.service.gov.uk/same' } }));
  await assert.rejects(fetchReleases(contractsFinder, { stage: 'tender', from: T0, to: T0, httpOptions: NO_DELAY }), /same next link twice/);
});

test('split: a full page (100) with no next link is refetched as two half windows (live API quirk)', async () => {
  const real = awardPackage().releases;
  const fake = (n, tag) => Array.from({ length: n }, (_, i) => ({ ...real[i % real.length], id: `${tag}-${i}` }));
  const calls = [];
  http.setFetch(async (url) => {
    const q = new URL(url).searchParams;
    calls.push(`${q.get('publishedFrom')}..${q.get('publishedTo')}`);
    // Whole day: truncated to 100, no next link. Each half fits in one page.
    if (calls.length === 1) return response({ releases: fake(100, 'whole') });
    return response({ releases: fake(calls.length === 2 ? 70 : 49, `half${calls.length}`) });
  });
  const got = await fetchReleases(contractsFinder, { stage: 'award', from: '2026-10-05T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', httpOptions: NO_DELAY });
  assert.deepEqual(calls, ['2026-10-05T00:00:00Z..2026-10-06T00:00:00Z', '2026-10-05T00:00:00Z..2026-10-05T12:00:00Z', '2026-10-05T12:00:00Z..2026-10-06T00:00:00Z']);
  assert.equal(got.length, 119); // the truncated 100 are replaced by the halves
});

test('rate limit: the plain-text "Rate limit of 12 exceeded" reply is waited out, then retried', async () => {
  let calls = 0;
  http.setFetch(async () => (++calls === 1
    ? response('Rate limit of 12 exceeded. Please retry after 120 seconds.', { headers: { 'content-type': 'text/plain' } })
    : response({ releases: [{ ocid: 'o', id: 'r-1' }] })));
  const got = await fetchReleases(contractsFinder, { stage: 'tender', from: T0, to: T0, httpOptions: { ...NO_DELAY, rateLimitWaitMs: 0 } });
  assert.equal(calls, 2);
  assert.equal(got.length, 1);
});

test('retry: 429 (Retry-After 0) and 503 are retried, then the page is returned', async () => {
  const replies = [
    () => response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
    () => response('down', { status: 503 }), // core.http backs off 2s here (attempt 2)
    () => response({ releases: [{ ocid: 'o', id: 'r-1' }] }),
  ];
  let calls = 0;
  http.setFetch(async () => replies[calls++]());
  const got = await fetchReleases(contractsFinder, { stage: 'award', from: T0, to: T0, httpOptions: NO_DELAY });
  assert.equal(calls, 3);
  assert.equal(got.length, 1);
});

test('retry: a 400 is not retried and fails the fetch', async () => {
  let calls = 0;
  http.setFetch(async () => { calls++; return response('bad request', { status: 400 }); });
  await assert.rejects(fetchReleases(contractsFinder, { stage: 'award', from: T0, to: T0, httpOptions: NO_DELAY }), /400/);
  assert.equal(calls, 1);
});

test('idempotency: ingesting the same real releases twice leaves identical row counts', () => {
  const db = freshDb();
  const tenders = tenderPackage().releases;
  const awards = awardPackage().releases;
  const first = [ingest(db, contractsFinder, 'tender', tenders, T0), ingest(db, contractsFinder, 'award', awards, T0)];
  const before = ['releases', 'notices', 'awards'].map((t) => count(db, t));
  const second = [ingest(db, contractsFinder, 'tender', tenders, T0), ingest(db, contractsFinder, 'award', awards, T0)];
  assert.deepEqual(['releases', 'notices', 'awards'].map((t) => count(db, t)), before);
  assert.equal(second[0].newReleases + second[1].newReleases, 0);
  assert.ok(first[0].newReleases > 0);

  assert.equal(count(db, 'releases'), tenders.length + awards.length);
  assert.equal(count(db, 'notices'), new Set(tenders.map((r) => r.ocid)).size); // 28 releases, 27 ocids
  db.close();
});

test('dedupe: an ocid keeps its latest release whatever order the releases arrive in', () => {
  const pair = tenderPackage().releases.filter((r) => r.ocid.endsWith('df90f65c491b')); // tender + tenderAmendment
  for (const order of [pair, [...pair].reverse()]) {
    const db = freshDb();
    ingest(db, contractsFinder, 'tender', order, T0);
    assert.equal(db.prepare(`SELECT tag FROM notices`).pluck().get(), 'tenderAmendment');
    db.close();
  }
});

test('awards: awardUpdate updates the row in place; first_seen_at never moves', () => {
  const db = freshDb();
  const norse = awardPackage().releases.filter((r) => r.ocid.endsWith('4894ea6a64d4')); // award, awardUpdate, awardUpdate
  const original = norse.find((r) => r.tag.includes('award'));
  const updates = norse.filter((r) => r.tag.includes('awardUpdate'));

  ingest(db, contractsFinder, 'award', [original], '2026-10-01T13:00:00.000Z');
  ingest(db, contractsFinder, 'award', updates, '2026-10-02T13:00:00.000Z');
  const rows = db.prepare(`SELECT * FROM awards`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_seen_at, '2026-10-01T13:00:00.000Z');
  assert.equal(rows[0].last_seen_at, '2026-10-02T13:00:00.000Z');
  assert.match(rows[0].release_id, /-916251$/); // the newest awardUpdate
  assert.equal(rows[0].supplier_identifier, '05694657');
  db.close();
});

test('newAwardsSince returns only awards first seen after the given time', () => {
  const db = freshDb();
  const awards = awardPackage().releases;
  ingest(db, contractsFinder, 'award', awards.slice(0, 5), '2026-10-01T06:00:00.000Z');
  ingest(db, contractsFinder, 'award', awards.slice(5, 8), '2026-10-02T06:00:00.000Z');
  assert.equal(newAwardsSince(db, '2026-09-30T00:00:00.000Z').length, 8);
  const later = newAwardsSince(db, '2026-10-01T06:00:00.000Z');
  assert.equal(later.length, 3);
  assert.ok(later.every((a) => a.first_seen_at === '2026-10-02T06:00:00.000Z'));
  assert.ok(Array.isArray(later[0].cpv_codes));
  db.close();
});

test('watermark: first run looks back 7 days, next run starts 1 hour before the watermark, --since overrides', async () => {
  const db = freshDb();
  const calls = mockPages([[]]);
  await runHarvest(db, { adapters: [contractsFinder], stages: ['tender'], now: T0, httpOptions: NO_DELAY });
  assert.equal(new URL(calls[0].url).searchParams.get('publishedFrom'), '2026-09-29T06:17:00Z');
  assert.equal(getWatermark(db, 'contracts-finder', 'tender'), T0);

  const T1 = '2026-10-07T06:41:00.000Z';
  await runHarvest(db, { adapters: [contractsFinder], stages: ['tender'], now: T1, httpOptions: NO_DELAY });
  assert.equal(new URL(calls[1].url).searchParams.get('publishedFrom'), apiTime('2026-10-06T05:17:00.000Z'));
  assert.equal(getWatermark(db, 'contracts-finder', 'tender'), T1);

  assert.equal(windowFor(db, 'contracts-finder', 'tender', { since: '2026-09-01', now: T1 }).from, '2026-09-01T00:00:00.000Z');
  db.close();
});

test('watermark: a failure part-way through the window leaves it where it was', async () => {
  const db = freshDb();
  mockPages([[]]);
  await runHarvest(db, { adapters: [contractsFinder], stages: ['award'], now: T0, httpOptions: NO_DELAY });

  let calls = 0;
  http.setFetch(async () => (++calls === 1
    ? response({ releases: awardPackage().releases.slice(0, 3), links: { next: 'https://www.contractsfinder.service.gov.uk/p2' } })
    : response('gone', { status: 404 })));
  await assert.rejects(runHarvest(db, { adapters: [contractsFinder], stages: ['award'], now: '2026-10-07T06:00:00.000Z', httpOptions: NO_DELAY }));
  assert.equal(getWatermark(db, 'contracts-finder', 'award'), T0);
  db.close();
});
