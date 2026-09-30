import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B1 Sponsor Licence Scout — entry point.
 *
 *   npm start -w bots/sponsor-licence-scout
 *   npm run dry-run -w bots/sponsor-licence-scout      # zero writes: no DB files, no Slack, no pings
 *   node bots/sponsor-licence-scout/index.js --from-snapshot 42   # re-process a stored snapshot
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { harvest, SOURCE } from './harvest.js';
import { AnomalyError, BOT, buildWatchMatcher, markNotified, pendingDiffs, processSnapshot } from './process.js';
import { buildAnomalyAlert, buildDigest } from './digest.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FROM_SNAPSHOT = args.includes('--from-snapshot') ? Number(args[args.indexOf('--from-snapshot') + 1]) : null;
const SLACK_CHANNEL = 'sponsors'; // SLACK_WEBHOOK_URL_SPONSORS, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

/** Read settings lazily, after dotenv has loaded. */
function loadSettings() {
  return {
    minOrgs: config.number('SLS_MIN_ORGS', 1000),
    maxDropRatio: config.number('SLS_MAX_DROP_RATIO', 0.1),
    watchlistPath: config.optional('SLS_WATCHLIST', fileURLToPath(new URL('./watchlist.json', import.meta.url))),
  };
}

function loadWatchlist(path) {
  if (!existsSync(path)) return { additionRoutes: [], match: () => null };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { additionRoutes: raw.additionRoutes ?? [], match: buildWatchMatcher(raw) };
}

async function deliver(message) {
  if (DRY_RUN) {
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  await slack.post(SLACK_CHANNEL, message);
}

async function main() {
  const settings = loadSettings();
  if (!DRY_RUN) slack.resolveWebhook(SLACK_CHANNEL); // fail fast, loudly, before any work
  if (FROM_SNAPSHOT !== null && !Number.isInteger(FROM_SNAPSHOT)) throw new Error('--from-snapshot needs a numeric snapshot id');
  const watchlist = loadWatchlist(settings.watchlistPath);

  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    log.info(DRY_RUN ? 'Dry run: working on in-memory copies; nothing will be written' : 'Live run', { dataDir: config.dataDir() });

    // 1. Harvest (snapshot-first) or pick a stored snapshot.
    let snapshotId;
    if (FROM_SNAPSHOT !== null) {
      const row = store.get(FROM_SNAPSHOT);
      if (!row || row.source !== SOURCE) throw new Error(`Snapshot ${FROM_SNAPSHOT} is not a ${SOURCE} snapshot`);
      snapshotId = FROM_SNAPSHOT;
    } else {
      snapshotId = (await harvest({ store, log })).snapshot.id;
    }

    // 2. Process.
    let result;
    try {
      result = processSnapshot({ db, spine, store, snapshotId, watchMatch: watchlist.match, settings, log });
    } catch (err) {
      if (err instanceof AnomalyError) {
        log.error(`Snapshot rejected: ${err.message}`, err.details);
        await deliver(buildAnomalyAlert({ reason: err.message, ...err.details }));
        err.alerted = true;
      }
      throw err; // halt: health.run pings /fail and sets exit code 1
    }
    if (result.outcome === 'already-processed') {
      log.info(`Snapshot ${snapshotId} already processed (${result.previousOutcome}); nothing new`);
    }

    // 3. Notify (includes diffs left over from an earlier failed post).
    const pending = pendingDiffs(db);
    if (!pending.length) {
      log.info('No pending changes; no Slack message');
      return;
    }
    const latest = pending.at(-1);
    const suppressed = db.prepare(`SELECT kind, COUNT(*) AS n FROM suppressed_changes WHERE snapshot_id = ? GROUP BY kind`).all(snapshotId)
      .reduce((acc, r) => ({ ...acc, [r.kind]: r.n }), {});
    const orgCount = db.prepare(`SELECT COUNT(*) FROM sponsors WHERE active = 1`).pluck().get();
    await deliver(buildDigest({
      diffs: pending,
      additionRoutes: watchlist.additionRoutes,
      meta: { publishedDate: result.publishedDate ?? latest.published_date, orgCount, relocated: suppressed.RELOCATED ?? 0, renamed: suppressed.RENAMED ?? 0, sourceUrl: latest.source_url },
    }));
    if (!DRY_RUN) markNotified(db, pending.map((d) => d.id));
    log.info(`${DRY_RUN ? 'Would post' : 'Posted'} digest with ${pending.length} changes`);
  } finally {
    db.close();
    spine.close();
    store.close();
  }
}

await health.run(BOT, main, {
  dryRun: DRY_RUN,
  uuid: process.env.SLS_HC_UUID?.trim() || undefined, // legacy name; HC_UUID_SPONSOR_LICENCE_SCOUT also works
  log,
  onFailure: async (err) => {
    if (DRY_RUN || err.alerted) return;
    await slack.post(SLACK_CHANNEL, `:rotating_light: Sponsor Licence Scout failed: ${err.message}`);
  },
});