/**
 * Tests for the shared helpers in src/core.   Run: npm test
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as core from '../src/core/index.js';

const { logger, http: chttp, match, slack, health } = core;

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'core-test-'));
  dirs.push(d);
  return d;
};
after(() => {
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

test('flat exports still work', () => {
  for (const name of ['sendSlackAlert', 'pingHealthcheck', 'buildHealthcheckUrl', 'withRetry']) {
    assert.equal(typeof core[name], 'function', `${name} exported`);
  }
  assert.equal(core.buildHealthcheckUrl('https://hc-ping.com/', 'abc', 'fail'), 'https://hc-ping.com/abc/fail');
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

  test('stop server', () => server.close());
});