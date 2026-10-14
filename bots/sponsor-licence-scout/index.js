import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B1 Sponsor Licence Scout — entry point.
 *
 * Daily: download the Home Office register CSV, keep every sponsor in the
 * Google Sheet (tab "Sponsors"), append new ones, mark vanished ones Revoked,
 * and send one Slack message.
 *
 *   npm start -w bots/sponsor-licence-scout
 *   npm run dry-run -w bots/sponsor-licence-scout   # download + diff, print what would change; no Sheet writes, no Slack
 */
import { health, logger, slack, snapshot } from '@botarmy/core';
import { harvest, parseRows } from './harvest.js';
import { appendRows, diffSponsors, ensureTab, openSheets, readRows, updateRows } from './sheets.js';

const BOT = 'sponsor-licence-scout';
const DRY_RUN = process.argv.includes('--dry-run');
const SLACK_CHANNEL = 'sponsors'; // SLACK_WEBHOOK_URL_SPONSORS, else SLACK_WEBHOOK_URL
const LIST_LIMIT = 25;

const log = logger.forBot(BOT);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const line = (f) => `• ${esc(f[0])} — ${esc(f[1] || 'town not listed')} (${esc(f[4])})`;

function section(title, rows) {
  if (!rows.length) return [];
  const shown = rows.slice(0, LIST_LIMIT).map(line);
  if (rows.length > LIST_LIMIT) shown.push(`...and ${rows.length - LIST_LIMIT} more (see sheet)`);
  return ['', `*${title}* (${rows.length})`, ...shown];
}

// Only two emoji, so they stand out: green circle = new sponsor, red circle = revoked.
const NEW = ':large_green_circle:';
const REVOKED = ':red_circle:';
const n = (x) => Number(x).toLocaleString('en-GB');

function message(d, today) {
  if (d.blocked) return `WARNING - Sponsor register ${today}: ${d.blocked}. Check the download.`;
  if (d.baseline) return `Sponsor register ${today}: baseline loaded: ${n(d.appends.length)} sponsors`;
  return [
    `*Sponsor register ${today}*`,
    `${NEW} ${n(d.added.length)} new   ${REVOKED} ${n(d.revoked.length)} revoked   ${n(d.reinstated.length)} reinstated   ·   ${n(d.activeAfter)} active`,
    ...section(`${NEW} New sponsors (Ateca leads)`, d.added),
    ...section(`${REVOKED} Revoked (workers have ~60 days; Ateca candidates / Osbrooks clients)`, d.revoked),
    ...section('Reinstated', d.reinstated),
  ].join('\n');
}

async function main() {
  if (!DRY_RUN) slack.resolveWebhook(SLACK_CHANNEL); // fail fast, loudly, before any work
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { snapshot: snap } = await harvest({ store, log });
    const rows = parseRows(store.readRaw(snap.id));
    log.info(`Register: ${rows.length} rows`);

    const sheets = openSheets();
    const hasTab = await ensureTab(sheets, { create: !DRY_RUN });
    const sheetRows = hasTab ? await readRows(sheets) : [];
    const d = diffSponsors(rows, sheetRows, today);
    const text = message(d, today);

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
  } finally {
    store.close();
  }
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