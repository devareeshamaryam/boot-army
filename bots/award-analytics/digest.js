/**
 * B6 Slack Block Kit formatting. Pure functions: no I/O.
 */
const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const link = (url, text) => (url && /^https:\/\//i.test(url) ? `<${url}|${esc(text).replace(/\|/g, '¦')}>` : esc(text));

/** Value as published, or an explicit "not published"; framework ceilings are labelled. */
export function money(value, currency, kind) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'value not published';
  const v = `${currency ? `${esc(currency)} ` : ''}${Math.round(Number(value)).toLocaleString('en-GB')}`;
  return kind === 'framework_ceiling' ? `${v} _(framework ceiling, not a contract value)_` : v;
}

const LABEL = { insufficient_data: 'insufficient data', unconcentrated: 'unconcentrated', moderate: 'moderately concentrated', high: 'highly concentrated' };

function awardLine(a) {
  const tenderers = Number.isInteger(a.number_of_tenderers) ? ` · ${a.number_of_tenderers} tenderer${a.number_of_tenderers === 1 ? '' : 's'}` : '';
  const conf = a.confidence === 'tenderer' ? ' · _named as tenderer, not confirmed winner_' : '';
  return `*${money(a.value, a.currency, a.value_kind)}* · ${link(a.url, a.title ?? 'award notice')}\n`
    + `${esc(a.buyer_name)} → ${esc(a.winners)}${a.award_date ? ` · ${esc(a.award_date)}` : ''}${tenderers} · ${esc(a.source)}${conf}`;
}

function shiftLine(b) {
  const hhi = b.prev_hhi === null || b.prev_hhi === undefined ? `HHI ${b.hhi}` : `HHI ${b.prev_hhi} → *${b.hhi}*`;
  const label = b.prev_concentration && b.prev_concentration !== b.concentration
    ? `${esc(LABEL[b.prev_concentration])} → *${esc(LABEL[b.concentration])}*` : esc(LABEL[b.concentration]);
  const inc = (b.prev_incumbent_key ?? null) !== (b.incumbent_supplier_key ?? null)
    ? ` · incumbent ${esc(b.prev_incumbent_name ?? b.prev_incumbent_key ?? 'none')} → *${esc(b.incumbent_name ?? b.incumbent_supplier_key ?? 'none')}*`
    : b.incumbent_supplier_key ? ` · incumbent ${esc(b.incumbent_name ?? b.incumbent_supplier_key)}` : '';
  return `*${esc(b.buyer_name)}* · ${label} · ${hhi} · ${b.awards} awards in ${b.window_months} months${inc}`;
}

/**
 * @param {object} input
 * @param {object[]} input.awards      pendingMajorAwards()
 * @param {object[]} input.winners     topNewWinners()
 * @param {object[]} input.shifts      pendingShifts()
 * @param {string}   input.date
 * @param {string[]} [input.warnings]
 * @param {object}   [input.stats]     { newAwards, backfill }
 */
export function buildDigest({ awards, winners, shifts, date, warnings = [], stats = {} }) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Award analytics · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [`${stats.newAwards ?? 0} new awards recorded`, `${awards.length} major`, `${shifts.length} buyer shifts`,
          stats.backfill ? `backfill ${stats.backfill.done ?? 0}/${(stats.backfill.done ?? 0) + (stats.backfill.pending ?? 0) + (stats.backfill.truncated ?? 0)} windows` : null,
        ].filter(Boolean).join(' · '),
      }],
    },
  ];
  const lines = (heading, list, fn) => {
    if (!list.length) return;
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*${heading}* (${list.length})` } });
    for (const x of list) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(fn(x)) } });
  };
  lines(':trophy: Major awards', awards, awardLine);
  if (winners.length) {
    const rows = winners.map((w, i) => `${i + 1}. *${esc(w.name)}* — ${w.wins} new win${w.wins === 1 ? '' : 's'}${w.totalWins ? ` (${w.totalWins} in total)` : ''}`).join('\n');
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: clip(`*:medal: Top winning suppliers*\n${rows}`) } });
  }
  lines(':bar_chart: Buyer concentration shifts', shifts, shiftLine);
  if (!awards.length && !winners.length && !shifts.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No new major awards or shifts.' } });

  if (warnings.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${warnings.slice(0, 10).map((w) => `• ${esc(w)}`).join('\n')}${warnings.length > 10 ? `\n…and ${warnings.length - 10} more` : ''}`) }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Concentration = HHI over supplier win shares (above 1,800 = highly concentrated, a heuristic). Values exclude framework ceilings. Win rates are not shown: award notices name winners, not losing bidders._' }] });

  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  const top = awards[0];
  return {
    text: top ? `Award analytics ${date}: ${awards.length} major awards, top ${top.buyer_name} → ${top.winners}` : `Award analytics ${date}: ${shifts.length} buyer shifts`,
    blocks,
  };
}

export function buildAnomalyAlert({ date, problems, halted = false }) {
  const head = halted ? ':rotating_light: *Award analytics: every source failed* — run halted.' : ':rotating_light: *Award analytics: source anomaly* — cursor held, the window will be retried.';
  return {
    text: `Award analytics ${date}: ${halted ? 'every source failed' : 'source anomaly'}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`${head}\n${problems.slice(0, 15).map((p) => `• ${esc(p)}`).join('\n')}`) } }],
  };
}