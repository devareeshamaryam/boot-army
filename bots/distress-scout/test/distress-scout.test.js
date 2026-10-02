/**
 * B4 Distress Scout tests.   Run: npm test -w bots/distress-scout
 *
 * Fixtures are built here in the shapes the sources serve: the Gazette notice
 * feed JSON (github.com/TheGazette/DevDocs), Companies House company profile
 * and insolvency JSON, and CSV extracts. Record real payloads with
 * BOTARMY_HTTP_RECORD=bots/distress-scout/test/fixtures/http.
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
import { GAZETTE_NOTICE, SOURCES, gazetteUrl, gazetteWindow, windowHasWeekday } from '../harvest.js';
import {
  BOT, EVENT_TYPE, companiesHouseToRecords, csvToRecords, evaluateCompanies, extractCompanyKey, gazetteToRecords,
  markNotified, parseGazetteFeed, pendingTransitions, processGazette, recordSourceRun, storeRecords, syncWatchlist,
  toIsoDate, validateConfig, volumeAnomaly,
} from '../process.js';
import { EVENT_TYPES, GAZETTE_CODES, applyTagRules, evaluateState, severityScore, transitionKind } from '../score.js';
import { buildAnomalyAlert, buildDigest, dateLabel } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ds-test-'));
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

const NOW = '2026-09-30T08:00:00.000Z'; // a Wednesday
const notice = (id, code, title, text, published = '2026-09-29T07:00:00') => ({
  id: `https://www.thegazette.co.uk/id/notice/${id}`, 'f:notice-code': String(code), title,
  link: [{ '@href': `https://www.thegazette.co.uk/id/notice/${id}`, '@rel': 'self' }, { '@href': `https://www.thegazette.co.uk/notice/${id}` }],
  published, content: `<div><p>${text}</p></div>`,
});
const feed = (entries) => JSON.stringify({ title: 'Search Result', 'f:total': String(entries.length), entry: entries });

const DAY1 = [
  notice(5001, 2450, 'ACME TRADING LIMITED', 'In the High Court of Justice, Case Number CR-2026-001234. A Petition to wind up ACME TRADING LIMITED (Company Number 01234567) was presented …'),
  notice(5002, 2410, 'BETA BUILD LIMITED', 'BETA BUILD LIMITED (Company Number 07654321). Nature of business: construction. Date of appointment of joint administrators: 25 September 2026 …'),
  notice(5003, 2431, 'GAMMA SOLVENT LIMITED', 'GAMMA SOLVENT LIMITED (Company Number 09999999) members\u2019 voluntary liquidation …'),
  notice(5004, 2442, 'DELTA LOGISTICS LTD', 'Notice is hereby given that a meeting of creditors …'),
  notice(5005, 1119, 'Warrants Under the Royal Sign Manual', 'Not insolvency'),
];
const DELTA_PAGE = '<html><body><dl><dt>Company Number:</dt><dd>Company Number: 08888888</dd></dl><p>DELTA LOGISTICS LTD meeting of creditors</p></body></html>';

const CONFIG_RAW = {
  watchlist: [{ companyNumber: '1234567', name: 'Acme Trading Limited' }],
  tagRules: [
    { id: 'talent-formal', tag: 'TALENT', tiers: ['severe_insolvency'], eventTypes: ['administration', 'winding_up_order'] },
    { id: 'acquire-admin', tag: 'ACQUIRE', eventTypes: ['administration'] },
    { id: 'property-sic', tag: 'PROPERTY', sicPrefixes: ['68'] },
    { id: 'approach-early', tag: 'APPROACH', tiers: ['early_warning', 'active_distress'] },
  ],
  routes: { TALENT: ['distress-talent-ateca'] },
  sources: { companiesHouse: { enabled: false } },
};
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function openAll(dataDir = tmp()) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  return { db, store, spine, dataDir };
}
const storeFeed = (env, entries, ref = 'p1.json') => env.store.writeRaw(SOURCES.gazetteFeed, ref, feed(entries), { kind: 'gazette-feed' }).id;
const ev = (eventType, eventDate, id = eventType + eventDate) => ({ id, eventType, eventDate });

/* ======================================================== state machine */

describe('state machine', () => {
  test('escalates early warning → active distress → severe insolvency', () => {
    assert.equal(evaluateState([]).tier, 'none');
    assert.equal(evaluateState([ev('accounts_overdue', '2026-06-30')]).tier, 'early_warning');
    assert.equal(evaluateState([ev('accounts_overdue', '2026-06-30'), ev('winding_up_petition', '2026-08-01')]).tier, 'active_distress');
    const severe = evaluateState([ev('accounts_overdue', '2026-06-30'), ev('winding_up_petition', '2026-08-01'), ev('administration', '2026-09-01')]);
    assert.equal(severe.tier, 'severe_insolvency');
    assert.equal(severe.stage, 'FORMAL');
    assert.equal(severe.reasons.driver.eventType, 'administration');
    assert.deepEqual(severe.reasons.corroborating, ['accounts_overdue', 'winding_up_petition']);
    assert.equal(transitionKind('active_distress', 'severe_insolvency'), 'escalation');
  });

  test('a dismissed petition de-escalates; the remaining signal sets the tier', () => {
    const s = evaluateState([ev('accounts_overdue', '2026-06-30'), ev('winding_up_petition', '2026-08-01'), ev('petition_dismissed', '2026-08-20')]);
    assert.equal(s.tier, 'early_warning');
    assert.equal(transitionKind('active_distress', s.tier), 'de-escalation');
    assert.equal(evaluateState([ev('winding_up_petition', '2026-08-01'), ev('petition_dismissed', '2026-08-20')]).tier, 'none');
  });

  test('out-of-order notices: arrival order never matters, event dates do', () => {
    const inOrder = [ev('winding_up_petition', '2026-08-01'), ev('petition_dismissed', '2026-08-20'), ev('winding_up_petition', '2026-09-10', 'second')];
    const shuffled = [inOrder[2], inOrder[1], inOrder[0]];
    assert.deepEqual(evaluateState(shuffled), evaluateState(inOrder));
    assert.equal(evaluateState(shuffled).tier, 'active_distress', 'a fresh petition after the dismissal is open');
    // A dismissal dated before a petition cannot close it.
    assert.equal(evaluateState([ev('petition_dismissed', '2026-07-01'), ev('winding_up_petition', '2026-08-01')]).tier, 'active_distress');
  });

  test('severe signals are never auto-resolved; dissolution is terminal', () => {
    assert.equal(evaluateState([ev('administration', '2026-09-01'), ev('accounts_filed', '2026-09-20')]).tier, 'severe_insolvency');
    assert.equal(evaluateState([ev('administration', '2026-09-01'), ev('dissolved', '2027-09-01')]).tier, 'dissolved');
  });

  test('severity bands never overlap across tiers; corroboration lifts within a tier', () => {
    const early = evaluateState([ev('accounts_overdue', 'a'), ev('confirmation_overdue', 'b'), ev('creditors_meeting', 'c'), ev('ccj', 'd')]).severity;
    const active = evaluateState([ev('strike_off_proposed', 'a')]).severity;
    const severe = evaluateState([ev('liquidator_appointed', 'a')]).severity;
    assert.ok(early < active && active < severe, `${early} < ${active} < ${severe}`);
    assert.ok(severityScore([{ ...EVENT_TYPES.winding_up_petition, eventType: 'winding_up_petition' }, { ...EVENT_TYPES.accounts_overdue, eventType: 'accounts_overdue' }], 'active_distress')
      > severityScore([{ ...EVENT_TYPES.winding_up_petition, eventType: 'winding_up_petition' }], 'active_distress'));
  });

  test("members' voluntary liquidation (solvent) is never a distress code", () => {
    for (const code of [2431, 2432, 2433, 2434, 2435]) assert.equal(GAZETTE_CODES[code], undefined);
    const { records, skipped } = gazetteToRecords(parseGazetteFeed(Buffer.from(feed(DAY1))));
    assert.equal(skipped.solvent, 1);
    assert.equal(skipped.otherCodes, 1);
    assert.ok(!records.some((r) => r.companyName === 'GAMMA SOLVENT LIMITED'));
  });

  test('tags: one per tag, every tag carries the rule that set it', () => {
    const cfg = validateConfig(CONFIG_RAW);
    const state = evaluateState([ev('administration', '2026-09-25')]);
    assert.deepEqual(applyTagRules(state, { name: 'Beta Build Limited', sicCodes: ['68100'] }, cfg.tagRules), [
      { tag: 'ACQUIRE', ruleHit: 'acquire-admin' }, { tag: 'PROPERTY', ruleHit: 'property-sic' }, { tag: 'TALENT', ruleHit: 'talent-formal' },
    ]);
    assert.deepEqual(applyTagRules(evaluateState([ev('accounts_overdue', 'x')]), { name: 'X', sicCodes: [] }, cfg.tagRules), [{ tag: 'APPROACH', ruleHit: 'approach-early' }]);
  });
});

/* ============================================================== parsing */

describe('parsing', () => {
  test('company numbers only from an explicit label; bare digits are never trusted', () => {
    assert.equal(extractCompanyKey('ACME (Company Number 1234567) …'), 'UK:01234567');
    assert.equal(extractCompanyKey('Company Registration No: SC123456'), 'UK:SC123456');
    assert.equal(extractCompanyKey('Company No. 07654321'), 'UK:07654321');
    assert.equal(extractCompanyKey('Telephone 01234567 or case 12345678'), null);
  });

  test('Gazette feed: array or single entry; codes, dates, notice URL, case number', () => {
    const entries = parseGazetteFeed(Buffer.from(feed(DAY1)));
    assert.equal(entries.length, 5);
    assert.deepEqual(entries[0], {
      noticeId: '5001', noticeCode: 2450, title: 'ACME TRADING LIMITED', published: '2026-09-29',
      url: 'https://www.thegazette.co.uk/notice/5001', text: entries[0].text,
    });
    assert.equal(parseGazetteFeed(Buffer.from(JSON.stringify({ entry: DAY1[0] }))).length, 1, 'single entry as an object');
    assert.equal(parseGazetteFeed(Buffer.from(JSON.stringify({ title: 'x' }))).length, 0);
    assert.throws(() => parseGazetteFeed(Buffer.from('<html>maintenance</html>')), /not valid JSON/);
    const [petition] = gazetteToRecords(entries).records;
    assert.equal(petition.reference, 'CR-2026-001234');
    assert.equal(petition.dateBasis, 'published');
  });

  test('a notice without a company number is resolved from its full page, else kept by name only', () => {
    const entries = parseGazetteFeed(Buffer.from(feed([DAY1[3]])));
    assert.equal(gazetteToRecords(entries).records[0].companyKey, 'name:delta logistics ltd');
    assert.equal(gazetteToRecords(entries, new Map([['5004', 'Company Number: 08888888']])).records[0].companyKey, 'UK:08888888');
  });

  test('Companies House: overdue filings, resolutions, strike-off, cases; MVL and unknown types never mapped', () => {
    const profile = {
      company_name: 'EXAMPLE CO LIMITED', company_status: 'active', company_status_detail: 'active-proposal-to-strike-off',
      accounts: { overdue: true, next_due: '2026-06-30' }, confirmation_statement: { overdue: false, next_due: '2026-12-01' }, sic_codes: ['68100'],
    };
    const insolvency = { cases: [
      { number: 1, type: 'creditors-voluntary-liquidation', dates: [{ type: 'wound-up-on', date: '2026-09-01' }] },
      { number: 2, type: 'members-voluntary-liquidation', dates: [{ date: '2020-01-01' }] },
      { number: 3, type: 'something-new', dates: [] },
    ] };
    const r = companiesHouseToRecords({ profile, insolvency, companyKey: 'UK:01234567', today: '2026-09-30' });
    assert.deepEqual(r.records.map((x) => [x.eventType, x.eventDate, x.dateBasis]), [
      ['accounts_overdue', '2026-06-30', 'due'],
      ['strike_off_proposed', '2026-09-30', 'observed'],
      ['creditors_voluntary_liquidation', '2026-09-01', 'case'],
    ]);
    assert.deepEqual(r.unknownCaseTypes, ['something-new']);
    assert.deepEqual(r.company.sicCodes, ['68100']);
    const filed = companiesHouseToRecords({ profile: { ...profile, company_status_detail: null, accounts: { overdue: false } }, insolvency: { cases: [] }, companyKey: 'UK:01234567', openTypes: new Set(['accounts_overdue', 'strike_off_proposed']), today: '2026-10-07' });
    assert.deepEqual(filed.records.map((x) => x.eventType), ['accounts_filed', 'strike_off_discontinued']);
    const reproposed = companiesHouseToRecords({ profile, insolvency: { cases: [] }, companyKey: 'UK:01234567', openTypes: new Set(), today: '2026-11-15' });
    assert.ok(reproposed.records.some((x) => x.sourceRef === '01234567:strike_off_proposed:2026-11-15'), 'a re-proposal is a new record');
  });

  test('CSV: mapped event types only; dates validated; nothing invented', () => {
    const csv = 'Company Number,Type,Judgment Date,Case Number\r\n1234567,CCJ,15/09/2026,K1AB234\r\n7654321,Mystery,01/09/2026,X\r\n,,,\r\n';
    const { records, problems } = csvToRecords(Buffer.from(csv), { name: 'ccj', fields: { companyNumber: ['Company Number'], eventType: ['Type'], eventDate: ['Judgment Date'], reference: ['Case Number'] }, eventTypeMap: { CCJ: 'ccj' } });
    assert.deepEqual(records.map((x) => [x.companyKey, x.eventType, x.eventDate, x.sourceRef]), [['UK:01234567', 'ccj', '2026-09-15', 'K1AB234']]);
    assert.equal(problems.unknownType, 1);
    assert.equal(toIsoDate('31/02/2026'), null);
    assert.equal(dateLabel(null, 'unknown'), 'date not published');
  });

  test('config validation reports every problem at once', () => {
    assert.throws(() => validateConfig({ watchlist: [{ companyNumber: 'abc' }], tagRules: [{ id: 'bad id', tag: 'HIRE', tiers: ['awful'], eventTypes: ['nope'] }], routes: { NOPE: ['x'] } }), (err) => {
      for (const p of ['not a Companies House number', 'name is required', 'id must be a slug', 'tag must be one of', '"awful" is not a tier', '"nope" is not an event type', 'routes.NOPE']) assert.ok(err.message.includes(p), p);
      return true;
    });
  });
});

/* ======================================================== deduplication */

describe('deduplication', () => {
  test('the same notice twice is one record and one spine event; re-processing a snapshot writes nothing', () => {
    const env = openAll();
    const s1 = storeFeed(env, DAY1);
    processGazette({ ...env, snapshotIds: [s1], now: NOW });
    const count = () => [env.db.prepare('SELECT COUNT(*) FROM distress_records').pluck().get(), env.spine.db.prepare('SELECT COUNT(*) FROM events WHERE type = ?').pluck().get(EVENT_TYPE)];
    assert.deepEqual(count(), [3, 3]);
    processGazette({ ...env, snapshotIds: [s1], now: NOW });
    const s2 = storeFeed(env, [...DAY1, notice(5006, 2410, 'EPSILON LTD', 'EPSILON LTD (Company Number 01111111)')], 'p1-overlap.json');
    processGazette({ ...env, snapshotIds: [s2], now: NOW });
    assert.deepEqual(count(), [4, 4], 'overlapping windows only add the new notice');
  });

  test('two notices for one company on one day stay distinct on the spine', () => {
    const env = openAll();
    const recs = gazetteToRecords(parseGazetteFeed(Buffer.from(feed([
      notice(6001, 2410, 'ZETA LIMITED', 'ZETA LIMITED (Company Number 05555555)'),
      notice(6002, 2412, 'ZETA LIMITED', 'ZETA LIMITED (Company Number 05555555) meeting of creditors'),
    ])))).records;
    storeRecords({ ...env, records: recs, snapshotId: 1, now: NOW });
    const events = env.spine.db.prepare(`SELECT e.source, n.registry_id FROM events e JOIN entities n ON n.entity_id = e.entity_id WHERE e.type = ?`).all(EVENT_TYPE);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.registry_id === '05555555'), 'keyed on the company number');
  });

  test('one transition per company per tier per day; only real tier changes alert', () => {
    const env = openAll();
    const cfg = validateConfig(CONFIG_RAW);
    syncWatchlist(env.db, cfg.watchlist, NOW);
    const touched = processGazette({ ...env, snapshotIds: [storeFeed(env, DAY1)], now: NOW }).touched;
    evaluateCompanies({ ...env, companyKeys: touched, tagRules: cfg.tagRules, now: NOW });
    const first = pendingTransitions(env.db);
    assert.deepEqual(first.map((t) => [t.company_name, t.to_tier]).sort(), [
      ['ACME TRADING LIMITED', 'active_distress'], ['BETA BUILD LIMITED', 'severe_insolvency'], ['DELTA LOGISTICS LTD', 'early_warning'],
    ]);
    assert.equal(first.find((t) => t.company_name === 'ACME TRADING LIMITED').watchlisted, true);
    assert.deepEqual(first.find((t) => t.company_name === 'BETA BUILD LIMITED').tags.map((t) => t.tag), ['ACQUIRE', 'TALENT']);
    markNotified(env.db, first.map((t) => t.id), NOW);

    // Same day, same companies, a second same-tier notice for Acme: no new alert.
    const more = processGazette({ ...env, snapshotIds: [storeFeed(env, [notice(5101, 2450, 'ACME TRADING LIMITED', 'ACME TRADING LIMITED (Company Number 01234567) further petition')], 'p2.json')], now: NOW }).touched;
    assert.equal(evaluateCompanies({ ...env, companyKeys: more, tagRules: cfg.tagRules, now: NOW }).transitions, 0);
    assert.equal(pendingTransitions(env.db).length, 0);

    // Later: Acme escalates to administration → one new alert.
    const later = processGazette({ ...env, snapshotIds: [storeFeed(env, [notice(5201, 2410, 'ACME TRADING LIMITED', 'ACME TRADING LIMITED (Company Number 01234567)', '2026-10-05T07:00:00')], 'p3.json')], now: '2026-10-05T08:00:00.000Z' }).touched;
    evaluateCompanies({ ...env, companyKeys: later, tagRules: cfg.tagRules, now: '2026-10-05T08:00:00.000Z' });
    assert.deepEqual(pendingTransitions(env.db).map((t) => [t.from_tier, t.to_tier]), [['active_distress', 'severe_insolvency']]);
  });

  test('a historic finding (e.g. a first lookup surfacing a 2015 liquidation) is recorded but never alerted', () => {
    const env = openAll();
    const recs = companiesHouseToRecords({ profile: { company_name: 'OLD CO LTD', company_status: 'liquidation' }, insolvency: { cases: [{ number: 1, type: 'compulsory-liquidation', dates: [{ date: '2015-03-01' }] }] }, companyKey: 'UK:02222222', today: '2026-09-30' }).records;
    const touched = storeRecords({ ...env, records: recs, snapshotId: 1, now: NOW });
    const counts = evaluateCompanies({ ...env, companyKeys: touched, tagRules: [], now: NOW });
    assert.deepEqual(counts, { transitions: 1, historic: 1 });
    assert.equal(pendingTransitions(env.db).length, 0);
    assert.equal(env.db.prepare(`SELECT tier FROM company_states WHERE company_key = 'UK:02222222'`).pluck().get(), 'severe_insolvency');
  });
});

/* =========================================================== drop guards */

describe('drop guards', () => {
  const guard = { minExpected: 20, lookbackRuns: 5 };

  test('a silent publishing day against a busy history is an anomaly; weekends and thin history are not', () => {
    const env = openAll();
    const runId = Number(env.db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(NOW).lastInsertRowid);
    assert.equal(volumeAnomaly(env.db, 'gazette', 0, true, guard), null, 'no history yet: not judged');
    for (const n of [180, 220, 205]) recordSourceRun(env.db, { runId, source: 'gazette', items: n, weekday: true, outcome: 'ok', now: NOW });
    assert.match(volumeAnomaly(env.db, 'gazette', 0, true, guard), /returned 0 notices for a publishing day; the last 3 weekday runs averaged 202/);
    assert.equal(volumeAnomaly(env.db, 'gazette', 0, false, guard), null, 'weekend-only window');
    assert.equal(volumeAnomaly(env.db, 'gazette', 45, true, guard), null);
    assert.equal(windowHasWeekday({ from: '2026-10-03', to: '2026-10-04' }), false, 'Sat–Sun');
    assert.equal(windowHasWeekday({ from: '2026-10-03', to: '2026-10-05' }), true);
  });

  test('a feed page that fails to parse is not marked processed: retried and reported every run', () => {
    const env = openAll();
    const bad = env.store.writeRaw(SOURCES.gazetteFeed, 'bad.json', '<html>Service unavailable</html>', {}).id;
    assert.equal(processGazette({ ...env, snapshotIds: [bad], now: NOW }).failures.length, 1);
    assert.equal(processGazette({ ...env, snapshotIds: [bad], now: NOW }).failures.length, 1, 'still failing loudly on the next run');
  });

  test('window and URL follow the documented feed parameters', () => {
    assert.deepEqual(gazetteWindow(null, NOW, 3), { from: '2026-09-27', to: '2026-09-30' });
    assert.deepEqual(gazetteWindow('2026-09-29', NOW), { from: '2026-09-29', to: '2026-09-30' });
    const u = new URL(gazetteUrl({ from: '2026-09-27', to: '2026-09-30' }, 2));
    assert.equal(u.pathname, '/insolvency/notice/data.json');
    assert.deepEqual(Object.fromEntries(u.searchParams), {
      categorycode: '24', 'start-publish-date': '2026-09-27', 'end-publish-date': '2026-09-30',
      'results-page-size': '100', 'results-page': '2', 'sort-by': 'oldest-date',
    });
  });
});

/* ================================================================ digest */

describe('digest', () => {
  const row = (over) => ({
    id: 1, kind: 'escalation', from_tier: 'none', to_tier: 'severe_insolvency', severity: 86, company_name: 'Beta <Build> Ltd', company_number: '07654321',
    watchlisted: false, tags: [{ tag: 'TALENT', ruleHit: 'talent-formal' }],
    evidence: [{ event_type: 'administration', event_date: '2026-09-29', date_basis: 'published', notice_code: '2410', reference: null, url: 'https://www.thegazette.co.uk/notice/5002' }],
    ...over,
  });

  test('grouped by tier, watchlist first, improvements last; links, codes and statutory references', () => {
    const d = buildDigest({ date: '2026-09-30', stats: { gazetteNotices: 5, solventSkipped: 1 }, transitions: [
      row(), row({ id: 2, to_tier: 'early_warning', severity: 30, company_name: 'Delta', watchlisted: true, tags: [] }),
      row({ id: 3, kind: 'de-escalation', from_tier: 'active_distress', to_tier: 'none', severity: 0, company_name: 'Recovered Ltd', tags: [] }),
    ] });
    const headings = d.blocks.filter((b) => b.type === 'section' && /^\*.+\* \(\d+\)$/.test(b.text.text)).map((b) => b.text.text);
    assert.deepEqual(headings, ['*:star: Watchlist companies* (1)', '*:red_circle: Severe insolvency* (1)', '*:white_check_mark: Improved (signals resolved)* (1)']);
    const text = JSON.stringify(d.blocks);
    assert.match(text, /find-and-update\.company-information\.service\.gov\.uk\/company\/07654321/);
    assert.match(text, /Gazette 2410/);
    assert.match(text, /Insolvency Act 1986 Sch\. B1/);
    assert.match(text, /\*TALENT\* _\(talent-formal\)_/);
    assert.match(text, /Beta &lt;Build&gt; Ltd/);
    assert.match(text, /1 solvent \(members' voluntary\) liquidations ignored/);
    assert.match(text, /not legal advice/);
  });

  test('limits and alerts', () => {
    const d = buildDigest({ date: 'd', transitions: Array.from({ length: 60 }, (_, i) => row({ id: i })), maxPerTier: 15 });
    assert.match(JSON.stringify(d.blocks), /and 45 more/);
    assert.ok(d.blocks.length <= 50);
    assert.match(buildAnomalyAlert({ date: 'd', problems: ['x'] }).blocks[0].text.text, /cursor held/);
    assert.match(buildAnomalyAlert({ date: 'd', problems: ['x'], halted: true }).blocks[0].text.text, /run halted/);
  });
});

/* ============================================================ entry point */

describe('index.js', () => {
  let base;
  let dataDir;
  let fixtures;
  let configPath;
  let server;
  let slackUrl;
  const posts = [];

  const put = (url, body, type = 'application/json') => writeFileSync(path.join(fixtures, `${coreHttp.fixtureKey('GET', url)}.json`), JSON.stringify({
    url, status: 200, headers: { 'content-type': type }, bodyBase64: Buffer.from(body).toString('base64'),
  }));
  const writeFixtures = (entries, { delta = true } = {}) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    put(gazetteUrl(gazetteWindow(null, NOW, 3), 1), feed(entries));
    // After a live run the cursor is today, so a re-run re-reads today's notices (overlap): same entries, deduplicated.
    put(gazetteUrl(gazetteWindow(NOW.slice(0, 10), NOW), 1), feed(entries));
    put('https://www.thegazette.co.uk/robots.txt', 'User-agent: *\nDisallow: /private', 'text/plain');
    if (delta) put(GAZETTE_NOTICE('5004'), DELTA_PAGE, 'text/html');
  };
  /** Async spawn, so the in-process Slack server can answer the child. */
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js', ...args], {
      cwd: BOT_DIR,
      env: {
        ...process.env, BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, DS_CONFIG: configPath, DS_NOW: NOW, LOG_FORMAT: 'json',
        SLACK_WEBHOOK_URL: slackUrl, SLACK_WEBHOOK_URL_DISTRESS: '', SLACK_WEBHOOK_URL_DISTRESS_TALENT_ATECA: `${slackUrl}/talent`,
        HEALTHCHECKS_BASE_URL: '', HC_UUID_DISTRESS_SCOUT: '', CH_API_KEY: '',
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
    base = tmp();
    dataDir = path.join(base, 'data');
    fixtures = path.join(base, 'fixtures');
    mkdirSync(dataDir);
    configPath = path.join(base, 'distress.json');
    writeFileSync(configPath, JSON.stringify(CONFIG_RAW));
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { posts.push({ path: req.url, body: JSON.parse(b) }); res.end('ok'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    slackUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  test('--dry-run on an empty data dir prints the digests and writes nothing', async () => {
    writeFixtures(DAY1);
    const r = await run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.match(r.stdout, /"channel": "distress"/);
    assert.match(r.stdout, /"channel": "distress-talent-ateca"/, 'TALENT routed to its channel');
    assert.match(r.stdout, /DELTA LOGISTICS LTD \(08888888\)/, 'number resolved from the full notice page');
    assert.match(r.stdout, /Companies House lookups skipped|Live run|Dry run/);
    assert.equal(posts.length, 0);
  });

  test('live run posts the main digest and the TALENT digest; a re-run sends nothing new', async () => {
    const r = await run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(posts.map((p) => p.path).sort(), ['/', '/talent']);
    assert.match(posts.find((p) => p.path === '/talent').body.text, /Distress Scout · TALENT/);
    assert.match(JSON.stringify(posts.find((p) => p.path === '/').body.blocks), /Watchlist companies/);
    const again = await run();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(posts.length, 2, 'no duplicate posts');
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
    const r = await run('--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /every source failed/);
  });
});