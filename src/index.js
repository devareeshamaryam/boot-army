import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

/**
 * B1 Sponsor Licence Scout — entry point.
 *
 * Daily: download the Home Office register CSV, keep every sponsor in the
 * Google Sheet (tab "Sponsors"), append new ones, mark vanished ones Revoked,
 * and send one Slack message.
 *
 * Runs once and exits (0 = success, 1 = failure); scheduling is external
 * (Cloud Scheduler -> Cloud Run Job). --once is accepted for clarity; a run is
 * always a single pass.
 *
 *   npm start          # node src/index.js --once
 *   npm run dry-run    # download + diff, print what would change; no Sheet writes, no Slack
 */
import { health, logger, slack } from './core/index.js';
import { resolveLinks, searchUrl } from './companies.js';
import { harvest, parseRows } from './harvest.js';
import { appendRows, diffSponsors, ensureTab, openSheets, readRows, sheetUrl, updateRows } from './sheets.js';

const BOT = 'sponsor-licence-scout';
const DRY_RUN = process.argv.includes('--dry-run');
const SLACK_CHANNEL = 'sponsors'; // SLACK_WEBHOOK_URL_SPONSORS, else SLACK_WEBHOOK_URL
const LIST_LIMIT = 25;

const log = logger.forBot(BOT);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Slack link <url|text>; a "|" in the text would end the URL part early.
const link = (url, text) => `<${url}|${esc(text).replace(/\|/g, '¦')}>`;
// Name → Companies House link (company page if resolved, else search).
const chLink = (links, name) => link(links.get(name) ?? searchUrl(name), name);
const line = (links) => (f) => `• ${chLink(links, f[0])} — ${esc(f[1] || 'town not listed')} (${esc(f[4])})`;

// Moved/renamed: show only what changed, old → new.
const changeLine = (links) => ({ from, to }) => {
  const was = [0, 1, 2, 3].filter((i) => from[i].toLowerCase() !== to[i].toLowerCase());
  const what = was.map((i) => `${esc(from[i] || '—')} → ${esc(to[i] || '—')}`).join('; ');
  return `• ${chLink(links, to[0])} — ${what || 'details updated'} (${esc(to[4])})`;
};

/** Names that will appear in the message, i.e. the first LIST_LIMIT of each section. */
const listedNames = (d) => [d.added, d.revoked, d.reinstated].flatMap((rows) => rows.slice(0, LIST_LIMIT).map((f) => f[0]))
  .concat(d.changed.slice(0, LIST_LIMIT).map((c) => c.to[0]));

function section(title, rows, sheet, format) {
  if (!rows.length) return [];
  const shown = rows.slice(0, LIST_LIMIT).map(format);
  if (rows.length > LIST_LIMIT) shown.push(`...and ${rows.length - LIST_LIMIT} more (${link(sheet, 'see sheet')})`);
  return ['', `*${title}* (${rows.length})`, ...shown];
}

// Only two emoji, so they stand out: green circle = new sponsor, red circle = revoked.
const NEW = ':large_green_circle:';
const REVOKED = ':red_circle:';
const n = (x) => Number(x).toLocaleString('en-GB');

function message(d, today, sheet, links = new Map()) {
  if (d.blocked) return `WARNING - Sponsor register ${today}: ${d.blocked}. Check the download.`;
  if (d.baseline) return `Sponsor register ${today}: baseline loaded: ${n(d.appends.length)} sponsors (${link(sheet, 'open sheet')})`;
  return [
    `*Sponsor register ${today}* (${link(sheet, 'open sheet')})`,
    `${NEW} ${n(d.added.length)} new   ${REVOKED} ${n(d.revoked.length)} removed   ${n(d.reinstated.length)} reinstated   ${n(d.changed.length)} moved/renamed   ·   ${n(d.activeAfter)} active`,
    ...section(`${NEW} New sponsors (Ateca leads)`, d.added, sheet, line(links)),
    ...section(`${REVOKED} Removed from the register: revoked or surrendered, the register does not say which (workers have ~60 days; Ateca candidates / Osbrooks clients)`, d.revoked, sheet, line(links)),
    ...section('Reinstated', d.reinstated, sheet, line(links)),
    ...section('Moved / renamed (same sponsor, not new or revoked)', d.changed, sheet, changeLine(links)),
  ].join('\n');
}

async function main() {
  if (!DRY_RUN) slack.resolveWebhook(SLACK_CHANNEL); // fail fast, loudly, before any work
  const today = new Date().toISOString().slice(0, 10);
  const { csv } = await harvest({ log });
  const rows = parseRows(csv);
  log.info(`Register: ${rows.length} rows`);

  const sheets = openSheets();
  const gid = await ensureTab(sheets, { create: !DRY_RUN });
  const sheetRows = gid != null ? await readRows(sheets) : [];
  const d = diffSponsors(rows, sheetRows, today);
  const links = d.blocked || d.baseline ? new Map() : await resolveLinks(listedNames(d), { log });
  const text = message(d, today, sheetUrl(sheets, gid), links);

  if (d.blocked) log.warn(d.blocked);
  if (DRY_RUN) {
    console.log(`DRY RUN — would append ${d.appends.length} rows and update ${d.updates.length} rows. Slack message would be:\n${text}`);
    return;
  }
  if (!d.blocked) {
    await appendRows(sheets, d.appends);
    await updateRows(sheets, d.updates);
  }
  await slack.post(SLACK_CHANNEL, text);
  log.info(`Sheet updated: +${d.appends.length} rows, ${d.updates.length} status changes`);
}

await health.run(BOT, main, {
  dryRun: DRY_RUN,
  uuid: process.env.SLS_HC_UUID?.trim() || undefined, // legacy name; HC_UUID_SPONSOR_LICENCE_SCOUT also works
  log,
  onFailure: async (err) => {
    if (DRY_RUN) return;
    await slack.post(SLACK_CHANNEL, `FAILED - Sponsor Licence Scout: ${err.message}`);
  },
});

// health.run sets exitCode 1 on failure. Exit explicitly so lingering
// keep-alive sockets can never hold the Cloud Run Job open.
process.exit(process.exitCode ?? 0);