/**
 * B9 Payment Practices Scout tests.   Run: npm test -w bots/payment-practices-scout
 *
 * Fixtures are built here in the export's historical header layout, including
 * the 2025 "because of a dispute" column. Replace them with a recorded export by
 * running once with BOTARMY_HTTP_RECORD=bots/payment-practices-scout/test/fixtures/http.
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
import { EXPORT_URL, SOURCE, harvest } from '../harvest.js';
import {
  AnomalyError, BOT, EVENT_TYPE, anomalyReason, companyIdentity, creditCheck, evaluateJump, markNotified,
  parseExport, pendingJumps, processSnapshot, resolveColumns, toInt, toIsoDate,
} from '../process.js';
import { asOf, buildAnomalyAlert, buildDigest, formatCreditCheck, jumpLine } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== cleanup */

const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'pps-test-'));
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

const HEADER = ['Report Id', 'Start date', 'End date', 'Filing date', 'Company', 'Company number',
  'Payments made in the reporting period', 'Average time to pay', '% Invoices paid within 30 days',
  '% Invoices not paid within agreed terms because of a dispute', '% Invoices not paid within agreed terms', 'URL'];
const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const row = (id, start, end, filed, name, num, avg, late) =>
  [id, start, end, filed, name, num, 'True', avg, 50, 3, late, `https://check-payment-practices.service.gov.uk/report/${id}`];
const csv = (rows, { bom = true, crlf = true } = {}) => `${bom ? '\uFEFF' : ''}${[HEADER, ...rows].map((r) => r.map(q).join(',')).join(crlf ? '\r\n' : '\n')}`;

/** 600 companies × 2 periods = 1,200 historical reports. */
function history() {
  const rows = [];
  let id = 1000;
  for (let c = 0; c < 600; c++) {
    const num = String(1000000 + c); // unpadded on purpose: normalised to 8 digits
    rows.push(row(id++, '2025-01-01', '2025-06-30', '2025-07-20', `Company ${c} Limited`, num, 30, 10));
    rows.push(row(id++, '2025-07-01', '2025-12-31', '2026-01-20', `Company ${c} Limited`, num, 31, 11));
  }
  return rows;
}
const DAY1 = history();
const NEW_REPORTS = [
  row(9001, '2026-01-01', '2026-06-30', '2026-09-28', 'Company 1 Limited', '1000001', 62, 12), // days jump 31 → 62
  row(9002, '2026-01-01', '2026-06-30', '2026-09-28', 'Company 2 Limited', '1000002', 33, 45), // outside-terms jump 11 → 45
  row(9003, '2026-01-01', '2026-06-30', '2026-09-28', 'Company 3 Limited', '1000003', 36, 14), // small rise: no alert
  row(9004, '2026-01-01', '2026-06-30', '2026-09-28', 'Company 4 Limited', '1000004', 20, 5),  // improvement: no alert
  row(9005, '2025-07-01', '2025-12-31', '2026-09-28', 'Company 5 Limited', '1000005', 90, 80), // re-filed earlier period
  row(9006, '2026-01-01', '2026-06-30', '2026-09-28', 'Brand New Plc', '07777777', 88, 70),     // no history: no alert
  row(9007, '2026-01-01', '2026-06-30', '2026-09-28', 'Company 6 Limited', '1000006', '', ''),  // missing figures: never a jump
];
const DAY2 = [...DAY1, ...NEW_REPORTS];

const SETTINGS = {
  rules: { minDaysIncrease: 15, minPctIncrease: 30, minAvgDays: 40, minLatePoints: 20, minLatePct: 30, maxGapDays: 400 },
  minReports: 1000, minRetainedRatio: 0.9, previewDays: 30, maxAlerts: 25,
};
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function openAll(dataDir) {
  const db = track(coreDb.connect(BOT, { dataDir }));
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const store = track(snapshot.openStore({ dataDir }));
  const spine = track(coreSpine.openSpine({ dataDir }));
  return { db, store, spine };
}
const storeExport = (store, text) => store.writeRaw(SOURCE, 'export.csv', Buffer.from(text), { url: EXPORT_URL, contentType: 'text/csv' }).id;

/* =============================================================== parsing */

describe('parsing', () => {
  test('columns found by pattern; the dispute column is not mistaken for outside-terms', () => {
    const { mapping, columns } = resolveColumns(HEADER);
    assert.equal(columns[mapping.paymentsBeyondTerms], '% Invoices not paid within agreed terms');
    assert.equal(columns[mapping.avgDaysToPay], 'Average time to pay');
    assert.equal(columns[mapping.periodEnd], 'End date');
  });

  test('unrecognised layout is an anomaly that lists the headers found', () => {
    assert.throws(() => resolveColumns(['Foo', 'Bar']), (err) => err instanceof AnomalyError && /missing companyName, avgDaysToPay, periodEnd/.test(err.message) && /Foo \| Bar/.test(err.message));
  });

  test('numbers and dates are parsed safely and never invented', () => {
    assert.equal(toInt('53'), 53);
    assert.equal(toInt('17%'), 17);
    assert.equal(toInt('1,234'), 1234);
    assert.equal(toInt(''), null);
    assert.equal(toInt('n/a'), null);
    assert.equal(toInt(null), null);
    assert.equal(toIsoDate('30/06/2026'), '2026-06-30');
    assert.equal(toIsoDate('30 June 2026'), '2026-06-30');
    assert.equal(toIsoDate('31/02/2026'), null, 'impossible date rejected');
    assert.equal(toIsoDate(''), null);
  });

  test('company numbers normalised to the spine; invalid numbers fall back to a name key, never a guessed number', () => {
    assert.deepEqual(companyIdentity('1000001', 'X'), { companyKey: 'UK:01000001', companyNumber: '01000001' });
    assert.deepEqual(companyIdentity('not-a-number', 'Acme & Co Ltd'), { companyKey: 'name:acme co ltd', companyNumber: null });
  });

  test('parseExport: BOM, CRLF, quoted commas, missing figures stay null', () => {
    const { reports, rowCount } = parseExport(csv([...NEW_REPORTS, row(9100, '2026-01-01', '2026-06-30', '2026-09-28', 'Smith, Jones & Co "Ltd"', '1234567', 41, 9)]));
    assert.equal(rowCount, NEW_REPORTS.length + 1);
    const missing = reports.find((r) => r.reportId === '9007');
    assert.equal(missing.avgDaysToPay, null);
    assert.equal(missing.paymentsBeyondTerms, null);
    assert.ok(reports.some((r) => r.companyName === 'Smith, Jones & Co "Ltd"'));
  });
});

/* ================================================================ rules */

describe('jump rules', () => {
  const base = { periodEndDate: '2025-12-31', avgDaysToPay: 31, paymentsBeyondTerms: 11 };
  const cur = (o) => ({ periodEndDate: '2026-06-30', avgDaysToPay: 31, paymentsBeyondTerms: 11, ...o });

  test('days rule needs the absolute AND relative rise AND a slow end point', () => {
    assert.deepEqual(evaluateJump(cur({ avgDaysToPay: 62 }), base, SETTINGS.rules).reasons, ['days']);
    assert.equal(evaluateJump(cur({ avgDaysToPay: 36 }), base, SETTINGS.rules), null, '+5 days is noise');
    assert.equal(evaluateJump(cur({ avgDaysToPay: 25 }), { ...base, avgDaysToPay: 9 }, SETTINGS.rules), null, 'still fast: below minAvgDays');
  });

  test('outside-terms rule, gap limit and missing figures', () => {
    assert.deepEqual(evaluateJump(cur({ paymentsBeyondTerms: 45 }), base, SETTINGS.rules).reasons, ['late']);
    assert.equal(evaluateJump(cur({ avgDaysToPay: 90, periodEndDate: '2028-01-01' }), base, SETTINGS.rules), null, 'gap > 400 days');
    assert.equal(evaluateJump(cur({ avgDaysToPay: null, paymentsBeyondTerms: null }), base, SETTINGS.rules), null);
    assert.equal(evaluateJump(cur({ avgDaysToPay: 90 }), null, SETTINGS.rules), null, 'no previous report');
  });

  test('drop guard thresholds', () => {
    assert.match(anomalyReason({ reportCount: 0, storedCount: 0, minReports: 1000, minRetainedRatio: 0.9 }), /0 reports/);
    assert.match(anomalyReason({ reportCount: 500, storedCount: 0, minReports: 1000, minRetainedRatio: 0.9 }), /minimum 1000/);
    assert.match(anomalyReason({ reportCount: 1500, storedCount: 2000, minReports: 1000, minRetainedRatio: 0.9 }), /looks truncated/);
    assert.equal(anomalyReason({ reportCount: 1800, storedCount: 2000, minReports: 1000, minRetainedRatio: 0.9 }), null);
  });
});

/* ================================================================ harvest */

describe('harvest (snapshot-first)', () => {
  after(() => http.setFetch());

  test('stores the raw export byte-for-byte; identical re-download dedupes', async () => {
    const text = csv(DAY1);
    http.setFetch(async () => new Response(text, { headers: { 'content-type': 'text/csv' } }));
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    const a = await harvest({ store, env: {} });
    assert.equal(store.readRaw(a.snapshot.id).toString('utf8'), text);
    const b = await harvest({ store, env: {} });
    assert.equal(b.snapshot.isNew, false);
    assert.equal(b.snapshot.id, a.snapshot.id);
  });

  test('a 403 explains the PPS_CSV_PATH workaround; a local file is stored the same way', async () => {
    http.setFetch(async () => new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));
    const store = track(snapshot.openStore({ dataDir: tmp() }));
    await assert.rejects(harvest({ store, env: {} }), /set PPS_CSV_PATH/);
    const file = path.join(tmp(), 'export.csv');
    writeFileSync(file, csv(DAY1));
    const { snapshot: s } = await harvest({ store, env: { PPS_CSV_PATH: file } });
    assert.equal(store.get(s.id).meta.origin, 'file:export.csv');
  });
});

/* ======================================================= end to end */

describe('processSnapshot end to end', () => {
  let env;
  before(() => {
    env = openAll(tmp());
  });

  test('first export is a BASELINE: all reports stored, no jumps, no spine events', () => {
    const r = processSnapshot({ ...env, snapshotId: storeExport(env.store, csv(DAY1)), settings: SETTINGS, log: quiet });
    assert.equal(r.outcome, 'baseline');
    assert.equal(r.stats.newReports, 1200);
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM payment_records').pluck().get(), 1200);
    assert.equal(pendingJumps(env.db).length, 0);
    assert.equal(env.spine.db.prepare('SELECT COUNT(*) FROM events').pluck().get(), 0);
  });

  test('new reports: days and outside-terms jumps found; small rises, improvements, no-history and missing figures ignored', () => {
    const r = processSnapshot({ ...env, snapshotId: storeExport(env.store, csv(DAY2)), settings: SETTINGS, now: '2026-09-29T06:00:00.000Z', log: quiet });
    assert.equal(r.outcome, 'diffed');
    assert.equal(r.stats.newReports, NEW_REPORTS.length);
    const jumps = pendingJumps(env.db);
    assert.deepEqual(jumps.map((j) => j.company_name).sort(), ['Company 1 Limited', 'Company 2 Limited', 'Company 5 Limited']);
    assert.deepEqual(jumps.find((j) => j.company_name === 'Company 1 Limited').reasons, ['days']);
    assert.deepEqual(jumps.find((j) => j.company_name === 'Company 2 Limited').reasons, ['late']);
  });

  test('a re-filed period is compared with the previous period and labelled', () => {
    const j = pendingJumps(env.db).find((x) => x.company_name === 'Company 5 Limited');
    assert.equal(j.refiled, 1);
    assert.equal(j.prev.periodEndDate, '2025-06-30');
    assert.match(jumpLine(j), /re-filed report for this period/);
  });

  test('PAYMENT_DAYS_JUMP emitted to the spine, keyed on the Companies House number and the period', () => {
    const events = env.spine.db.prepare(`SELECT e.*, n.registry_id FROM events e JOIN entities n ON n.entity_id = e.entity_id WHERE e.type = ?`).all(EVENT_TYPE);
    assert.equal(events.length, 3);
    const c1 = events.find((e) => e.registry_id === '01000001');
    assert.equal(c1.event_date, '2026-06-30');
    assert.equal(c1.source, `${BOT}:${SOURCE}`);
    assert.match(JSON.parse(c1.payload).note, /not current payment behaviour/);
  });

  test('re-processing the same snapshot changes nothing', () => {
    const latest = env.store.latest(SOURCE).id;
    const counts = () => [env.db.prepare('SELECT COUNT(*) FROM payment_records').pluck().get(), env.db.prepare('SELECT COUNT(*) FROM payment_jumps').pluck().get(), env.spine.db.prepare('SELECT COUNT(*) FROM events').pluck().get()];
    const before = counts();
    assert.equal(processSnapshot({ ...env, snapshotId: latest, settings: SETTINGS, log: quiet }).outcome, 'already-processed');
    assert.deepEqual(counts(), before);
  });

  test('a truncated export is rejected loudly and leaves state untouched', () => {
    const before = env.db.prepare('SELECT COUNT(*) FROM payment_records').pluck().get();
    const snap = storeExport(env.store, csv(DAY2.slice(0, 1050)));
    assert.throws(() => processSnapshot({ ...env, snapshotId: snap, settings: SETTINGS, log: quiet }), (err) => {
      assert.ok(err instanceof AnomalyError);
      assert.match(err.message, /looks truncated/);
      assert.equal(err.details.storedCount, before);
      return true;
    });
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM payment_records').pluck().get(), before);
    assert.equal(env.db.prepare('SELECT outcome FROM processed_snapshots WHERE snapshot_id = ?').pluck().get(snap), 'rejected');
  });

  test('an HTML page or an empty export is rejected, never parsed into data', () => {
    const html = storeExport(env.store, '<!DOCTYPE html><html>Checking your browser</html>');
    assert.throws(() => processSnapshot({ ...env, snapshotId: html, settings: SETTINGS, log: quiet }), /HTML page/);
    const empty = storeExport(env.store, '');
    assert.throws(() => processSnapshot({ ...env, snapshotId: empty, settings: SETTINGS, log: quiet }), /no header row/);
  });

  test('credit check lists every stored report with its period', () => {
    const results = creditCheck(env.db, '1000001');
    assert.equal(results[0].companyNumber, '01000001');
    assert.equal(results[0].reports.length, 3);
    const text = formatCreditCheck(results, '1000001');
    assert.match(text, /data as of period ending 2026-06-30: 62 avg days to pay/);
    assert.match(formatCreditCheck(creditCheck(env.db, 'Company 6'), 'Company 6'), /avg days not reported/);
    assert.match(formatCreditCheck([], 'Nobody'), /No payment practices reports stored/);
  });

  test('markNotified clears pending jumps', () => {
    markNotified(env.db, pendingJumps(env.db).map((j) => j.id));
    assert.equal(pendingJumps(env.db).length, 0);
  });
});

/* ================================================================= digest */

describe('digest', () => {
  const jump = (over = {}) => ({
    id: 1, company_name: 'Acme <Ltd> & Co', company_number: '01000001', report_url: 'https://check-payment-practices.service.gov.uk/report/9001',
    avg_days_to_pay: 62, payments_beyond_terms: 12, period_end_date: '2026-06-30', filing_date: '2026-09-28',
    days_delta: 31, pct_delta: 100, late_delta: 1, refiled: 0, reasons: ['days'], score: 31,
    prev: { avgDaysToPay: 31, paymentsBeyondTerms: 11, periodEndDate: '2025-12-31' }, ...over,
  });

  test('every alert line, the header context and the notification text say "data as of period ending {date}"', () => {
    const d = buildDigest({ jumps: [jump(), jump({ id: 2, period_end_date: '2026-03-31' })], date: '2026-09-29' });
    const sections = d.blocks.filter((b) => b.type === 'section');
    assert.equal(sections.length, 2);
    for (const s of sections) assert.match(s.text.text, /data as of period ending \d{4}-\d{2}-\d{2}/);
    assert.match(d.blocks[1].elements[0].text, /data as of period ending 2026-06-30 \(oldest 2026-03-31\)/);
    assert.match(d.text, /data as of period ending 2026-06-30/);
    assert.equal(asOf('2026-06-30'), 'data as of period ending 2026-06-30');
  });

  test('caps alerts, escapes mrkdwn, stays inside Slack limits', () => {
    const d = buildDigest({ jumps: Array.from({ length: 60 }, (_, i) => jump({ id: i })), date: '2026-09-29', maxAlerts: 25 });
    assert.match(JSON.stringify(d.blocks), /and 35 more/);
    assert.match(JSON.stringify(d.blocks), /Acme &lt;Ltd&gt; &amp; Co/);
    assert.ok(d.blocks.length <= 50);
    assert.ok(d.blocks.every((b) => !b.text || b.text.text.length <= 3000));
  });

  test('missing figures are shown as incomplete, never filled in', () => {
    assert.match(jumpLine(jump({ avg_days_to_pay: null, days_delta: null, payments_beyond_terms: null, late_delta: null })), /figures incomplete/);
  });

  test('anomaly alert states the halt', () => {
    assert.match(buildAnomalyAlert({ reason: 'looks truncated', snapshotId: 4, storedCount: 120000 }).blocks[0].text.text, /processing halted, nothing recorded/);
  });
});

/* ============================================================ entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;

  const writeFixture = (body) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(path.join(fixtures, `${http.fixtureKey('GET', EXPORT_URL)}.json`), JSON.stringify({
      url: EXPORT_URL, status: 200, headers: { 'content-type': 'text/csv' }, bodyBase64: Buffer.from(body).toString('base64'),
    }));
  };
  const run = (...args) => spawnSync(process.execPath, ['index.js', ...args], {
    cwd: BOT_DIR, encoding: 'utf8',
    env: {
      ...process.env,
      BOTARMY_DATA_DIR: dataDir, BOTARMY_HTTP_REPLAY: fixtures, LOG_FORMAT: 'json',
      // Blank values stop dotenv loading real ones from the root .env during tests.
      SLACK_WEBHOOK_URL: 'http://127.0.0.1:9/never-called', SLACK_WEBHOOK_URL_PAYMENTS: '',
      HEALTHCHECKS_BASE_URL: '', HC_UUID_PAYMENT_PRACTICES_SCOUT: '', PPS_CSV_PATH: '', PPS_CSV_URL: '',
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
  });

  test('--dry-run on an empty data dir writes nothing', () => {
    writeFixture(csv(DAY1));
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.match(r.stdout, /Column mapping/);
  });

  test('live baseline stores everything and posts nothing', () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(readdirSync(dataDir).includes('payment-practices-scout.sqlite'));
    assert.match(r.stdout, /Baseline stored; no alerts/);
  });

  test('--dry-run with new reports prints the digest and leaves every file byte-identical', () => {
    writeFixture(csv(DAY2));
    const before = fingerprint(dataDir);
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /3 slower payers/);
    assert.match(r.stdout, /data as of period ending 2026-06-30/);
    assert.deepEqual(fingerprint(dataDir), before);
  });

  test('a truncated export halts with exit code 1 and a loud alert', () => {
    writeFixture(csv(DAY1.slice(0, 1050)));
    const r = run('--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /export rejected/);
  });

  test('--credit-check is read-only', () => {
    const before = fingerprint(dataDir);
    const r = run('--credit-check', '1000001');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Company 1 Limited \(01000001\)/);
    assert.match(r.stdout, /data as of period ending 2025-12-31/);
    assert.deepEqual(fingerprint(dataDir), before);
  });
});