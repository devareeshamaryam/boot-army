/**
 * B1 Slack Block Kit formatting. Pure functions: no I/O.
 */
const SECTION_LIMIT = 2900; // Slack allows 3000 per section text
const MAX_BLOCKS = 50;
const ROW_CAP = 25;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parse = (json) => (json ? JSON.parse(json) : { ratings: {}, routes: [] });
const place = (d) => [d.town, d.county].filter(Boolean).map(esc).join(', ');
const ratingsText = (ratings) => Object.entries(ratings).map(([t, r]) => `${esc(t)} ${esc(r)}`).join(', ') || 'no rating';

export function diffLine(d) {
  const star = d.watch_match ? ' :star:' : '';
  const where = place(d) ? ` · ${place(d)}` : '';
  if (d.diff_type === 'RATING_CHANGED') {
    const icon = { downgrade: ':small_red_triangle_down:', upgrade: ':arrow_up_small:' }[d.direction] ?? ':left_right_arrow:';
    return `${icon} *${esc(d.name)}*${star}${where}\n      ${ratingsText(parse(d.old).ratings)} → *${ratingsText(parse(d.new).ratings)}*`;
  }
  const state = parse(d.diff_type === 'ADDED' ? d.new : d.old);
  const routes = state.routes.slice(0, 3).map(esc).join(', ') + (state.routes.length > 3 ? ` +${state.routes.length - 3}` : '');
  return `• *${esc(d.name)}*${star}${where} · ${ratingsText(state.ratings)}${routes ? ` · _${routes}_` : ''}`;
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

function group(title, diffs, cap = ROW_CAP) {
  if (!diffs.length) return [];
  const lines = diffs.slice(0, cap).map(diffLine);
  if (diffs.length > cap) lines.push(`_…and ${diffs.length - cap} more (sponsor_diffs table)_`);
  return [{ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*${title}* (${diffs.length})` } }, ...sections(lines)];
}

/**
 * Daily digest. Order: watchlist hits, downgrades (on an action plan), removals,
 * other rating changes, additions (optionally filtered to routes of interest).
 *
 * @param {object} input
 * @param {object[]} input.diffs              rows from pendingDiffs()
 * @param {string[]} [input.additionRoutes]   show only additions licensed for one of these routes
 * @param {object}   input.meta               { publishedDate, orgCount, relocated, renamed, sourceUrl }
 */
export function buildDigest({ diffs, additionRoutes = [], meta }) {
  const of = (t) => diffs.filter((d) => d.diff_type === t);
  const changed = of('RATING_CHANGED');
  const downgrades = changed.filter((d) => d.direction === 'downgrade');
  const otherChanges = changed.filter((d) => d.direction !== 'downgrade');
  const removed = of('REMOVED');
  const allAdded = of('ADDED');
  const filters = additionRoutes.map((r) => r.toLowerCase());
  const added = filters.length
    ? allAdded.filter((d) => parse(d.new).routes.some((r) => filters.some((f) => r.toLowerCase().includes(f))))
    : allAdded;

  const counts = `*${allAdded.length}* added · *${removed.length}* removed · *${downgrades.length}* downgraded · *${otherChanges.length}* other rating changes`;
  const context = [
    `${Number(meta.orgCount ?? 0).toLocaleString('en-GB')} licensed sponsors`,
    meta.relocated ? `${meta.relocated} relocations` : null,
    meta.renamed ? `${meta.renamed} renames` : null,
    (meta.relocated || meta.renamed) ? 'not counted as changes' : null,
    meta.sourceUrl ? `<${meta.sourceUrl}|source CSV>` : null,
  ].filter(Boolean).join(' · ');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Sponsor register · ${meta.publishedDate ?? 'latest'}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${counts}\n${context}` }] },
    ...group(':star: Watchlist companies', diffs.filter((d) => d.watch_match)),
    ...group(':rotating_light: Downgraded (now on an action plan)', downgrades),
    ...group(':no_entry: Removed from the register', removed),
    ...group('Other rating changes', otherChanges),
    ...group(filters.length ? `:new: Newly licensed (${additionRoutes.join(', ')})` : ':new: Newly licensed', added),
  ];
  if (removed.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_The register does not say why a sponsor was removed: it may be revoked, surrendered, expired or renamed. Check before acting._' }] });
  }
  if (blocks.length > MAX_BLOCKS) {
    blocks.length = MAX_BLOCKS - 1;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Digest truncated to fit Slack limits._' }] });
  }
  return {
    text: `Sponsor register ${meta.publishedDate ?? ''}: ${allAdded.length} added, ${removed.length} removed, ${downgrades.length} downgraded`.replace(/\s+/g, ' '),
    blocks,
  };
}

/** Loud alert for a rejected snapshot. */
export function buildAnomalyAlert({ reason, filename, snapshotId, previousOrgCount }) {
  const lines = [
    `:rotating_light: *Sponsor register snapshot rejected* — processing halted, no diffs recorded.`,
    `*Reason:* ${esc(reason)}`,
    filename ? `*File:* ${esc(filename)}${snapshotId ? ` (snapshot ${snapshotId})` : ''}` : null,
    previousOrgCount ? `*Last accepted register:* ${Number(previousOrgCount).toLocaleString('en-GB')} sponsors` : null,
    '_The raw file is kept in the snapshot store. If the register really did change this much, re-run with SLS_MAX_DROP_RATIO raised._',
  ].filter(Boolean);
  return { text: `Sponsor register snapshot rejected: ${reason}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }] };
}