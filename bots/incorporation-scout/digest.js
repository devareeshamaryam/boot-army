/**
 * B7 Slack Block Kit formatting. Pure functions: no I/O.
 * One digest per SIC watchlist. Directors are shown as a setup summary only.
 */
const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const chUrl = (n) => `https://find-and-update.company-information.service.gov.uk/company/${n}`;

export function directorsLabel(lead) {
  const s = lead.officers_summary;
  if (!s) return lead.officers_status === 'not-found' ? 'officers not published' : 'directors not looked up yet';
  const parts = [];
  if (s.individualDirectors) parts.push(`${s.individualDirectors} individual`);
  if (s.corporateDirectors) parts.push(`${s.corporateDirectors} corporate`);
  if (s.nomineeDirectors) parts.push(`${s.nomineeDirectors} nominee`);
  return parts.length ? `${parts.join(' + ')} director${s.directors === 1 ? '' : 's'}` : 'no current directors';
}

export function locationLabel(lead) {
  if (lead.formation_agent) return ':warning: formation-agent address';
  const place = [lead.ro_locality, lead.ro_postcode].filter(Boolean).map(esc).join(' ');
  return place || 'registered office not published';
}

export function leadBlock(lead) {
  const r = lead.reasons;
  const why = ['sic', 'directors', 'geography'].map((k) => `${k} ${r[k].points}`).join(' · ');
  const text = `*${lead.score}* · <${chUrl(lead.company_number)}|${esc(lead.name)}> (${esc(lead.company_number)})\n`
    + `Incorporated ${esc(lead.date_of_creation ?? 'date not published')} · SIC ${lead.sic_codes.map(esc).join(', ') || 'none'} _(matched ${esc(lead.matched_sic)})_\n`
    + `${locationLabel(lead)} · ${directorsLabel(lead)}\n_${esc(r.directors.note)}; ${esc(r.geography.note)} · points: ${why}_`;
  return { type: 'section', text: { type: 'mrkdwn', text: clip(text) } };
}

/**
 * @param {object} input
 * @param {{ name: string, minScore: number }} input.watchlist
 * @param {object[]} input.leads     pendingLeads() (already capped)
 * @param {number}   input.total     leads at or above the threshold in total
 * @param {string}   input.date
 * @param {string[]} [input.warnings]
 * @param {object}   [input.stats]   { incorporations, matched }
 */
export function buildDigest({ watchlist, leads, total = leads.length, date, warnings = [], stats = {} }) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `New incorporations · ${watchlist.name} · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [`${total} lead${total === 1 ? '' : 's'} scoring ${watchlist.minScore}+`,
          total > leads.length ? `top ${leads.length} shown` : null,
          stats.incorporations !== undefined ? `${stats.incorporations} incorporations read, ${stats.matched ?? 0} in target SIC codes` : null,
        ].filter(Boolean).join(' · '),
      }],
    },
    { type: 'divider' },
    ...leads.map(leadBlock),
  ];
  if (!leads.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No new leads above the threshold.' } });
  if (warnings.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${warnings.slice(0, 8).map((w) => `• ${esc(w)}`).join('\n')}${warnings.length > 8 ? `\n…and ${warnings.length - 8} more` : ''}`) }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Most new companies are shells: scores weigh SIC fit, a credible board and location. Directors shown as counts only. Source: Companies House._' }] });
  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  return {
    text: leads.length ? `New incorporations · ${watchlist.name} ${date}: ${total} leads, top ${leads[0].name} (${leads[0].score})` : `New incorporations · ${watchlist.name} ${date}: no leads`,
    blocks,
  };
}

export function buildAnomalyAlert({ date, problems, halted = false }) {
  const head = halted ? ':rotating_light: *Incorporation Scout: every source failed* — run halted.' : ':rotating_light: *Incorporation Scout: source anomaly* — cursor held, the window will be retried.';
  return {
    text: `Incorporation Scout ${date}: ${halted ? 'every source failed' : 'source anomaly'}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`${head}\n${problems.slice(0, 15).map((p) => `• ${esc(p)}`).join('\n')}`) } }],
  };
}