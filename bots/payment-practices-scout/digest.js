/**
 * B9 Slack Block Kit formatting. Pure functions: no I/O.
 *
 * Payment-practices reports are self-reported, semi-annual and can be months
 * old when filed. Every line therefore states the period its figures describe:
 * "data as of period ending {date}". Never present them as current behaviour.
 */
const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;
export const MAX_ALERTS = 25;
export const SOURCE_LINK = '<https://check-payment-practices.service.gov.uk/export|check-payment-practices.service.gov.uk>';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

/** The required staleness wording. */
export const asOf = (periodEndDate) => `data as of period ending ${periodEndDate ?? 'unknown'}`;

export function jumpLine(j) {
  const link = j.report_url && /^https:\/\//.test(j.report_url) ? ` · <${j.report_url}|report>` : '';
  const number = j.company_number ? ` (${esc(j.company_number)})` : '';
  const figures = [];
  if (j.avg_days_to_pay !== null && j.prev.avgDaysToPay !== null && j.days_delta !== null) {
    figures.push(`Avg days to pay ${j.prev.avgDaysToPay} → *${j.avg_days_to_pay}* (${sign(j.days_delta)}, ${sign(j.pct_delta)}%)`);
  }
  if (j.payments_beyond_terms !== null && j.prev.paymentsBeyondTerms !== null && j.late_delta !== null) {
    figures.push(`Outside terms ${j.prev.paymentsBeyondTerms}% → *${j.payments_beyond_terms}%* (${sign(j.late_delta)} pts)`);
  }
  const filed = j.filing_date ? `, filed ${j.filing_date}` : '';
  const refiled = j.refiled ? ' · re-filed report for this period, check against the original' : '';
  return `*${esc(j.company_name)}*${number}${link}\n${figures.join(' · ') || 'figures incomplete'}\n`
    + `_${asOf(j.period_end_date)}${filed}; previous period ending ${j.prev.periodEndDate}${refiled}_`;
}

/**
 * @param {object} input
 * @param {object[]} input.jumps  rows from pendingJumps()
 * @param {string}   input.date   run date
 * @param {number}   [input.maxAlerts]
 */
export function buildDigest({ jumps, date, maxAlerts = MAX_ALERTS }) {
  const shown = jumps.slice(0, maxAlerts);
  const periods = jumps.map((j) => j.period_end_date).filter(Boolean).sort();
  const range = periods.length
    ? periods[0] === periods.at(-1) ? asOf(periods[0]) : `${asOf(periods.at(-1))} (oldest ${periods[0]})`
    : asOf(null);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Payment practices · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${jumps.length} compan${jumps.length === 1 ? 'y reports' : 'ies report'} paying suppliers markedly slower than in their previous period · ${range}` }],
    },
    { type: 'divider' },
    ...shown.map((j) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(jumpLine(j)) } })),
  ];
  if (jumps.length > shown.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${jumps.length - shown.length} more (payment_jumps table)_` }] });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_Self-reported figures, published semi-annually: each line shows the period it describes, not current payment behaviour. Source: ${SOURCE_LINK}_` }],
  });
  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  const top = jumps[0];
  return {
    text: top
      ? `Payment practices ${date}: ${jumps.length} slower payers, top ${top.company_name} (${asOf(top.period_end_date)})`
      : `Payment practices ${date}: no new jumps`,
    blocks,
  };
}

/** Loud alert for a rejected export snapshot. */
export function buildAnomalyAlert({ reason, snapshotId, storedCount }) {
  const lines = [
    ':rotating_light: *Payment practices export rejected* — processing halted, nothing recorded.',
    `*Reason:* ${esc(reason)}`,
    snapshotId ? `*Snapshot:* ${snapshotId} (kept in the raw store for inspection)` : null,
    storedCount ? `*Reports already stored:* ${Number(storedCount).toLocaleString('en-GB')}` : null,
    '_If the export really changed, re-run with PPS_MIN_REPORTS or PPS_MIN_RETAINED_RATIO adjusted. Stored figures remain data as of the periods already reported._',
  ].filter(Boolean);
  return { text: `Payment practices export rejected: ${reason}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(lines.join('\n')) } }] };
}

/** Plain-text credit-check report for the terminal (Osbrooks screening). */
export function formatCreditCheck(results, query) {
  if (!results.length) return `No payment practices reports stored for "${query}".`;
  const out = [];
  for (const r of results) {
    out.push(`${r.companyName}${r.companyNumber ? ` (${r.companyNumber})` : ''} — ${r.reports.length} report(s)`);
    for (const rep of r.reports.slice(0, 8)) {
      const days = rep.avgDaysToPay === null ? 'avg days not reported' : `${rep.avgDaysToPay} avg days to pay`;
      const late = rep.paymentsBeyondTerms === null ? 'outside-terms % not reported' : `${rep.paymentsBeyondTerms}% outside agreed terms`;
      out.push(`  ${asOf(rep.periodEndDate)}: ${days}, ${late}${rep.filingDate ? ` (filed ${rep.filingDate})` : ''}`);
    }
    out.push('');
  }
  out.push('Self-reported figures for the periods stated; not current payment behaviour.');
  return out.join('\n');
}