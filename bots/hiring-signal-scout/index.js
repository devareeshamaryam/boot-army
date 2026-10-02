import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B5 Hiring-Signal Scout — entry point.
 *
 *   npm start -w bots/hiring-signal-scout
 *   npm run dry-run -w bots/hiring-signal-scout     # zero writes: in-memory DB copies, no Slack, no pings
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { harvestAll } from './harvest.js';
import {
  BOT, buildMatcher, getCursor, markNotified, pendingSignals, processAwards, processBoards, processFunding,
  setCursor, spikeCandidates, syncWatchlist, upsertSignals, validateWatchlist,
} from './process.js';
import { buildDigest, buildFailureAlert } from './digest.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SLACK_CHANNEL = 'hiring'; // SLACK_WEBHOOK_URL_HIRING, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

/** Read settings lazily, after dotenv has loaded. All numbers validated by core.config. */
function loadSettings() {
  return config.load({
    HSS_WATCHLIST: { default: fileURLToPath(new URL('./watchlist.json', import.meta.url)) },
    HSS_MAX_DROP_RATIO: { type: 'number', default: 0.6, min: 0, max: 1 },
    HSS_MAX_SIGNALS_PER_TYPE: { type: 'number', default: 15, min: 1, max: 40, integer: true },
  });
}

function loadWatchlist(file) {
  if (!existsSync(file)) throw new Error(`Watchlist not found at ${file}`);
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
  if (!DRY_RUN) slack.resolveWebhook(SLACK_CHANNEL); // fail fast, loudly, before any work
  const watchlist = loadWatchlist(s.HSS_WATCHLIST);

  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    const now = new Date().toISOString();
    const runId = Number(db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
    log.info(`${DRY_RUN ? 'Dry run: in-memory copies, nothing will be written · ' : ''}${watchlist.companies.length} companies`, { dataDir: config.dataDir() });

    // 1. Harvest: raw snapshots only.
    const harvest = await harvestAll(watchlist, { store, getCursor: (id) => getCursor(db, id), now, log });
    harvest.notes.forEach((n) => log.info(n));
    for (const u of harvest.unsupported) log.warn(`${u.name} (${u.atsType}): unsupported, ${u.reason}`);
    const fetched = harvest.awards.reduce((n, a) => n + a.snapshotIds.length, 0) + harvest.boards.length + harvest.jobFeeds.length + harvest.funding.length;
    const failures = harvest.failures.map((f) => `${f.source}: ${f.error}`);
    if (!fetched && failures.length) {
      await deliver(buildFailureAlert({ date: now.slice(0, 10), problems: failures }));
      const err = new Error(`Every source failed (${failures.length})`);
      err.alerted = true;
      throw err;
    }

    // 2. Process.
    syncWatchlist({ db, spine, watchlist, unsupported: harvest.unsupported, now });
    const matcher = buildMatcher(watchlist.companies);
    const awards = processAwards({ db, store, fetches: harvest.awards, watchlist, matcher, now, log });
    const boards = processBoards({ db, store, boards: harvest.boards, jobFeeds: harvest.jobFeeds, watchlist, matcher, settings: { maxDropRatio: s.HSS_MAX_DROP_RATIO }, now, log });
    const spikes = spikeCandidates({ db, boardResults: boards.results, watchlist, now });
    const funding = processFunding({ db, store, fetches: harvest.funding, watchlist, matcher, now });
    const signalCounts = upsertSignals({ db, spine, candidates: [...awards.candidates, ...spikes, ...funding], now, log });

    // Cursors advance only after their snapshots were processed.
    for (const a of harvest.awards) if (a.nextCursor) setCursor(db, a.sourceId, a.nextCursor, now);

    // 3. Report.
    const warnings = [...failures, ...awards.stats.failures, ...boards.warnings];
    const pending = pendingSignals(db);
    if (pending.length || failures.length) {
      await deliver(buildDigest({ signals: pending, date: now.slice(0, 10), warnings, unsupported: harvest.unsupported, maxPerType: s.HSS_MAX_SIGNALS_PER_TYPE }));
      if (!DRY_RUN) markNotified(db, pending.map((x) => x.id));
      log.info(`${DRY_RUN ? 'Would post' : 'Posted'} digest with ${pending.length} signals`);
    } else {
      log.info('No new signals; no Slack message');
    }

    const stats = {
      awards: awards.stats, boards: boards.results.length, rejectedBoards: boards.results.filter((r) => r.outcome === 'rejected').length,
      unsupported: harvest.unsupported.length, signals: signalCounts, failures: failures.length,
    };
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
    await slack.post(SLACK_CHANNEL, `:rotating_light: Hiring-Signal Scout failed: ${err.message}`);
  },
});