import { sendSlackAlert, withRetry } from '@botarmy/core';

const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parse = (json) => (json ? JSON.parse(json) : { ratings: {}, routes: [] });
const place = (d) => [d.town, d.county].filter(Boolean).map(esc).join(', ');

const ratingsText = (ratings) =>
  Object.entries(ratings).map(([type, rating]) => `${esc(type)} ${esc(rating)}`).join(', ') || 'no rating';

function line(d) {
  const watch = d.watch_match ? ' :star:' : '';
  const where = place(d) ? ` · ${place(d)}` : '';
  if (d.diff_type === 'RATING_CHANGED') {
    const icon = { downgrade: ':small_red_triangle_down:', upgrade: ':arrow_up_small:' }[d.direction] ?? ':left_right_arrow:';
    return `${icon} *${esc(d.name)}*${watch}${where}\n      ${ratingsText(parse(d.old_json).ratings)} → *${ratingsText(parse(d.new_json).ratings)}*`;
  }
  const state = parse(d.diff_type === 'ADDED' ? d.new_json : d.old_json);
  const routes = state.routes.slice(0, 3).map(esc).join(', ') + (state.routes.length > 3 ? ` +${state.routes.length - 3}` : '');
  return `• *${esc(d.name)}*${watch}${where} · ${ratingsText(state.ratings)}${routes ? ` · _${routes}_` : ''}`;
}

/** Pack lines into as few section blocks as fit Slack's per-section limit. */
function sections(lines) {
  const blocks = [];
  let buf = '';
  for (const l of lines) {
    if (buf && buf.length + l.length + 1 > SECTION_LIMIT) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
      buf = '';
    }
    buf = buf ? `${buf}\n${l}` : l.slice(0, SECTION_LIMIT);
  }
  if (buf) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
  return blocks;
}

function group(title, diffs, limit) {
  if (!diffs.length) return [];
  const shown = diffs.slice(0, limit).map(line);
  if (diffs.length > limit) shown.push(`_…and ${diffs.length - limit} more (see the sponsor_diffs table)_`);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}* (${diffs.length})` } },
    ...sections(shown),
  ];
}

/**
 * Build the Block Kit digest.
 *
 * Order of importance: watchlist hits, downgrades to B (the sponsor is on an
 * action plan), removals, other rating changes, then additions. Additions can
 * be filtered to routes of interest (e.g. Skilled Worker); everything else is
 * always shown.
 *
 * @param {object} input
 * @param {object[]} input.diffs            rows from listPendingDiffs
 * @param {string[]} [input.additionRoutes] show only additions licensed for one of these routes
 * @param {object}   input.meta             { publishedDate, orgCount, relocated, sourceUrl }
 * @param {object}   [input.limits]
 */
export function buildDigestPayload({ diffs, additionRoutes = [], meta, limits = {} }) {
  const lim = { watch: 20, downgrades: 25, removed: 25, changes: 15, added: 25, ...limits };
  const byType = (t) => diffs.filter((d) => d.diff_type === t);

  const watch = diffs.filter((d) => d.watch_match);
  const changed = byType('RATING_CHANGED');
  const downgrades = changed.filter((d) => d.direction === 'downgrade');
  const otherChanges = changed.filter((d) => d.direction !== 'downgrade');
  const removed = byType('REMOVED');
  const allAdded = byType('ADDED');
  const routeFilter = additionRoutes.map((r) => r.toLowerCase());
  const added = routeFilter.length
    ? allAdded.filter((d) => parse(d.new_json).routes.some((r) => routeFilter.some((f) => r.toLowerCase().includes(f))))
    : allAdded;

  const counts = [
    `*${allAdded.length}* added`,
    `*${removed.length}* removed`,
    `*${downgrades.length}* downgraded`,
    `*${otherChanges.length}* other rating changes`,
  ].join(' · ');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Sponsor register · ${meta.publishedDate ?? 'latest'}`, emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${counts}\n${meta.orgCount.toLocaleString('en-GB')} licensed sponsors`
          + (meta.relocated ? ` · ${meta.relocated} relocations not counted` : '')
          + (meta.sourceUrl ? ` · <${meta.sourceUrl}|source CSV>` : ''),
      }],
    },
    ...(watch.length ? [{ type: 'divider' }, ...group(':star: Watchlist companies', watch, lim.watch)] : []),
    ...(downgrades.length ? [{ type: 'divider' }, ...group(':rotating_light: Downgraded (now on an action plan)', downgrades, lim.downgrades)] : []),
    ...(removed.length ? [{ type: 'divider' }, ...group(':no_entry: Removed from the register', removed, lim.removed)] : []),
    ...(otherChanges.length ? [{ type: 'divider' }, ...group('Other rating changes', otherChanges, lim.changes)] : []),
    ...(added.length ? [{ type: 'divider' }, ...group(
      routeFilter.length ? `:new: Newly licensed (${additionRoutes.join(', ')})` : ':new: Newly licensed', added, lim.added,
    )] : []),
  ];

  if (removed.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_The register does not say why a sponsor was removed: it may be revoked, surrendered, expired, or renamed. Check before acting._' }],
    });
  }

  if (blocks.length > MAX_BLOCKS) {
    blocks.length = MAX_BLOCKS - 1;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] });
  }

  return {
    text: `Sponsor register ${meta.publishedDate ?? ''}: ${allAdded.length} added, ${removed.length} removed, ${downgrades.length} downgraded`,
    blocks,
  };
}

export function sendDigest(webhookUrl, payload) {
  return withRetry(() => sendSlackAlert(webhookUrl, payload), 3, 2000);
}