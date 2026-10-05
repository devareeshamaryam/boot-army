/**
 * B7 Incorporation Scout tests.   Run: npm test -w bots/incorporation-scout
 *
 * Fixtures are built here in the shapes Companies House serves: advanced-search
 * results, officer lists and streaming-API events (newline-delimited JSON).
 * Record real payloads with BOTARMY_HTTP_RECORD=bots/incorporation-scout/test/fixtures/http.
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
import { CH_API, SOURCES, SourceConfigError, harvestSearch, searchUrl, streamSession } from '../harvest.js';
import {
  BOT, EVENT_TYPE, companyFrom, formationAgentRule, markNotified, parseSearchPage, parseStreamChunk, pendingLeads,
  processOfficers, processSearch, querySicCodes, recordSourceRun, scoreCompanies, searchWindow, syncWatchlists,
  validateConfig, volumeAnomaly, windowDays, windowHasWeekday,
} from '../process.js';
import { DEFAULT_WEIGHTS, bestSicMatch, postcodeParts, regionMatch, scoreLead, summariseOfficers } from '../score.js';
import { buildAnomalyAlert, buildDigest, directorsLabel } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'is-test-'));
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

const NOW = '2026-10-01T06:00:00.000Z'; // a Thursday
const item = (number, name, sic, { postcode = 'EC2A 4NE', locality = 'London', line1 = '1 Example Street', created = '2026-09-29', country = 'England' } = {}) => ({
  kind: 'search-results#company', company_number: number, company_name: name, company_status: 'active', company_type: 'ltd',
  date_of_creation: created, sic_codes: sic,
  registered_office_address: { address_line_1: line1, locality, postal_code: postcode, country },
});
const page = (items, hits = items.length) => JSON.stringify({ kind: 'search#advanced-search', hits: String(hits), items });
const officers = (roles) => JSON.stringify({ items: roles.map((r, i) => ({ name: `PERSON ${i}, Secret`, officer_role: r, appointed_on: '2026-09-29' })) });

const RAW_CONFIG = {
  watchlists: [
    { id: 'fintech', name: 'Fintech', sicCodes: ['64999', '62012'], regions: ['EC', 'Manchester'], minScore: 50, slackChannel: 'inc-fintech' },
    { id: 'proptech', name: 'Proptech', sicCodes: ['6820'], regions: [], minScore: 50 },
  ],
  formationAgents: [{ id: 'wenlock', postcode: 'N1 7GU', addressContains: 'Wenlock Road' }],
};
const CFG = validateConfig(RAW_CONFIG);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function openAll(dataDir = tmp()) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  syncWatchlists(db, CFG.watchlists, NOW);
  return { db, store, spine, dataDir };
}
const storeSearch = (env, items, ref = `p${Math.random()}`) => env.store.writeRaw(SOURCES.search, `${ref}.json`, page(items), { kind: 'search' }).id;
const ingest = (env, items) => processSearch({ ...env, snapshotIds: [storeSearch(env, items)], watchlists: CFG.watchlists, formationAgents: CFG.formationAgents, now: NOW });

/* =========================================================== SIC matching */

describe('SIC matching', () => {
  test('exact code beats class beats division; non-5-digit company codes are ignored', () => {
    assert.deepEqual(bestSicMatch(['64999'], ['64', '6499', '64999']), { entry: '64999', code: '64999', value: 1, label: 'exact code' });
    assert.deepEqual(bestSicMatch(['64991'], ['64', '6499']), { entry: '6499', code: '64991', value: 0.7, label: 'class' });
    assert.equal(bestSicMatch(['64110'], ['64']).label, 'division');
    assert.equal(bestSicMatch(['70100'], ['64999', '6820']), null);
    assert.equal(bestSicMatch(['6499', 'x'], ['64']), null, 'malformed company codes never match');
  });

  test('watchlist entries must be codes, classes or divisions; every problem reported', () => {
    assert.throws(() => validateConfig({ watchlists: [{ id: 'x', sicCodes: ['123', '64999'], minScore: 200 }, { id: 'x', sicCodes: [] }], formationAgents: [{ id: 'f' }] }), (err) => {
      for (const p of ['"123" must be', 'minScore must be 0–100', '"x" is duplicated', 'must list at least one SIC code', 'needs "postcode" or "addressContains"']) assert.ok(err.message.includes(p), p);
      return true;
    });
  });

  test('query filter: Companies House filters exact codes only, so any prefix means fetch-all + local filter', () => {
    assert.deepEqual(querySicCodes([{ sicCodes: ['64999', '62012'] }]), ['62012', '64999']);
    assert.deepEqual(querySicCodes(CFG.watchlists), []);
  });

  test('only companies in a target SIC code are stored', () => {
    const env = openAll();
    const r = ingest(env, [item('12345678', 'PAYFLOW LTD', ['64999']), item('12345679', 'BAKERY LTD', ['10710']), item('12345680', 'LETTINGS LTD', ['68209'])]);
    assert.deepEqual(r.touched.sort(), ['12345678', '12345680']);
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM incorporations').pluck().get(), 2);
  });
});

/* ================================================================ scoring */

describe('scoring', () => {
  const fintech = CFG.watchlists[0];
  const company = companyFrom(item('12345678', 'PAYFLOW LTD', ['64999']));
  const two = summariseOfficers(JSON.parse(officers(['director', 'director'])).items);

  test('deterministic, and every point is explained', () => {
    const a = scoreLead(company, fintech, two);
    assert.deepEqual(a, scoreLead(structuredClone(company), structuredClone(fintech), structuredClone(two)));
    const sum = Object.keys(DEFAULT_WEIGHTS).reduce((s, k) => s + a.reasons[k].points, 0);
    assert.ok(Math.abs(sum - a.score) <= 0.5, `${sum} vs ${a.score}`);
    for (const k of Object.keys(DEFAULT_WEIGHTS)) assert.equal(typeof a.reasons[k].note, 'string');
    assert.equal(a.score, 97, 'exact SIC 1.0×45 + two individual directors 0.9×30 + target region 1.0×25 = 45 + 27 + 25');
  });

  test('director setups: individuals > mixed > corporate-only > nominees', () => {
    const s = (roles) => scoreLead(company, fintech, summariseOfficers(JSON.parse(officers(roles)).items)).score;
    const ind = s(['director']);
    const mixed = s(['director', 'corporate-director']);
    const corp = s(['corporate-director']);
    const nom = s(['nominee-director', 'director']);
    assert.ok(ind > mixed && mixed > corp && corp > nom, `${ind} > ${mixed} > ${corp} > ${nom}`);
    assert.equal(scoreLead(company, fintech, null).reasons.directors.unknown, true, 'not looked up: explicit unknown');
  });

  test('geography: postcode district/area and whole-word place names; formation agents and abroad score low', () => {
    assert.deepEqual(postcodeParts('ec2a 4ne'), { area: 'EC', district: 'EC2A' });
    assert.equal(postcodeParts('not a postcode'), null);
    assert.equal(regionMatch({ roPostcode: 'EC2A 4NE' }, ['EC']).via, 'postcode');
    assert.equal(regionMatch({ roPostcode: 'M1 1AA', roLocality: 'Manchester' }, ['Manchester']).via, 'name');
    assert.equal(regionMatch({ roLocality: 'Manchesterford' }, ['Manchester']), null, 'whole words only');
    const agent = scoreLead({ ...company, formationAgent: 'wenlock' }, fintech, two);
    assert.match(agent.reasons.geography.note, /formation agent/);
    assert.ok(agent.score < scoreLead(company, fintech, two).score);
    assert.equal(scoreLead({ ...company, roPostcode: null, roLocality: null, roRegion: null, roCountry: 'Ireland' }, fintech, two).reasons.geography.unknown, true);
    assert.match(scoreLead({ ...company, roPostcode: 'D02 X285', roLocality: 'Dublin', roCountry: 'Ireland' }, fintech, two).reasons.geography.note, /outside the UK/);
  });

  test('officer summaries keep counts by role only, never names; resigned officers excluded', () => {
    const s = summariseOfficers([...JSON.parse(officers(['director', 'corporate-director', 'secretary'])).items, { name: 'GONE, Old', officer_role: 'director', resigned_on: '2026-09-30' }]);
    assert.deepEqual(s, { directors: 2, individualDirectors: 1, corporateDirectors: 1, nomineeDirectors: 0, secretaries: 1 });
    assert.doesNotMatch(JSON.stringify(s), /PERSON|Secret|GONE/);
  });
});

/* ================================================================ parsing */

describe('parsing', () => {
  test('search items: number normalised, address assembled, invalid numbers dropped', () => {
    const c = companyFrom(item('1234567', 'PAYFLOW LTD', ['64999', 'x']));
    assert.equal(c.companyNumber, '01234567');
    assert.equal(c.companyKey, 'UK:01234567');
    assert.deepEqual(c.sicCodes, ['64999']);
    assert.equal(c.roAddress, '1 Example Street, London, EC2A 4NE');
    assert.equal(companyFrom(item('not-a-number', 'X', ['64999'])), null);
    assert.equal(companyFrom({ ...item('12345678', 'X', []), date_of_creation: '2026-02-31' }).dateOfCreation, null);
    assert.throws(() => parseSearchPage(Buffer.from('<html>busy</html>')), /not valid JSON/);
  });

  test('formation-agent blocklist matches on postcode (+ address) regardless of spacing and case', () => {
    const c = companyFrom(item('12345678', 'SHELL LTD', ['64999'], { postcode: 'n17gu', line1: '20-22 WENLOCK ROAD' }));
    assert.equal(formationAgentRule(c, CFG.formationAgents), 'wenlock');
    assert.equal(formationAgentRule(companyFrom(item('12345678', 'X', ['64999'], { postcode: 'N1 7GU', line1: 'Other Street' })), CFG.formationAgents), null, 'postcode alone is not enough when an address is configured');
  });

  test('stream chunks: only new company profiles; deletions, other kinds and old companies skipped; bad lines counted', () => {
    const ev = (tp, data, extra = {}) => JSON.stringify({ resource_kind: 'company-profile', resource_id: data.company_number, data, event: { timepoint: tp, published_at: '2026-10-01T05:00:00', type: 'changed' }, ...extra });
    const chunk = [
      ev(1, item('12345678', 'NEW LTD', ['64999'])),
      ev(2, item('00000001', 'OLD LTD', ['64999'], { created: '1990-01-01' })),
      ev(3, item('12345679', 'GONE LTD', ['64999']), { event: { timepoint: 3, published_at: '2026-10-01T05:00:00', type: 'deleted' } }),
      JSON.stringify({ resource_kind: 'company-officers', data: {}, event: { timepoint: 4 } }),
      '{ not json',
      '',
    ].join('\n');
    const r = parseStreamChunk(Buffer.from(chunk), { maxAgeDays: 7 });
    assert.deepEqual(r.items.map((x) => x.company_name), ['NEW LTD']);
    assert.equal(r.events, 4);
    assert.equal(r.malformed, 1);
  });
});

/* ===================================================== storage and leads */

describe('storage and leads', () => {
  test('re-running the same page changes nothing; one spine event per company dated at incorporation', () => {
    const env = openAll();
    const id = storeSearch(env, [item('12345678', 'PAYFLOW LTD', ['64999'])]);
    const run = () => processSearch({ ...env, snapshotIds: [id], watchlists: CFG.watchlists, formationAgents: CFG.formationAgents, now: NOW });
    assert.equal(run().added, 1);
    assert.equal(run().added, 0);
    ingest(env, [item('12345678', 'PAYFLOW LTD', ['64999'])]); // seen again in an overlapping window
    const events = env.spine.db.prepare(`SELECT e.event_date, n.registry_id FROM events e JOIN entities n ON n.entity_id = e.entity_id WHERE e.type = ?`).all(EVENT_TYPE);
    assert.deepEqual(events, [{ event_date: '2026-09-29', registry_id: '12345678' }]);
  });

  test('officers arrive later: unsent leads are re-scored; director names never reach the database', () => {
    const env = openAll();
    ingest(env, [item('12345678', 'PAYFLOW LTD', ['64999'])]);
    scoreCompanies({ ...env, companyNumbers: ['12345678'], watchlists: CFG.watchlists, now: NOW });
    const before = env.db.prepare(`SELECT score FROM scored_leads WHERE watchlist_id = 'fintech'`).pluck().get();
    const snapId = env.store.writeRaw(SOURCES.officers, '12345678.json', officers(['director', 'director']), { kind: 'officers' }).id;
    processOfficers({ ...env, results: [{ companyNumber: '12345678', status: 'fetched', snapshotId: snapId }], now: NOW });
    scoreCompanies({ ...env, companyNumbers: ['12345678'], watchlists: CFG.watchlists, now: NOW });
    const after = env.db.prepare(`SELECT score FROM scored_leads WHERE watchlist_id = 'fintech'`).pluck().get();
    assert.ok(after > before, `${after} > ${before}`);
    const dump = JSON.stringify(env.db.prepare('SELECT * FROM incorporations').all()) + JSON.stringify(env.db.prepare('SELECT * FROM scored_leads').all());
    assert.doesNotMatch(dump, /PERSON|Secret/, 'no officer names stored');
  });

  test('a sent lead is never re-scored or re-sent; below-threshold leads stay eligible', () => {
    const env = openAll();
    const fintech = CFG.watchlists[0];
    ingest(env, [item('12345678', 'PAYFLOW LTD', ['64999']), item('22345678', 'WEAK LTD', ['64999'], { postcode: 'N1 7GU', line1: 'Wenlock Road' })]);
    scoreCompanies({ ...env, companyNumbers: ['12345678', '22345678'], watchlists: CFG.watchlists, now: NOW });
    env.db.prepare(`UPDATE scored_leads SET score = 40 WHERE company_number = '22345678'`).run(); // force it under the bar
    assert.deepEqual(pendingLeads(env.db, fintech, 20).map((l) => l.company_number), ['12345678']);
    markNotified(env.db, fintech, NOW);
    assert.equal(env.db.prepare(`SELECT notified_at FROM scored_leads WHERE company_number = '22345678'`).pluck().get(), null, 'below the bar: still eligible');
    scoreCompanies({ ...env, companyNumbers: ['12345678'], watchlists: CFG.watchlists, now: NOW });
    assert.deepEqual(pendingLeads(env.db, fintech, 20), [], 'sent once only');
  });
});

/* ============================================================ drop guards */

describe('drop guards', () => {
  test('an empty weekday window against a busy history is an anomaly; weekends and thin history are not', () => {
    const env = openAll();
    const runId = Number(env.db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(NOW).lastInsertRowid);
    const guard = { minExpected: 5, lookbackRuns: 5 };
    assert.equal(volumeAnomaly(env.db, 'search', 0, true, guard), null, 'no history yet');
    for (const n of [40, 55, 38]) recordSourceRun(env.db, { runId, source: 'search', items: n, weekday: true, outcome: 'ok', now: NOW });
    assert.match(volumeAnomaly(env.db, 'search', 0, true, guard), /returned 0 incorporations for a weekday window; the last 3 weekday runs averaged 44/);
    assert.equal(volumeAnomaly(env.db, 'search', 0, false, guard), null, 'weekend-only window');
    assert.equal(windowHasWeekday({ from: '2026-10-03', to: '2026-10-04' }), false);
  });

  test('a page that fails to parse is not marked processed: retried and reported every run', () => {
    const env = openAll();
    const bad = env.store.writeRaw(SOURCES.search, 'bad.json', '<html>maintenance</html>', {}).id;
    const run = () => processSearch({ ...env, snapshotIds: [bad], watchlists: CFG.watchlists, formationAgents: [], now: NOW }).failures.length;
    assert.equal(run(), 1);
    assert.equal(run(), 1);
  });

  test('search windows: lag-overlapped, one day at a time', () => {
    assert.deepEqual(searchWindow(null, NOW, { lookbackDays: 3 }), { from: '2026-09-28', to: '2026-10-01' });
    assert.deepEqual(searchWindow('2026-09-30', NOW, { lagDays: 2 }), { from: '2026-09-28', to: '2026-10-01' });
    assert.deepEqual(windowDays({ from: '2026-09-29', to: '2026-10-01' }), ['2026-09-29', '2026-09-30', '2026-10-01']);
  });
});

/* ========================================================= harvest: search */

describe('harvest: advanced search', () => {
  after(() => coreHttp.setFetch());
  const day = { from: '2026-09-30', to: '2026-09-30' };

  test('pages by hits; a 404 "no results" is an empty result, not a failure; a missing key is a config error', async () => {
    const calls = [];
    coreHttp.setFetch(async (url) => {
      calls.push(String(url));
      const start = Number(new URL(String(url)).searchParams.get('start_index'));
      const items = Array.from({ length: start === 0 ? 2 : 1 }, (_, i) => item(String(10000000 + start + i), 'X', ['64999']));
      return new Response(page(items, 3), { headers: { 'content-type': 'application/json' } });
    });
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    const r = await harvestSearch({ store, window: day, sicCodes: ['64999'], cfg: { pageSize: 2 }, env: { CH_API_KEY: 'k' } });
    assert.deepEqual([r.items, r.hits, r.truncated, r.snapshotIds.length], [3, 3, false, 2]);
    assert.match(calls[0], /incorporated_from=2026-09-30&incorporated_to=2026-09-30&size=2&start_index=0&sic_codes=64999/);
    coreHttp.setFetch(async () => new Response('{"errors":[{"error":"no results"}]}', { status: 404, statusText: 'Not Found' }));
    assert.deepEqual((await harvestSearch({ store, window: day, cfg: {}, env: { CH_API_KEY: 'k' } })).items, 0);
    await assert.rejects(harvestSearch({ store, window: day, env: {} }), (err) => err instanceof SourceConfigError);
  });
});

/* ========================================================= harvest: stream */

describe('harvest: stream (reconnect and resume)', () => {
  const enc = new TextEncoder();
  const evLine = (tp) => `${JSON.stringify({ resource_kind: 'company-profile', data: item(String(20000000 + tp), 'S LTD', ['64999']), event: { timepoint: tp, published_at: '2026-10-01T05:00:00', type: 'changed' } })}\n`;
  /**
   * A fake streaming response: one piece per read, then a clean close or an error (dropped connection).
   * Pull-based on purpose: erroring a ReadableStream discards chunks still queued, whereas a real
   * connection delivers what it received before it fails.
   */
  const streamOf = (pieces, { fail = false } = {}) => {
    let i = 0;
    return new Response(new ReadableStream({
      pull(c) {
        if (i < pieces.length) c.enqueue(enc.encode(pieces[i++]));
        else if (fail) c.error(new Error('ECONNRESET'));
        else c.close();
      },
    }), { status: 200 });
  };

  test('lines split across network chunks and heartbeats are handled; a drop reconnects from the last timepoint', async () => {
    const urls = [];
    const responses = [
      () => streamOf([evLine(100).slice(0, 25), evLine(100).slice(25), '\n', evLine(101)], { fail: true }),
      () => streamOf([evLine(101), evLine(102), evLine(103)]),
    ];
    const fetchImpl = async (url) => { urls.push(String(url)); return responses.shift()(); };
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    const r = await streamSession({ store, timepoint: '99', env: { CH_STREAM_KEY: 's' }, fetchImpl, maxEvents: 5, maxSeconds: 10, backoffMs: 1, chunkLines: 2 });
    assert.equal(r.endedBy, 'max-events');
    assert.equal(r.reconnects, 1);
    assert.match(urls[0], /timepoint=99$/);
    assert.match(urls[1], /timepoint=101$/, 'resumed from the last timepoint seen (inclusive)');
    assert.equal(r.lastTimepoint, '103');
    const lines = r.snapshotIds.flatMap((id) => store.readRaw(id).toString().trim().split('\n'));
    assert.equal(lines.length, 5, 'every event read was stored raw, including before the drop');
  });

  test('gives up after maxReconnects, keeping its timepoint; needs a stream key', async () => {
    const fetchImpl = async () => streamOf([evLine(7)], { fail: true });
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    const r = await streamSession({ store, env: { CH_STREAM_KEY: 's' }, fetchImpl, maxReconnects: 2, maxSeconds: 10, backoffMs: 1 });
    assert.equal(r.endedBy, 'gave-up');
    assert.equal(r.reconnects, 2);
    assert.equal(r.lastTimepoint, '7');
    await assert.rejects(streamSession({ store, env: {}, fetchImpl }), /CH_STREAM_KEY/);
  });

  test('a 429 waits before reconnecting rather than hammering the stream', async () => {
    const seen = [];
    const fetchImpl = async () => { seen.push(Date.now()); return seen.length === 1 ? new Response('slow down', { status: 429, statusText: 'Too Many Requests' }) : streamOf([evLine(1), evLine(2)]); };
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    const r = await streamSession({ store, env: { CH_STREAM_KEY: 's' }, fetchImpl, maxEvents: 2, maxSeconds: 10, backoffMs: 1, rateLimitWaitMs: 50 });
    assert.equal(r.endedBy, 'max-events');
    assert.ok(seen[1] - seen[0] >= 45, 'waited for the rate limit');
  });
});

/* ================================================================= digest */

test('digest: leads with score, links, SIC, location, director setup and reasons; limits respected', () => {
  const lead = (over) => ({
    company_number: '12345678', name: 'Pay<flow> Ltd', score: 96, matched_sic: '64999', sic_codes: ['64999'], date_of_creation: '2026-09-29',
    ro_locality: 'London', ro_postcode: 'EC2A 4NE', formation_agent: null, officers_status: 'fetched',
    officers_summary: { directors: 2, individualDirectors: 2, corporateDirectors: 0, nomineeDirectors: 0, secretaries: 0 },
    reasons: { sic: { points: 45, note: 'x' }, directors: { points: 27, note: '2 individual director(s)' }, geography: { points: 25, note: 'registered office in EC' } }, ...over,
  });
  const d = buildDigest({ watchlist: { name: 'Fintech', minScore: 50 }, leads: [lead(), lead({ formation_agent: 'wenlock', officers_summary: null, officers_status: 'pending' })], total: 30, date: '2026-10-01', stats: { incorporations: 2400, matched: 31 } });
  const text = JSON.stringify(d.blocks);
  assert.match(text, /find-and-update\.company-information\.service\.gov\.uk\/company\/12345678/);
  assert.match(text, /Pay&lt;flow&gt; Ltd/);
  assert.match(text, /2 individual directors/);
  assert.match(text, /formation-agent address/);
  assert.match(text, /directors not looked up yet/);
  assert.match(text, /30 leads scoring 50\+ · top 2 shown/);
  assert.match(text, /Directors shown as counts only/);
  assert.equal(directorsLabel({ officers_summary: null, officers_status: 'not-found' }), 'officers not published');
  assert.match(buildAnomalyAlert({ date: 'd', problems: ['x'], halted: true }).blocks[0].text.text, /run halted/);
});

/* ============================================================ entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;
  let configPath;
  let server;
  let slackUrl;
  const posts = [];

  const put = (url, body, status = 200) => writeFileSync(path.join(fixtures, `${coreHttp.fixtureKey('GET', url)}.json`), JSON.stringify({
    url, status, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(body).toString('base64'),
  }));
  const writeFixtures = (byDay, { now = NOW } = {}) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    for (const d of windowDays(searchWindow(null, now, CFG.search))) {
      put(searchUrl({ from: d, to: d }, { sicCodes: [], size: 100, startIndex: 0 }), page(byDay[d] ?? []));
    }
    put(`${CH_API}/company/12345678/officers?items_per_page=35`, officers(['director', 'director']));
    put(`${CH_API}/company/12345680/officers?items_per_page=35`, officers(['corporate-director']));
  };
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js', ...args], {
      cwd: BOT_DIR,
      env: {
        ...process.env, BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, IS_CONFIG: configPath, IS_NOW: NOW, LOG_FORMAT: 'json',
        SLACK_WEBHOOK_URL: slackUrl, SLACK_WEBHOOK_URL_INCORPORATIONS: '', SLACK_WEBHOOK_URL_INC_FINTECH: `${slackUrl}/fintech`,
        HEALTHCHECKS_BASE_URL: '', HC_UUID_INCORPORATION_SCOUT: '', CH_API_KEY: 'k', CH_STREAM_KEY: '',
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
    configPath = path.join(base, 'incorporations.json');
    writeFileSync(configPath, JSON.stringify(RAW_CONFIG));
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { posts.push({ path: req.url, body: JSON.parse(b) }); res.end('ok'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    slackUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  const DAY = { '2026-09-29': [item('12345678', 'PAYFLOW LTD', ['64999']), item('12345679', 'BAKERY LTD', ['10710'])], '2026-09-30': [item('12345680', 'LETTINGS LTD', ['68209'])] };

  test('--dry-run on an empty data dir prints per-watchlist digests and writes nothing', async () => {
    writeFixtures(DAY);
    const r = await run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.match(r.stdout, /"channel": "inc-fintech"/);
    assert.match(r.stdout, /PAYFLOW LTD/);
    assert.match(r.stdout, /searching every incorporation and filtering locally/, 'proptech uses a SIC class prefix');
    assert.equal(posts.length, 0);
  });

  test('live run posts to each watchlist channel; a re-run sends nothing new', async () => {
    const r = await run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(posts.map((p) => p.path).sort(), ['/', '/fintech'], 'fintech has its own webhook; proptech falls back to the default');
    const again = await run();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(posts.length, 2);
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
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['index.js', '--dry-run'], { cwd: BOT_DIR, env: { ...process.env, BOTARMY_DATA_DIR: fresh, BOTARMY_HTTP_REPLAY: fixtures, IS_CONFIG: configPath, IS_NOW: NOW, LOG_FORMAT: 'json', SLACK_WEBHOOK_URL: slackUrl, HEALTHCHECKS_BASE_URL: '', CH_API_KEY: 'k' } });
      let out = '';
      c.stdout.on('data', (x) => (out += x));
      c.on('close', (status) => resolve({ status, out }));
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /every source failed/);
  });
});