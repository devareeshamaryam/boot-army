import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B2 Mandate Matcher — entry point.
 *
 *   npm start -w bots/mandate-matcher
 *   npm run dry-run -w bots/mandate-matcher          # zero writes: in-memory DB copies, no Slack, no pings
 *   npm run retention -w bots/mandate-matcher        # only the UK GDPR retention job
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { BOT_DIR, harvestFcaDestinations, harvestRosters } from './harvest.js';
import {
  BOT, activeMandates, applyDestinations, digestMovers, fcaLeaversNeedingDestination, markNotified,
  pendingIdentityReviews, processRoster, purgeExpired, recordMovers, scorePending, syncWatchlist, validateWatchlist,
} from './process.js';
import { TOP_N, buildDigest, buildFailureAlert } from './digest.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RETENTION_ONLY = args.includes('--retention-only');
const SLACK_CHANNEL = 'mandates'; // SLACK_WEBHOOK_URL_MANDATES, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

/** Read settings lazily, after dotenv has loaded. All numbers validated by core.config. */
function loadSettings() {
  return config.load({
    MM_WATCHLIST: { default: fileURLToPath(new URL('./watchlist.json', import.meta.url)) },
    MM_MAX_DROP_RATIO: { type: 'number', default: 0.5, min: 0, max: 1 },
    MM_MOVE_LOOKBACK_DAYS: { type: 'number', default: 90, min: 1, integer: true },
    MM_MATCH_THRESHOLD: { type: 'number', default: 92, min: 0, max: 100 },
    MM_REVIEW_FLOOR: { type: 'number', default: 80, min: 0, max: 100 },
    MM_RETENTION_DAYS: { type: 'number', default: 365, min: 30, integer: true },
    MM_MAX_DESTINATION_LOOKUPS: { type: 'number', default: 25, min: 0, integer: true },
    MM_REVIEW_DIGEST_WEEKDAY: { type: 'number', default: 1, min: 0, max: 6, integer: true }, // 1 = Monday
  });
}

function loadWatchlist(file) {
  if (!existsSync(file)) throw new Error(`Watchlist not found at ${file}. Copy watchlist.example.json to watchlist.json.`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`watchlist.json is not valid JSON: ${err.message}`);
  }
  return validateWatchlist(raw);
}

async function deliver(message) {
  if (DRY_RUN) {
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  await slack.post(SLACK_CHANNEL, message);
}

async function main() {
  const s = loadSettings();
  if (s.MM_REVIEW_FLOOR > s.MM_MATCH_THRESHOLD) throw new Error('MM_REVIEW_FLOOR must not exceed MM_MATCH_THRESHOLD');
  const settings = {
    maxDropRatio: s.MM_MAX_DROP_RATIO, moveLookbackDays: s.MM_MOVE_LOOKBACK_DAYS,
    matchThreshold: s.MM_MATCH_THRESHOLD, reviewFloor: s.MM_REVIEW_FLOOR,
  };
  if (!DRY_RUN && !RETENTION_ONLY) slack.resolveWebhook(SLACK_CHANNEL); // fail fast before any work

  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    const now = new Date().toISOString();
    log.info(DRY_RUN ? 'Dry run: in-memory copies, nothing will be written' : 'Live run', { dataDir: config.dataDir() });

    if (RETENTION_ONLY) {
      const r = purgeExpired({ db, spine, now, retentionDays: s.MM_RETENTION_DAYS, log });
      log.info('Retention job finished', r);
      return;
    }

    const watchlist = loadWatchlist(s.MM_WATCHLIST);
    syncWatchlist(db, watchlist, now);
    const runId = Number(db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);

    // 1. Harvest: raw snapshots only.
    const { fetches, failures } = await harvestRosters(watchlist.firms, { store, baseDir: BOT_DIR, log });
    const warnings = failures.map((f) => `${f.firmKey}: ${f.error}`);

    // 2. Process each firm's roster (baseline / diff / drop guard).
    let processed = 0;
    let rejected = 0;
    for (const fetch of fetches) {
      try {
        const r = processRoster({ db, spine, store, fetch, settings, now, log });
        if (r.outcome === 'rejected') {
          rejected += 1;
          warnings.push(`${fetch.firmKey}: roster snapshot rejected, ${r.note}`);
        } else processed += 1;
      } catch (err) {
        warnings.push(`${fetch.firmKey}: ${err.message}`);
        log.error(`${fetch.firmKey}: ${err.message}`);
      }
    }
    if (watchlist.firms.length && processed === 0) {
      await deliver(buildFailureAlert({ date: now.slice(0, 10), problems: warnings }));
      const err = new Error(`No firm roster could be processed (${warnings.length} problems)`);
      err.alerted = true;
      throw err;
    }

    // 3. Movers, then destinations for FCA leavers (harvest → snapshot → process).
    const counts = recordMovers({ db, spine, settings, now, log });
    const needing = fcaLeaversNeedingDestination(db, s.MM_MAX_DESTINATION_LOOKUPS);
    if (needing.length) {
      const snaps = await harvestFcaDestinations([...new Set(needing.map((m) => m.person_ref))], { store, log });
      applyDestinations(db, store, snaps);
    }

    // 4. Score, retention, digest.
    scorePending(db, { mandates: activeMandates(db), scoring: watchlist.scoring, now });
    const retention = purgeExpired({ db, spine, now, retentionDays: s.MM_RETENTION_DAYS, log });

    const totalPending = db.prepare(`SELECT COUNT(*) FROM movers WHERE superseded_by IS NULL AND notified_at IS NULL`).pluck().get();
    const movers = digestMovers(db, TOP_N);
    const reviewItems = pendingIdentityReviews(spine);
    const reviews = { pending: reviewItems.length, items: reviewItems, showItems: new Date(now).getUTCDay() === s.MM_REVIEW_DIGEST_WEEKDAY };

    if (movers.length || warnings.length || (reviews.showItems && reviews.pending)) {
      await deliver(buildDigest({ movers, totalPending, date: now.slice(0, 10), warnings, reviews, stats: { firms: processed + rejected, retention } }));
      if (!DRY_RUN) markNotified(db, movers.map((m) => m.id), now);
    } else {
      log.info('Nothing new; no Slack message');
    }

    const stats = { firms: watchlist.firms.length, processed, rejected, failed: failures.length, ...counts, notified: movers.length, retention };
    db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?`)
      .run(new Date().toISOString(), warnings.length ? 'partial' : 'ok', JSON.stringify(stats), runId);
    log.info('Run complete', stats);
  } finally {
    db.close();
    store.close();
    spine.close();
  }
}

await health.run(BOT, main, {
  dryRun: DRY_RUN,
  log,
  onFailure: async (err) => {
    if (DRY_RUN || err.alerted) return;
    await slack.post(SLACK_CHANNEL, `:rotating_light: Mandate Matcher failed: ${err.message}`);
  },
});