/**
 * B5 Hiring-Signal Scout tests.   Run: npm test -w bots/hiring-signal-scout
 *
 * Fixtures are built here in the shapes the sources serve (OCDS release
 * packages, GeBIZ datastore JSON, Greenhouse/Workday board JSON, RSS).
 * Record real payloads with BOTARMY_HTTP_RECORD=bots/hiring-signal-scout/test/fixtures/http.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as coreDb, http, snapshot, spine as coreSpine } from '@botarmy/core';
import { SOURCE, harvestAll } from '../harvest.js';
import {
  BOT, MIN_SPIKE_FLOOR, SPINE_EVENT, applyAwardFilters, buildMatcher, evaluateSpike, markNotified, parseAmount,
  pendingSignals, processAwards, processBoards, processFunding, spikeCandidates, syncWatchlist, toIsoDate,
  upsertSignals, validateWatchlist, weekOf,
} from '../process.js';
import { ratioFactor, scoreAward, scoreSpike, suggestAngle, toNumberOrNull } from '../score.js';
import { buildDigest, buildFailureAlert, money } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hss-test-'));
  dirs.push(d);
  return d;
};
const track = (h) => {
  handles.push(h);
  return h;
};
after(() => {
  http.setFetch();
  for (const h of handles.splice(0)) {
    try { h.close(); } catch { /* already closed */ }
  }
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});

/* ============================================================= fixtures */

const OFF = Object.fromEntries(['contractsFinder', 'findATender', 'ted', 'gebiz', 'hk', 'etimad', 'meaAggregator'].map((k) => [k, { enabled: false }]));
const RAW_WATCHLIST = {
  companies: [
    { id: 'acme-digital', name: 'Acme Digital Limited', aliases: ['Acme Digital'], country: 'UK', registrationNumber: '01234567', ats: { type: 'greenhouse', token: 'acmedigital' } },
    { id: 'beta-systems', name: 'Beta Systems Ltd', country: 'UK', ats: { type: 'greenhouse', token: 'betasystems' } },
    { id: 'gamma-global', name: 'Gamma Global plc', ats: { type: 'workday', host: 'gamma.wd3.myworkdayjobs.com', tenant: 'gamma', site: 'External' } },
    { id: 'delta-optin', name: 'Delta Holdings plc', ats: { type: 'workday', host: 'delta.wd3.myworkdayjobs.com', tenant: 'delta', site: 'Careers', optIn: true } },
  ],
  filters: { cpvPrefixes: ['72', '48'], awardKeywords: [], stackKeywords: [] },
  thresholds: { majorAward: { GBP: 1000000, default: 1000000 }, majorFunding: { USD: 5000000, default: 5000000 } },
  spikes: { windowDays: 7, baselineWeeks: 8, multiplier: 2, minNewJobs: 5 },
  sources: OFF,
  jobFeeds: {},
  funding: { feeds: [] },
};
const wl = (over = {}) => validateWatchlist({ ...RAW_WATCHLIST, ...over, filters: { ...RAW_WATCHLIST.filters, ...(over.filters ?? {}) } });

const greenhouse = (jobs) => JSON.stringify({ jobs: jobs.map(([id, title]) => ({ id, title, location: { name: 'London' }, absolute_url: `https://boards.greenhouse.io/x/jobs/${id}` })) });
const jobs = (prefix, n, title = 'Software Engineer') => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, `${title} ${i}`]);

/** OCDS release package with tender CPV codes. */
const ocds = (awards) => JSON.stringify({
  releases: awards.map(([id, supplier, value, cpv, title]) => ({
    id: `abdbeb99-0618-44e9-aaf8-9b03ecbcb3cf-${id}`, tag: ['award'], date: '2026-09-28T10:00:00Z',
    buyer: { name: 'Leeds City Council' },
    tender: { title, items: cpv ? [{ classification: { scheme: 'CPV', id: cpv } }] : [] },
    // Acme's real Companies House number; other suppliers get their own, so matching is by registry id.
    parties: [{ id: 'S1', name: supplier, identifier: { scheme: 'GB-COH', id: /acme/i.test(supplier) ? '1234567' : '07654321' } }],
    awards: [{ id: 'A1', title, status: 'active', date: '2026-09-27', value: { amount: value, currency: 'GBP' }, suppliers: [{ id: 'S1', name: supplier }] }],
  })),
  links: {},
});

const DAY = (n) => new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString(); // day 0 = 2026-09-01 (Tuesday)
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function openAll(dataDir = tmp()) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  return { db, store, spine, dataDir };
}

/** Store a Greenhouse board snapshot and process it on a given day. */
function boardDay(env, watchlist, companyId, list, now) {
  const id = env.store.writeRaw(SOURCE.board('greenhouse'), `${companyId}.json`, greenhouse(list), { kind: 'board', companyId, atsType: 'greenhouse', fetchedAt: now }).id;
  return processBoards({
    ...env, boards: [{ companyId, atsType: 'greenhouse', snapshotIds: [id], complete: true }], jobFeeds: [],
    watchlist, matcher: buildMatcher(watchlist.companies), settings: { maxDropRatio: 0.6 }, now, log: quiet,
  });
}

/* ======================================================= spike maths */

describe('velocity spikes', () => {
  const rules = { windowDays: 7, baselineWeeks: 8, multiplier: 2, minNewJobs: 5 };

  test('0 → 1 never triggers, whatever the history', () => {
    for (const trackedDays of [0, 3, 20, 70]) {
      assert.equal(evaluateSpike({ newInWindow: 1, baselineNew: 0, trackedDays }, rules).isSpike, false, `trackedDays ${trackedDays}`);
    }
    assert.equal(evaluateSpike({ newInWindow: 1, baselineNew: 0, trackedDays: 70 }, { ...rules, minNewJobs: 1 }).isSpike, false, 'floor cannot be configured below MIN_SPIKE_FLOOR');
    assert.ok(MIN_SPIKE_FLOOR >= 2);
    assert.equal(validateWatchlist({ ...RAW_WATCHLIST, spikes: { ...rules, minNewJobs: 1 } }).spikes.minNewJobs, MIN_SPIKE_FLOOR);
  });

  test('thresholds: doubled floor until two weeks of history, then max(floor, baseline × multiplier)', () => {
    assert.deepEqual(evaluateSpike({ newInWindow: 9, baselineNew: 0, trackedDays: 10 }, rules), { isSpike: false, threshold: 10, baselineWeekly: null });
    assert.equal(evaluateSpike({ newInWindow: 10, baselineNew: 0, trackedDays: 10 }, rules).isSpike, true);
    const busy = evaluateSpike({ newInWindow: 12, baselineNew: 64, trackedDays: 70 }, rules); // 8/week → threshold 16
    assert.equal(busy.threshold, 16);
    assert.equal(busy.isSpike, false);
    const quietCo = evaluateSpike({ newInWindow: 12, baselineNew: 16, trackedDays: 70 }, rules); // 2/week → floor 5
    assert.equal(quietCo.threshold, 5);
    assert.equal(quietCo.isSpike, true);
  });

  test('end to end: baseline board, steady trickle, then a burst — only the burst signals', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    let list = jobs('base', 20);
    assert.equal(boardDay(env, watchlist, 'acme-digital', list, DAY(0)).results[0].outcome, 'baseline');
    for (let d = 1; d <= 20; d++) {
      list = [...list, [`t${d}`, `Software Engineer trickle ${d}`]]; // 1 new/day ≈ 7/week
      const r = boardDay(env, watchlist, 'acme-digital', list, DAY(d));
      assert.equal(spikeCandidates({ ...env, boardResults: r.results, watchlist, now: DAY(d) }).length, 0, `no spike on day ${d}`);
    }
    list = [...list, ...jobs('burst', 25, 'Data Engineer')];
    const r = boardDay(env, watchlist, 'acme-digital', list, DAY(21));
    const [spike] = spikeCandidates({ ...env, boardResults: r.results, watchlist, now: DAY(21) });
    assert.ok(spike, 'burst detected');
    assert.equal(spike.evidence.baselineWeekly, 7);
    assert.equal(spike.evidence.threshold, 14);
    assert.ok(spike.evidence.newInWindow >= 25);
  });

  test('postings from a second run on the baseline day still count', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    boardDay(env, watchlist, 'acme-digital', jobs('a', 20), '2026-09-01T06:00:00.000Z');
    const r = boardDay(env, watchlist, 'acme-digital', [...jobs('a', 20), ...jobs('n', 12)], '2026-09-01T15:00:00.000Z');
    const [spike] = spikeCandidates({ ...env, boardResults: r.results, watchlist, now: '2026-09-01T15:00:00.000Z' });
    assert.ok(spike, 'same-day burst after the baseline is detected');
    assert.equal(spike.evidence.newInWindow, 12);
  });

  test('a quiet company going 0 → 1 new posting is not a spike', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    boardDay(env, watchlist, 'beta-systems', jobs('q', 4), DAY(0));
    for (let d = 1; d <= 30; d++) boardDay(env, watchlist, 'beta-systems', jobs('q', 4), DAY(d));
    const r = boardDay(env, watchlist, 'beta-systems', [...jobs('q', 4), ['one', 'Engineer']], DAY(31));
    assert.equal(r.results[0].newCount, 1);
    assert.equal(spikeCandidates({ ...env, boardResults: r.results, watchlist, now: DAY(31) }).length, 0);
  });

  test('stack keywords: only matching postings count towards a spike', () => {
    const env = openAll();
    const watchlist = wl({ filters: { stackKeywords: ['salesforce', 'data engineer'] } });
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    const base = jobs('b', 15, 'Office Manager');
    boardDay(env, watchlist, 'acme-digital', base, DAY(0));
    const offStack = boardDay(env, watchlist, 'acme-digital', [...base, ...jobs('x', 12, 'Receptionist')], DAY(1));
    assert.equal(spikeCandidates({ ...env, boardResults: offStack.results, watchlist, now: DAY(1) }).length, 0, '12 receptionists are not a stack spike');
    const onStack = boardDay(env, watchlist, 'acme-digital', [...base, ...jobs('x', 12, 'Receptionist'), ...jobs('s', 11, 'Salesforce Developer')], DAY(2));
    const [spike] = spikeCandidates({ ...env, boardResults: onStack.results, watchlist, now: DAY(2) });
    assert.ok(spike);
    assert.equal(spike.evidence.newInWindow, 11);
    assert.equal(spike.rationale.stack.share, 1);
  });
});

/* ======================================================== board drops */

describe('board drop guard', () => {
  test('empty board or > 60% drop on 10+ postings is rejected and leaves postings untouched', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    boardDay(env, watchlist, 'acme-digital', jobs('a', 20), DAY(0));
    const active = () => env.db.prepare(`SELECT COUNT(*) FROM job_postings WHERE company_id = 'acme-digital' AND active = 1`).pluck().get();

    const empty = boardDay(env, watchlist, 'acme-digital', [], DAY(1));
    assert.equal(empty.results[0].outcome, 'rejected');
    assert.match(empty.warnings[0], /board empty \(previously 20 open\)/);
    assert.equal(active(), 20);

    const collapse = boardDay(env, watchlist, 'acme-digital', jobs('a', 5), DAY(2));
    assert.equal(collapse.results[0].outcome, 'rejected');
    assert.match(collapse.warnings[0], /fell from 20 to 5/);
    assert.equal(active(), 20);

    const normal = boardDay(env, watchlist, 'acme-digital', jobs('a', 15), DAY(3));
    assert.equal(normal.results[0].outcome, 'diffed', 'a 25% drop is normal churn');
    assert.equal(active(), 15);
  });

  test('small boards (< 10) may shrink sharply: that is churn, not a broken scrape', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    boardDay(env, watchlist, 'beta-systems', jobs('s', 9), DAY(0));
    assert.equal(boardDay(env, watchlist, 'beta-systems', jobs('s', 2), DAY(1)).results[0].outcome, 'diffed');
  });

  test('re-processing the same board snapshot writes nothing', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    const id = env.store.writeRaw(SOURCE.board('greenhouse'), 'acme.json', greenhouse(jobs('r', 3)), { kind: 'board', companyId: 'acme-digital', atsType: 'greenhouse' }).id;
    const args = { ...env, boards: [{ companyId: 'acme-digital', atsType: 'greenhouse', snapshotIds: [id], complete: true }], jobFeeds: [], watchlist, matcher: buildMatcher(watchlist.companies), settings: { maxDropRatio: 0.6 }, log: quiet };
    processBoards({ ...args, now: DAY(0) });
    assert.equal(processBoards({ ...args, now: DAY(0) }).results[0].outcome, 'already-processed');
  });
});

/* ========================================================= CPV filters */

describe('CPV and keyword filters', () => {
  const filters = (o = {}) => ({ cpvPrefixes: ['72', '48'], allowUnknownCpv: true, awardKeywords: [], stackKeywords: [], ...o });

  test('prefix match passes, mismatch is filtered out', () => {
    assert.deepEqual(applyAwardFilters({ cpv: ['72222300'], title: 'x' }, filters()), { passed: true, reason: 'cpv' });
    assert.deepEqual(applyAwardFilters({ cpv: ['45000000'], title: 'Road resurfacing' }, filters()), { passed: false, reason: 'cpv-mismatch' });
  });

  test('a notice with no CPV codes is labelled, never assumed to match', () => {
    assert.deepEqual(applyAwardFilters({ cpv: [], title: 'x' }, filters()), { passed: true, reason: 'cpv-not-published' });
    assert.deepEqual(applyAwardFilters({ cpv: [], title: 'x' }, filters({ allowUnknownCpv: false })), { passed: false, reason: 'cpv-not-published' });
    assert.deepEqual(applyAwardFilters({ cpv: [], title: 'Cloud platform' }, filters({ awardKeywords: ['cloud'] })), { passed: true, reason: 'keyword' });
    assert.deepEqual(applyAwardFilters({ cpv: [], title: 'Catering' }, filters({ awardKeywords: ['cloud'] })), { passed: false, reason: 'keyword-mismatch' });
    assert.deepEqual(applyAwardFilters({ cpv: [], title: 'x' }, filters({ cpvPrefixes: [] })), { passed: true, reason: 'unfiltered' });
  });

  test('end to end: IT award signals, construction award is stored but filtered, missing CPV labelled', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(27) });
    const id = env.store.writeRaw(SOURCE.contractsFinder, 'page-1.json', ocds([
      ['1', 'ACME DIGITAL LTD', 2500000, '72222300', 'Digital platform delivery'],
      ['2', 'ACME DIGITAL LTD', 3000000, '45233142', 'Road resurfacing'],
      ['3', 'ACME DIGITAL LTD', 1500000, null, 'Managed service'],
      ['4', 'Unrelated Builders Ltd', 9000000, '72000000', 'Not ours'],
    ]), { kind: 'awards', sourceId: 'contractsFinder', format: 'ocds', noticeBase: 'cf' }).id;
    const r = processAwards({ ...env, fetches: [{ sourceId: 'contractsFinder', snapshotIds: [id] }], watchlist, matcher: buildMatcher(watchlist.companies), now: DAY(27), log: quiet });
    const rows = env.db.prepare(`SELECT title, filter_passed, filter_reason, match_method FROM contract_awards ORDER BY title`).all();
    assert.deepEqual(rows.map((x) => [x.title, x.filter_passed, x.filter_reason]), [
      ['Digital platform delivery', 1, 'cpv'], ['Managed service', 1, 'cpv-not-published'], ['Road resurfacing', 0, 'cpv-mismatch'],
    ]);
    assert.ok(rows.every((x) => x.match_method === 'registration'), 'matched by Companies House number');
    assert.deepEqual(r.candidates.map((c) => c.evidence.title).sort(), ['Digital platform delivery', 'Managed service']);
    const cpvScore = r.candidates.find((c) => c.evidence.title === 'Digital platform delivery').rationale.relevance.factor;
    const unknownScore = r.candidates.find((c) => c.evidence.title === 'Managed service').rationale.relevance.factor;
    assert.ok(cpvScore > unknownScore, 'a confirmed CPV match ranks above an unknown one');
  });
});

/* ===================================================== full datasets */

describe('full-dataset sources', () => {
  const gebiz = (rows) => JSON.stringify({ success: true, result: { total: rows.length, records: rows } });
  const rec = (no, supplier, amt) => ({ tender_no: no, tender_description: 'Cloud services', agency: 'MOF', award_date: '2026-03-01', tender_detail_status: 'Awarded to Suppliers', supplier_name: supplier, awarded_amt: amt });

  test('first good read is a baseline; a failed parse is not "seen", is retried, and is reported every run', () => {
    const env = openAll();
    const watchlist = validateWatchlist({ ...RAW_WATCHLIST, companies: [...RAW_WATCHLIST.companies, { id: 'sg-co', name: 'Example Digital Pte. Ltd.', country: 'SG' }] });
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    const matcher = buildMatcher(watchlist.companies);
    const run = (body, now) => {
      const id = env.store.writeRaw(SOURCE.gebiz, 'offset-0.json', body, { kind: 'awards', sourceId: 'gebiz', format: 'gebiz' }).id;
      return processAwards({ ...env, fetches: [{ sourceId: 'gebiz', snapshotIds: [id] }], watchlist, matcher, now, log: quiet });
    };
    const broken = run('{"not json', DAY(0));
    assert.equal(broken.stats.failures.length, 1);
    assert.equal(run('{"not json', DAY(1)).stats.failures.length, 1, 'still reported on the next run');

    const first = run(gebiz([rec('T1', 'EXAMPLE DIGITAL PTE LTD', '5000000')]), DAY(2));
    assert.deepEqual(first.stats.baselineSources, ['gebiz'], 'treated as baseline despite the earlier failure');
    assert.equal(first.candidates.length, 0, 'history never alerts');
    const later = run(gebiz([rec('T1', 'EXAMPLE DIGITAL PTE LTD', '5000000'), rec('T2', 'EXAMPLE DIGITAL PTE LTD', '4000000')]), DAY(3));
    assert.equal(later.candidates.length, 1, 'new award after the baseline signals');
  });
});

/* ===================================================== Workday opt-in */

describe('Workday opt-in', () => {
  after(() => http.setFetch());

  test('without optIn: reported unsupported with a reason, recorded in watchlist_companies, shown in the digest', async () => {
    const calls = [];
    http.setFetch(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (String(url).includes('delta.wd3')) return new Response(JSON.stringify({ total: 2, jobPostings: [{ title: 'Engineer', externalPath: '/job/1' }, { title: 'Analyst', externalPath: '/job/2' }] }));
      return new Response(greenhouse(jobs('g', 3)));
    });
    const env = openAll();
    const watchlist = wl();
    const h = await harvestAll(watchlist, { store: env.store, getCursor: () => null, now: DAY(0), env: {}, log: quiet });
    assert.equal(h.unsupported.length, 1);
    assert.equal(h.unsupported[0].companyId, 'gamma-global');
    assert.match(h.unsupported[0].reason, /set "optIn": true/);
    assert.ok(!calls.some((u) => u.includes('gamma.wd3')), 'no request sent for a non-opted-in Workday board');
    assert.ok(h.boards.some((b) => b.companyId === 'delta-optin' && b.atsType === 'workday'), 'opted-in Workday board is fetched');

    syncWatchlist({ ...env, watchlist, unsupported: h.unsupported, now: DAY(0) });
    assert.equal(env.db.prepare(`SELECT ats_status FROM watchlist_companies WHERE id = 'gamma-global'`).pluck().get(), 'unsupported');
    assert.equal(env.db.prepare(`SELECT ats_status FROM watchlist_companies WHERE id = 'delta-optin'`).pluck().get(), 'supported');

    const d = buildDigest({ signals: [], date: '2026-09-01', unsupported: h.unsupported });
    assert.match(JSON.stringify(d.blocks), /Job boards not polled \(unsupported\)/);
    assert.match(JSON.stringify(d.blocks), /Gamma Global plc \(workday\)/);
  });
});

/* =========================================================== dedup */

describe('weekly dedup', () => {
  test('one signal per company per type per ISO week; stronger unsent evidence upgrades it; next week signals again', () => {
    const env = openAll();
    const watchlist = wl();
    syncWatchlist({ ...env, watchlist, now: DAY(0) });
    const cand = (score, ref) => ({ type: 'contract_award', companyId: 'acme-digital', refKey: ref, score, rationale: {}, evidence: { company: 'Acme Digital Limited', title: ref, confidence: 'awarded' } });
    const monday = '2026-09-07T09:00:00.000Z';
    assert.equal(weekOf(monday), '2026-09-07');
    assert.equal(weekOf('2026-09-13T23:59:00.000Z'), '2026-09-07', 'Sunday belongs to the same week');

    assert.equal(upsertSignals({ ...env, candidates: [cand(60, 'a1')], now: monday }).inserted, 1);
    assert.equal(upsertSignals({ ...env, candidates: [cand(80, 'a2')], now: '2026-09-09T09:00:00.000Z' }).upgraded, 1);
    assert.equal(upsertSignals({ ...env, candidates: [cand(70, 'a3')], now: '2026-09-10T09:00:00.000Z' }).deduplicated, 1, 'weaker evidence ignored');
    const [only] = pendingSignals(env.db);
    assert.equal(only.score, 80);
    assert.equal(only.ref_key, 'a2');

    markNotified(env.db, [only.id]);
    assert.equal(upsertSignals({ ...env, candidates: [cand(99, 'a4')], now: '2026-09-12T09:00:00.000Z' }).deduplicated, 1, 'already sent this week: never a second signal');
    assert.equal(upsertSignals({ ...env, candidates: [cand(50, 'a5')], now: '2026-09-14T09:00:00.000Z' }).inserted, 1, 'new week');

    const events = env.spine.db.prepare(`SELECT type, event_date FROM events WHERE source = ?`).all(BOT);
    assert.deepEqual(events, [{ type: SPINE_EVENT.contract_award, event_date: '2026-09-07' }, { type: SPINE_EVENT.contract_award, event_date: '2026-09-14' }]);
  });
});

/* ========================================================== funding */

test('funding: funding language + watchlist company; amount parsed or explicitly null', () => {
  const env = openAll();
  const watchlist = wl();
  syncWatchlist({ ...env, watchlist, now: DAY(0) });
  const id = env.store.writeRaw(SOURCE.funding, 'feed', `<?xml version="1.0"?><rss><channel>
    <item><title>Acme Digital raises $12m Series A to expand</title><link>https://news.example/a</link><guid>a</guid></item>
    <item><title>Acme Digital opens new office</title><link>https://news.example/b</link><guid>b</guid></item>
    <item><title>Beta Systems secures growth equity investment</title><link>https://news.example/c</link><guid>c</guid></item>
  </channel></rss>`, { kind: 'funding', feedName: 'Test' }).id;
  const c = processFunding({ ...env, fetches: [{ feed: 'Test', snapshotId: id }], watchlist, matcher: buildMatcher(watchlist.companies), now: DAY(0) });
  assert.deepEqual(c.map((x) => [x.companyId, x.evidence.amount]).sort(), [['acme-digital', 12000000], ['beta-systems', null]]);
  assert.deepEqual(parseAmount('no amount here'), { amount: null, currency: null });
  assert.equal(processFunding({ ...env, fetches: [{ feed: 'Test', snapshotId: id }], watchlist, matcher: buildMatcher(watchlist.companies), now: DAY(0) }).length, 0, 'idempotent');
});

/* ===================================================== numbers / score */

test('numbers are parsed safely and never invented', () => {
  assert.equal(toNumberOrNull('1,250,000'), 1250000);
  assert.equal(toNumberOrNull(''), null);
  assert.equal(toNumberOrNull('approx 5m'), null);
  assert.equal(toNumberOrNull(Infinity), null);
  assert.equal(ratioFactor(null), null);
  assert.equal(money(null, 'GBP'), 'value not stated');
  assert.equal(toIsoDate('31/02/2026'), null);
  const unknown = scoreAward({ value: null, currency: 'GBP', confidence: 'awarded', filterReason: 'cpv' }, { threshold: 1000000 });
  assert.equal(unknown.rationale.value.unknown, true);
  assert.equal(unknown.rationale.value.input, null);
  assert.deepEqual(scoreSpike({ newInWindow: 10, threshold: 10, newStack: null, baselineWeekly: null }), scoreSpike({ newInWindow: 10, threshold: 10, newStack: null, baselineWeekly: null }), 'deterministic');
});

/* ============================================================ digest */

describe('digest', () => {
  const sig = (over) => ({ id: 1, signal_type: 'contract_award', score: 80, angle: 'Offer to help staff it.', evidence: { company: 'Acme <Digital>', title: 'Platform', buyer: 'Leeds City Council', value: 2500000, currency: 'GBP', cpv: ['72222300'], url: 'https://x/n', confidence: 'awarded', filter: 'cpv', source: 'contractsFinder' }, ...over });

  test('evidence and a suggested angle on every signal; tenderers never called winners', () => {
    const tenderer = sig({ id: 2, evidence: { ...sig().evidence, confidence: 'tenderer', title: 'Framework' } });
    const spike = sig({ id: 3, signal_type: 'hiring_spike', evidence: { company: 'Beta', newInWindow: 26, windowDays: 7, threshold: 14, baselineWeekly: 7, stackOnly: false, stackKeywords: [], sources: ['greenhouse'], sampleTitles: ['Data Engineer 1'] } });
    const d = buildDigest({ signals: [sig(), tenderer, spike], date: '2026-09-28' });
    const sections = d.blocks.filter((b) => b.type === 'section' && b.text.text.includes('Suggested angle'));
    assert.equal(sections.length, 3);
    const text = JSON.stringify(d.blocks);
    assert.match(text, /GBP 2,500,000/);
    assert.match(text, /CPV 72222300/);
    assert.match(text, /named as tenderer, not confirmed winner/);
    assert.match(text, /26 new roles\* in 7 days \(threshold 14, usually ~7\/week\)/);
    assert.match(text, /Acme &lt;Digital&gt;/);
    assert.match(suggestAngle('contract_award', { ...tenderer.evidence, company: 'X' }), /is named on the award notice for/);
    assert.doesNotMatch(suggestAngle('contract_award', { ...tenderer.evidence, company: 'X' }), /has won/);
  });

  test('caps per type and respects Slack limits; failure alert is loud', () => {
    const many = Array.from({ length: 60 }, (_, i) => sig({ id: i }));
    const d = buildDigest({ signals: many, date: '2026-09-28', maxPerType: 15 });
    assert.match(JSON.stringify(d.blocks), /and 45 more/);
    assert.ok(d.blocks.length <= 50);
    assert.match(buildFailureAlert({ date: 'd', problems: ['ted: 400'] }).blocks[0].text.text, /run halted/);
  });
});

/* ======================================================== entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;
  let watchlistPath;
  const RSS = 'https://news.example/rss';

  const put = (url, body, method = 'GET') => writeFileSync(path.join(fixtures, `${http.fixtureKey(method, url)}.json`), JSON.stringify({
    url, status: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(body).toString('base64'),
  }));
  const writeDay = (acmeJobs, rss = '<rss><channel></channel></rss>') => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    put('https://boards-api.greenhouse.io/v1/boards/acmedigital/jobs', greenhouse(acmeJobs));
    put('https://boards-api.greenhouse.io/v1/boards/betasystems/jobs', greenhouse(jobs('b', 4)));
    put(RSS, rss);
  };
  const run = (...args) => spawnSync(process.execPath, ['index.js', ...args], {
    cwd: BOT_DIR, encoding: 'utf8',
    env: {
      ...process.env,
      BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, HSS_WATCHLIST: watchlistPath, LOG_FORMAT: 'json',
      // Blank values stop dotenv loading real ones from the root .env during tests.
      SLACK_WEBHOOK_URL: 'http://127.0.0.1:9/never-called', SLACK_WEBHOOK_URL_HIRING: '',
      HEALTHCHECKS_BASE_URL: '', HC_UUID_HIRING_SIGNAL_SCOUT: '',
    },
  });
  const fingerprint = (dir) => {
    const out = {};
    const walk = (d) => readdirSync(d).forEach((f) => {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    });
    walk(dir);
    return out;
  };

  before(() => {
    const base = tmp();
    dataDir = path.join(base, 'data');
    fixtures = path.join(base, 'fixtures');
    mkdirSync(dataDir);
    watchlistPath = path.join(base, 'watchlist.json');
    writeFileSync(watchlistPath, JSON.stringify({
      ...RAW_WATCHLIST,
      companies: RAW_WATCHLIST.companies.filter((c) => c.id !== 'delta-optin'),
      funding: { feeds: [{ name: 'Test news', url: RSS }] },
    }));
  });

  test('--dry-run on an empty data dir writes nothing', () => {
    writeDay(jobs('a', 20));
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.match(r.stdout, /Gamma Global plc \(workday\): unsupported/, 'Workday reported every run, never silently skipped');
  });

  test('live baseline stores boards and posts nothing', () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(readdirSync(dataDir).includes('hiring-signal-scout.sqlite'));
    assert.match(r.stdout, /No new signals; no Slack message/);
  });

  test('--dry-run with a burst and funding news prints the digest; files byte-identical', () => {
    writeDay([...jobs('a', 20), ...jobs('n', 12, 'Data Engineer')],
      `<rss><channel><item><title>Acme Digital raises $12m Series A</title><link>https://news.example/a</link><guid>a</guid></item></channel></rss>`);
    const before = fingerprint(dataDir);
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Hiring signals \d{4}-\d{2}-\d{2}: 2 new/);
    assert.match(r.stdout, /Suggested angle/);
    assert.match(r.stdout, /Job boards not polled \(unsupported\)/);
    assert.deepEqual(fingerprint(dataDir), before);
  });

  test('when every source fails the run halts with exit code 1 and a loud alert', () => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures);
    const r = run('--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /every source failed/);
  });
});