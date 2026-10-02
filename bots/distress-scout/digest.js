/**
 * B4 Slack Block Kit formatting. Pure functions: no I/O.
 *
 * Grouped by severity tier, worst first, with watchlist companies on top and
 * improvements last. Every signal links to its source and shows its reference
 * (Gazette notice code, court case or CH case number) and the general
 * statutory basis, for orientation only — not legal advice.
 */
import { EVENT_TYPES, TIER_LABEL } from './score.js';

const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;
export const MAX_PER_TIER = 15;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const link = (url, text) => (url && /^https:\/\//i.test(url) ? `<${url}|${esc(text).replace(/\|/g, '¦')}>` : esc(text));

const TIER_ICON = { severe_insolvency: ':red_circle:', active_distress: ':large_orange_circle:', early_warning: ':large_yellow_circle:', dissolved: ':black_circle:', none: ':white_circle:' };
const DATE_NOTE = { published: 'published', case: 'case date', due: 'was due', observed: 'first seen', reported: 'reported', unknown: 'date not published' };

/** "2026-09-29 (published)" or "date not published". */
export function dateLabel(date, basis) {
  if (!date) return 'date not published';
  return `${date} (${DATE_NOTE[basis] ?? basis})`;
}

function signalLine(e) {
  const def = EVENT_TYPES[e.event_type] ?? { label: e.event_type };
  const refs = [
    e.notice_code ? `Gazette ${e.notice_code}` : null,
    e.reference ? esc(e.reference) : null,
    def.ref ? `_${esc(def.ref)}_` : null,
  ].filter(Boolean).join(' · ');
  return `• ${link(e.url, def.label)} — ${esc(dateLabel(e.event_date, e.date_basis))}${refs ? ` · ${refs}` : ''}`;
}

export function transitionBlock(t) {
  const name = t.company_number
    ? link(`https://find-and-update.company-information.service.gov.uk/company/${t.company_number}`, `${t.company_name} (${t.company_number})`)
    : `${esc(t.company_name)} _(no company number published)_`;
  const arrow = `${esc(TIER_LABEL[t.from_tier] ?? t.from_tier)} → *${esc(TIER_LABEL[t.to_tier] ?? t.to_tier)}*`;
  const star = t.watchlisted ? ':star: ' : '';
  const tags = t.tags?.length ? `\n:label: ${t.tags.map((x) => `*${x.tag}* _(${esc(x.ruleHit)})_`).join(' · ')}` : '';
  const lines = (t.evidence ?? []).slice(0, 5).map(signalLine).join('\n');
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: clip(`${star}${TIER_ICON[t.to_tier] ?? ''} *${t.severity}* · ${name}\n${arrow}${lines ? `\n${lines}` : ''}${tags}`) },
  };
}

const GROUPS = [
  ['severe_insolvency', ':red_circle: Severe insolvency'],
  ['active_distress', ':large_orange_circle: Active distress'],
  ['early_warning', ':large_yellow_circle: Early warning'],
  ['dissolved', ':black_circle: Dissolved'],
];

/**
 * @param {object} input
 * @param {object[]} input.transitions  rows from pendingTransitions()
 * @param {string}   input.date
 * @param {string}   [input.title]      e.g. "Distress Scout" or "Distress Scout · TALENT"
 * @param {string[]} [input.warnings]
 * @param {object}   [input.stats]      { gazetteNotices, solventSkipped, historic }
 * @param {number}   [input.maxPerTier]
 */
export function buildDigest({ transitions, date, title = 'Distress Scout', warnings = [], stats = {}, maxPerTier = MAX_PER_TIER }) {
  const escalations = transitions.filter((t) => t.kind === 'escalation');
  const improved = transitions.filter((t) => t.kind === 'de-escalation');
  const watch = escalations.filter((t) => t.watchlisted);
  const market = escalations.filter((t) => !t.watchlisted);
  const count = (tier) => escalations.filter((t) => t.to_tier === tier).length;

  const context = [
    `${count('severe_insolvency')} severe · ${count('active_distress')} active · ${count('early_warning')} early warning · ${improved.length} improved`,
    stats.gazetteNotices !== undefined ? `${stats.gazetteNotices} Gazette notices read` : null,
    stats.solventSkipped ? `${stats.solventSkipped} solvent (members' voluntary) liquidations ignored` : null,
    stats.historic ? `${stats.historic} historic findings recorded without alerting` : null,
  ].filter(Boolean).join(' · ');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${title} · ${date}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
  ];
  const section = (heading, list) => {
    if (!list.length) return;
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*${heading}* (${list.length})` } });
    for (const t of list.slice(0, maxPerTier)) blocks.push(transitionBlock(t));
    if (list.length > maxPerTier) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${list.length - maxPerTier} more (transitions table)_` }] });
  };

  section(':star: Watchlist companies', watch);
  for (const [tier, heading] of GROUPS) section(heading, market.filter((t) => t.to_tier === tier));
  section(':white_check_mark: Improved (signals resolved)', improved);
  if (!transitions.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No tier changes today.' } });

  if (warnings.length) {
    const lines = warnings.slice(0, 10).map((w) => `• ${esc(w)}`).join('\n');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${lines}${warnings.length > 10 ? `\n…and ${warnings.length - 10} more` : ''}`) }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Sources: The Gazette, Companies House. Statutory references are for orientation only, not legal advice. A notice is not proof of insolvency: check the source before acting._' }] });

  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  const top = escalations[0];
  return {
    text: top
      ? `${title} ${date}: ${escalations.length} escalations, top ${top.company_name} (${TIER_LABEL[top.to_tier]})`
      : `${title} ${date}: ${improved.length ? `${improved.length} improved` : 'no tier changes'}`,
    blocks,
  };
}

/** Loud alert: a source went silent or every source failed. */
export function buildAnomalyAlert({ date, problems, halted = false }) {
  const head = halted ? ':rotating_light: *Distress Scout: every source failed* — run halted.' : ':rotating_light: *Distress Scout: source anomaly* — cursor held, the window will be retried.';
  return {
    text: `Distress Scout ${date}: ${halted ? 'every source failed' : 'source anomaly'}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`${head}\n${problems.slice(0, 15).map((p) => `• ${esc(p)}`).join('\n')}`) } }],
  };
}