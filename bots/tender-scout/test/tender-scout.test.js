/**
 * B3 TenderScout tests.   Run: npm test -w bots/tender-scout
 *
 * Fixtures are built here in the shapes the sources serve: OCDS release
 * packages (Contracts Finder, Find a Tender) and TED v3 search pages. Record
 * real payloads with BOTARMY_HTTP_RECORD=bots/tender-scout/test/fixtures/http.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as coreDb, http as coreHttp, snapshot, spine as coreSpine } from '@botarmy/core';
import { SOURCES, contractsFinderUrl, findATenderUrl, harvestAll, tedRequest, windowFrom } from '../harvest.js';
import {
  BOT, EVENT_TYPE, activeProfiles, applyFilters, getCursor, markNotified, matchAndScore, parseOcdsTenders,
  parseTedTenders, pendingMatches, recordSourceRun, setCursor, storeTenders, syncProfiles, validateConfig, volumeAnomaly,
} from '../process.js';
import { DEFAULT_WEIGHTS, NOT_SCORED, bestCpvMatch, daysUntil, scoreTender, toNumberOrNull } from '../score.js';
import { buildAnomalyAlert, buildDigest, deadlineLabel, valueLabel } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ts-test-'));
  dirs.push(d);
  return d;
};
const track = (h) => {
  handles.push(h);
  return h;
};
after(() => {
  coreHttp.setFetch();
  for (const h of handles.splice(0)) {
    try { h.close(); } catch { /* already closed */ }
  }
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});

/* ============================================================= fixtures */

const NOW = '2026-10-01T06:00:00.000Z';
const inDays = (n) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();

/** OCDS tender release. */
const release = ({ ocid, title, cpv = ['79600000'], value = 250000, deadlineDays = 30, region = 'London', buyer = 'Leeds City Council', tag = 'tender', date = NOW, description = '' }) => ({
  ocid, id: `${ocid.replace('ocds-', '').padEnd(8, '0')}-0618-44e9-aaf8-9b03ecbcb3cf-1`, tag: [tag], date,
  buyer: { name: buyer },
  tender: {
    title, description, status: tag === 'tenderCancellation' ? 'cancelled' : 'active',
    value: value === null ? undefined : { amount: value, currency: 'GBP' },
    tenderPeriod: deadlineDays === null ? {} : { endDate: inDays(deadlineDays) },
    items: [{ classification: cpv[0] ? { scheme: 'CPV', id: cpv[0] } : undefined, additionalClassifications: cpv.slice(1).map((id) => ({ scheme: 'CPV', id })), deliveryAddresses: region ? [{ region }] : [] }],
  },
});
const ocdsPackage = (releases, next = null) => JSON.stringify({ releases, links: next ? { next } : {} });

const PROFILE_RAW = {
  id: 'ateca', name: 'Ateca', cpvPrefixes: ['796', '7941'], keywords: ['recruitment', 'executive search', 'interim'],
  excludeKeywords: ['catering'], valueBand: { min: 50000, max: 5000000, currency: 'GBP' }, locations: ['London', 'England'], minDaysToDeadline: 10,
};
const CONFIG = (over = {}) => validateConfig({ profiles: [PROFILE_RAW], sources: {}, ...over });
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function openAll(dataDir = tmp()) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  return { db, store, spine, dataDir };
}
const storeOcds = (env, sourceId, releases) => ({
  sourceId, notices: releases.length,
  snapshotIds: [env.store.writeRaw(SOURCES[sourceId], 'page-1.json', ocdsPackage(releases), { sourceId, format: 'ocds' }).id],
});
const profileOf = (env) => activeProfiles(env.db)[0];

/* ================================================================ parsing */

describe('parsing', () => {
  test('OCDS: tender releases only; CPV from items and additional codes; lot values; latest release per ocid wins', () => {
    const pkg = JSON.parse(ocdsPackage([
      release({ ocid: 'ocds-1', title: 'Recruitment services', cpv: ['79600000-0', '79620000'], date: '2026-09-29T00:00:00Z' }),
      { ...release({ ocid: 'ocds-1', title: 'Recruitment services (amended)', cpv: ['79600000'], date: '2026-09-30T00:00:00Z' }), tag: ['tenderAmendment'] },
      { ...release({ ocid: 'ocds-2', title: 'Award only' }), tag: ['award'] },
      { ...release({ ocid: 'ocds-3', title: 'Lots only', value: null }), tender: { ...release({ ocid: 'ocds-3', title: 'Lots only', value: null }).tender, lots: [{ value: { amount: 1000, currency: 'GBP' } }, { value: { amount: 5000, currency: 'GBP' } }] } },
      release({ ocid: 'ocds-4', title: 'Cancelled one', tag: 'tenderCancellation' }),
    ]));
    const notices = parseOcdsTenders(Buffer.from(JSON.stringify(pkg)), { sourceId: 'findATender' });
    assert.deepEqual(notices.map((n) => n.noticeId).sort(), ['ocds-1', 'ocds-3', 'ocds-4']);
    const one = notices.find((n) => n.noticeId === 'ocds-1');
    assert.equal(one.title, 'Recruitment services (amended)');
    assert.deepEqual(one.cpv, ['79600000']);
    assert.deepEqual(one.locations, ['London']);
    assert.equal(notices.find((n) => n.noticeId === 'ocds-3').valueMax, 5000);
    assert.equal(notices.find((n) => n.noticeId === 'ocds-4').status, 'cancelled');
  });

  test('missing values, deadlines and locations stay null/empty: never invented', () => {
    const [n] = parseOcdsTenders(Buffer.from(ocdsPackage([release({ ocid: 'ocds-9', title: 'Bare', value: null, deadlineDays: null, region: null, cpv: [] })])), { sourceId: 'contractsFinder' });
    assert.equal(n.valueMax, null);
    assert.equal(n.valueMin, null);
    assert.equal(n.deadline, null);
    assert.deepEqual(n.locations, []);
    assert.deepEqual(n.cpv, []);
    assert.equal(toNumberOrNull('approx 1m'), null);
    assert.equal(toNumberOrNull('1,250,000'), 1250000);
  });

  test('TED: field names come from snapshot meta; unrequested fields are unknown', () => {
    const page = JSON.stringify({ notices: [
      { 'publication-number': '600001-2026', 'notice-title': { eng: 'Interim recruitment framework' }, 'buyer-name': { eng: ['Dublin City Council'] }, 'publication-date': '2026-09-30+02:00', 'classification-cpv': ['79600000'], 'buyer-country': ['IRL'], 'deadline-x': '2026-11-15T12:00:00+01:00' },
      { 'notice-title': { eng: 'No publication number' } },
    ] });
    const withDeadline = parseTedTenders(Buffer.from(page), { cpvField: 'classification-cpv', countryField: 'buyer-country', deadlineField: 'deadline-x' });
    assert.equal(withDeadline.length, 1);
    assert.equal(withDeadline[0].deadline, '2026-11-15T12:00:00+01:00');
    assert.deepEqual(withDeadline[0].locations, ['IRL']);
    const defaults = parseTedTenders(Buffer.from(page), { cpvField: 'classification-cpv', countryField: null, deadlineField: null });
    assert.equal(defaults[0].deadline, null);
    assert.equal(defaults[0].valueMax, null);
    assert.throws(() => parseTedTenders(Buffer.from('{"oops":1}'), {}), /no "notices" array/);
  });
});

/* ============================================================ CPV / filters */

describe('CPV matching and filters', () => {
  const env = openAll();
  before(() => syncProfiles(env.db, CONFIG().profiles, NOW));
  const t = (o = {}) => ({ status: 'active', duplicateOf: null, title: 'Recruitment services', description: '', cpv: ['79620000'], valueMax: 250000, valueMin: null, currency: 'GBP', deadline: inDays(30), locations: ['London'], ...o });

  test('longest CPV prefix wins', () => {
    assert.deepEqual(bestCpvMatch(['79411000'], ['79', '7941']), { code: '79411000', prefix: '7941' });
    assert.equal(bestCpvMatch(['45000000'], ['796']), null);
    assert.equal(bestCpvMatch([], ['796']), null);
  });

  test('passes on a CPV match or a capability keyword; fails when neither', () => {
    const p = profileOf(env);
    assert.deepEqual(applyFilters(t(), p, NOW), { passed: true, reason: `cpv:${bestCpvMatch(['79620000'], p.cpvPrefixes).prefix}` });
    assert.deepEqual(applyFilters(t({ cpv: [], title: 'Executive search for a director' }), p, NOW), { passed: true, reason: 'keyword' }, 'no CPV, keyword hit');
    assert.deepEqual(applyFilters(t({ cpv: ['45000000'], title: 'Road resurfacing' }), p, NOW), { passed: false, reason: 'cpv-mismatch-no-keywords' });
    assert.deepEqual(applyFilters(t({ cpv: [], title: 'Road resurfacing' }), p, NOW), { passed: false, reason: 'no-cpv-no-keywords' });
  });

  test('exclusions, value floor, deadlines, cancellations and duplicates', () => {
    const p = profileOf(env);
    assert.equal(applyFilters(t({ title: 'Recruitment of catering staff' }), p, NOW).reason, 'excluded-keyword:catering');
    assert.equal(applyFilters(t({ valueMax: 10000 }), p, NOW).reason, 'below-value-floor');
    assert.equal(applyFilters(t({ valueMax: null }), p, NOW).passed, true, 'unknown value is not assumed below the floor');
    assert.equal(applyFilters(t({ valueMax: 10000, currency: 'EUR' }), p, NOW).passed, true, 'floor not applied across currencies');
    assert.equal(applyFilters(t({ deadline: inDays(5) }), p, NOW).reason, 'deadline-too-close');
    assert.equal(applyFilters(t({ deadline: inDays(-1) }), p, NOW).reason, 'deadline-passed');
    assert.equal(applyFilters(t({ deadline: null }), p, NOW).passed, true, 'unknown deadline passes, labelled in the score');
    assert.equal(applyFilters(t({ status: 'cancelled' }), p, NOW).reason, 'cancelled');
    assert.equal(applyFilters(t({ duplicateOf: 7 }), p, NOW).reason, 'duplicate');
  });
});

/* ========================================================== determinism */

describe('scoring', () => {
  const profile = CONFIG().profiles[0];
  const tender = { title: 'Interim recruitment and executive search', description: 'Recruitment of senior leaders', cpv: ['79411000'], valueMax: 400000, valueMin: null, currency: 'GBP', deadline: inDays(30), locations: ['London'] };

  test('deterministic: identical inputs, identical score and reasons', () => {
    assert.deepEqual(scoreTender(tender, profile, NOW), scoreTender(tender, profile, NOW));
    assert.deepEqual(scoreTender(structuredClone(tender), structuredClone(profile), NOW), scoreTender(tender, profile, NOW));
  });

  test('every point explained: factor points sum to the score; not-yet-scored factors listed', () => {
    const { score, reasons } = scoreTender(tender, profile, NOW);
    const sum = Object.keys(DEFAULT_WEIGHTS).reduce((s, k) => s + reasons[k].points, 0);
    assert.ok(Math.abs(sum - score) <= 0.5, `points ${sum} vs score ${score}`);
    for (const k of Object.keys(DEFAULT_WEIGHTS)) assert.equal(typeof reasons[k].note, 'string');
    assert.deepEqual(reasons.notScored, NOT_SCORED);
    assert.equal(reasons.cpv.matched, '7941');
  });

  test('unknowns are explicit and neutral, never full marks', () => {
    const { reasons } = scoreTender({ ...tender, cpv: [], valueMax: null, deadline: null, locations: [] }, profile, NOW);
    for (const k of ['cpv', 'value', 'location', 'deadline']) assert.equal(reasons[k].unknown, true, k);
    assert.ok(reasons.value.value < 1 && reasons.deadline.value < 1);
  });

  test('only the clock-dependent factor moves with time; weights override per profile', () => {
    const a = scoreTender(tender, profile, NOW).reasons;
    const b = scoreTender(tender, profile, inDays(18)).reasons;
    assert.deepEqual({ ...a, deadline: null }, { ...b, deadline: null });
    assert.notEqual(a.deadline.value, b.deadline.value);
    const cpvHeavy = scoreTender({ ...tender, cpv: ['45000000'] }, { ...profile, weights: { cpv: 90 } }, NOW);
    const cpvLight = scoreTender({ ...tender, cpv: ['45000000'] }, profile, NOW);
    assert.ok(cpvHeavy.score < cpvLight.score);
    assert.equal(daysUntil(null, NOW), null);
  });
});

/* =========================================================== drop guards */

describe('drop guards', () => {
  test('zero notices is an anomaly only against a busy history', () => {
    const env = openAll();
    const runId = Number(env.db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(NOW).lastInsertRowid);
    const guard = { minExpected: 20, lookbackRuns: 7 };
    assert.equal(volumeAnomaly(env.db, 'ted', 0, guard), null, 'no history: a quiet first day is fine');
    for (const n of [40, 55, 38]) recordSourceRun(env.db, { runId, sourceId: 'ted', notices: n, outcome: 'ok', now: NOW });
    assert.match(volumeAnomaly(env.db, 'ted', 0, guard), /ted returned 0 notices; the last 3 runs averaged 44/);
    assert.equal(volumeAnomaly(env.db, 'ted', 3, guard), null, 'a low but non-zero day is not a drop');
    for (const n of [2, 1, 3]) recordSourceRun(env.db, { runId, sourceId: 'contractsFinder', notices: n, outcome: 'ok', now: NOW });
    assert.equal(volumeAnomaly(env.db, 'contractsFinder', 0, guard), null, 'a normally quiet source may return 0');
  });

  test('parse failures are not marked processed: retried and reported every run', () => {
    const env = openAll();
    const bad = { sourceId: 'contractsFinder', notices: 1, snapshotIds: [env.store.writeRaw(SOURCES.contractsFinder, 'p.json', '<!DOCTYPE html><html>maintenance</html>', { sourceId: 'contractsFinder', format: 'ocds' }).id] };
    assert.equal(storeTenders({ ...env, fetch: bad, now: NOW, log: quiet }).failures.length, 1);
    assert.equal(storeTenders({ ...env, fetch: bad, now: NOW, log: quiet }).failures.length, 1, 'still failing, still reported');
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM processed_snapshots').pluck().get(), 0);
  });

  test('a truncated window keeps the cursor; a clean one advances it; one failing source does not stop others', async () => {
    const env = openAll();
    const page = ocdsPackage([release({ ocid: 'ocds-1', title: 'Recruitment' })], 'https://www.contractsfinder.service.gov.uk/next-page');
    coreHttp.setFetch(async (url) => {
      if (String(url).includes('contractsfinder')) return new Response(page, { headers: { 'content-type': 'application/json' } });
      if (String(url).includes('find-tender')) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ notices: [] }), { headers: { 'content-type': 'application/json' } });
    });
    const h = await harvestAll({ sources: { contractsFinder: { maxPages: 1 }, findATender: {}, ted: {} }, store: env.store, getCursor: () => '2026-09-30T00:00:00.000Z', now: NOW, log: quiet });
    const cf = h.fetches.find((f) => f.sourceId === 'contractsFinder');
    assert.equal(cf.truncated, true);
    assert.equal(cf.nextCursor, '2026-09-30T00:00:00.000Z', 'cursor held so the rest is fetched next run');
    assert.equal(h.fetches.find((f) => f.sourceId === 'ted').nextCursor, NOW);
    assert.deepEqual(h.failures.map((f) => f.sourceId), ['findATender']);
    coreHttp.setFetch();
  });

  test('request windows overlap the cursor by one hour; TED filters at query time', () => {
    assert.equal(windowFrom('2026-09-30T06:00:00.000Z', NOW, 2).toISOString(), '2026-09-30T05:00:00.000Z');
    assert.equal(windowFrom(null, NOW, 2).toISOString(), '2026-09-29T06:00:00.000Z');
    const q = tedRequest({ buyerCountries: ['IRL'], cpvPrefixes: ['796'] }, null, NOW).query;
    assert.match(q, /buyer-country IN \(IRL\)/);
    assert.match(q, /classification-cpv IN \(796\*\)/);
    const noCpv = JSON.parse(tedRequest({ cpvField: null, cpvPrefixes: ['796'] }, null, NOW).body);
    assert.ok(!noCpv.fields.includes('classification-cpv'));
    assert.doesNotMatch(noCpv.query, /classification-cpv/);
    assert.match(contractsFinderUrl({}, null, NOW), /publishedFrom=2026-09-29T06%3A00%3A00/);
    assert.match(findATenderUrl({}, null, NOW), /updatedTo=2026-10-01T06%3A00%3A00/);
  });
});

/* ===================================================== store and match */

describe('store, match and spine', () => {
  let env;
  before(() => {
    env = openAll();
    syncProfiles(env.db, CONFIG().profiles, NOW);
  });

  test('idempotent storage; cross-source duplicates are recognised and never scored twice', () => {
    const r1 = storeTenders({ ...env, fetch: storeOcds(env, 'contractsFinder', [release({ ocid: 'ocds-cf-1', title: 'Interim recruitment services' }), release({ ocid: 'ocds-cf-2', title: 'Executive search partner', buyer: 'Leeds City Council' })]), now: NOW });
    const r2 = storeTenders({ ...env, fetch: storeOcds(env, 'findATender', [release({ ocid: 'ocds-fts-9', title: 'Interim Recruitment Services' })]), now: NOW });
    assert.equal(r1.changedIds.length, 2);
    assert.equal(r2.changedIds.length, 1);
    const dup = env.db.prepare(`SELECT duplicate_of FROM tenders WHERE notice_id = 'ocds-fts-9'`).pluck().get();
    assert.ok(dup, 'same title + buyer + deadline on Find a Tender is a duplicate');
    const again = storeTenders({ ...env, fetch: { sourceId: 'contractsFinder', notices: 2, snapshotIds: [env.store.latest(SOURCES.contractsFinder).id] }, now: NOW });
    assert.equal(again.changedIds.length, 0, 'same snapshot is not reparsed');

    const counts = matchAndScore({ ...env, profiles: activeProfiles(env.db), tenderIds: [...r1.changedIds, ...r2.changedIds], now: NOW, log: quiet });
    assert.equal(counts.opportunities, 2);
    assert.equal(env.db.prepare(`SELECT filter_reason FROM scored_matches m JOIN tenders t ON t.id = m.tender_id WHERE t.notice_id = 'ocds-fts-9'`).pluck().get(), 'duplicate');
  });

  test('one TENDER_OPPORTUNITY per tender, even for two tenders from one buyer on one day; buyer resolved on the spine', () => {
    const events = env.spine.db.prepare(`SELECT e.*, n.name FROM events e JOIN entities n ON n.entity_id = e.entity_id WHERE e.type = ?`).all(EVENT_TYPE);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.name === 'Leeds City Council'));
    assert.equal(new Set(events.map((e) => e.source)).size, 2);
    assert.match(events[0].source, /^tender-scout:contractsFinder:ocds-cf-/);
    assert.equal(JSON.parse(events[0].payload).profiles[0].profileId, 'ateca');
  });

  test('pending matches ranked by score; notified matches are not re-sent after an amendment', () => {
    const p = profileOf(env);
    const pending = pendingMatches(env.db, p.profileId);
    assert.equal(pending.length, 2);
    assert.ok(pending[0].score >= pending[1].score);
    markNotified(env.db, pending.map((m) => m.matchId), NOW);
    const amended = storeTenders({ ...env, fetch: storeOcds(env, 'contractsFinder', [release({ ocid: 'ocds-cf-1', title: 'Interim recruitment services', deadlineDays: 45 })]), now: inDays(1) });
    assert.equal(amended.changedIds.length, 1, 'deadline extension detected as an amendment');
    matchAndScore({ ...env, profiles: activeProfiles(env.db), tenderIds: amended.changedIds, now: inDays(1), log: quiet });
    assert.equal(pendingMatches(env.db, p.profileId).length, 0, 'already sent: not repeated');
    const reasons = JSON.parse(env.db.prepare(`SELECT reasons FROM scored_matches m JOIN tenders t ON t.id = m.tender_id WHERE t.notice_id = 'ocds-cf-1'`).pluck().get());
    assert.equal(reasons.deadline.input, 44, 'rescored against the amended deadline');
    assert.equal(env.spine.db.prepare(`SELECT COUNT(*) FROM events WHERE type = ?`).pluck().get(EVENT_TYPE), 2, 'no extra event for an amendment');
  });

  test('cursors are stored per source', () => {
    setCursor(env.db, 'ted', NOW, NOW);
    assert.equal(getCursor(env.db, 'ted'), NOW);
    assert.equal(getCursor(env.db, 'findATender'), null);
  });

  test('config validation reports every problem at once', () => {
    assert.throws(() => validateConfig({ profiles: [{ id: 'Bad Id', cpvPrefixes: ['7'], valueBand: { min: 10, max: 5 }, minDaysToDeadline: -1 }], sources: { bogus: {} }, volumeGuard: { minExpected: 0 } }), (err) => {
      for (const p of ['lowercase slug', 'name is required', '2–8 digits', 'min exceeds max', 'minDaysToDeadline', 'not a known source', 'minExpected']) assert.match(err.message, new RegExp(p));
      return true;
    });
  });
});

/* =============================================================== digest */

describe('digest', () => {
  const row = (o = {}) => ({ id: 1, matchId: 1, score: 77, title: 'Interim <recruitment> & search', buyer: 'Leeds City Council', valueMin: null, valueMax: 250000, currency: 'GBP', deadline: inDays(12), source: 'contractsFinder', url: 'https://www.contractsfinder.service.gov.uk/Notice/x', reasons: { cpv: { input: '79600000', matched: '796' }, keywords: { input: ['recruitment (title)'] }, location: { input: 'London', value: 1 } }, ...o });

  test('ranked opportunities and a key-deadlines section; unknowns labelled; mrkdwn escaped', () => {
    const d = buildDigest({ profile: { name: 'Ateca' }, matches: [row(), row({ id: 2, matchId: 2, score: 60, deadline: null, valueMax: null })], now: NOW });
    const text = JSON.stringify(d.blocks);
    assert.match(d.blocks[0].text.text, /Tenders for Ateca · 2026-10-01/);
    assert.match(text, /Ranked opportunities/);
    assert.match(text, /Key deadlines \(next 21 days\)/);
    assert.match(text, /closes 2026-10-13 \(12 days left\)/);
    assert.match(text, /deadline not published/);
    assert.match(text, /value not published/);
    assert.match(text, /Interim &lt;recruitment&gt; &amp; search/);
    assert.match(text, /Not scored yet: buyerConcentration/);
    assert.equal(valueLabel({ valueMin: 100000, valueMax: 250000, currency: 'GBP' }), 'GBP 100,000–250,000');
    assert.equal(deadlineLabel({ deadline: null }, NOW), 'deadline not published');
  });

  test('caps the ranked list and respects Slack limits; anomaly alert is explicit', () => {
    const d = buildDigest({ profile: { name: 'X' }, matches: Array.from({ length: 60 }, (_, i) => row({ id: i, matchId: i })), now: NOW, maxRanked: 20 });
    assert.match(d.blocks[1].elements[0].text, /60 new opportunities \(top 20 shown\)/);
    assert.ok(d.blocks.length <= 50);
    assert.match(buildAnomalyAlert({ date: 'd', problems: ['ted returned 0'] }).blocks[0].text.text, /fetched again next run/);
  });
});

/* =========================================================== entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;
  let configPath;
  let server;
  let webhook;
  const posts = [];
  const SOURCES_CFG = { contractsFinder: { lookbackDays: 2 }, findATender: { enabled: false }, ted: { lookbackDays: 2, cpvField: 'classification-cpv', countryField: null } };

  const put = (method, url, body, payload) => writeFileSync(path.join(fixtures, `${coreHttp.fixtureKey(method, url, body)}.json`), JSON.stringify({
    url, status: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(payload).toString('base64'),
  }));
  /** Record fixtures for exactly the requests a run at `now` with `cursors` will make. */
  const writeDay = (now, cursors, cfReleases, tedNotices) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    put('GET', contractsFinderUrl(SOURCES_CFG.contractsFinder, cursors.contractsFinder ?? null, now), undefined, ocdsPackage(cfReleases));
    const ted = tedRequest(SOURCES_CFG.ted, cursors.ted ?? null, now, 1);
    put('POST', ted.url, ted.body, JSON.stringify({ notices: tedNotices }));
  };
  const runAsync = (now, ...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js', ...args], {
      cwd: BOT_DIR,
      env: {
        ...process.env, BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, TS_PROFILES: configPath, TS_NOW: now, LOG_FORMAT: 'json',
        SLACK_WEBHOOK_URL: webhook, SLACK_WEBHOOK_URL_TENDERS: '', HEALTHCHECKS_BASE_URL: '', HC_UUID_TENDER_SCOUT: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const cursorsNow = () => {
    const db = coreDb.connect(BOT, { dataDir, dryRun: true });
    try {
      return Object.fromEntries(db.prepare('SELECT source, cursor FROM harvest_state').all().map((r) => [r.source, r.cursor]));
    } finally {
      db.close();
    }
  };
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
  const tedNotice = (n, title) => ({ 'publication-number': `60000${n}-2026`, 'notice-title': { eng: title }, 'buyer-name': { eng: ['Dublin City Council'] }, 'publication-date': '2026-09-30', 'classification-cpv': ['79600000'] });

  before(async () => {
    const base = tmp();
    dataDir = path.join(base, 'data');
    fixtures = path.join(base, 'fixtures');
    mkdirSync(dataDir);
    configPath = path.join(base, 'profiles.json');
    writeFileSync(configPath, JSON.stringify({ profiles: [PROFILE_RAW], sources: SOURCES_CFG, volumeGuard: { minExpected: 1, lookbackRuns: 3 } }));
    server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { posts.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise((r) => server.listen(0, r));
    webhook = `http://127.0.0.1:${server.address().port}/hook`;
  });
  after(() => server.close());

  test('--dry-run on an empty data dir prints a digest and writes nothing', async () => {
    writeDay(NOW, {}, [release({ ocid: 'ocds-1', title: 'Interim recruitment services' })], [tedNotice(1, 'Executive search framework')]);
    const r = await runAsync(NOW, '--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Tenders for Ateca 2026-10-01: 2 new/);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.equal(posts.length, 0);
  });

  test('live run posts one digest per profile, then a re-run sends nothing new', async () => {
    const r = await runAsync(NOW);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(posts.length, 1);
    assert.match(posts[0].text, /Tenders for Ateca/);
    assert.ok(readdirSync(dataDir).includes('tender-scout.sqlite'));
    // The cursors advanced, so the re-run asks for the overlapping window; it returns the same notices.
    writeDay(NOW, cursorsNow(), [release({ ocid: 'ocds-1', title: 'Interim recruitment services' })], [tedNotice(1, 'Executive search framework')]);
    const again = await runAsync(NOW);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(posts.length, 1, 'the same notices in an overlapping window are not re-sent');
  });

  test('a source going silent against a busy history alerts and holds its cursor; files untouched in dry-run', async () => {
    // Two more healthy days so the guard has three runs of history.
    for (const day of ['2026-10-02T06:00:00.000Z', '2026-10-03T06:00:00.000Z']) {
      writeDay(day, cursorsNow(), [release({ ocid: `ocds-${day.slice(8, 10)}`, title: 'Recruitment services', date: day })], [tedNotice(Number(day.slice(8, 10)), 'Interim staffing')]);
      const r = await runAsync(day);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    const quietDay = '2026-10-04T06:00:00.000Z';
    const cursorsBefore = cursorsNow();
    writeDay(quietDay, cursorsBefore, [release({ ocid: 'ocds-04', title: 'Recruitment services', date: quietDay })], []);
    const before = fingerprint(dataDir);
    const dry = await runAsync(quietDay, '--dry-run');
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /TenderScout source problem/);
    assert.match(dry.stdout, /ted returned 0 notices/);
    assert.deepEqual(fingerprint(dataDir), before);

    const live = await runAsync(quietDay);
    assert.equal(live.status, 0, live.stdout + live.stderr);
    const after = cursorsNow();
    assert.equal(after.ted, cursorsBefore.ted, 'ted cursor held: the window is re-fetched next run');
    assert.equal(after.contractsFinder, quietDay, 'healthy source advanced');
  });

  test('when every source fails the run exits 1 with a loud alert', () => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures);
    const r = spawnSync(process.execPath, ['index.js', '--dry-run'], {
      cwd: BOT_DIR, encoding: 'utf8',
      env: { ...process.env, BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, TS_PROFILES: configPath, TS_NOW: '2026-10-05T06:00:00.000Z', SLACK_WEBHOOK_URL: webhook, HEALTHCHECKS_BASE_URL: '', HC_UUID_TENDER_SCOUT: '' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /TenderScout source problem/);
  });
});