/**
 * B2 Slack Block Kit formatting. Pure functions: no I/O.
 */
const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;
export const TOP_N = 20;

export const GDPR_FOOTER = 'Personal data from public regulator registers, processed under legitimate interests for executive search. '
  + 'Not enriched beyond the registers. Records are deleted 12 months after a person was last listed. Do not forward outside the search team.';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = SECTION_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const parseRoles = (s) => {
  try {
    const v = typeof s === 'string' ? JSON.parse(s) : s;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function tenureLabel(m) {
  const t = m.rationale?.tenure;
  if (!t || t.years === null || t.years === undefined) return 'tenure unknown';
  return `${t.estimate ? '≥' : ''}${t.years.toFixed(1)}y tenure`;
}

function changeLine(m) {
  const from = esc(m.from_firm_name ?? m.from_firm_key);
  const to = esc(m.to_firm_name ?? m.to_firm_key);
  if (m.kind === 'move') {
    const how = m.match_method === 'cross-register-name' ? ` _(cross-register match, ${m.match_confidence}% confidence)_` : '';
    return `:twisted_rightwards_arrows: *${from}* → *${to}*${how}`;
  }
  if (m.kind === 'leaver') {
    return m.dest_firm_name ? `:door: Left *${from}* → ${esc(m.dest_firm_name)} _(per register)_` : `:door: Left *${from}*`;
  }
  return `:new: Joined *${to}*`;
}

export function moverBlock(m) {
  const r = m.rationale ?? {};
  const roles = parseRoles(m.roles).map((x) => x.title).filter(Boolean);
  const meta = [
    esc(r.seniority?.input ?? roles[0] ?? 'role not published'),
    roles.length > 1 ? `+${roles.length - 1} more` : null,
    r.market?.input ?? null,
    r.firmTier?.input ? `Tier ${r.firmTier.input}` : null,
    tenureLabel(m),
  ].filter(Boolean).join(' · ');
  const mandates = (r.mandates ?? []).map((x) => `${esc(x.title)} _(${esc(x.client)})_`);
  const near = (r.nearMandates ?? []).map((x) => `${esc(x.title)} ${x.met}/${x.of}`);
  const mandateLine = mandates.length
    ? `\n:dart: Matches: ${mandates.join(', ')}`
    : near.length ? `\n_Partial fit: ${near.join(', ')}_` : '';
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: clip(`*${m.score}* · *${esc(m.name)}* _(${esc(m.regulator)} ${esc(m.person_ref)})_\n${changeLine(m)}\n${meta}${mandateLine}`) },
  };
}

/**
 * @param {object} input
 * @param {object[]} input.movers        rows from digestMovers() (already capped at TOP_N)
 * @param {number}   input.totalPending  movers waiting in total (for the "and N more" line)
 * @param {string}   input.date
 * @param {string[]} [input.warnings]    rejected snapshots, failed sources
 * @param {{ pending: number, items: object[], showItems: boolean }} [input.reviews]
 * @param {object}   [input.stats]       { firms, rejected, retention: { purgedPersons } }
 */
export function buildDigest({ movers, totalPending = movers.length, date, warnings = [], reviews = { pending: 0, items: [], showItems: false }, stats = {} }) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Mandate Matcher · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `${totalPending} mover${totalPending === 1 ? '' : 's'}${totalPending > movers.length ? ` (top ${movers.length} shown)` : ''}`,
          stats.firms !== undefined ? `${stats.firms} firm rosters checked` : null,
          reviews.pending ? `${reviews.pending} identity question${reviews.pending === 1 ? '' : 's'} awaiting review` : null,
        ].filter(Boolean).join(' · '),
      }],
    },
  ];

  if (movers.length) {
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: '*Regulated-person moves* (score / 100)' } });
    for (const m of movers) blocks.push(moverBlock(m));
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No new movers today.' } });
  }

  if (reviews.showItems && reviews.items.length) {
    const lines = reviews.items.slice(0, 5).map((it) => {
      const j = it.payload?.joiner ?? {};
      const c = it.payload?.candidates?.[0];
      return `• ${esc(j.name)} (${esc(j.regulator)} ${esc(j.personRef)}, joined ${esc(j.firm)})${c ? ` — maybe ${esc(c.name)} (${esc(c.regulator)}, left ${esc(c.firm)}), ${c.confidence}%` : ''}`;
    });
    blocks.push({ type: 'divider' }, {
      type: 'section',
      text: { type: 'mrkdwn', text: clip(`*Weekly identity review* (${reviews.pending} pending, never auto-merged)\n${lines.join('\n')}`) },
    });
  }

  if (warnings.length) {
    const shown = warnings.slice(0, 10).map((w) => `• ${esc(w)}`).join('\n');
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${shown}${warnings.length > 10 ? `\n…and ${warnings.length - 10} more` : ''}`) }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${GDPR_FOOTER}_` }] });

  if (blocks.length > MAX_BLOCKS) {
    const footer = blocks.pop();
    blocks.length = MAX_BLOCKS - 2;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] }, footer);
  }
  const top = movers[0];
  return {
    text: top ? `Mandate Matcher ${date}: ${totalPending} movers, top ${top.name} (${top.score})` : `Mandate Matcher ${date}: no new movers`,
    blocks,
  };
}

/** Loud alert when no roster could be processed at all. */
export function buildFailureAlert({ date, problems }) {
  const lines = problems.slice(0, 15).map((p) => `• ${esc(p)}`).join('\n');
  return {
    text: `Mandate Matcher ${date}: no firm roster could be processed`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`:rotating_light: *Mandate Matcher: no firm roster could be processed* — run halted.\n${lines}`) } }],
  };
}