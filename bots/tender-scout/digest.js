/**
 * B3 Slack Block Kit formatting. Pure functions: no I/O.
 * One message per capability profile: ranked opportunities, then key deadlines.
 */
import { daysUntil, NOT_SCORED } from './score.js';

const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;
export const MAX_RANKED = 20;
export const KEY_DEADLINE_DAYS = 21;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const link = (url, text) => (url && /^https:\/\//i.test(url) ? `<${url}|${esc(text).replace(/\|/g, '¦')}>` : esc(text));
const SOURCE_LABEL = { contractsFinder: 'Contracts Finder', findATender: 'Find a Tender', ted: 'TED' };

/** Value exactly as published, or an explicit "not published". */
export function valueLabel(t) {
  const fmt = (n) => Math.round(n).toLocaleString('en-GB');
  const cur = t.currency ? `${esc(t.currency)} ` : '';
  if (t.valueMin !== null && t.valueMax !== null && t.valueMin !== t.valueMax) return `${cur}${fmt(t.valueMin)}–${fmt(t.valueMax)}`;
  const v = t.valueMax ?? t.valueMin;
  return v === null || v === undefined ? 'value not published' : `${cur}${fmt(v)}`;
}

/** Deadline with days left, or an explicit "not published". */
export function deadlineLabel(t, now) {
  const days = daysUntil(t.deadline, now);
  if (days === null) return 'deadline not published';
  return `closes ${t.deadline.slice(0, 10)} (${days} day${days === 1 ? '' : 's'} left)`;
}

function why(reasons) {
  const parts = [];
  if (reasons.cpv?.matched) parts.push(`CPV ${esc(reasons.cpv.input)} ⊂ ${esc(reasons.cpv.matched)}`);
  else if (reasons.cpv?.unknown) parts.push('CPV not published');
  if (reasons.keywords?.input?.length) parts.push(`keywords: ${reasons.keywords.input.slice(0, 3).map(esc).join(', ')}`);
  if (reasons.location?.input && reasons.location.value === 1) parts.push(`📍 ${esc([reasons.location.input].flat()[0])}`);
  else if (reasons.location?.unknown) parts.push('location not published');
  return parts.join(' · ');
}

export function opportunityBlock(t, now) {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: clip(`*${t.score}* · ${link(t.url, t.title)}\n${esc(t.buyer ?? 'buyer not published')} · *${valueLabel(t)}* · ${deadlineLabel(t, now)} · ${SOURCE_LABEL[t.source] ?? esc(t.source)}\n_${why(t.reasons)}_`),
    },
  };
}

/**
 * @param {object} input
 * @param {{ name: string }} input.profile
 * @param {object[]} input.matches   rows from pendingMatches() (best first)
 * @param {string}   input.now       ISO timestamp (deadline maths)
 * @param {string[]} [input.warnings]
 */
export function buildDigest({ profile, matches, now, warnings = [], maxRanked = MAX_RANKED }) {
  const date = now.slice(0, 10);
  const ranked = matches.slice(0, maxRanked);
  const closing = matches
    .filter((t) => { const d = daysUntil(t.deadline, now); return d !== null && d <= KEY_DEADLINE_DAYS; })
    .sort((a, b) => a.deadline.localeCompare(b.deadline) || a.id - b.id)
    .slice(0, 12);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Tenders for ${profile.name} · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${matches.length} new opportunit${matches.length === 1 ? 'y' : 'ies'}${matches.length > ranked.length ? ` (top ${ranked.length} shown)` : ''} · ranked by fit and winnability (0–100)` }],
    },
  ];
  if (ranked.length) {
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: '*Ranked opportunities*' } });
    for (const t of ranked) blocks.push(opportunityBlock(t, now));
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No new opportunities.' } });
  }
  if (closing.length) {
    const lines = closing.map((t) => `• *${esc(t.deadline.slice(0, 10))}* (${daysUntil(t.deadline, now)}d) · ${link(t.url, t.title)} · ${esc(t.buyer ?? 'buyer not published')}`);
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: clip(`:alarm_clock: *Key deadlines (next ${KEY_DEADLINE_DAYS} days)*\n${lines.join('\n')}`) } });
  }
  if (warnings.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${warnings.slice(0, 8).map((w) => `• ${esc(w)}`).join('\n')}${warnings.length > 8 ? `\n…and ${warnings.length - 8} more` : ''}`) }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_Not scored yet: ${NOT_SCORED.map(esc).join('; ')}. Unpublished values, deadlines and locations are shown as such, never estimated._` }] });

  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  const top = matches[0];
  return {
    text: top ? `Tenders for ${profile.name} ${date}: ${matches.length} new, top "${top.title}" (${top.score})` : `Tenders for ${profile.name} ${date}: none new`,
    blocks,
  };
}

/** Loud alert: a source went silent where history says it shouldn't, or failed outright. */
export function buildAnomalyAlert({ date, problems }) {
  return {
    text: `TenderScout ${date}: source anomaly`,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: clip(`:rotating_light: *TenderScout source problem* — the affected window will be fetched again next run.\n${problems.slice(0, 12).map((p) => `• ${esc(p)}`).join('\n')}`) },
    }],
  };
}