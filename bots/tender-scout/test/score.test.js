/** Scoring: each component, exclusions, and honest gaps for missing fields. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, score, topReasons } from '../score.js';
import { validateProfiles } from '../profiles.js';
import { normaliseTender } from '../normalise.js';
import { byOcid, tenderPackage } from './helpers.js';

const NOW = '2026-10-06T06:00:00.000Z';
const [PROFILE] = validateProfiles({ profiles: [{
  entity: 'ateca', name: 'Ateca', slackWebhookEnv: 'SLACK_WEBHOOK_URL_TENDERS_ATECA',
  keywords: { include: ['recruitment', 'temporary staff'], exclude: ['catering'] },
  cpvPrefixes: ['796'], value: { min: 50_000, max: 500_000 }, regions: ['London'], excludedBuyers: ['Banned Council'],
}] });

/** A complete notice (synthetic, in the normalised shape) that should score full marks. */
const notice = (over = {}) => ({
  ocid: 'ocds-test', title: 'Recruitment of temporary staff', description: 'Agency recruitment services.',
  buyer_name: 'Test Council', buyer_key: 'test council', value_amount: 200_000, value_currency: 'GBP', value_placeholder: false,
  deadline: '2026-10-30T12:00:00.000Z', published_at: '2026-10-05T12:00:00.000Z', cpv_codes: ['79620000'], regions: ['London'], ...over,
});
const part = (r, c) => r.breakdown.find((b) => b.component === c);
const FAMILIAR = { total: 5, inCategory: 2 };

test('a complete, well-matched notice scores 100 with no gaps', () => {
  const r = score(notice(), PROFILE, { now: NOW, buyerHistory: FAMILIAR });
  assert.equal(r.score, 100);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.excluded, null);
  assert.deepEqual(r.breakdown.map((b) => [b.component, b.max]), [['relevance', 40], ['value', 20], ['deadline', 20], ['buyer', 15], ['recency', 5]]);
});

test('relevance: keywords in title beat description; CPV and region count', () => {
  const descOnly = score(notice({ title: 'Services', cpv_codes: ['79620000'] }), PROFILE, { now: NOW, buyerHistory: FAMILIAR });
  assert.ok(part(descOnly, 'relevance').points < 40);
  assert.match(part(descOnly, 'relevance').reason, /in description/);

  const wrongCpv = score(notice({ cpv_codes: ['45000000'] }), PROFILE, { now: NOW, buyerHistory: FAMILIAR });
  assert.equal(part(wrongCpv, 'relevance').points, 28); // 40 * (0.6 + 0 + 0.1)
  assert.match(part(wrongCpv, 'relevance').reason, /outside your categories/);

  const wrongRegion = score(notice({ regions: ['North West'] }), PROFILE, { now: NOW, buyerHistory: FAMILIAR });
  assert.equal(part(wrongRegion, 'relevance').points, 36);
});

test('value fit: inside range full, outside range scaled down', () => {
  assert.equal(part(score(notice({ value_amount: 25_000 }), PROFILE, { now: NOW }), 'value').points, 10);  // half the minimum
  assert.equal(part(score(notice({ value_amount: 1_000_000 }), PROFILE, { now: NOW }), 'value').points, 10); // double the maximum
  assert.match(part(score(notice({ value_amount: 1_000_000 }), PROFILE, { now: NOW }), 'value').reason, /above your maximum £500,000/);
});

test('deadline runway: 0 under minDays, full at fullDays, linear between', () => {
  const at = (days) => part(score(notice({ deadline: new Date(Date.parse(NOW) + days * 86_400_000).toISOString() }), PROFILE, { now: NOW }), 'deadline');
  assert.equal(at(3).points, 0);
  assert.match(at(3).reason, /only 3 days to bid/);
  assert.equal(at(9.5).points, 10);
  assert.equal(at(20).points, 20);
});

test('buyer familiarity: history in category, history elsewhere, none', () => {
  assert.equal(part(score(notice(), PROFILE, { now: NOW, buyerHistory: { total: 3, inCategory: 1 } }), 'buyer').points, 12);
  assert.equal(part(score(notice(), PROFILE, { now: NOW, buyerHistory: { total: 3, inCategory: 0 } }), 'buyer').points, 6);
});

test('recency: last 24h full, then decays', () => {
  assert.equal(part(score(notice({ published_at: '2026-10-05T07:00:00.000Z' }), PROFILE, { now: NOW }), 'recency').points, 5);
  assert.equal(part(score(notice({ published_at: '2026-10-04T00:00:00.000Z' }), PROFILE, { now: NOW }), 'recency').points, 3);
  assert.equal(part(score(notice({ published_at: '2026-09-01T00:00:00.000Z' }), PROFILE, { now: NOW }), 'recency').points, 0);
});

test('gaps: missing value, deadline, buyer history and region get half points and are named', () => {
  const r = score(notice({ value_amount: null, deadline: null, regions: [] }), PROFILE, { now: NOW, buyerHistory: null });
  assert.deepEqual(r.gaps, ['region not published', 'value not published', 'deadline not published', 'no award history for this buyer in our data']);
  assert.equal(part(r, 'value').points, 10);
  assert.equal(part(r, 'deadline').points, 10);
  assert.equal(part(r, 'buyer').points, 7.5);
  assert.equal(part(r, 'value').reason, 'value not published');
  assert.ok(r.score > 0 && r.score < 100);
});

test('gaps: a £1 placeholder is called out as a placeholder, not a value', () => {
  const r = score(notice({ value_amount: null, value_placeholder: true }), PROFILE, { now: NOW });
  assert.ok(r.gaps.includes('value published as a placeholder (e.g. £1)'));
});

test('exclusions: buyer, keyword, passed deadline, nothing relevant', () => {
  assert.equal(score(notice({ buyer_name: 'banned council' }), PROFILE, { now: NOW }).excluded, 'excluded buyer: banned council');
  assert.equal(score(notice({ description: 'Includes catering.' }), PROFILE, { now: NOW }).excluded, 'excluded keyword: catering');
  assert.equal(score(notice({ deadline: '2026-10-01T00:00:00.000Z' }), PROFILE, { now: NOW }).excluded, 'deadline has passed');
  const none = score(notice({ title: 'Road resurfacing', description: 'Tarmac.', cpv_codes: ['45233000'] }), PROFILE, { now: NOW });
  assert.equal(none.excluded, 'no keyword or CPV match');
  assert.equal(none.score, 0);
});

test('a real tender with no published value scores with the gap flagged', () => {
  const n = normaliseTender(byOcid(tenderPackage(), '031baf8c6675')); // Merton graffiti removal, no value
  const [p] = validateProfiles({ profiles: [{ entity: 'x', name: 'X', slackWebhookEnv: 'X', keywords: { include: ['graffiti'] } }] });
  const r = score(n, p, { now: '2026-10-01T09:00:00.000Z' });
  assert.ok(r.gaps.includes('value not published'));
  assert.ok(r.score > 0);
});

test('topReasons: strongest components first; formatMoney', () => {
  const r = score(notice({ value_amount: 25_000 }), PROFILE, { now: NOW, buyerHistory: FAMILIAR });
  const reasons = topReasons(r.breakdown);
  assert.equal(reasons.length, 2);
  assert.ok(!reasons.some((x) => /below your minimum/.test(x)));
  assert.equal(formatMoney(1500000.01, 'GBP'), '£1,500,000');
  assert.equal(formatMoney(10, 'XYZ'), '10 XYZ');
});
