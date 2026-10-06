/** Digest: formatting, no repost, dry run sends nothing. No real Slack: fetch is mocked. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { http } from '@botarmy/core';
import { buildDigest, deliverDigest } from '../digest.js';
import { digestCandidates, openDb, saveScore, upsertNotice } from '../db.js';
import { validateProfiles } from '../profiles.js';
import { score } from '../score.js';
import { response } from './helpers.js';

const NOW = '2026-10-06T06:00:00.000Z';
const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const ENV = { SLACK_WEBHOOK_URL_TENDERS_ATECA: HOOK };
const [PROFILE] = validateProfiles({ profiles: [{
  entity: 'ateca', name: 'Ateca', slackWebhookEnv: 'SLACK_WEBHOOK_URL_TENDERS_ATECA', maxDigestSize: 2,
  keywords: { include: ['recruitment'] }, cpvPrefixes: ['796'], value: { min: 10_000, max: 1_000_000 },
}] });

afterEach(() => http.setFetch());

/** Synthetic notices in the normalised shape. */
const notice = (i, over = {}) => ({
  ocid: `ocds-test-${i}`, source: 'contracts-finder', release_id: `r-${i}`, release_date: '2026-10-05T10:00:00.000Z', release_seq: i, tag: 'tender',
  title: `Recruitment services lot ${i}`, description: 'Temporary recruitment.', buyer_id: 'B1', buyer_name: 'Test Council', buyer_key: 'test council',
  value_amount: 100_000 * i, value_currency: 'GBP', value_placeholder: false, deadline: '2026-10-30T12:00:00.000Z',
  published_at: '2026-10-05T10:00:00.000Z', cpv_codes: ['79620000'], regions: [], procurement_method: null, link: `https://example.test/${i}`, ...over,
});

function seededDb(notices) {
  const db = openDb({ dryRun: true, dataDir: mkdtempSync(path.join(tmpdir(), 'tender-scout-')) });
  for (const n of notices) {
    upsertNotice(db, n, NOW);
    saveScore(db, n.ocid, PROFILE.entity, score(n, PROFILE, { now: NOW }), NOW);
  }
  return db;
}

function slackMock() {
  const calls = [];
  http.setFetch(async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return response('ok', { headers: { 'content-type': 'text/plain' } }); });
  return calls;
}

test('formatting: header, ranked items with link, value/deadline, reasons and gaps', () => {
  const db = seededDb([notice(1), notice(2, { value_amount: null, title: 'Recruitment <urgent> & more' })]);
  const items = digestCandidates(db, 'ateca', NOW, 10);
  const payload = buildDigest(PROFILE, items, { now: NOW });
  assert.equal(payload.blocks[0].type, 'header');
  assert.equal(payload.blocks[0].text.text, 'TenderScout · Ateca · 6 Oct 2026');
  assert.equal(payload.blocks.length, 2 + 2 * items.length);
  assert.match(payload.text, /2 new tenders for Ateca \(top score \d+\)/);

  const first = payload.blocks[2].text.text;
  assert.match(first, /^\*1\. <https:\/\/example\.test\/\d\|/);
  assert.match(first, /\*Deadline:\* 30 Oct 2026 \(24 days\)/);
  assert.match(first, /\n• /);

  const noValue = payload.blocks.find((b) => b.text?.text?.includes('&lt;urgent&gt; &amp; more')).text.text;
  assert.match(noValue, /\*Value:\* _not published_/);
  assert.match(noValue, /_Gaps: value not published/);
  assert.equal(buildDigest(PROFILE, [], { now: NOW }), null);
  db.close();
});

test('ranking and maxDigestSize: best score first, at most N items', () => {
  const db = seededDb([notice(1, { value_amount: 5_000 }), notice(2), notice(3, { deadline: '2026-10-08T00:00:00.000Z' })]);
  const items = digestCandidates(db, 'ateca', NOW, PROFILE.maxDigestSize);
  assert.equal(items.length, 2);
  assert.ok(items[0].score.score >= items[1].score.score);
  assert.equal(items[0].ocid, 'ocds-test-2');
  db.close();
});

test('no repost: a sent notice is never posted to the same entity again', async () => {
  const db = seededDb([notice(1), notice(2)]);
  const calls = slackMock();
  const first = await deliverDigest(db, PROFILE, { runId: null, now: NOW, send: true, env: ENV, print: () => {} });
  assert.equal(first.posted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK);

  const second = await deliverDigest(db, PROFILE, { runId: null, now: NOW, send: true, env: ENV, print: () => {} });
  assert.equal(second.posted, false);
  assert.equal(second.note, 'nothing new');
  assert.equal(calls.length, 1);

  upsertNotice(db, notice(3), NOW); // a new tender arrives: only it is posted
  saveScore(db, 'ocds-test-3', 'ateca', score(notice(3), PROFILE, { now: NOW }), NOW);
  await deliverDigest(db, PROFILE, { runId: null, now: NOW, send: true, env: ENV, print: () => {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.blocks.length, 4);
  db.close();
});

test('dry run sends nothing, records nothing, and prints the exact payload', async () => {
  const db = seededDb([notice(1)]);
  const calls = slackMock();
  const printed = [];
  const r = await deliverDigest(db, PROFILE, { runId: null, now: NOW, send: false, env: ENV, print: (s) => printed.push(s) });
  assert.equal(r.posted, false);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM digests_sent`).pluck().get(), 0);
  const json = printed[0].slice(printed[0].indexOf('{'));
  assert.deepEqual(JSON.parse(json), buildDigest(PROFILE, digestCandidates(db, 'ateca', NOW, 2), { now: NOW }));
  db.close();
});

test('--send without the webhook env var, or with a PLACEHOLDER profile, does not post', async () => {
  const db = seededDb([notice(1)]);
  const calls = slackMock();
  const noHook = await deliverDigest(db, PROFILE, { runId: null, now: NOW, send: true, env: {}, print: () => {} });
  assert.equal(noHook.note, 'SLACK_WEBHOOK_URL_TENDERS_ATECA is not set');
  const placeholder = await deliverDigest(db, { ...PROFILE, name: 'PLACEHOLDER' }, { runId: null, now: NOW, send: true, env: ENV, print: () => {} });
  assert.match(placeholder.note, /PLACEHOLDER/);
  assert.equal(calls.length, 0);
  db.close();
});

test('a Slack failure throws and nothing is marked as sent', async () => {
  const db = seededDb([notice(1)]);
  http.setFetch(async () => response('invalid_payload', { status: 400 }));
  await assert.rejects(deliverDigest(db, PROFILE, { runId: null, now: NOW, send: true, env: ENV, print: () => {} }), /400/);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM digests_sent`).pluck().get(), 0);
  db.close();
});
