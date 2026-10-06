/** Profile loading and validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WEIGHTS, EXAMPLE_FILE, ProfileError, hasPlaceholder, loadProfiles, validateProfiles } from '../profiles.js';

const valid = (over = {}) => ({
  entity: 'ateca', name: 'Ateca', keywords: { include: ['recruitment'] }, cpvPrefixes: ['796'],
  slackWebhookEnv: 'SLACK_WEBHOOK_URL_TENDERS_ATECA', ...over,
});

test('the committed example is valid and every profile is marked PLACEHOLDER', () => {
  const profiles = validateProfiles(JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8')));
  assert.deepEqual(profiles.map((p) => p.entity), ['ateca', 'osbrooks', 'amc-bme', 'trading-co']);
  assert.ok(profiles.every(hasPlaceholder));
});

test('defaults are filled in', () => {
  const [p] = validateProfiles({ profiles: [valid()] });
  assert.deepEqual(p.weights, DEFAULT_WEIGHTS);
  assert.equal(p.maxDigestSize, 10);
  assert.deepEqual(p.value, { min: null, max: null });
  assert.deepEqual(p.runway, { minDays: 5, fullDays: 14 });
});

test('every problem is reported at once, with its path', () => {
  let err;
  try {
    validateProfiles({ profiles: [
      valid({ cpvPrefixes: ['79a'], weights: { relevance: 50 } }),
      valid({ entity: 'ateca', slackWebhookEnv: 'https://hooks.slack.com/services/x', maxDigestSize: 99, value: { min: 10, max: 5 } }),
    ] });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ProfileError);
  const text = err.problems.join('\n');
  assert.match(text, /profiles\[0\] \(ateca\)\.cpvPrefixes\[0\]: must be a string of digits/);
  assert.match(text, /profiles\[0\] \(ateca\)\.weights: must add up to 100 \(they add up to 110\)/);
  assert.match(text, /profiles\[1\] \(ateca\)\.entity: duplicate entity/);
  assert.match(text, /slackWebhookEnv: must be the NAME of an env var/);
  assert.match(text, /maxDigestSize: must be a whole number from 1 to 20/);
  assert.match(text, /value: min is greater than max/);
});

test('a profile with no keywords and no CPV prefixes is rejected', () => {
  assert.throws(() => validateProfiles({ profiles: [valid({ keywords: { include: [] }, cpvPrefixes: [] })] }), /at least one keyword or CPV prefix/);
});

test('missing profiles.json: error by default, example only when allowed', () => {
  const missing = new URL('./no-such-profiles.json', import.meta.url);
  assert.throws(() => loadProfiles({ file: missing }), /copy profiles\.example\.json to profiles\.json/);
  assert.equal(loadProfiles({ file: missing, allowExample: true }).length, 4);
});
