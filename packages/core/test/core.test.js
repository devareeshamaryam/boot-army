/**
 * @botarmy/core tests.   Run: npm test -w packages/core
 */
import { test, describe, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import * as core from '../index.js';

const { config, logger, http: chttp, db, snapshot, spine, match, slack, health } = core;

const CORE_MIGRATION = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));

/* Every connection a test opens is tracked and closed before temp folders are
 * removed: on Windows an open better-sqlite3 handle locks its file (EPERM). */
const dirs = [];
const handles = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'core-test-'));
  dirs.push(d);
  return d;
};
/** Register anything with close() (store, spine, raw connection) and return it. */
const track = (handle) => {
  handles.push(handle);
  return handle;
};
const closeQuietly = (h) => {
  try {
    h.close();
  } catch {
    // already closed
  }
};
after(() => {
  handles.splice(0).forEach(closeQuietly);
  slack.closeApprovals();
  snapshot.close();
  spine.close();
  // maxRetries covers Windows antivirus/indexer briefly holding a just-closed file.
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
});

/** Set env vars for the duration of fn (undefined deletes), then restore. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (obj) => Object.entries(obj).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

/* ============================================================ exports */

test('legacy flat exports still work', () => {
  for (const name of ['sendSlackAlert', 'askClaude', 'pingHealthcheck', 'buildHealthcheckUrl', 'withRetry', 'normalizeEntityId']) {
    assert.equal(typeof core[name], 'function', `${name} exported`);
  }
  assert.equal(core.normalizeEntityId('445790', 'UK'), 'UK:00445790');
  assert.equal(core.buildHealthcheckUrl('https://hc-ping.com/', 'abc', 'fail'), 'https://hc-ping.com/abc/fail');
});

/* ============================================================= config */

describe('config', () => {
  test('schema: types, defaults, every problem reported at once, secrets not echoed', async () => {
    await withEnv({ T_NUM: '12', T_BOOL: 'yes', T_LIST: 'a, b,,c', T_BAD_NUM: 'x', T_SECRET: undefined, T_ENUM: 'weekly', T_URL: 'nope' }, () => {
      const ok = config.load({
        T_NUM: { type: 'number', min: 1 },
        T_BOOL: { type: 'boolean' },
        T_LIST: { type: 'list' },
        T_DEFAULT: { type: 'number', default: 7 },
        T_ENUM: { type: 'enum', values: ['daily', 'weekly'] },
      });
      assert.deepEqual({ ...ok }, { T_NUM: 12, T_BOOL: true, T_LIST: ['a', 'b', 'c'], T_DEFAULT: 7, T_ENUM: 'weekly' });
      assert.ok(Object.isFrozen(ok));
      assert.throws(() => config.load({
        T_BAD_NUM: { type: 'number' },
        T_SECRET: { required: true, secret: true },
        T_URL: { type: 'url', secret: true },
      }), (err) => {
        assert.ok(err instanceof core.ConfigError);
        assert.equal(err.problems.length, 3);
        assert.match(err.message, /T_BAD_NUM must be a number \(got "x"\)/);
        assert.match(err.message, /T_SECRET is required/);
        assert.doesNotMatch(err.message, /nope/, 'secret values are never printed');
        return true;
      });
    });
  });

  test('dataDir honours BOTARMY_DATA_DIR', async () => {
    const d = tmp();
    await withEnv({ BOTARMY_DATA_DIR: d }, () => assert.equal(config.dataDir(), d));
  });
});

/* ============================================================= logger */

test('logger: JSON lines by default, child fields, levels, errors serialised', async () => {
  const lines = [];
  const stream = { write: (s) => lines.push(s) };
  await withEnv({ LOG_FORMAT: undefined, LOG_LEVEL: undefined }, () => {
    const log = logger.forBot('test-bot', { stream });
    log.debug('hidden');
    log.child({ stage: 'harvest' }).info('fetched', { rows: 3 });
    log.error('boom', { err: new Error('bad') });
  });
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.bot, 'test-bot');
  assert.equal(first.stage, 'harvest');
  assert.equal(first.rows, 3);
  assert.equal(JSON.parse(lines[1]).err.message, 'bad');
  const text = [];
  logger.forBot('t', { format: 'text', stream: { write: (s) => text.push(s) } }).info('hello', { a: 1 });
  assert.match(text[0], /INFO {2}\[t\] hello a=1/);
});

/* =============================================================== http */

describe('http', () => {
  after(() => chttp.setFetch());

  test('retries 5xx and honours Retry-After on 429', async () => {
    let calls = 0;
    const started = Date.now();
    chttp.setFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 503 });
      if (calls === 2) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await chttp.fetch('https://example.test/x', { retries: 3 });
    assert.equal(calls, 3);
    assert.deepEqual(res.json(), { ok: true });
    assert.ok(Date.now() - started >= 2000, 'waited ~1s backoff + 1s Retry-After');
  });

  test('does not retry 4xx; error message omits query strings', async () => {
    let calls = 0;
    chttp.setFetch(async () => { calls += 1; return new Response('nope', { status: 404, statusText: 'Not Found' }); });
    await assert.rejects(chttp.fetch('https://example.test/p?token=secret'), (err) => {
      assert.equal(err.status, 404);
      assert.doesNotMatch(err.message, /secret/);
      return true;
    });
    assert.equal(calls, 1);
  });

  test('per-host rate limit spaces requests', async () => {
    chttp.setFetch(async () => new Response('ok'));
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => chttp.fetch('https://rate.test/a', { minIntervalMs: 200 })));
    assert.ok(Date.now() - t0 >= 380);
  });

  test('records fixtures and replays them without the network', async () => {
    const dir = tmp();
    chttp.setFetch(async () => new Response('recorded body', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await chttp.fetch('https://rec.test/file?x=1', { recordDir: dir });
    assert.equal(readdirSync(dir).length, 1);
    chttp.setFetch(async () => { throw new Error('network must not be used'); });
    const res = await chttp.fetch('https://rec.test/file?x=1', { replayDir: dir });
    assert.equal(res.text(), 'recorded body');
    await assert.rejects(chttp.fetch('https://rec.test/other', { replayDir: dir }), /No recorded fixture/);
  });

  test('robots.txt: RFC 9309 matching; 5xx means disallowed', async () => {
    chttp.setFetch(async (url) => (String(url).endsWith('/robots.txt')
      ? new Response('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/public$\n')
      : new Response('x')));
    assert.equal(await chttp.allowedByRobots('https://robots.test/open'), true);
    assert.equal(await chttp.allowedByRobots('https://robots.test/private/x'), false);
    assert.equal(await chttp.allowedByRobots('https://robots.test/private/public'), true);
    chttp.setFetch(async () => new Response('', { status: 500 }));
    assert.equal(await chttp.allowedByRobots('https://down.test/x'), false);
  });
});

/* ================================================================= db */

describe('db', () => {
  const migrations = (dir, files) => {
    mkdirSync(dir, { recursive: true });
    for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
    return dir;
  };

  test('live connections use WAL and foreign keys; migrations apply once, in order', () => {
    const d = tmp();
    const m = migrations(path.join(d, 'm'), {
      '001_a.sql': 'CREATE TABLE parent (id INTEGER PRIMARY KEY);',
      '002_b.sql': 'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));',
    });
    const conn = track(db.connect('t', { dataDir: d }));
    assert.equal(conn.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(conn.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(db.migrate(conn, m, { namespace: 't' }), ['001_a.sql', '002_b.sql']);
    assert.deepEqual(db.migrate(conn, m, { namespace: 't' }), []);
    assert.throws(() => conn.prepare('INSERT INTO child (parent_id) VALUES (99)').run(), /FOREIGN KEY/);
    conn.close();
  });

  test('a failing migration rolls back entirely', () => {
    const d = tmp();
    const m = migrations(path.join(d, 'm'), { '001_bad.sql': 'CREATE TABLE ok_table (id INTEGER); CREATE TABLE broken (' });
    const conn = track(db.connect('t', { dataDir: d }));
    assert.throws(() => db.migrate(conn, m), (err) => err instanceof db.MigrationError && /001_bad\.sql/.test(err.message));
    assert.equal(conn.prepare(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'ok_table'`).pluck().get(), 0);
    conn.close();
  });

  test('dry run works on an in-memory copy and leaves no files behind', () => {
    const d = tmp();
    const live = track(db.connect('copy', { dataDir: d }));
    live.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')`);
    live.close();
    const before = readdirSync(d).sort();
    const bytes = readFileSync(path.join(d, 'copy.sqlite'));
    const dry = track(db.connect('copy', { dryRun: true, dataDir: d }));
    assert.equal(dry.prepare('SELECT v FROM t').pluck().get(), 'kept');
    dry.exec(`INSERT INTO t VALUES ('dry')`);
    assert.equal(dry.pragma('foreign_keys', { simple: true }), 1);
    dry.close();
    assert.deepEqual(readdirSync(d).sort(), before, 'no -wal/-shm created');
    assert.ok(readFileSync(path.join(d, 'copy.sqlite')).equals(bytes), 'file unchanged');
    track(db.connect('nope', { dryRun: true, dataDir: d })).close();
    assert.equal(existsSync(path.join(d, 'nope.sqlite')), false);
  });

  test('migration files saved with a UTF-8 BOM (Windows Notepad) still apply', () => {
    const d = tmp();
    const m = migrations(path.join(d, 'm'), { '001_bom.sql': '\uFEFFCREATE TABLE bom_ok (id INTEGER);' });
    const conn = track(db.connect('t', { dataDir: d }));
    assert.deepEqual(db.migrate(conn, m), ['001_bom.sql']);
    assert.equal(conn.prepare(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'bom_ok'`).pluck().get(), 1);
  });
});

describe('openCore schema checks', () => {
  const mkMigrations = (files = {}, dirsInside = []) => {
    const dir = path.join(tmp(), 'migrations');
    mkdirSync(dir, { recursive: true });
    dirsInside.forEach((sub) => mkdirSync(path.join(dir, sub)));
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    return dir;
  };

  test('creates every core table on a fresh data dir', () => {
    const conn = track(db.openCore({ dataDir: tmp() }));
    const tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all();
    for (const t of db.CORE_TABLES) assert.ok(tables.includes(t), `${t} created`);
  });

  test('missing 001_init.sql (core 0.2 subfolder layout) fails with a clear message and leaves no open handle', () => {
    const dataDir = tmp();
    const dir = mkMigrations({}, ['spine', 'snapshots']);
    assert.throws(() => db.openCore({ dataDir, migrations: dir }), (err) => {
      assert.ok(err instanceof db.MigrationError);
      assert.match(err.message, /001_init\.sql not found/);
      assert.match(err.message, /found: (snapshots, spine|spine, snapshots)/);
      return true;
    });
    // If openCore had leaked its connection, Windows would refuse this delete (EPERM).
    rmSync(path.join(dataDir, 'spine.sqlite'), { force: true, maxRetries: 3, retryDelay: 50 });
    assert.throws(() => snapshot.openStore({ dataDir, migrations: dir }), /001_init\.sql not found/);
    assert.throws(() => spine.openSpine({ dataDir, migrations: dir }), /001_init\.sql not found/);
  });

  test('the real core migration with a BOM still builds the full schema', () => {
    const dir = mkMigrations({ '001_init.sql': `\uFEFF${readFileSync(CORE_MIGRATION, 'utf8')}` });
    const store = track(snapshot.openStore({ dataDir: tmp(), migrations: dir }));
    assert.equal(store.writeRaw('src', 'a.txt', 'x').isNew, true);
  });

  test('a recorded migration with missing tables is re-applied (self-heal)', () => {
    const dataDir = tmp();
    const stale = track(db.connect('spine', { dataDir }));
    stale.exec(`CREATE TABLE schema_migrations (namespace TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (namespace, version));
      INSERT INTO schema_migrations VALUES ('core', 1, '001_init.sql', '2026-09-30');`);
    stale.close();
    const conn = track(db.openCore({ dataDir }));
    assert.equal(conn.prepare(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'snapshots'`).pluck().get(), 1);
  });

  test('a migration that does not create the core tables is reported, not silently accepted', () => {
    const dir = mkMigrations({ '001_init.sql': 'CREATE TABLE IF NOT EXISTS something_else (id INTEGER);' });
    assert.throws(() => db.openCore({ dataDir: tmp(), migrations: dir }), /missing table\(s\) snapshots, entities/);
  });
});

/* =========================================================== snapshot */

describe('snapshot', () => {
  test('writeRaw stores gzipped, dedupes by sha256, readRaw verifies; iterRaw streams oldest first', () => {
    const d = tmp();
    const store = track(snapshot.openStore({ dataDir: d }));
    const a = store.writeRaw('src', 'a.csv', Buffer.from('one'), { url: 'https://x/a.csv', contentType: 'text/csv', note: 'kept' });
    const again = store.writeRaw('src', 'a-renamed.csv', 'one');
    const b = store.writeRaw('src', 'b.json', { two: 2 });
    assert.equal(a.isNew, true);
    assert.equal(again.isNew, false);
    assert.equal(again.id, a.id);
    assert.equal(store.readRaw(a.id).toString(), 'one');
    assert.equal(store.get(a.id).meta.note, 'kept');
    assert.match(store.get(a.id).path, /raw[/\\]src[/\\]\d{4}-\d{2}[/\\][0-9a-f]{64}\.csv\.gz$/);
    assert.deepEqual([...store.iterRaw('src')].map((x) => x.payload.toString()), ['one', '{"two":2}']);
    assert.equal(store.latest('src').id, b.id);

    writeFileSync(path.join(d, store.get(a.id).path), gzipSync(Buffer.from('tampered')));
    assert.throws(() => store.readRaw(a.id), /checksum mismatch/);
    store.close();
  });

  test('dry run keeps bodies in memory and writes nothing', () => {
    const d = tmp();
    const store = track(snapshot.openStore({ dataDir: d, dryRun: true }));
    const s = store.writeRaw('src', 'x.txt', 'in memory');
    assert.equal(store.readRaw(s.id).toString(), 'in memory');
    store.close();
    assert.deepEqual(readdirSync(d), []);
  });

  test('imports a core 0.2 snapshots.sqlite once, preserving ids', () => {
    const d = tmp();
    const legacy = track(new Database(path.join(d, 'snapshots.sqlite')));
    legacy.exec(`CREATE TABLE snapshots (id INTEGER PRIMARY KEY, source TEXT, ref TEXT, url TEXT, sha256 TEXT, bytes INTEGER,
      content_type TEXT, fetched_at TEXT, path TEXT, meta TEXT, UNIQUE (source, sha256));
      INSERT INTO snapshots VALUES (41, 'src', 'old.csv', NULL, 'abc', 3, 'text/csv', '2026-09-01T00:00:00Z', 'raw/src/2026-09/abc.csv.gz', '{}');`);
    legacy.close();
    const store = track(snapshot.openStore({ dataDir: d }));
    assert.equal(store.get(41).ref, 'old.csv');
    assert.ok(store.writeRaw('src', 'new.csv', 'new').id > 41, 'new ids continue after imported ones');
    store.close();
    assert.ok(existsSync(path.join(d, 'snapshots.sqlite.imported')));
  });
});

/* ============================================================== spine */

describe('spine', () => {
  test('registry id wins; unresolved entities keyed by name + locality; aliases recorded', () => {
    const s = track(spine.openSpine({ dataDir: tmp() }));
    const a = s.upsertEntity({ jurisdiction: 'UK', registryId: '01026167', spineId: 'UK:01026167', name: 'Barclays Bank Plc' });
    const b = s.upsertEntity({ jurisdiction: 'UK', registryId: '01026167', name: 'BARCLAYS BANK PUBLIC LIMITED COMPANY' });
    assert.equal(a, b);
    assert.equal(s.db.prepare('SELECT COUNT(*) FROM entity_aliases WHERE entity_id = ?').pluck().get(a), 1, 'plc spellings normalise to one alias');
    const u1 = s.upsertEntity({ jurisdiction: 'UK', name: 'Acme Care Ltd', locality: 'Bristol' });
    const u2 = s.upsertEntity({ jurisdiction: 'UK', name: 'ACME CARE LIMITED', locality: 'bristol' });
    const u3 = s.upsertEntity({ jurisdiction: 'UK', name: 'Acme Care Ltd', locality: 'Leeds' });
    assert.equal(u1, u2, 'Ltd/Limited and case unify');
    assert.notEqual(u1, u3, 'different town = different unresolved entity');
    assert.equal(s.findEntity({ jurisdiction: 'UK', name: 'acme care ltd', locality: 'Bristol' }).entity_id, u1);
    s.close();
  });

  test('linkEvent is idempotent; queueReview round-trips; candidates never auto-merge', () => {
    const s = track(spine.openSpine({ dataDir: tmp() }));
    const id = s.upsertEntity({ jurisdiction: 'UK', name: 'Brightside Nursing Agency Ltd', locality: 'Leeds' });
    const e1 = s.linkEvent({ entityId: id, type: 'SPONSOR_ADDED', date: '2026-09-30', source: 'b1', payload: { a: 1 } });
    const e2 = s.linkEvent({ entityId: id, type: 'SPONSOR_ADDED', date: '2026-09-30', source: 'b1', payload: { a: 2 } });
    assert.equal(e1.isNew, true);
    assert.equal(e2.isNew, false);
    assert.equal(e2.eventId, e1.eventId);
    assert.equal(s.events({ type: 'SPONSOR_ADDED' }).length, 1);

    const cands = s.findCandidates({ jurisdiction: 'UK', name: 'Brightside Nursing Agency Services Ltd', threshold: 85 });
    assert.equal(cands[0].entity.entity_id, id);
    assert.equal(s.db.prepare('SELECT COUNT(*) FROM entities').pluck().get(), 1, 'lookup alone creates nothing');

    const item = s.queueReview({ kind: 'possible_duplicate', payload: { a: id } });
    assert.equal(s.pendingReviews()[0].item_id, item);
    assert.equal(s.resolveReview(item, { resolution: { merged: false } }), true);
    assert.equal(s.pendingReviews().length, 0);
    s.close();
  });

  test('snapshot store and spine share data/spine.sqlite (one migration)', () => {
    const d = tmp();
    track(snapshot.openStore({ dataDir: d })).close();
    track(spine.openSpine({ dataDir: d })).close();
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith('.sqlite')), ['spine.sqlite']);
  });
});

/* ============================================================== match */

test('match: normalisation, company similarity, guards against legal-word inflation, persons', () => {
  assert.equal(match.nameNorm('  The ACME & Sons Limited. '), 'the acme and sons ltd');
  assert.equal(match.companyCore('The Acme Group Holdings Ltd'), 'acme');
  assert.equal(match.companySimilarity('Acme Ltd', 'ACME LIMITED'), 100);
  assert.ok(match.companySimilarity('Care Ltd', 'Abc Care Ltd') < 90, 'shared legal words do not inflate');
  assert.ok(match.companySimilarity('Brightside Nursing Agency', 'Brightside Nursing Agency Services') >= 90);
  assert.equal(match.fuzzyCompany('Acme Care', ['Zeta Ltd', { name: 'Acme Care Ltd' }]).candidate.name, 'Acme Care Ltd');
  assert.equal(match.fuzzyCompany('Acme Care', ['Zeta Ltd']), null);
  assert.ok(match.fuzzyPerson({ name: 'Mr John A Smith', dobPartial: '1975-03' }, { name: 'Smith John', dobPartial: '1975-03' }).score >= 90);
  assert.equal(match.fuzzyPerson({ name: 'John Smith', dobPartial: '1975-03' }, { name: 'John Smith', dobPartial: '1980-01' }).score, 0);
  assert.equal(match.extract('acme care', ['Acme Care Ltd', 'Acme Cars', 'Zeta'], { limit: 1 })[0].choice, 'Acme Care Ltd');
});

/* ============================================ health + slack (local server) */

describe('health and slack against a local server', () => {
  const received = [];
  let base;
  let server;

  test('start server', async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { received.push({ url: req.url, body }); res.end(req.url.startsWith('/hc') ? 'OK' : 'ok'); });
    });
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  test('health.run pings start + success; failure pings /fail, sets exit code, calls onFailure; dry run never pings', async () => {
    const quiet = { info() {}, warn() {}, error() {} };
    await withEnv({ HEALTHCHECKS_BASE_URL: `${base}/hc`, HC_UUID_DEMO_BOT: 'uuid-1' }, async () => {
      assert.equal(await health.run('demo-bot', async () => 42, { log: quiet }), 42);
      let handled = null;
      const savedExit = process.exitCode;
      await health.run('demo-bot', async () => { throw new Error('kaput'); }, { log: quiet, onFailure: (e) => (handled = e.message) });
      assert.equal(process.exitCode, 1);
      process.exitCode = savedExit;
      assert.equal(handled, 'kaput');
      await health.run('demo-bot', async () => 1, { log: quiet, dryRun: true });
    });
    assert.deepEqual(received.filter((r) => r.url.startsWith('/hc')).map((r) => r.url),
      ['/hc/uuid-1/start', '/hc/uuid-1', '/hc/uuid-1/start', '/hc/uuid-1/fail']);
  });

  test('slack.post resolves per-channel webhooks and sends Block Kit', async () => {
    await withEnv({ SLACK_WEBHOOK_URL: `${base}/default`, SLACK_WEBHOOK_URL_SPONSORS: `${base}/sponsors` }, async () => {
      await slack.post('sponsors', { text: 't', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }] });
      await slack.post('other', 'plain');
    });
    const posts = received.filter((r) => !r.url.startsWith('/hc'));
    assert.equal(posts[0].url, '/sponsors');
    assert.equal(JSON.parse(posts[0].body).blocks[0].text.text, 'hi');
    assert.equal(posts[1].url, '/default');
    await withEnv({ SLACK_WEBHOOK_URL: undefined, SLACK_WEBHOOK_URL_X: undefined }, () => {
      assert.throws(() => slack.resolveWebhook('x'), /SLACK_WEBHOOK_URL_X or SLACK_WEBHOOK_URL/);
    });
  });

  test('approval gate: request → signed click → assertApproved; forgeries, outsiders and double clicks rejected', async () => {
    const dataDir = tmp();
    const secret = 'shh';
    await withEnv({ SLACK_WEBHOOK_URL: `${base}/approvals`, SLACK_SIGNING_SECRET: secret, SLACK_APPROVER_IDS: 'U1' }, async () => {
      slack.closeApprovals();
      const req = { bot: 'outreach', kind: 'email', ref: 'draft-7', title: 'Email to Acme', body: 'Hello…' };
      const { token, isNew } = await slack.requestApproval('approvals', req, { dataDir });
      assert.equal(isNew, true);
      assert.equal((await slack.requestApproval('approvals', req, { dataDir })).token, token, 'idempotent per ref');
      const posted = JSON.parse(received.filter((r) => r.url === '/approvals')[0].body);
      assert.equal(posted.blocks.at(-1).elements[0].value, token);
      assert.throws(() => slack.assertApproved(token, { dataDir }), /Not approved \(status: pending\)/);

      const click = (user, action = slack.ACTION_APPROVE, signingSecret = secret) => {
        const rawBody = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: user }, actions: [{ action_id: action, value: token }] }))}`;
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = `v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
        return slack.handleInteraction(rawBody, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, { dataDir });
      };
      assert.equal((await click('U1', slack.ACTION_APPROVE, 'wrong')).status, 401);
      assert.equal((await click('U2')).outcome, 'forbidden');
      assert.equal((await click('U1')).outcome, 'approved');
      assert.equal((await click('U1', slack.ACTION_REJECT)).outcome, 'already_approved', 'a decision cannot be flipped');
      assert.equal(slack.assertApproved(token, { dataDir }).decided_by, 'U1');
    });
  });

  test('stop server', () => server.close());
});