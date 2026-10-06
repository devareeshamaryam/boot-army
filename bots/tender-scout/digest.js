/**
 * Ranked Slack digest per entity (Block Kit, incoming webhook).
 *
 * A notice is never posted to the same entity twice (digests_sent). It is only
 * recorded as sent after Slack accepts the message. Anything that is not a real
 * send (dry run, no webhook configured, PLACEHOLDER profile) prints the exact
 * payload instead and records nothing.
 */
import { http } from '@botarmy/core';
import { digestCandidates, markSent } from './db.js';
import { hasPlaceholder } from './profiles.js';
import { formatMoney, topReasons } from './score.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const DAY = 86_400_000;

const ukDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

function valueText(n) {
  if (n.value_amount != null) return formatMoney(n.value_amount, n.value_currency);
  return n.value_placeholder ? '_not published (placeholder value)_' : '_not published_';
}

function deadlineText(n, now) {
  if (!n.deadline) return '_not published_';
  const days = Math.floor((Date.parse(n.deadline) - Date.parse(now)) / DAY);
  return `${ukDate(n.deadline)} (${days} day${days === 1 ? '' : 's'})`;
}

function itemBlock(n, i, now) {
  const title = esc(clip(n.title ?? 'Untitled notice', 150)).replace(/\|/g, '/');
  const heading = n.link ? `<${n.link}|${title}>` : title;
  const lines = [
    `*${i + 1}. ${heading}*  ·  *Score ${n.score.score}*`,
    `*Buyer:* ${esc(clip(n.buyer_name ?? 'not published', 100))}  ·  *Value:* ${valueText(n)}  ·  *Deadline:* ${deadlineText(n, now)}`,
    ...topReasons(n.score.breakdown).map((r) => `• ${esc(r)}`),
  ];
  if (n.score.gaps.length) lines.push(`_Gaps: ${esc(n.score.gaps.join(', '))}_`);
  return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } };
}

/**
 * @param {object} profile
 * @param {object[]} items  digestCandidates() rows, best first
 * @param {{ now: string }} options
 * @returns {{ text: string, blocks: object[] } | null}  null when there is nothing to post
 */
export function buildDigest(profile, items, { now }) {
  if (!items.length) return null;
  const count = `${items.length} new tender${items.length === 1 ? '' : 's'}`;
  return {
    text: `TenderScout: ${count} for ${profile.name} (top score ${items[0].score.score})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: clip(`TenderScout · ${profile.name} · ${ukDate(now)}`, 150) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${count}, best first. Score = winnability 0-100; gaps are fields the buyer did not publish.` }] },
      ...items.flatMap((n, i) => [itemBlock(n, i, now), { type: 'divider' }]),
    ],
  };
}

/** Why this run must not post for this profile, or null if it may. */
export function sendBlocker(profile, { send, env = process.env }) {
  if (!send) return 'dry run (pass --send to post)';
  if (hasPlaceholder(profile)) return `profile "${profile.entity}" still contains PLACEHOLDER values`;
  if (!env[profile.slackWebhookEnv]?.trim()) return `${profile.slackWebhookEnv} is not set`;
  return null;
}

/**
 * Build and post (or print) one entity's digest.
 * @returns {Promise<{ entity, count, posted: boolean, note: string|null }>}
 */
export async function deliverDigest(db, profile, { runId, now, send = false, env = process.env, log, print = console.log }) {
  const items = digestCandidates(db, profile.entity, now, profile.maxDigestSize);
  const payload = buildDigest(profile, items, { now });
  if (!payload) {
    log?.info?.(`No new tenders for ${profile.entity}`);
    return { entity: profile.entity, count: 0, posted: false, note: 'nothing new' };
  }

  const blocker = sendBlocker(profile, { send, env });
  if (blocker) {
    if (send) log?.warn?.(`Not posting ${profile.entity} digest: ${blocker}`);
    print(`--- ${profile.entity}: NOT SENT (${blocker}). Payload:\n${JSON.stringify(payload, null, 2)}`);
    return { entity: profile.entity, count: items.length, posted: false, note: blocker };
  }

  await http.fetch(env[profile.slackWebhookEnv].trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    retries: 2,
  });
  markSent(db, profile.entity, items, runId, now);
  log?.info?.(`Posted ${profile.entity} digest`, { count: items.length });
  return { entity: profile.entity, count: items.length, posted: true, note: null };
}
