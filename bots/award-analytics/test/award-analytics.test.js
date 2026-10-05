/**
 * B6 Award Analytics tests.   Run: npm test -w bots/award-analytics
 *
 * Fixtures are built here in the shapes the sources serve (OCDS release
 * packages with parties, bids statistics and framework techniques; TED v3
 * search JSON). Record real payloads with BOTARMY_HTTP_RECORD=bots/award-analytics/test/fixtures/http.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as coreDb, http as coreHttp, snapshot, spine as coreSpine } from '@botarmy/core';
import { CF_SEARCH, FTS_PACKAGES, SOURCES, TED_SEARCH, tedRequest } from '../harvest.js';
import {
  BOT, EVENT_TYPE, dailyWindow, emitBuyerEvents, isJointVenture, markWindow, parseOcdsAwards, parseTedAwards,
  pendingMajorAwards, pendingShifts, pendingWindows, planBackfill, processSnapshots, queueSupplierReviews,
  recordSourceRun, supplierIdentity, toNumberOrNull, validateConfig, volumeAnomaly,
} from '../process.js';
import {
  WIN_RATE_NOTE, buyerKeyOf, computeMetrics, concentrationLabel, cpvDivisionOf, createAwardLookup, hhi, median,
  openAwardLookup, reconcile, recomputeBuyers, recomputeSuppliers,
} from '../analytics.js';
import { buildDigest, money } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'aa-test-'));
  dirs.push(d);
  return d;
};
const track = (h) => {
  handles.push(h);
  return h;
};
after(() => {
  for (const h of handles.splice(0)) {
    try { h.close(); } catch { /* already closed */ }
  }
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});

/* ============================================================= fixtures */

const NOW = '2026-09-30T08:00:00.000Z';
let seq = 0;
/** One OCDS award release. suppliers: [[name, chNumber|null]] */
const release = ({ buyer = 'Leeds City Council', suppliers, value = 500000, currency = 'GBP', cpv = '72222300', date = '2026-09-20', framework = false, tenderers = null, status = 'active', title = 'Digital services' }) => {
  seq += 1;
  return {
    ocid: `ocds-b5fd17-${seq}`, id: `abdbeb99-0618-44e9-aaf8-9b03ecbcb3cf-${seq}`, tag: ['award'], date: `${date}T10:00:00Z`,
    buyer: { name: buyer },
    tender: { title, items: cpv ? [{ classification: { scheme: 'CPV', id: cpv } }] : [], ...(framework ? { techniques: { hasFrameworkAgreement: true } } : {}) },
    ...(tenderers === null ? {} : { bids: { statistics: [{ measure: 'bids', value: tenderers }] } }),
    parties: [{ id: 'B', name: buyer, roles: ['buyer'], address: { countryName: 'United Kingdom' } },
      ...suppliers.map(([name, ch], i) => ({ id: `S${i}`, name, roles: ['supplier'], ...(ch ? { identifier: { scheme: 'GB-COH', id: ch } } : {}) }))],
    awards: [{ id: '1', title, status, date, value: value === null ? undefined : { amount: value, currency }, suppliers: suppliers.map(([name], i) => ({ id: `S${i}`, name })) }],
  };
};
const ocdsPage = (releases) => JSON.stringify({ releases, links: {} });

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
function openAll(dataDir = tmp()) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  return { db, store, spine, dataDir };
}
const storePage = (env, releases, sourceId = 'contractsFinder') =>
  env.store.writeRaw(SOURCES[sourceId], `p${seq}.json`, ocdsPage(releases), { sourceId, format: 'ocds' }).id;
const ingest = (env, releases, now = NOW) => {
  const r = processSnapshots({ ...env, snapshotIds: [storePage(env, releases)], now });
  recomputeSuppliers(env.db, r.suppliers, { now });
  return { ...r, changed: recomputeBuyers(env.db, r.buyers, { now }) };
};

/* =============================================================== parsing */

describe('award parsing', () => {
  test('OCDS: buyer, suppliers with registry ids, value, CPV division, tenderers; missing values stay null', () => {
    const [a] = parseOcdsAwards(Buffer.from(ocdsPage([release({ suppliers: [['ACME DIGITAL LTD', '1234567']], tenderers: 4 })])), 'contractsFinder');
    assert.equal(a.buyerName, 'Leeds City Council');
    assert.equal(a.buyerCountry, 'UK');
    assert.equal(a.value, 500000);
    assert.equal(a.valueKind, 'contract');
    assert.deepEqual(a.cpv, ['72222300']);
    assert.equal(a.numberOfTenderers, 4);
    assert.equal(a.confidence, 'awarded');
    assert.match(a.url, /contractsfinder\.service\.gov\.uk\/Notice\//);
    const [b] = parseOcdsAwards(Buffer.from(ocdsPage([release({ suppliers: [['X Ltd', null]], value: null, cpv: null })])), 'contractsFinder');
    assert.deepEqual([b.value, b.currency, b.valueKind, b.cpv, b.numberOfTenderers], [null, null, 'unknown', [], null]);
  });

  test('framework ceilings are flagged; cancelled awards and non-award releases are skipped', () => {
    const [fw] = parseOcdsAwards(Buffer.from(ocdsPage([release({ suppliers: [['A Ltd', null], ['B Ltd', null]], value: 50000000, framework: true })])), 'findATender');
    assert.equal(fw.valueKind, 'framework_ceiling');
    assert.equal(parseOcdsAwards(Buffer.from(ocdsPage([release({ suppliers: [['A Ltd', null]], status: 'cancelled' })])), 'contractsFinder').length, 0);
    assert.equal(parseOcdsAwards(Buffer.from(JSON.stringify({ releases: [{ id: 'x', tag: ['tender'], buyer: { name: 'B' } }] })), 'contractsFinder').length, 0);
    assert.throws(() => parseOcdsAwards(Buffer.from('<html>busy</html>'), 'findATender'), /not valid JSON/);
  });

  test('TED: tenderers are not confirmed winners; field names come from the snapshot meta', () => {
    const body = Buffer.from(JSON.stringify({ notices: [{ 'publication-number': '533445-2026', 'notice-title': { eng: 'IT framework' }, 'buyer-name': { eng: ['Dublin City Council'] },
      'buyer-country': ['IRL'], 'publication-date': '2026-09-28+02:00', 'organisation-name-tenderer': { eng: ['Alpha Ltd', 'Beta Ltd'] }, 'my-cpv': ['72000000'] }] }));
    const [t] = parseTedAwards(body, { cpvField: 'my-cpv', countryField: 'buyer-country' });
    assert.equal(t.confidence, 'tenderer');
    assert.equal(t.buyerCountry, 'IRL');
    assert.deepEqual(t.cpv, ['72000000']);
    assert.equal(t.value, null, 'no value field requested → no value, never guessed');
    assert.equal(t.suppliers.length, 2);
  });

  test('supplier identity: Companies House number first, else core name; JVs flagged; raw names kept', () => {
    assert.deepEqual(supplierIdentity({ name: 'Acme Digital Ltd', identifiers: [{ scheme: 'GB-COH', id: '1234567' }] }), { supplierKey: 'UK:01234567', matchMethod: 'registry' });
    assert.equal(supplierIdentity({ name: 'ACME DIGITAL LIMITED' }).supplierKey, supplierIdentity({ name: 'Acme Digital Ltd' }).supplierKey);
    assert.equal(isJointVenture('Alpha Ltd and Beta Ltd'), true);
    assert.equal(isJointVenture('Delta Consortium'), true);
    assert.equal(isJointVenture('Marks and Spencer plc'), false, 'one company with "and" in its name is not a JV');
  });

  test('numbers parsed safely', () => {
    assert.equal(toNumberOrNull('1,250,000'), 1250000);
    assert.equal(toNumberOrNull(''), null);
    assert.equal(toNumberOrNull(null), null);
    assert.equal(toNumberOrNull('approx'), null);
    assert.equal(cpvDivisionOf('72222300'), '72');
    assert.equal(cpvDivisionOf('7222'), null);
  });
});

/* ================================================================ metrics */

describe('metrics', () => {
  const award = (suppliers, o = {}) => ({ suppliers, value: 100, currency: 'GBP', valueKind: 'contract', tenderers: null, ...o });

  test('HHI and concentration bands', () => {
    assert.equal(hhi([1]), 10000);
    assert.equal(hhi([0.5, 0.5]), 5000);
    assert.equal(hhi([0.25, 0.25, 0.25, 0.25]), 2500);
    assert.equal(hhi([]), null);
    assert.equal(concentrationLabel(900, 10), 'unconcentrated');
    assert.equal(concentrationLabel(1800, 10), 'moderate');
    assert.equal(concentrationLabel(1801, 10), 'high');
    assert.equal(concentrationLabel(10000, 4), 'insufficient_data', 'below the minimum sample nothing is concluded');
  });

  test('multi-supplier awards split credit; incumbent needs both wins and share', () => {
    const m = computeMetrics([award(['A']), award(['A']), award(['A']), award(['B']), award(['A', 'C'])]);
    assert.equal(m.awards, 5);
    assert.deepEqual(m.topSupplier, { key: 'A', share: 0.7, wins: 4 });
    assert.deepEqual(m.incumbent, { key: 'A', share: 0.7, wins: 4 });
    assert.equal(m.hhi, Math.round(70 ** 2 + 20 ** 2 + 10 ** 2));
    assert.equal(computeMetrics([award(['A']), award(['B']), award(['C']), award(['D']), award(['E'])]).incumbent, null, 'no one ≥ 40%');
  });

  test('values: single-supplier contract values only, most common currency, mean and median', () => {
    const m = computeMetrics([
      award(['A'], { value: 100 }), award(['A'], { value: 300 }), award(['B'], { value: 200 }), award(['C'], { value: 400 }),
      award(['A', 'B'], { value: 9999 }), award(['D'], { value: 50000000, valueKind: 'framework_ceiling' }),
      award(['E'], { value: null, valueKind: 'unknown' }), award(['F'], { value: 7, currency: 'EUR' }),
    ]);
    assert.equal(m.valueCurrency, 'GBP');
    assert.equal(m.valueN, 4);
    assert.equal(m.avgValue, 250);
    assert.equal(m.medianValue, 250);
    assert.equal(median([1, 2, 3]), 2);
  });

  test('deterministic: same inputs, same metrics', () => {
    const list = [award(['B']), award(['A']), award(['A']), award(['C']), award(['A'])];
    assert.deepEqual(computeMetrics(list), computeMetrics([...list].reverse()));
  });
});

/* ======================================================= store + analytics */

describe('store, analytics, spine', () => {
  let env;
  before(() => {
    env = openAll();
  });

  test('awards stored once; suppliers resolved; re-processing writes nothing', () => {
    const releases = [
      ...Array.from({ length: 4 }, () => release({ suppliers: [['ACME DIGITAL LTD', '1234567']], tenderers: 3 })),
      release({ suppliers: [['Beta Systems Limited', null]] }),
      release({ suppliers: [['Gamma Ltd and Delta Ltd', null]], value: 2000000 }),
    ];
    const id = storePage(env, releases);
    const r = processSnapshots({ ...env, snapshotIds: [id], now: NOW });
    assert.equal(r.newAwards, 6);
    assert.equal(processSnapshots({ ...env, snapshotIds: [id], now: NOW }).newAwards, 0);
    recomputeSuppliers(env.db, r.suppliers, { now: NOW });
    recomputeBuyers(env.db, r.buyers, { now: NOW });
    assert.equal(env.db.prepare(`SELECT is_jv FROM award_suppliers WHERE raw_name = 'Gamma Ltd and Delta Ltd'`).pluck().get(), 1);
    assert.deepEqual(reconcile(env.db), [], 'aggregates reconcile with raw counts');
  });

  test('buyer analytics: concentration, incumbent, values; supplier profile: wins and contested wins', () => {
    const row = env.db.prepare(`SELECT * FROM buyer_analytics WHERE buyer_key = ? AND cpv_division = '*'`).get(buyerKeyOf('Leeds City Council'));
    assert.equal(row.awards, 6);
    assert.equal(row.incumbent_supplier_key, 'UK:01234567');
    assert.equal(row.concentration, 'high');
    assert.equal(row.value_currency, 'GBP');
    const p = env.db.prepare(`SELECT * FROM supplier_profiles WHERE supplier_key = 'UK:01234567'`).get();
    assert.deepEqual([p.wins, p.contested_wins, p.avg_competitors, p.company_number], [4, 4, 3, '01234567']);
  });

  test('a concentration shift is detected, emitted once to the spine per day, and listed for the digest', () => {
    const r = ingest(env, Array.from({ length: 12 }, (_, i) => release({ suppliers: [[`Newcomer ${i} Ltd`, null]] })));
    const shift = r.changed.find((c) => c.division === '*');
    assert.ok(shift.isShift);
    assert.equal(shift.prevConcentration, 'high');
    assert.notEqual(shift.concentration, 'high');
    assert.equal(emitBuyerEvents({ ...env, changedRows: r.changed, now: NOW }), 1);
    assert.equal(emitBuyerEvents({ ...env, changedRows: r.changed, now: NOW }), 0, 'idempotent per buyer per day');
    assert.equal(env.spine.db.prepare(`SELECT COUNT(*) FROM events WHERE type = ?`).pluck().get(EVENT_TYPE), 1);
    assert.equal(pendingShifts(env.db).length, 1);
  });

  test('TED tenderer listings are excluded from win shares by default', () => {
    const teds = Buffer.from(JSON.stringify({ notices: Array.from({ length: 6 }, (_, i) => ({ 'publication-number': `90000${i}-2026`, 'buyer-name': { eng: ['Leeds City Council'] }, 'publication-date': '2026-09-20', 'organisation-name-tenderer': { eng: ['Tenderer Only Ltd'] } })) }));
    const id = env.store.writeRaw(SOURCES.ted, 't.json', teds, { sourceId: 'ted', format: 'ted', countryField: null }).id;
    const r = processSnapshots({ ...env, snapshotIds: [id], now: NOW });
    recomputeBuyers(env.db, [...r.buyers, buyerKeyOf('Leeds City Council')], { now: NOW });
    const top = env.db.prepare(`SELECT top_supplier_key FROM buyer_analytics WHERE buyer_key = ? AND cpv_division = '*'`).pluck().get(buyerKeyOf('Leeds City Council'));
    assert.notEqual(top, 'name:tenderer only');
  });

  test('near-duplicate supplier names go to review_queue once, never merged', () => {
    const r = ingest(env, [release({ suppliers: [['Beta Systems UK Solutions Limited', null]] })]);
    recomputeSuppliers(env.db, r.suppliers, { now: NOW });
    const queued = queueSupplierReviews({ ...env, supplierKeys: r.suppliers, now: NOW });
    assert.equal(queued, 1);
    assert.equal(queueSupplierReviews({ ...env, supplierKeys: r.suppliers, now: NOW }), 0);
    assert.equal(env.db.prepare(`SELECT COUNT(*) FROM supplier_profiles WHERE supplier_key LIKE 'name:beta%'`).pluck().get(), 2, 'both kept');
  });

  test('reconcile catches drift between aggregates and raw rows', () => {
    env.db.prepare(`UPDATE supplier_profiles SET wins = wins + 1 WHERE supplier_key = 'UK:01234567'`).run();
    assert.match(reconcile(env.db).join(), /supplier_profiles wins/);
    recomputeSuppliers(env.db, ['UK:01234567'], { now: NOW });
    assert.deepEqual(reconcile(env.db), []);
  });

  test('major awards honour per-currency thresholds; framework ceilings labelled', () => {
    ingest(env, [release({ suppliers: [['Huge Ltd', null]], value: 90000000, framework: true }), release({ suppliers: [['Small Ltd', null]], value: 200 })]);
    const major = pendingMajorAwards(env.db, { GBP: 1000000, default: 1000000 });
    assert.ok(major.some((a) => a.winners === 'Huge Ltd' && a.value_kind === 'framework_ceiling'));
    assert.ok(!major.some((a) => a.winners === 'Small Ltd'));
    assert.match(money(90000000, 'GBP', 'framework_ceiling'), /framework ceiling, not a contract value/);
  });
});

/* ======================================================= lookup for B3 */

describe('lookup interface (for B3 tender-scout)', () => {
  let env;
  before(() => {
    env = openAll();
    ingest(env, [
      ...Array.from({ length: 5 }, () => release({ buyer: 'Bristol City Council', suppliers: [['Incumbent IT Ltd', '07654321']], cpv: '72000000' })),
      release({ buyer: 'Bristol City Council', suppliers: [['Other IT Ltd', null]], cpv: '72000000' }),
      release({ buyer: 'Bristol City Council', suppliers: [['Cleaners Ltd', null]], cpv: '90910000' }),
      release({ buyer: 'Tiny Parish Council', suppliers: [['X Ltd', null]] }),
    ]);
  });

  test('concentration and incumbent by buyer name + CPV code, exactly what B3 has when scoring', () => {
    const lookup = createAwardLookup(env.db);
    const c = lookup.buyerConcentration({ buyerName: 'BRISTOL CITY COUNCIL', cpv: '72220000' });
    assert.equal(c.available, true);
    assert.equal(c.scope, 'CPV division 72');
    assert.equal(c.awards, 6);
    assert.equal(c.concentration, 'high');
    assert.equal(c.topSupplier.name, 'Incumbent IT Ltd');
    const i = lookup.incumbent({ buyerName: 'Bristol City Council', cpv: '72220000' });
    assert.deepEqual(i.incumbent, { key: 'UK:07654321', name: 'Incumbent IT Ltd', wins: 5, share: 0.83 });
    assert.equal(lookup.buyerConcentration({ buyerName: 'Bristol City Council', cpv: '90910000' }).scope, 'all categories', 'thin division → falls back to all categories');
  });

  test('every miss says why; nothing is guessed', () => {
    const lookup = createAwardLookup(env.db);
    assert.match(lookup.buyerConcentration({ buyerName: 'Unknown Buyer' }).reason, /no awards recorded/);
    const thin = lookup.buyerConcentration({ buyerName: 'Tiny Parish Council' });
    assert.equal(thin.available, false);
    assert.match(thin.reason, /only 1 award/);
    const p = lookup.supplierProfile('UK:07654321');
    assert.equal(p.winRate, null);
    assert.equal(p.winRateNote, WIN_RATE_NOTE);
    assert.equal(lookup.topSuppliers({ cpv: '72000000' })[0].name, 'Incumbent IT Ltd');
  });

  test('openAwardLookup: unavailable before B6 has run; reads the real file afterwards; dry runs write nothing', () => {
    const empty = openAwardLookup({ dataDir: tmp() });
    assert.equal(empty.available, false);
    assert.match(empty.incumbent({ buyerName: 'x' }).reason, /run B6 first/);
    const live = openAwardLookup({ dataDir: env.dataDir });
    assert.equal(live.incumbent({ buyerName: 'Bristol City Council', cpv: '72000000' }).incumbent.name, 'Incumbent IT Ltd');
    live.close();
    const before = readFileSync(coreDb.dbPath(BOT, env.dataDir));
    const dry = openAwardLookup({ dataDir: env.dataDir, dryRun: true });
    assert.equal(dry.available, true);
    dry.close();
    assert.ok(readFileSync(coreDb.dbPath(BOT, env.dataDir)).equals(before));
  });
});

/* ============================================================ drop guards */

describe('drop guards and backfill', () => {
  test('a silent source against a busy history is an anomaly; thin history is not judged', () => {
    const env = openAll();
    const runId = Number(env.db.prepare(`INSERT INTO runs (started_at, mode) VALUES (?, 'daily')`).run(NOW).lastInsertRowid);
    const guard = { minExpected: 10, lookbackRuns: 5 };
    assert.equal(volumeAnomaly(env.db, 'contractsFinder', 0, guard), null);
    for (const n of [120, 90, 150]) recordSourceRun(env.db, { runId, source: 'contractsFinder', items: n, outcome: 'ok', now: NOW });
    assert.match(volumeAnomaly(env.db, 'contractsFinder', 0, guard), /returned 0 award releases; its last 3 runs averaged 120/);
    assert.equal(volumeAnomaly(env.db, 'contractsFinder', 3, guard), null);
  });

  test('an unparseable page is never marked processed: retried and reported every run', () => {
    const env = openAll();
    const bad = env.store.writeRaw(SOURCES.findATender, 'bad.json', '<html>429</html>', { sourceId: 'findATender', format: 'ocds' }).id;
    assert.equal(processSnapshots({ ...env, snapshotIds: [bad], now: NOW }).failures.length, 1);
    assert.equal(processSnapshots({ ...env, snapshotIds: [bad], now: NOW }).failures.length, 1);
  });

  test('backfill resumes after a kill: windows are planned once and only finished ones are skipped', () => {
    const env = openAll();
    const plan = () => planBackfill(env.db, { sources: ['contractsFinder', 'findATender'], months: 2, chunkDays: 7, now: NOW });
    const planned = plan();
    assert.ok(planned >= 16);
    assert.equal(plan(), 0, 'replanning adds nothing');
    const first = pendingWindows(env.db, 5);
    first.slice(0, 3).forEach((w) => markWindow(env.db, { ...w, status: 'done', items: 10, now: NOW }));
    // "kill" here: the remaining two of this batch were never marked.
    const next = pendingWindows(env.db, 100);
    assert.equal(next.length, planned - 3);
    assert.ok(next.some((w) => w.from === first[3].from && w.source === first[3].source), 'unfinished window is still pending');
    assert.deepEqual(dailyWindow(null, NOW, 3), { from: '2026-09-27T08:00:00.000Z', to: NOW });
  });

  test('config validation reports every problem at once', () => {
    assert.throws(() => validateConfig({ sources: { nope: {} }, majorAward: { GBP: -1 }, analytics: { windowMonths: 0, minSample: 1, minIncumbentShare: 2 }, backfill: { chunkDays: 90 } }), (err) => {
      for (const p of ['sources.nope', 'majorAward.GBP', 'windowMonths', 'minSample', 'minIncumbentShare', 'chunkDays']) assert.ok(err.message.includes(p), p);
      return true;
    });
  });
});

/* ================================================================= digest */

test('digest: major awards, top winners, shifts; values as published; limits respected', () => {
  const d = buildDigest({
    date: '2026-09-30', stats: { newAwards: 40 },
    awards: [{ value: 2500000, currency: 'GBP', value_kind: 'contract', url: 'https://x/n', title: 'Platform <build>', buyer_name: 'Leeds', winners: 'Acme', award_date: '2026-09-20', number_of_tenderers: 4, source: 'contractsFinder', confidence: 'awarded' }],
    winners: [{ name: 'Acme', wins: 3, totalWins: 12 }],
    shifts: [{ buyer_name: 'Leeds', prev_hhi: 6000, hhi: 1200, prev_concentration: 'high', concentration: 'moderate', awards: 18, window_months: 24, prev_incumbent_key: 'UK:1', incumbent_supplier_key: null, prev_incumbent_name: 'Acme' }],
  });
  const text = JSON.stringify(d.blocks);
  assert.match(text, /GBP 2,500,000/);
  assert.match(text, /Platform &lt;build&gt;/);
  assert.match(text, /4 tenderers/);
  assert.match(text, /3 new wins \(12 in total\)/);
  assert.match(text, /highly concentrated → \*moderately concentrated\*/);
  assert.match(text, /incumbent Acme → \*none\*/);
  assert.match(text, /Win rates are not shown/);
  assert.ok(d.blocks.length <= 50);
});

/* ============================================================ entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;
  let server;
  let slackUrl;
  const posts = [];
  const window = dailyWindow(null, NOW, 3);
  const iso = (d) => new Date(d).toISOString().slice(0, 19);

  const put = (method, url, body, payload) => writeFileSync(path.join(fixtures, `${coreHttp.fixtureKey(method, url, payload)}.json`), JSON.stringify({
    url, status: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(body).toString('base64'),
  }));
  const writeFixtures = (releases) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    const ted = validateConfig({}).sources.ted;
    // The first run reads the 3-day lookback; after a live run each cursor is NOW, so the next run reads the
    // 1-hour overlap window. Same releases in both: re-reads are deduplicated.
    for (const w of [window, dailyWindow(NOW, NOW)]) {
      put('GET', `${CF_SEARCH}?${new URLSearchParams({ publishedFrom: iso(w.from), publishedTo: iso(w.to), limit: '100' })}`, ocdsPage(releases));
      put('GET', `${FTS_PACKAGES}?${new URLSearchParams({ updatedFrom: iso(w.from), updatedTo: iso(w.to) })}`, ocdsPage([]));
      put('POST', TED_SEARCH, JSON.stringify({ notices: [] }), tedRequest(ted, w, 1).body);
    }
  };
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js', ...args], {
      cwd: BOT_DIR,
      env: {
        ...process.env, BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, AA_NOW: NOW, AA_CONFIG: path.join(dataDir, '..', 'none.json'),
        LOG_FORMAT: 'json', SLACK_WEBHOOK_URL: slackUrl, SLACK_WEBHOOK_URL_AWARDS: '', HEALTHCHECKS_BASE_URL: '', HC_UUID_AWARD_ANALYTICS: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
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

  before(async () => {
    const base = tmp();
    dataDir = path.join(base, 'data');
    fixtures = path.join(base, 'fixtures');
    mkdirSync(dataDir);
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { posts.push(JSON.parse(b)); res.end('ok'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    slackUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  const RELEASES = () => [release({ suppliers: [['ACME DIGITAL LTD', '1234567']], value: 2500000 }), release({ suppliers: [['Beta Ltd', null]], value: 300000 })];

  test('--dry-run on an empty data dir prints the digest and writes nothing', async () => {
    writeFixtures(RELEASES());
    const r = await run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.match(r.stdout, /Award analytics 2026-09-30: 1 major awards/);
    assert.equal(posts.length, 0);
  });

  test('live daily run stores awards and posts one digest', async () => {
    const r = await run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(readdirSync(dataDir).includes('award-analytics.sqlite'));
    assert.equal(posts.length, 1);
    assert.match(JSON.stringify(posts[0].blocks), /GBP 2,500,000/);
  });

  test('--dry-run after a live run leaves every file byte-identical', async () => {
    const before = fingerprint(dataDir);
    const r = await run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fingerprint(dataDir), before);
  });

  test('when every source fails the run exits 1 with a loud alert', async () => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures);
    const fresh = path.join(tmp(), 'data');
    mkdirSync(fresh);
    const child = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['index.js', '--dry-run'], { cwd: BOT_DIR, env: { ...process.env, BOTARMY_DATA_DIR: fresh, BOTARMY_HTTP_REPLAY: fixtures, AA_NOW: NOW, AA_CONFIG: '/nonexistent.json', LOG_FORMAT: 'json', SLACK_WEBHOOK_URL: slackUrl, HEALTHCHECKS_BASE_URL: '' } });
      let out = '';
      c.stdout.on('data', (x) => (out += x));
      c.on('close', (status) => resolve({ status, out }));
    });
    assert.equal(child.status, 1);
    assert.match(child.out, /every source failed/);
  });
});