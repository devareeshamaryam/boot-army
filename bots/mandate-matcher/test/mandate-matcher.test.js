/**
 * B2 Mandate Matcher tests.   Run: npm test -w bots/mandate-matcher
 *
 * Fixtures are built here in the formats the sources serve: FCA Register API
 * JSON (/Firm/{FRN}, /Firm/{FRN}/CF, /Individuals/{IRN}/CF) and CSV exports for
 * the file-based registers. Replace them with recorded payloads by running once
 * with BOTARMY_HTTP_RECORD=bots/mandate-matcher/test/fixtures/http.
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
import { FCA_BASE, harvestRosters, SourceConfigError } from '../harvest.js';
import {
  BOT, EVENT, LAWFUL_BASIS, activeMandates, crossRegisterConfidence, digestMovers, markNotified, parseFcaDestination,
  parseFcaRoster, parseTabularRoster, pendingIdentityReviews, processRoster, purgeExpired, recordMovers, scorePending,
  syncWatchlist, toIsoDate, validateWatchlist, applyDestinations,
} from '../process.js';
import { mandateFit, scoreMover, seniorityOf, tenureFactor, toNumberOrNull } from '../score.js';
import { GDPR_FOOTER, TOP_N, buildDigest, buildFailureAlert } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

/* Every connection is tracked and closed before temp folders are removed:
 * on Windows an open SQLite handle locks its file. */
const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
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

/** FCA /Firm/{FRN}/CF body. people: [irn, name, role, effective dd/mm/yyyy, end?] */
const cfBody = (people) => JSON.stringify({
  Status: 'FSR-API-02-01-00',
  ResultInfo: { page: '1', per_page: '200', total_count: String(people.length) },
  Data: [{
    Current: Object.fromEntries(people.map(([irn, name, role, date, end], i) => [`(${i})${role}`, {
      'Individual Name': name, Name: role, 'Effective Date': date, ...(end ? { 'End Date': end } : {}),
      URL: `${FCA_BASE}/Individuals/${irn}`,
    }])),
  }],
});
const profileBody = (name, ch) => JSON.stringify({ Data: [{ 'Organisation Name': name, 'Companies House Number': ch, Status: 'Authorised' }] });
const individualBody = (firmName, frn) => JSON.stringify({ Data: [{ Current: { '(1)SMF4 Chief Risk': { 'Firm Name': firmName, URL: `${FCA_BASE}/Firm/${frn}`, 'Effective Date': '01/09/2026' } } }] });

const filler = (prefix, n) => Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(3, '0')}`, `${prefix} Person ${i}`, '[PRA CF] Material risk taker', '01/01/2022']);

const FIRM_A = { regulator: 'FCA', ref: '122702', name: 'Barclays Bank Plc', market: 'UK', tier: 1 };
const FIRM_B = { regulator: 'FCA', ref: '759676', name: 'Barclays Bank UK PLC', market: 'UK', tier: 2 };
const csvOf = (rows) => ['Individual Reference,Name,Function,Effective Date,Status', ...rows.map((r) => r.join(','))].join('\r\n');

const A_DAY1 = [
  ['AAA01', 'Alice Ang', 'SMF1 Chief Executive', '01/03/2019'],
  ['BBB01', 'Bob Brown', 'SMF16 Compliance Oversight', '15/06/2020'],
  ['JSM01', 'Jane Smith', 'SMF16 Compliance Oversight', '01/02/2018'],
  ['JOH01', 'John Smith', 'SMF17 Money Laundering Reporting', '01/02/2017'],
  ...filler('AF', 12),
];
const B_DAY1 = [['DDD01', 'Dan Dee', 'SMF3 Executive Director', '01/01/2021'], ...filler('BF', 9)];
const DFSA_DAY1 = filler('DF', 10).map(([ref, name]) => [ref, name, 'Licensed Director', '01/01/2023', 'Active']);

const A_DAY2 = A_DAY1.filter(([irn]) => !['BBB01', 'JSM01', 'JOH01'].includes(irn));     // three leave A
const B_DAY2 = [...B_DAY1, ['BBB01', 'Bob Brown', 'SMF16 Compliance Oversight', '28/09/2026'], ['NEW01', 'Nina New', 'SMF24 Chief Operations', '28/09/2026']];
const DFSA_DAY2 = [
  ...DFSA_DAY1,
  ['DX900', 'Jane Q Smith', 'Compliance Officer', '29/09/2026', 'Active'],   // ≈ Jane Smith (FCA): 100% → cross-register move
  ['DX901', 'Jon Smyth', 'Money Laundering Reporting Officer', '29/09/2026', 'Active'], // ≈ John Smith: 84% → review
  ['DX902', 'Former Person', 'Licensed Director', '01/01/2020', 'Ceased'],  // inactive status: ignored
];

const MANDATES = [{
  id: 'acme-hoc-dxb', client: 'Acme Private Bank', title: 'Head of Compliance, Dubai',
  markets: ['DIFC', 'UK'], minSeniority: 'control', licenceCategories: ['SMF16', 'compliance'], firmTiers: [1, 2],
  exclusions: { fromFirms: ['FCA:999999'] },
}];

/** Fake FCA API serving a mutable state. */
function fcaFake(state) {
  return async (url) => {
    const u = String(url);
    let m;
    if ((m = u.match(/\/Firm\/(\d+)\/CF/))) return new Response(cfBody(state.rosters[m[1]] ?? []), { headers: { 'content-type': 'application/json' } });
    if ((m = u.match(/\/Firm\/(\d+)$/))) return new Response(profileBody('X', m[1] === '122702' ? '01026167' : ''), { headers: { 'content-type': 'application/json' } });
    if ((m = u.match(/\/Individuals\/(\w+)\/CF/))) return new Response(individualBody('Other Bank Ltd', '999999'), { headers: { 'content-type': 'application/json' } });
    return new Response('nf', { status: 404 });
  };
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SETTINGS = { maxDropRatio: 0.5, moveLookbackDays: 90, matchThreshold: 92, reviewFloor: 80 };
const ENV = { FCA_API_EMAIL: 'me@example.com', FCA_API_KEY: 'k' };

function openAll(dataDir) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  return { db, store, spine };
}

/* =============================================================== parsing */

describe('parsing', () => {
  test('FCA CF: grouped by IRN, multiple roles kept, ended roles dropped, dates normalised', () => {
    const body = Buffer.from(cfBody([
      ['AAA01', 'Alice Ang', 'SMF1 Chief Executive', '01/03/2019'],
      ['AAA01', 'Alice Ang', 'SMF9 Chair', '01/03/2020'],
      ['OLD01', 'Old Timer', 'SMF3 Executive Director', '01/01/2010', '01/01/2020'],
    ]));
    const recs = parseFcaRoster([body], '2026-09-30');
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0].roles.map((r) => r.since), ['2019-03-01', '2020-03-01']);
  });

  test('tabular export: status filter, default role, column overrides, clear error for unknown layout', () => {
    const rows = parseTabularRoster([{ buffer: Buffer.from(csvOf(DFSA_DAY2)), meta: { format: 'csv' } }], 'DFSA');
    assert.ok(!rows.some((r) => r.personRef === 'DX902'), 'Ceased status skipped');
    const sfc = parseTabularRoster([{ buffer: Buffer.from('CE No.,Name\r\nabc 123,Lee Wong\r\n'), meta: { format: 'csv', defaultRole: 'Responsible Officer' } }], 'SFC');
    assert.deepEqual(sfc[0], { personRef: 'ABC123', name: 'Lee Wong', roles: [{ title: 'Responsible Officer', code: null, since: null }] });
    assert.throws(() => parseTabularRoster([{ buffer: Buffer.from('Foo,Bar\r\n1,2\r\n'), meta: { format: 'csv' } }], 'MAS'), /no person reference column found/);
  });

  test('numbers and dates are never invented', () => {
    assert.equal(toIsoDate('31/02/2026'), null, 'impossible dates are rejected, not rolled over');
    assert.equal(toIsoDate('29/02/2028'), '2028-02-29');
    assert.equal(toIsoDate('12 Mar 2024'), '2024-03-12');
    assert.equal(toIsoDate('45/13/2026'), null);
    assert.equal(toIsoDate(''), null);
    assert.equal(toIsoDate('soon'), null);
    assert.equal(toNumberOrNull(''), null);
    assert.equal(toNumberOrNull(null), null);
    assert.equal(toNumberOrNull('12x'), null);
    assert.equal(toNumberOrNull('12'), 12);
    assert.deepEqual(tenureFactor(null), { value: 0.5, years: null, unknown: true });
  });

  test('FCA destination ignores the firm the person left', () => {
    assert.deepEqual(parseFcaDestination(Buffer.from(individualBody('Other Bank Ltd', '999999')), '122702'), { firmName: 'Other Bank Ltd', firmRef: '999999', since: '2026-09-01' });
    assert.equal(parseFcaDestination(Buffer.from(individualBody('Same Bank', '122702')), '122702'), null);
  });
});

/* ================================================================ scoring */

describe('scoring', () => {
  const mover = {
    kind: 'move', roles: [{ title: 'SMF16 Compliance Oversight' }], prevRoles: [], market: 'UK',
    fromFirmKey: 'FCA:122702', toFirmKey: 'FCA:759676', fromTier: 1, toTier: 2, tenureDays: 2200, tenureEstimate: false,
  };
  const mandates = validateWatchlist({ firms: [{ ...FIRM_A }], mandates: MANDATES }).mandates;

  test('deterministic: identical input, identical output', () => {
    assert.deepEqual(scoreMover(mover, mandates), scoreMover(mover, mandates));
  });

  test('seniority bands from regulated role titles', () => {
    assert.equal(seniorityOf([{ title: 'SMF1 Chief Executive' }]).band, 'c-suite');
    assert.equal(seniorityOf([{ title: 'SMF16 Compliance Oversight' }]).band, 'control');
    assert.equal(seniorityOf([{ title: 'Responsible Officer' }]).band, 'control');
    assert.equal(seniorityOf([{ title: 'Something new' }]).band, 'other');
  });

  test('mandate fit, exclusions, and the matching list in the rationale', () => {
    const r = scoreMover(mover, mandates);
    assert.equal(r.rationale.mandates[0].mandateId, 'acme-hoc-dxb');
    assert.ok(r.score >= 80 && r.score <= 100);
    assert.equal(mandateFit({ ...mover, fromFirmKey: 'FCA:999999' }, mandates[0]).excluded, true);
    const junior = scoreMover({ ...mover, roles: [{ title: 'Material risk taker' }] }, mandates);
    assert.equal(junior.rationale.mandates.length, 0);
    assert.ok(junior.score < r.score);
  });

  test('without mandates the mandate weight drops out instead of scoring zero', () => {
    const r = scoreMover(mover, []);
    assert.equal(r.rationale.mandateFit, undefined);
    assert.equal(r.rationale.weights.mandateFit, undefined);
  });

  test('unknown inputs are flagged, not guessed', () => {
    const r = scoreMover({ ...mover, market: null, fromTier: null, toTier: null, tenureDays: null }, []);
    assert.equal(r.rationale.market.unknown, true);
    assert.equal(r.rationale.firmTier.unknown, true);
    assert.equal(r.rationale.tenure.unknown, true);
  });
});

/* =============================================================== watchlist */

test('watchlist validation reports every problem at once', () => {
  assert.throws(() => validateWatchlist({
    firms: [{ regulator: 'XYZ', ref: '', name: '', market: 'FR', tier: 9 }, { regulator: 'MAS', ref: 'M1', name: 'N', market: 'SG', tier: 1 }],
    mandates: [{ id: 'bad id!', licenceCategories: ['('] }],
  }), (err) => {
    for (const p of ['regulator must be', 'ref must be', 'market must be', 'tier must be', 'source is required for MAS', 'id must be a slug', 'not a valid regex']) {
      assert.match(err.message, new RegExp(p.replace(/[()]/g, '\\$&')));
    }
    return true;
  });
});

/* ================================================================ harvest */

describe('harvest', () => {
  after(() => http.setFetch());

  test('FCA: profile and roster stored raw; missing key is a config failure, other firms continue', async () => {
    const state = { rosters: { 122702: A_DAY1 } };
    http.setFetch(fcaFake(state));
    const dataDir = tmp();
    const store = track(snapshot.openStore({ dataDir }));
    const ok = await harvestRosters([FIRM_A], { store, env: ENV, log: quiet });
    assert.equal(ok.fetches.length, 1);
    assert.equal(JSON.parse(store.readRaw(ok.fetches[0].snapshotIds[0]).toString()).Data.length, 1, 'raw CF body stored byte-for-byte');
    assert.ok(ok.fetches[0].profileSnapshotId);
    const noKey = await harvestRosters([FIRM_A, FIRM_B], { store, env: {}, log: quiet });
    assert.equal(noKey.failures.length, 2);
    assert.ok(noKey.failures.every((f) => f.config && /FCA_API_EMAIL/.test(f.error)));
  });

  test('file sources are stored raw with their parse settings; SFC register URLs are refused', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'f.csv'), csvOf(DFSA_DAY1));
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    const firm = { regulator: 'DFSA', ref: 'F1', name: 'D', market: 'DIFC', tier: 2, source: { type: 'file', path: 'f.csv', fields: { name: ['Name'] } } };
    const r = await harvestRosters([firm], { store, baseDir: dir, log: quiet });
    const meta = store.get(r.fetches[0].snapshotIds[0]).meta;
    assert.equal(meta.format, 'csv');
    assert.deepEqual(meta.fields, { name: ['Name'] });
    const sfc = { regulator: 'SFC', ref: 'AAA000', name: 'S', market: 'HK', tier: 1, source: { type: 'url', url: 'https://apps.sfc.hk/publicregWeb/corp/AAA000/ro' } };
    const refused = await harvestRosters([sfc], { store, log: quiet });
    assert.match(refused.failures[0].error, /disallows automated access/);
    assert.ok(new SourceConfigError('x') instanceof Error);
  });
});

/* ============================================= end-to-end processing */

describe('process end to end', () => {
  let env;
  let dataDir;
  let importDir;
  const state = { rosters: { 122702: A_DAY1, 759676: B_DAY1 } };
  const DFSA_FIRM = () => ({ regulator: 'DFSA', ref: 'F000123', name: 'Example Capital (DIFC) Limited', market: 'DIFC', tier: 2, registrationNumber: '1234', source: { type: 'file', path: path.join(importDir, 'dfsa.csv') } });
  const watchlist = () => validateWatchlist({ firms: [FIRM_A, FIRM_B, DFSA_FIRM()], mandates: MANDATES });

  const day = async (now) => {
    http.setFetch(fcaFake(state));
    const { fetches } = await harvestRosters(watchlist().firms, { store: env.store, env: ENV, baseDir: importDir, log: quiet });
    return fetches.map((fetch) => processRoster({ ...env, fetch, settings: SETTINGS, now, log: quiet }));
  };

  before(() => {
    dataDir = tmp();
    importDir = tmp();
    writeFileSync(path.join(importDir, 'dfsa.csv'), csvOf(DFSA_DAY1));
    env = openAll(dataDir);
    syncWatchlist(env.db, watchlist(), '2026-09-28T06:00:00.000Z');
  });

  test('first sight of every firm is a BASELINE: state stored, zero changes, zero movers', async () => {
    const results = await day('2026-09-28T06:00:00.000Z');
    assert.deepEqual(results.map((r) => r.outcome), ['baseline', 'baseline', 'baseline']);
    assert.deepEqual(results.map((r) => r.joiners + r.leavers), [0, 0, 0]);
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM roster_changes').pluck().get(), 0);
    assert.equal(recordMovers({ ...env, settings: SETTINGS, now: '2026-09-28T06:00:00.000Z', log: quiet }).moves, 0);
    assert.equal(env.spine.db.prepare('SELECT COUNT(*) FROM persons').pluck().get(), 36);
    assert.equal(env.spine.db.prepare('SELECT COUNT(*) FROM person_history WHERE to_date IS NULL').pluck().get(), 36);
  });

  test('UK GDPR: every person carries the lawful basis and purpose', () => {
    const rows = env.db.prepare('SELECT DISTINCT lawful_basis, purpose FROM person_registry').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lawful_basis, LAWFUL_BASIS);
    assert.match(rows[0].purpose, /public regulator registers/);
  });

  test('firm entities resolved on the spine (FCA profile Companies House number; DIFC number from watchlist)', () => {
    const a = env.spine.db.prepare(`SELECT * FROM entities WHERE registry_id = '01026167'`).get();
    assert.equal(a.spine_id, 'UK:01026167');
    assert.ok(env.spine.db.prepare(`SELECT 1 FROM entities WHERE jurisdiction = 'AE-DIFC' AND spine_id = 'DIFC:1234'`).get());
  });

  test('re-running the same snapshots writes nothing', async () => {
    const results = await day('2026-09-28T07:00:00.000Z');
    assert.deepEqual(results.map((r) => r.outcome), ['already-processed', 'already-processed', 'already-processed']);
  });

  test('day 2: same-register move, leavers, joiners, cross-register move ≥ threshold, review below threshold', async () => {
    state.rosters = { 122702: A_DAY2, 759676: B_DAY2 };
    writeFileSync(path.join(importDir, 'dfsa.csv'), csvOf(DFSA_DAY2));
    const now = '2026-09-29T06:00:00.000Z';
    const results = await day(now);
    assert.deepEqual(results.map((r) => [r.joiners, r.leavers]), [[0, 3], [2, 0], [2, 0]]);

    const counts = recordMovers({ ...env, settings: SETTINGS, now, log: quiet });
    assert.deepEqual(counts, { moves: 2, leavers: 3, joiners: 2, reviews: 1 });

    const current = env.db.prepare('SELECT kind, name, match_method, match_confidence FROM movers WHERE superseded_by IS NULL ORDER BY name').all();
    assert.deepEqual(current.map((m) => [m.name, m.kind, m.match_method]), [
      ['Bob Brown', 'move', 'registry-id'],
      ['Jane Q Smith', 'move', 'cross-register-name'],
      ['John Smith', 'leaver', null],
      ['Jon Smyth', 'joiner', null],
      ['Nina New', 'joiner', null],
    ]);
    assert.equal(current.find((m) => m.name === 'Jane Q Smith').match_confidence, 100);
  });

  test('low-confidence identity goes to review_queue and is never auto-merged', () => {
    const reviews = pendingIdentityReviews(env.spine);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].payload.joiner.name, 'Jon Smyth');
    assert.equal(reviews[0].payload.candidates[0].name, 'John Smith');
    assert.ok(reviews[0].payload.candidates[0].confidence < SETTINGS.matchThreshold);
    assert.ok(crossRegisterConfidence({ name: 'Jon Smyth', roles: '[]' }, { name: 'John Smith', roles: '[]' }) >= SETTINGS.reviewFloor);
    recordMovers({ ...env, settings: SETTINGS, now: '2026-09-29T07:00:00.000Z', log: quiet });
    assert.equal(pendingIdentityReviews(env.spine).length, 1, 're-runs do not queue the same question twice');
  });

  test('spine: person_history closed for leavers, events emitted per person (two joiners at one firm on one day both kept)', () => {
    const bob = env.spine.db.prepare(`SELECT person_id FROM persons WHERE registry_person_id = 'BBB01'`).pluck().get();
    assert.equal(env.spine.db.prepare('SELECT COUNT(*) FROM person_history WHERE person_id = ? AND to_date IS NOT NULL').pluck().get(bob), 1);
    const events = env.spine.db.prepare(`SELECT type, source FROM events WHERE source LIKE 'mandate-matcher:%'`).all();
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === EVENT.MOVE).length, 2);
    assert.equal(types.filter((t) => t === EVENT.LEFT).length, 3);
    assert.equal(types.filter((t) => t === EVENT.JOINED).length, 2, 'Bob and Nina both joined FCA:759676 on the same day');
    // Bob's leaver and move events share his FCA source; Jane's move is recorded under her new DFSA reference.
    assert.equal(new Set(events.map((e) => e.source)).size, events.length - 1);
  });

  test('scores are deterministic and the digest shows top movers with mandates and the GDPR footer', () => {
    const mandates = activeMandates(env.db);
    scorePending(env.db, { mandates, scoring: {}, now: '2026-09-29T06:00:00.000Z' });
    const rows = digestMovers(env.db, TOP_N);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score), 'ordered by score');
    const jane = rows.find((r) => r.name === 'Jane Q Smith');
    assert.equal(jane.rationale.mandates[0].mandateId, 'acme-hoc-dxb');

    const d = buildDigest({ movers: rows, totalPending: rows.length, date: '2026-09-29', reviews: { pending: 1, items: pendingIdentityReviews(env.spine), showItems: true } });
    const text = JSON.stringify(d.blocks);
    assert.match(text, /cross-register match, 100% confidence/);
    assert.match(text, /Head of Compliance, Dubai/);
    assert.match(text, /Weekly identity review/);
    assert.ok(text.includes(GDPR_FOOTER.slice(0, 40)));
    assert.ok(d.blocks.length <= 50);
  });

  test('FCA leaver destinations come from stored /Individuals snapshots', () => {
    const irns = env.db.prepare(`SELECT person_ref FROM movers WHERE kind = 'leaver' AND superseded_by IS NULL`).pluck().all();
    const map = new Map(irns.map((irn) => [irn, env.store.writeRaw('fca-individual-cf', `${irn}.json`, individualBody('Other Bank Ltd', '999999')).id]));
    assert.equal(applyDestinations(env.db, env.store, map), 1);
    assert.equal(env.db.prepare(`SELECT dest_firm_name FROM movers WHERE name = 'John Smith'`).pluck().get(), 'Other Bank Ltd');
  });

  test('drop guard: a roster that collapses is rejected, state untouched; other firms still process', async () => {
    markNotified(env.db, digestMovers(env.db, 100).map((m) => m.id));
    state.rosters = { 122702: A_DAY2.slice(0, 2), 759676: B_DAY2 };
    const activeBefore = env.db.prepare(`SELECT COUNT(*) FROM roster_people WHERE firm_key = 'FCA:122702' AND active = 1`).pluck().get();
    const results = await day('2026-09-30T06:00:00.000Z');
    assert.equal(results[0].outcome, 'rejected');
    assert.match(results[0].note, /fell from 13 to 2/);
    assert.equal(env.db.prepare(`SELECT COUNT(*) FROM roster_people WHERE firm_key = 'FCA:122702' AND active = 1`).pluck().get(), activeBefore);
    assert.equal(results[1].outcome, 'already-processed');
    state.rosters = { 122702: [], 759676: B_DAY2 };
    const empty = await day('2026-09-30T07:00:00.000Z');
    assert.match(empty[0].note, /empty roster/);
  });

  test('retention purges persons inactive > 12 months, keeps those another bot still references', () => {
    const now = '2027-12-01T00:00:00.000Z';
    const john = env.spine.db.prepare(`SELECT person_id FROM persons WHERE registry_person_id = 'JOH01'`).pluck().get();
    const bob = env.spine.db.prepare(`SELECT person_id FROM persons WHERE registry_person_id = 'BBB01'`).pluck().get();
    // John left 2026-09-29; another bot recorded an event about Alice, who is still active.
    env.spine.linkEvent({ personId: john, type: 'PHOENIX_APPOINTMENT', date: '2027-01-01', source: 'phoenix-tracker' });
    // Force every left person's last activity into the past; active people stay protected by roster_people.
    env.db.prepare(`UPDATE person_registry SET last_active_at = '2026-09-29T06:00:00.000Z'`).run();
    const r = purgeExpired({ ...env, now, retentionDays: 365, log: quiet });
    assert.ok(r.purgedPersons >= 2, `purged ${r.purgedPersons}`);
    assert.equal(r.keptShared, 1, 'John kept: another bot references him');
    assert.ok(env.spine.db.prepare('SELECT 1 FROM persons WHERE person_id = ?').get(john));
    assert.equal(env.spine.db.prepare(`SELECT COUNT(*) FROM events WHERE person_id = ? AND source LIKE 'mandate-matcher:%'`).pluck().get(john), 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM movers WHERE person_id = ?').pluck().get(john), 0);
    assert.equal(env.db.prepare(`SELECT COUNT(*) FROM person_registry WHERE person_id = ?`).pluck().get(bob), 1, 'Bob is active at his new firm: kept');
    assert.ok(env.db.prepare(`SELECT COUNT(*) FROM roster_people WHERE active = 1`).pluck().get() > 0, 'active rosters untouched');
    assert.equal(env.db.prepare('SELECT purged_persons FROM retention_log ORDER BY id DESC LIMIT 1').pluck().get(), r.purgedPersons);
  });
});

/* ================================================================== digest */

test('digest caps at the top 20, escapes mrkdwn, failure alert is loud', () => {
  const row = (i) => ({ id: i, kind: 'joiner', name: `P<${i}>&`, regulator: 'FCA', person_ref: `X${i}`, to_firm_key: 'FCA:1', to_firm_name: 'Firm', roles: '[]', score: 50, rationale: { tenure: { years: null } } });
  const d = buildDigest({ movers: Array.from({ length: TOP_N }, (_, i) => row(i)), totalPending: 37, date: '2026-09-29' });
  assert.match(d.blocks[1].elements[0].text, /37 movers \(top 20 shown\)/);
  assert.match(JSON.stringify(d.blocks), /P&lt;0&gt;&amp;/);
  assert.match(JSON.stringify(d.blocks), /tenure unknown/);
  assert.match(buildFailureAlert({ date: 'd', problems: ['a: b'] }).blocks[0].text.text, /run halted/);
});

/* ============================================================ entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;
  let watchlistPath;
  let importDir;

  const put = (url, body) => writeFileSync(path.join(fixtures, `${http.fixtureKey('GET', url)}.json`), JSON.stringify({
    url, status: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(body).toString('base64'),
  }));
  const writeDay = (a, b, dfsa) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    put(`${FCA_BASE}/Firm/122702`, profileBody('Barclays Bank Plc', '01026167'));
    put(`${FCA_BASE}/Firm/759676`, profileBody('Barclays Bank UK PLC', ''));
    put(`${FCA_BASE}/Firm/122702/CF`, cfBody(a));
    put(`${FCA_BASE}/Firm/759676/CF`, cfBody(b));
    for (const irn of ['BBB01', 'JSM01', 'JOH01']) put(`${FCA_BASE}/Individuals/${irn}/CF`, individualBody('Other Bank Ltd', '999999'));
    writeFileSync(path.join(importDir, 'dfsa.csv'), csvOf(dfsa));
  };
  const run = (...args) => spawnSync(process.execPath, ['index.js', ...args], {
    cwd: BOT_DIR, encoding: 'utf8',
    env: {
      ...process.env,
      BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, MM_WATCHLIST: watchlistPath,
      FCA_API_EMAIL: 'me@example.com', FCA_API_KEY: 'k',
      // Blank values stop dotenv loading real ones from the root .env during tests.
      SLACK_WEBHOOK_URL: 'http://127.0.0.1:9/never-called', SLACK_WEBHOOK_URL_MANDATES: '',
      HEALTHCHECKS_BASE_URL: '', HC_UUID_MANDATE_MATCHER: '', LOG_FORMAT: 'json',
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
    importDir = path.join(base, 'imports');
    mkdirSync(dataDir);
    mkdirSync(importDir);
    watchlistPath = path.join(base, 'watchlist.json');
    writeFileSync(watchlistPath, JSON.stringify({
      firms: [FIRM_A, FIRM_B, { regulator: 'DFSA', ref: 'F000123', name: 'Example Capital (DIFC) Limited', market: 'DIFC', tier: 2, source: { type: 'file', path: path.join(importDir, 'dfsa.csv') } }],
      mandates: MANDATES,
    }));
  });

  test('--dry-run on an empty data dir writes nothing', () => {
    writeDay(A_DAY1, B_DAY1, DFSA_DAY1);
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dataDir), []);
  });

  test('live baseline creates state; nothing is posted', () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(readdirSync(dataDir).includes('mandate-matcher.sqlite'));
    assert.match(r.stdout, /Nothing new; no Slack message/);
  });

  test('--dry-run with changes prints the digest and leaves every file byte-identical', () => {
    writeDay(A_DAY2, B_DAY2, DFSA_DAY2);
    const before = fingerprint(dataDir);
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Mandate Matcher \d{4}-\d{2}-\d{2}: 5 movers/);
    assert.match(r.stdout, /Other Bank Ltd/, 'leaver destination fetched and applied in memory');
    assert.deepEqual(fingerprint(dataDir), before);
  });

  test('when no firm can be processed the run halts with exit code 1 and a loud alert', () => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures);
    rmSync(path.join(importDir, 'dfsa.csv'));
    const r = run('--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no firm roster could be processed/);
  });

  test('--retention-only runs just the GDPR job', () => {
    const r = run('--retention-only');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Retention job finished/);
  });
});