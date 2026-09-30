/**
 * B1 Sponsor Licence Scout tests.   Run: npm test -w bots/sponsor-licence-scout
 *
 * Fixtures are built here in the exact formats GOV.UK serves (register CSV
 * columns, Content API attachment shape, publication-page markup, modern
 * filename). Replace them with recorded payloads by running the bot once with
 * BOTARMY_HTTP_RECORD=bots/sponsor-licence-scout/test/fixtures/http.
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
import {
  CONTENT_API, PUBLICATION_PAGE, INDEX_SOURCE, SOURCE,
  candidatesFromHtml, discoverRegisterCsv, harvest, rankCandidates, scoreCandidate, toAssetUrl,
} from '../harvest.js';
import {
  AnomalyError, BOT, EVENT_TYPES, anomalyReason, buildWatchMatcher, computeDelta, markNotified,
  parseRegister, parseTypeAndRating, pendingDiffs, processSnapshot, renameSimilarity,
} from '../process.js';
import { buildAnomalyAlert, buildDigest, diffLine } from '../digest.js';

const BOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/* ============================================================== fixtures */

const HEADER = 'Organisation Name,Town/City,County,Type & Rating,Route';
const ASSET_ID = '6abb7089fe72ed1e2b02f19e';
const assetUrl = (date) => `https://assets.publishing.service.gov.uk/media/${ASSET_ID}/SP_-_Worker_and_Temporary_Worker_Web_Register_-_${date}.csv`;

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Register CSV: BOM, CRLF, stray whitespace, one row per organisation per route — as GOV.UK publishes it. */
const registerCsv = (rows) => `\uFEFF${[HEADER, ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n')}\r\n`;

/** 100 filler sponsors so the drop guard has a meaningful base. */
const filler = (n = 100) => Array.from({ length: n }, (_, i) => [`Filler Company ${i} Ltd`, 'London', '', 'Worker (A rating)', 'Skilled Worker']);

const DAY1 = [
  ...filler(),
  ['Acme Care Ltd', 'Bristol', 'Avon', 'Worker (A rating)', 'Skilled Worker'],
  ['Acme Care Ltd', 'Bristol', 'Avon', 'Worker (A rating)', 'Health and Care Worker'],
  ['Acme Care Ltd', 'Bristol', 'Avon', 'Temporary Worker (A rating)', 'Seasonal Worker'],
  ['Mover Foods Ltd', 'Hayes', '', 'Worker (A rating)', 'Skilled Worker'],
  ['Gone Soon Ltd', 'Luton', 'Bedfordshire', 'Worker (A rating)', 'Skilled Worker'],
  ['Brightside Nursing Agency Ltd', 'Leeds', 'West Yorkshire', 'Worker (A rating)', 'Skilled Worker'],
  ['Suffix Swap Ltd', 'Derby', '', 'Worker (A rating)', 'Skilled Worker'],
  ['Premium Bank plc', 'London', '', 'Worker (A (Premium))', 'Global Business Mobility: Senior or Specialist Worker'],
];

const DAY2 = [
  ...filler(),
  // downgrade A -> B on the Worker licence; Temporary Worker unchanged
  ['Acme Care Ltd', 'Bristol', 'Avon', 'Worker (B rating)', 'Skilled Worker'],
  ['Acme Care Ltd', 'Bristol', 'Avon', 'Worker (B rating)', 'Health and Care Worker'],
  ['Acme Care Ltd', 'Bristol', 'Avon', 'Temporary Worker (A rating)', 'Seasonal Worker'],
  ['Mover Foods Ltd', 'Slough', 'Berkshire', 'Worker (A rating)', 'Skilled Worker'],        // relocation
  ['Brightside Nursing Agency Services Ltd', 'Leeds', 'West Yorkshire', 'Worker (A rating)', 'Skilled Worker'], // rename
  ['Suffix Swap Limited', 'Derby', '', 'Worker (A rating)', 'Skilled Worker'],               // Ltd -> Limited: same key
  ['Premium Bank plc', 'London', '', 'Worker (A (Premium))', 'Global Business Mobility: Senior or Specialist Worker'],
  ['Example Consulting Limited', 'London', '', 'Worker (A rating)', 'Skilled Worker'],       // new, on watchlist
  ['New Fintech Ltd', 'Manchester', '', 'Worker (A (SME+))', 'Scale-up'],                   // new
  ['Farm Labour Ltd', 'Hereford', '', 'Temporary Worker (A rating)', 'Seasonal Worker'],     // new
  // 'Gone Soon Ltd' removed
];

const WATCHLIST = {
  additionRoutes: ['Skilled Worker', 'Scale-up'],
  companies: [{ name: 'Example Consulting Limited', registrationNumber: '1234567' }],
};

/** Content API response shape (details.attachments). */
const contentApi = (date) => JSON.stringify({
  title: 'Register of licensed sponsors: workers',
  details: {
    attachments: [
      { title: 'Register of Worker and Temporary Worker licensed sponsors', url: assetUrl(date), filename: assetUrl(date).split('/').pop(), content_type: 'text/csv' },
      { title: 'Guidance', url: 'https://assets.publishing.service.gov.uk/media/x1/guidance.pdf', filename: 'guidance.pdf' },
    ],
  },
});

/** Publication page markup, mirroring the live page (thumbnail link, titled link, csv-preview link, student register). */
const publicationHtml = (date) => `<!DOCTYPE html><html><head><title>Register of licensed sponsors: workers - GOV.UK</title></head><body>
  <a class="govuk-link" href="${assetUrl(date)}" aria-hidden="true"><img alt=""></a>
  <h3><a class="govuk-link" href="${assetUrl(date).replace(/&/g, '&amp;')}">Register of Worker and Temporary Worker licensed sponsors</a></h3>
  <a href="https://www.gov.uk/csv-preview/${ASSET_ID}/SP_-_Worker_and_Temporary_Worker_Web_Register_-_${date}.csv">View online</a>
  <a href="https://assets.publishing.service.gov.uk/media/st1/2026-09-29_-_Student_sponsor_register.csv">Students</a>
</body></html>`;

/* ================================================================ helpers */

const tempDirs = [];
function tempDir(prefix = 'sls-test-') {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
after(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Fake fetch serving a route table; records every URL requested. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const r = routes[String(url)];
    if (!r) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const [status, body, type] = typeof r === 'function' ? r() : r;
    return new Response(body, { status, headers: { 'content-type': type } });
  };
  fn.calls = calls;
  return fn;
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function openAll(dataDir) {
  const store = snapshot.openStore({ dataDir });
  const db = coreDb.connect(BOT, { dataDir });
  coreDb.migrate(db, MIGRATIONS, { namespace: BOT });
  const spine = coreSpine.openSpine({ dataDir });
  return { store, db, spine, close: () => { db.close(); spine.close(); store.close(); } };
}

const settings = { minOrgs: 5, maxDropRatio: 0.1 };

function storeCsv(store, rows, date) {
  return store.writeRaw(SOURCE, assetUrl(date).split('/').pop(), Buffer.from(registerCsv(rows)), { url: assetUrl(date), contentType: 'text/csv', publishedDate: date }).id;
}

/* ============================================================== discovery */

describe('discovery', () => {
  after(() => http.setFetch());

  test('finds the modern SP_-_…_Web_Register_-_YYYY-MM-DD.csv via the Content API', async () => {
    http.setFetch(fakeFetch({ [CONTENT_API]: [200, contentApi('2026-09-29'), 'application/json'] }));
    const store = snapshot.openStore({ dataDir: tempDir() });
    const hit = await discoverRegisterCsv({ store, env: {} });
    assert.equal(hit.url, assetUrl('2026-09-29'));
    assert.equal(hit.publishedDate, '2026-09-29');
    assert.equal(hit.via, 'content-api');
    assert.ok(store.latest(INDEX_SOURCE), 'discovery response stored as a raw snapshot');
    store.close();
  });

  test('falls back to the publication page when the Content API fails', async () => {
    http.setFetch(fakeFetch({
      [CONTENT_API]: [403, 'Forbidden', 'text/plain'],
      [PUBLICATION_PAGE]: [200, publicationHtml('2026-09-30'), 'text/html'],
    }));
    const store = snapshot.openStore({ dataDir: tempDir() });
    const hit = await discoverRegisterCsv({ store, env: {} });
    assert.equal(hit.url, assetUrl('2026-09-30'));
    assert.equal(hit.via, 'html');
    store.close();
  });

  test('uses SPONSOR_CSV_URL only when both discovery paths fail', async () => {
    http.setFetch(fakeFetch({ [PUBLICATION_PAGE]: [200, '<html><title>Moved</title></html>', 'text/html'] }));
    const store = snapshot.openStore({ dataDir: tempDir() });
    const hit = await discoverRegisterCsv({ store, env: { SPONSOR_CSV_URL: assetUrl('2026-09-28') } });
    assert.equal(hit.via, 'SPONSOR_CSV_URL');
    assert.equal(hit.publishedDate, '2026-09-28');
    store.close();
  });

  test('failure message lists what each step saw and how to override', async () => {
    http.setFetch(fakeFetch({}));
    const store = snapshot.openStore({ dataDir: tempDir() });
    await assert.rejects(discoverRegisterCsv({ store, env: {} }), (err) => {
      assert.match(err.message, /Content API: .*404/);
      assert.match(err.message, /Publication page: .*404/);
      assert.match(err.message, /SPONSOR_CSV_URL/);
      return true;
    });
    store.close();
  });

  test('link handling: csv-preview mapped to asset, student register excluded, foreign hosts rejected', () => {
    assert.equal(toAssetUrl(`https://www.gov.uk/csv-preview/${ASSET_ID}/File.csv`), `https://assets.publishing.service.gov.uk/media/${ASSET_ID}/File.csv`);
    assert.equal(toAssetUrl('/media/abc/File.csv'), 'https://assets.publishing.service.gov.uk/media/abc/File.csv');
    assert.equal(toAssetUrl('https://evil.example.com/media/abc/File.csv'), null);
    assert.equal(scoreCandidate({ url: 'https://a/Student_sponsor_register.csv' }), 0);
    const ranked = rankCandidates(candidatesFromHtml(publicationHtml('2026-09-30')));
    assert.equal(ranked.length, 1, 'thumbnail, titled and preview links collapse to one asset; student excluded');
    assert.equal(ranked[0].score, 3);
  });
});

/* ================================================================ harvest */

describe('harvest (snapshot-first)', () => {
  after(() => http.setFetch());

  test('stores the raw CSV bytes unchanged and dedupes an identical re-download', async () => {
    const csv = registerCsv(DAY1);
    http.setFetch(fakeFetch({
      [CONTENT_API]: [200, contentApi('2026-09-29'), 'application/json'],
      [assetUrl('2026-09-29')]: [200, csv, 'text/csv'],
    }));
    const store = snapshot.openStore({ dataDir: tempDir() });
    const first = await harvest({ store, env: {} });
    assert.equal(first.snapshot.isNew, true);
    assert.equal(store.readRaw(first.snapshot.id).toString('utf8'), csv, 'byte-identical raw payload');
    assert.equal(store.get(first.snapshot.id).meta.publishedDate, '2026-09-29');
    const second = await harvest({ store, env: {} });
    assert.equal(second.snapshot.isNew, false);
    assert.equal(second.snapshot.id, first.snapshot.id);
    store.close();
  });

  test('stores even a bad payload (an HTML page) so it can be diagnosed; parsing rejects it later', async () => {
    http.setFetch(fakeFetch({
      [CONTENT_API]: [200, contentApi('2026-09-29'), 'application/json'],
      [assetUrl('2026-09-29')]: [200, '<!DOCTYPE html><html>Service unavailable</html>', 'text/html'],
    }));
    const store = snapshot.openStore({ dataDir: tempDir() });
    const { snapshot: s } = await harvest({ store, env: {} });
    assert.match(store.readRaw(s.id).toString(), /Service unavailable/);
    store.close();
  });
});

/* ================================================================ parsing */

describe('parsing', () => {
  test('ratings including nested parentheses', () => {
    assert.deepEqual(parseTypeAndRating(' Worker (A rating) '), { type: 'Worker', rating: 'A' });
    assert.deepEqual(parseTypeAndRating('Worker (A (Premium))'), { type: 'Worker', rating: 'A (Premium)' });
    assert.deepEqual(parseTypeAndRating('Temporary Worker (B rating)'), { type: 'Temporary Worker', rating: 'B' });
  });

  test('merges one row per route into one organisation; handles BOM, CRLF, quotes', () => {
    const { orgs, rowCount } = parseRegister(registerCsv([...DAY1, ['"Smith, Jones" & Partners LLP', ' Leeds ', '', 'Worker (A rating)', 'Skilled Worker']]));
    assert.equal(rowCount, DAY1.length + 1);
    const acme = [...orgs.values()].find((o) => o.name === 'Acme Care Ltd');
    assert.deepEqual(acme.routes, ['Health and Care Worker', 'Seasonal Worker', 'Skilled Worker']);
    assert.deepEqual(acme.ratings, { Worker: 'A', 'Temporary Worker': 'A' });
    assert.ok([...orgs.values()].some((o) => o.name === '"Smith, Jones" & Partners LLP' && o.town === 'Leeds'));
  });

  test('missing columns (format drift) raise AnomalyError listing the columns found', () => {
    assert.throws(() => parseRegister('Name,City\nX,Y\n'), (err) => err instanceof AnomalyError && /Found: Name, City/.test(err.message));
  });
});

/* ================================================================== delta */

describe('delta', () => {
  const orgsOf = (rows) => parseRegister(registerCsv(rows)).orgs;

  test('classifies added, removed, downgraded; suppresses relocation, rename and Ltd/Limited', () => {
    const d = computeDelta(orgsOf(DAY1), orgsOf(DAY2));
    assert.deepEqual(d.added.map((o) => o.name).sort(), ['Example Consulting Limited', 'Farm Labour Ltd', 'New Fintech Ltd']);
    assert.deepEqual(d.removed.map((o) => o.name), ['Gone Soon Ltd']);
    assert.equal(d.ratingChanged.length, 1);
    assert.equal(d.ratingChanged[0].direction, 'downgrade');
    assert.deepEqual(d.suppressed.map((s) => s.kind).sort(), ['RELOCATED', 'RENAMED']);
  });

  test('rename matching is conservative', () => {
    assert.ok(renameSimilarity('Brightside Nursing Agency Ltd', 'Brightside Nursing Agency Services Ltd') >= 90);
    assert.equal(renameSimilarity('Care Ltd', 'Abc Care Ltd'), 0, 'one shared significant token is not enough');
    assert.equal(renameSimilarity('Alpha Beta Ltd', 'Alpha Beta Gamma Delta Ltd'), 0, 'two extra tokens is a different business');
  });

  test('ambiguous pairs are never suppressed', () => {
    const prev = orgsOf([['Dup Ltd', 'A', '', 'Worker (A rating)', 'x'], ['Dup Ltd', 'B', '', 'Worker (A rating)', 'x']]);
    const cur = orgsOf([['Dup Ltd', 'C', '', 'Worker (A rating)', 'x']]);
    const d = computeDelta(prev, cur);
    assert.equal(d.suppressed.length, 0);
    assert.equal(d.removed.length, 2);
    assert.equal(d.added.length, 1);
  });

  test('drop guard thresholds', () => {
    assert.match(anomalyReason({ orgCount: 0, previousOrgCount: 100, minOrgs: 5, maxDropRatio: 0.1 }), /0 sponsors/);
    assert.match(anomalyReason({ orgCount: 89, previousOrgCount: 100, minOrgs: 5, maxDropRatio: 0.1 }), /shrank 11\.0%/);
    assert.equal(anomalyReason({ orgCount: 90, previousOrgCount: 100, minOrgs: 5, maxDropRatio: 0.1 }), null, 'exactly 10% is allowed');
    assert.match(anomalyReason({ orgCount: 3, previousOrgCount: null, minOrgs: 5, maxDropRatio: 0.1 }), /minimum 5/);
  });
});

/* ======================================================= process + spine */

describe('processSnapshot end to end', () => {
  let dataDir;
  let env;
  let day1;
  let day2;
  const watchMatch = buildWatchMatcher(WATCHLIST);

  before(() => {
    dataDir = tempDir();
    env = openAll(dataDir);
    day1 = storeCsv(env.store, DAY1, '2026-09-29');
    day2 = storeCsv(env.store, DAY2, '2026-09-30');
  });
  after(() => env.close());

  test('first snapshot is a baseline: state stored, no diffs, no spine events', () => {
    const r = processSnapshot({ ...env, snapshotId: day1, watchMatch, settings, log: quietLog });
    assert.equal(r.outcome, 'baseline');
    assert.equal(pendingDiffs(env.db).length, 0);
    assert.equal(env.spine.db.prepare('SELECT COUNT(*) FROM events').pluck().get(), 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM sponsors WHERE active = 1').pluck().get(), 106);
  });

  test('second snapshot: diffs recorded and SPONSOR_* events emitted', () => {
    const r = processSnapshot({ ...env, snapshotId: day2, watchMatch, settings, log: quietLog });
    assert.equal(r.outcome, 'diffed');
    assert.deepEqual(
      { added: r.stats.added, removed: r.stats.removed, downgraded: r.stats.downgraded, relocated: r.stats.relocated, renamed: r.stats.renamed },
      { added: 3, removed: 1, downgraded: 1, relocated: 1, renamed: 1 },
    );
    const events = env.spine.db.prepare('SELECT type, event_date, source, payload FROM events ORDER BY type').all();
    assert.deepEqual(events.map((e) => e.type).sort(), [
      EVENT_TYPES.ADDED, EVENT_TYPES.ADDED, EVENT_TYPES.ADDED, EVENT_TYPES.DOWNGRADED, EVENT_TYPES.REMOVED,
    ].sort());
    assert.ok(events.every((e) => e.event_date === '2026-09-30' && e.source === `${BOT}:${SOURCE}`));
    assert.match(JSON.parse(events.find((e) => e.type === EVENT_TYPES.REMOVED).payload).note, /does not publish a reason/);
  });

  test('watchlist company is resolved to its Companies House number on the spine', () => {
    const entity = env.spine.db.prepare(`SELECT * FROM entities WHERE name = 'Example Consulting Limited'`).get();
    assert.equal(entity.registry_id, '01234567');
    assert.equal(entity.spine_id, 'UK:01234567');
    const diff = pendingDiffs(env.db).find((d) => d.name === 'Example Consulting Limited');
    assert.equal(diff.watch_match, 'Example Consulting Limited');
    assert.ok(diff.event_id);
  });

  test('re-running the same snapshot creates no duplicates anywhere', () => {
    const before = [env.db.prepare('SELECT COUNT(*) FROM sponsor_diffs').pluck().get(), env.spine.db.prepare('SELECT COUNT(*) FROM events').pluck().get()];
    const r = processSnapshot({ ...env, snapshotId: day2, watchMatch, settings, log: quietLog });
    assert.equal(r.outcome, 'already-processed');
    const afterCounts = [env.db.prepare('SELECT COUNT(*) FROM sponsor_diffs').pluck().get(), env.spine.db.prepare('SELECT COUNT(*) FROM events').pluck().get()];
    assert.deepEqual(afterCounts, before);
  });

  test('spine events are idempotent even if the same register is stored as a new snapshot', () => {
    const count = () => env.spine.db.prepare('SELECT COUNT(*) FROM events').pluck().get();
    const n = count();
    for (const e of env.spine.db.prepare('SELECT * FROM events').all()) {
      env.spine.linkEvent({ entityId: e.entity_id, type: e.type, date: e.event_date, source: e.source, payload: {} });
    }
    assert.equal(count(), n);
  });

  test('a 0-row register is rejected loudly and leaves state untouched', () => {
    const empty = env.store.writeRaw(SOURCE, 'empty.csv', Buffer.from(`${HEADER}\r\n`), { publishedDate: '2026-10-01' }).id;
    const active = env.db.prepare('SELECT COUNT(*) FROM sponsors WHERE active = 1').pluck().get();
    assert.throws(() => processSnapshot({ ...env, snapshotId: empty, settings, log: quietLog }), (err) => err instanceof AnomalyError && /0 sponsors/.test(err.message));
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM sponsors WHERE active = 1').pluck().get(), active);
    assert.equal(env.db.prepare('SELECT outcome FROM processed_snapshots WHERE snapshot_id = ?').pluck().get(empty), 'rejected');
  });

  test('a > 10% drop is rejected loudly and leaves state untouched', () => {
    const truncated = storeCsv(env.store, DAY2.slice(0, 80), '2026-10-02');
    const diffs = env.db.prepare('SELECT COUNT(*) FROM sponsor_diffs').pluck().get();
    const lastAccepted = env.db.prepare(`SELECT org_count FROM processed_snapshots WHERE outcome = 'diffed' ORDER BY snapshot_id DESC LIMIT 1`).pluck().get();
    assert.throws(() => processSnapshot({ ...env, snapshotId: truncated, settings, log: quietLog }), (err) => {
      assert.ok(err instanceof AnomalyError);
      assert.match(err.message, /shrank/);
      assert.equal(err.details.previousOrgCount, lastAccepted);
      return true;
    });
    assert.equal(env.db.prepare('SELECT COUNT(*) FROM sponsor_diffs').pluck().get(), diffs);
  });

  test('an HTML page stored as the register is rejected, not parsed', () => {
    const html = env.store.writeRaw(SOURCE, 'x.csv', Buffer.from('<!DOCTYPE html><html>maintenance</html>'), {}).id;
    assert.throws(() => processSnapshot({ ...env, snapshotId: html, settings, log: quietLog }), /HTML page/);
  });

  test('the next good snapshot diffs against the last ACCEPTED one, ignoring rejections', () => {
    const day3 = storeCsv(env.store, [...DAY2, ['Late Addition Ltd', 'York', '', 'Worker (A rating)', 'Skilled Worker']], '2026-10-03');
    const r = processSnapshot({ ...env, snapshotId: day3, watchMatch, settings, log: quietLog });
    assert.equal(r.outcome, 'diffed');
    assert.equal(r.stats.added, 1);
    assert.equal(r.stats.removed, 0);
  });

  test('markNotified clears pending diffs', () => {
    markNotified(env.db, pendingDiffs(env.db).map((d) => d.id));
    assert.equal(pendingDiffs(env.db).length, 0);
  });
});

/* ================================================================= digest */

describe('digest', () => {
  const row = (over) => ({ diff_type: 'ADDED', name: 'X Ltd', town: 'London', county: null, old: null, new: JSON.stringify({ ratings: { Worker: 'A' }, routes: ['Skilled Worker'] }), watch_match: null, ...over });
  const meta = { publishedDate: '2026-09-30', orgCount: 127261, relocated: 1, renamed: 1, sourceUrl: assetUrl('2026-09-30') };

  test('counts on top, sections in priority order, removal disclaimer present', () => {
    const d = buildDigest({ meta, diffs: [
      row({ name: 'Watched Ltd', watch_match: 'Watched Ltd' }),
      row({ diff_type: 'RATING_CHANGED', direction: 'downgrade', old: JSON.stringify({ ratings: { Worker: 'A' }, routes: [] }), new: JSON.stringify({ ratings: { Worker: 'B' }, routes: [] }) }),
      row({ diff_type: 'REMOVED', old: row().new, new: null }),
    ] });
    assert.equal(d.blocks[0].type, 'header');
    assert.match(d.blocks[1].elements[0].text, /\*1\* added · \*1\* removed · \*1\* downgraded/);
    assert.match(d.blocks[1].elements[0].text, /127,261 licensed sponsors/);
    const titles = d.blocks.filter((b) => b.type === 'section' && /^\*[^*]+\* \(\d+\)$/.test(b.text.text)).map((b) => b.text.text);
    assert.ok(titles[0].includes('Watchlist') && titles[1].includes('Downgraded') && titles[2].includes('Removed'));
    assert.match(JSON.stringify(d.blocks.at(-1)), /does not say why/);
  });

  test('rows capped at 25 per section; Slack limits respected; mrkdwn escaped', () => {
    const many = Array.from({ length: 300 }, (_, i) => row({ name: `Co <${i}> & Sons` }));
    const d = buildDigest({ meta, diffs: many });
    const text = JSON.stringify(d.blocks);
    assert.match(text, /and 275 more/);
    assert.ok(d.blocks.length <= 50);
    assert.ok(d.blocks.every((b) => !b.text || b.text.text.length <= 3000));
    assert.match(diffLine(row({ name: 'A <b> & C' })), /A &lt;b&gt; &amp; C/);
  });

  test('additions can be filtered to routes of interest', () => {
    const d = buildDigest({ meta, additionRoutes: ['Scale-up'], diffs: [row({ name: 'Farm Ltd', new: JSON.stringify({ ratings: {}, routes: ['Seasonal Worker'] }) })] });
    assert.doesNotMatch(JSON.stringify(d.blocks), /Farm Ltd/);
  });

  test('anomaly alert is explicit about the halt', () => {
    const a = buildAnomalyAlert({ reason: 'register shrank 40.0%', filename: 'f.csv', snapshotId: 9, previousOrgCount: 127000 });
    assert.match(a.blocks[0].text.text, /processing halted, no diffs recorded/);
    assert.match(a.blocks[0].text.text, /127,000 sponsors/);
  });
});

/* ======================================================== entry point */

describe('index.js', () => {
  let dataDir;
  let fixtures;

  const writeFixtures = (date, csv) => {
    rmSync(fixtures, { recursive: true, force: true });
    mkdirSync(fixtures, { recursive: true });
    const put = (url, status, body, type) => writeFileSync(path.join(fixtures, `${http.fixtureKey('GET', url)}.json`), JSON.stringify({
      method: 'GET', url, finalUrl: url, status, headers: { 'content-type': type }, bodyBase64: Buffer.from(body).toString('base64'),
    }));
    put(CONTENT_API, 200, contentApi(date), 'application/json');
    put(assetUrl(date), 200, csv, 'text/csv');
  };

  const run = (...args) => spawnSync(process.execPath, ['index.js', ...args], {
    cwd: BOT_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      BOTARMY_DATA_DIR: dataDir,
      BOTARMY_HTTP_REPLAY: fixtures,
      SLS_MIN_ORGS: '5',
      SLS_WATCHLIST: path.join(dataDir, '..', 'no-watchlist.json'),
      // Blank values stop dotenv loading real ones from the root .env during tests.
      SLACK_WEBHOOK_URL: 'http://127.0.0.1:9/never-called',
      SLACK_WEBHOOK_URL_SPONSORS: '',
      HEALTHCHECKS_BASE_URL: '',
      SLS_HC_UUID: '',
      HC_UUID_SPONSOR_LICENCE_SCOUT: '',
      SPONSOR_CSV_URL: '',
    },
  });

  /** sha256 of every file under a directory, so any write at all is detected. */
  const fingerprint = (dir) => {
    const out = {};
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else out[path.relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    };
    walk(dir);
    return out;
  };

  before(() => {
    const base = tempDir();
    dataDir = path.join(base, 'data');
    fixtures = path.join(base, 'fixtures');
    mkdirSync(dataDir);
  });

  test('--dry-run on an empty data dir writes nothing at all', () => {
    writeFixtures('2026-09-29', registerCsv(DAY1));
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(dataDir), [], 'no files created');
  });

  test('live baseline creates the bot DB, spine and snapshot store', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const files = readdirSync(dataDir);
    for (const f of ['sponsor-licence-scout.sqlite', 'spine.sqlite', 'snapshots.sqlite', 'raw']) assert.ok(files.includes(f), `${f} exists`);
  });

  test('--dry-run with changes prints the digest and leaves every file byte-identical', () => {
    writeFixtures('2026-09-30', registerCsv(DAY2));
    const before = fingerprint(dataDir);
    const r = run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Sponsor register 2026-09-30: 3 added, 1 removed, 1 downgraded/);
    assert.deepEqual(fingerprint(dataDir), before, 'no DB, snapshot or spine writes');
  });

  test('a > 10% drop halts with a non-zero exit and a loud alert', () => {
    writeFixtures('2026-10-01', registerCsv(DAY2.slice(0, 50)));
    const r = run('--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /snapshot rejected/);
    assert.match(r.stdout + r.stderr, /shrank/);
  });
});