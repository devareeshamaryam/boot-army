/**
 * CLI flags and a full run (harvest -> score -> digest) over the real fixtures,
 * with Contracts Finder and Slack both mocked.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { http } from '@botarmy/core';
import { parseCli, runOnce } from '../index.js';
import { openDb } from '../db.js';
import { validateProfiles } from '../profiles.js';
import { awardPackage, response, tenderPackage } from './helpers.js';

const NOW = '2026-10-02T06:00:00.000Z'; // the fixture tenders are still open at this time
const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const PROFILES = validateProfiles({ profiles: [{
  entity: 'transport', name: 'Transport test', slackWebhookEnv: 'SLACK_WEBHOOK_URL_TENDERS_TEST', maxDigestSize: 5,
  keywords: { include: ['taxi', 'passenger'] }, cpvPrefixes: ['60'],
}] });
const NO_DELAY = { minIntervalMs: 0 };
const count = (db, table) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

afterEach(() => http.setFetch());

function mockWorld() {
  const slack = [];
  http.setFetch(async (url, init) => {
    if (url.startsWith(HOOK)) { slack.push(JSON.parse(init.body)); return response('ok'); }
    const stage = new URL(url).searchParams.get('stages');
    return response(stage === 'award' ? awardPackage() : tenderPackage());
  });
  return slack;
}

test('parseCli: dry run is the default; --send is live; --dry-run wins', () => {
  assert.deepEqual(parseCli([]), { since: undefined, sources: ['contracts-finder', 'find-a-tender'], stages: ['tender', 'award'], send: false, dryRun: true, cache: false, offline: false });
  assert.deepEqual(parseCli(['--sources', 'find-a-tender']).sources, ['find-a-tender']);
  assert.throws(() => parseCli(['--sources', 'ted']), /--sources must be/);
  assert.equal(parseCli(['--cache', '--offline']).offline, true);
  assert.throws(() => parseCli(['--send', '--cache']), /for dry runs/);
  assert.equal(parseCli(['--send']).send, true);
  assert.equal(parseCli(['--send', '--dry-run']).send, false);
  assert.deepEqual(parseCli(['--stages', 'award', '--since', '2026-09-01']).stages, ['award']);
  assert.throws(() => parseCli(['--since', '01/09/2026']), /YYYY-MM-DD/);
  assert.throws(() => parseCli(['--stages', 'planning']), /--stages must be/);
  assert.throws(() => parseCli(['--bogus']));
});

test('full dry run: harvests, scores with buyer history, prints the digest, posts nothing', async () => {
  const db = openDb({ dryRun: true, dataDir: mkdtempSync(path.join(tmpdir(), 'tender-scout-')) });
  const slack = mockWorld();
  const printed = [];
  const r = await runOnce({ db, profiles: PROFILES, sources: ['contracts-finder'], stages: ['tender', 'award'], now: NOW, env: { SLACK_WEBHOOK_URL_TENDERS_TEST: HOOK }, print: (s) => printed.push(s), httpOptions: NO_DELAY });

  assert.equal(slack.length, 0);
  assert.equal(r.digests[0].posted, false);
  assert.ok(r.digests[0].count > 0);
  assert.match(printed[0], /NOT SENT \(dry run/);
  assert.match(printed[0], /East Sussex County Council/);
  assert.equal(count(db, 'digests_sent'), 0);
  assert.equal(db.prepare(`SELECT status FROM runs WHERE id = ?`).pluck().get(r.runId), 'ok');

  // East Sussex has real taxi awards (CPV 60...) in the award fixture, so the buyer is known.
  const breakdown = JSON.parse(db.prepare(`SELECT breakdown FROM scores s JOIN notices n USING (ocid) WHERE n.buyer_name = 'East Sussex County Council' LIMIT 1`).pluck().get());
  assert.match(breakdown.find((b) => b.component === 'buyer').reason, /awarded \d+ contracts? in your categories/);
  db.close();
});

test('dry-run cache: data survives between runs in its own file; --offline makes no API calls', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tender-scout-'));
  const calls = [];
  mockWorld();
  const base = { profiles: PROFILES, sources: ['contracts-finder'], stages: ['tender', 'award'], now: NOW, print: () => {}, httpOptions: NO_DELAY };

  let db = openDb({ dryRun: true, cache: true, dataDir });
  assert.match(db.botarmy.path, /tender-scout-v2-dryrun\.sqlite$/);
  await runOnce({ ...base, db });
  const notices = count(db, 'notices');
  db.close();

  http.setFetch(async (url) => { calls.push(url); throw new Error('network must not be used'); });
  db = openDb({ dryRun: true, cache: true, dataDir });
  assert.equal(count(db, 'notices'), notices); // still there
  const printed = [];
  const r = await runOnce({ ...base, db, offline: true, print: (s) => printed.push(s) });
  assert.equal(calls.length, 0);
  assert.equal(r.harvest, 'skipped (--offline)');
  assert.match(printed[0], /NOT SENT \(dry run/);
  db.close();
});

test('two live runs: same row counts, and the second posts nothing already sent', async () => {
  const db = openDb({ dryRun: true, dataDir: mkdtempSync(path.join(tmpdir(), 'tender-scout-')) });
  const slack = mockWorld();
  const opts = { db, profiles: PROFILES, sources: ['contracts-finder'], stages: ['tender', 'award'], send: true, env: { SLACK_WEBHOOK_URL_TENDERS_TEST: HOOK }, print: () => {}, httpOptions: NO_DELAY };

  await runOnce({ ...opts, now: NOW });
  const after1 = ['releases', 'notices', 'awards', 'digests_sent'].map((t) => count(db, t));
  assert.equal(slack.length, 1);
  assert.equal(after1[3], 5); // maxDigestSize

  await runOnce({ ...opts, now: '2026-10-02T07:00:00.000Z' });
  assert.deepEqual(['releases', 'notices', 'awards'].map((t) => count(db, t)), after1.slice(0, 3));
  assert.equal(slack.length, 2);
  // digests_sent is keyed (entity, ocid) and inserted with OR IGNORE: if run 2 had reposted
  // anything from run 1, this total would fall short of 5 + run 2's item count.
  assert.equal(count(db, 'digests_sent'), after1[3] + slack[1].blocks.filter((b) => b.type === 'section').length);
  assert.equal(count(db, 'runs'), 2);
  db.close();
});
