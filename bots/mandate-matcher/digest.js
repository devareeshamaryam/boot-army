import { sendSlackAlert, withRetry } from '@botarmy/core';

const SECTION_LIMIT = 3000; // Slack's max characters per section text
const MAX_BLOCKS = 50;      // Slack's max blocks per message

/** Escape the three characters Slack mrkdwn treats as control characters. */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s, max = SECTION_LIMIT) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const link = (url, text) => {
  if (!url || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return esc(text);
  return `<${url}|${esc(text).replace(/\|/g, '¦')}>`;
};

const parseJson = (s, fallback) => {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
};

function tenureLabel(mover) {
  if (mover.tenure_days === null || mover.tenure_days === undefined) return null;
  const years = (mover.tenure_days / 365.25).toFixed(1);
  return mover.tenure_is_estimate ? `≥${years}y tenure` : `${years}y tenure`;
}

function describeChange(m) {
  const from = esc(m.from_firm_label ?? m.from_firm_ref);
  const to = esc(m.to_firm_label ?? m.to_firm_ref);
  switch (m.change_type) {
    case 'move':
      return `:twisted_rightwards_arrows: Moved *${from}* → *${to}*`;
    case 'leaver':
      return m.to_firm_name
        ? `:door: Left *${from}* → ${esc(m.to_firm_name)} _(per register)_`
        : `:door: Left *${from}*`;
    default:
      return `:new: Joined *${to}*`;
  }
}

function moverBlock(m) {
  const breakdown = parseJson(m.score_json, {});
  const roles = parseJson(m.roles_json, []).map((r) => r.title).filter(Boolean);
  const primaryRole = breakdown.seniority?.input ?? roles[0] ?? 'Role not stated';
  const market = breakdown.market?.input;
  const tier = breakdown.firmTier?.input;

  const meta = [
    esc(primaryRole),
    roles.length > 1 ? `+${roles.length - 1} more role${roles.length > 2 ? 's' : ''}` : null,
    market,
    tier ? `Tier ${tier}` : null,
    tenureLabel(m),
  ].filter(Boolean).join(' · ');

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: clip(
        `*${m.score}* · *${esc(m.name)}* _(${esc(m.regulator)} ${esc(m.person_ref)})_\n${describeChange(m)}\n${meta}`,
      ),
    },
  };
}

function newsBlock(items) {
  const lines = items.map((n) => {
    const matched = parseJson(n.matched_json, []);
    const tags = matched.length ? ` — _${esc(matched.slice(0, 3).join(', '))}_` : '';
    return `• ${link(n.link, n.title)} (${esc(n.feed_name)})${tags}`;
  });
  return { type: 'section', text: { type: 'mrkdwn', text: clip(lines.join('\n')) } };
}

/**
 * Build a Slack Block Kit payload.
 *
 * @param {object} input
 * @param {object[]} input.movers   Ranked mover rows (from listDigestMovers).
 * @param {object[]} input.news     RSS rows (from listDigestNews).
 * @param {string}   input.date     YYYY-MM-DD shown in the header.
 * @param {string[]} [input.warnings] Source failures / rejected snapshots.
 * @param {string}   [input.aiSummary] Optional short analyst note.
 * @param {object}   [input.stats]  { firmsChecked, snapshotsDiffed, newMovers }
 * @returns {{ text: string, blocks: object[] }}
 */
export function buildDigestPayload({ movers, news, date, warnings = [], aiSummary = null, stats = {} }) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Mandate Matcher · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${movers.length} ranked mover${movers.length === 1 ? '' : 's'} · ${news.length} news item${news.length === 1 ? '' : 's'}`
          + (stats.firmsChecked !== undefined ? ` · ${stats.firmsChecked} firm rosters checked` : ''),
      }],
    },
  ];

  if (aiSummary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`:memo: ${esc(aiSummary)}`) } });
  }

  if (movers.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Regulated-person moves* (score / 100)' } });
    for (const m of movers) blocks.push(moverBlock(m));
  }

  if (news.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*People-moves news*' } });
    blocks.push(newsBlock(news));
  }

  if (!movers.length && !news.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No new movers or matching news today.' } });
  }

  if (warnings.length) {
    const shown = warnings.slice(0, 10).map((w) => `• ${esc(w)}`).join('\n');
    const more = warnings.length > 10 ? `\n…and ${warnings.length - 10} more` : '';
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${shown}${more}`) }] });
  }

  const top = movers[0];
  const text = top
    ? `Mandate Matcher ${date}: ${movers.length} movers, top ${top.name} (${top.score})`
    : `Mandate Matcher ${date}: ${news.length} news items, no new movers`;

  return { text, blocks: blocks.slice(0, MAX_BLOCKS) };
}

/** Post the digest, retrying transient Slack failures. */
export function sendDigest(webhookUrl, payload, { retries = 3, delayMs = 2000 } = {}) {
  return withRetry(() => sendSlackAlert(webhookUrl, payload), retries, delayMs);
}