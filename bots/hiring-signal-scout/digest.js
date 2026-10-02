/**
 * B5 Slack Block Kit formatting. Pure functions: no I/O.
 *
 * Every signal shows its evidence and a suggested outreach angle. The angle is
 * template text for a human; B5 never contacts anyone.
 */
const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;
export const MAX_PER_TYPE = 15;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const link = (url, text) => (url && /^https?:\/\//i.test(url) ? `<${url}|${esc(text).replace(/\|/g, '¦')}>` : esc(text));

/** Money exactly as reported, or an explicit "not stated" — never estimated. */
export function money(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'value not stated';
  return `${currency ? `${esc(currency)} ` : ''}${Math.round(Number(value)).toLocaleString('en-GB')}`;
}

function awardEvidence(e) {
  const cpv = e.cpv?.length ? `CPV ${e.cpv.slice(0, 3).map(esc).join(', ')}` : 'CPV not published';
  const how = { cpv: 'CPV match', keyword: 'keyword match', unfiltered: 'no filter set', 'cpv-not-published': 'CPV not published; passed by policy' }[e.filter] ?? esc(e.filter);
  const tenderer = e.confidence === 'tenderer' ? ' · _named as tenderer, not confirmed winner_' : '';
  return `${link(e.url, e.title ?? 'award notice')}\n${esc(e.buyer ?? 'buyer not stated')} · *${money(e.value, e.currency)}* · ${cpv} · ${how}`
    + ` · ${esc(e.source)}${e.awardDate ? ` · ${esc(e.awardDate)}` : ''}${tenderer}`;
}

function spikeEvidence(e) {
  const base = e.baselineWeekly === null || e.baselineWeekly === undefined ? 'limited history' : `usually ~${e.baselineWeekly}/week`;
  const stack = e.stackOnly ? ` · counting roles matching: ${e.stackKeywords.slice(0, 6).map(esc).join(', ')}` : '';
  const titles = e.sampleTitles?.length ? `\ne.g. ${e.sampleTitles.slice(0, 3).map(esc).join('; ')}` : '';
  return `*${e.newInWindow} new roles* in ${e.windowDays} days (threshold ${e.threshold}, ${base})${stack} · _${e.sources.map(esc).join(', ')}_${titles}`;
}

function fundingEvidence(e) {
  const amount = e.amount === null || e.amount === undefined ? 'amount not stated' : `*${money(e.amount, e.currency)}*`;
  return `${link(e.link, e.title)}\n${amount}${e.feed ? ` · ${esc(e.feed)}` : ''}${e.published ? ` · ${esc(e.published)}` : ''}`;
}

const EVIDENCE = { contract_award: awardEvidence, hiring_spike: spikeEvidence, funding: fundingEvidence };
const GROUPS = [
  ['contract_award', ':trophy: Major contract awards'],
  ['funding', ':moneybag: Funding'],
  ['hiring_spike', ':chart_with_upwards_trend: Hiring spikes'],
];

export function signalBlock(s) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: clip(`*${s.score}* · *${esc(s.evidence.company)}* · ${EVIDENCE[s.signal_type](s.evidence)}\n:bulb: _Suggested angle:_ ${esc(s.angle)}`) },
  };
}

/**
 * @param {object} input
 * @param {object[]} input.signals      rows from pendingSignals()
 * @param {string}   input.date
 * @param {string[]} [input.warnings]   failed sources, rejected boards, parse failures
 * @param {{ name: string, atsType: string, reason: string }[]} [input.unsupported]
 * @param {number}   [input.maxPerType]
 */
export function buildDigest({ signals, date, warnings = [], unsupported = [], maxPerType = MAX_PER_TYPE }) {
  const count = (t) => signals.filter((s) => s.signal_type === t).length;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Hiring signals · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${count('contract_award')} awards · ${count('funding')} funding · ${count('hiring_spike')} hiring spikes · max one signal per company per type per week` }],
    },
  ];
  for (const [type, title] of GROUPS) {
    const list = signals.filter((s) => s.signal_type === type).sort((a, b) => b.score - a.score || a.id - b.id);
    if (!list.length) continue;
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*${title}* (${list.length})` } });
    for (const s of list.slice(0, maxPerType)) blocks.push(signalBlock(s));
    if (list.length > maxPerType) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${list.length - maxPerType} more (signals table)_` }] });
  }
  if (!signals.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No new signals.' } });

  if (unsupported.length) {
    const lines = unsupported.slice(0, 10).map((u) => `• ${esc(u.name)} (${esc(u.atsType)}): ${esc(u.reason)}`).join('\n');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:no_entry_sign: *Job boards not polled (unsupported):*\n${lines}${unsupported.length > 10 ? `\n…and ${unsupported.length - 10} more` : ''}`) }] });
  }
  if (warnings.length) {
    const lines = warnings.slice(0, 10).map((w) => `• ${esc(w)}`).join('\n');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${lines}${warnings.length > 10 ? `\n…and ${warnings.length - 10} more` : ''}`) }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Angles are suggestions for a human to adapt. B5 sends no outreach._' }] });

  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  const top = [...signals].sort((a, b) => b.score - a.score)[0];
  return {
    text: top ? `Hiring signals ${date}: ${signals.length} new, top ${top.evidence.company} (${top.score})` : `Hiring signals ${date}: no new signals`,
    blocks,
  };
}

/** Loud alert when no source could be harvested at all. */
export function buildFailureAlert({ date, problems }) {
  return {
    text: `Hiring-Signal Scout ${date}: every source failed`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`:rotating_light: *Hiring-Signal Scout: every source failed* — run halted.\n${problems.slice(0, 15).map((p) => `• ${esc(p)}`).join('\n')}`) } }],
  };
}