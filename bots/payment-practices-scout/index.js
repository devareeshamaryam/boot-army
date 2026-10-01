import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B9 Payment Practices Scout — entry point.
 *
 *   npm start -w bots/payment-practices-scout
 *   npm run dry-run -w bots/payment-practices-scout                  # zero writes: no DB files, no Slack, no pings
 *   npm run credit-check -w bots/payment-practices-scout -- "Acme"   # read-only company screen
 *   node bots/payment-practices-scout/index.js --from-snapshot 42    # re-process a stored export
 */
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { harvest, SOURCE } from './harvest.js';
import { AnomalyError, BOT, creditCheck, markNotified, pendingJumps, processSnapshot } from './process.js';
import { buildAnomalyAlert, buildDigest, formatCreditCheck } from './digest.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const FROM_SNAPSHOT = argValue('--from-snapshot');
const CREDIT_CHECK = args.includes('--credit-check') ? (argValue('--credit-check') ?? '') : null;
const SLACK_CHANNEL = 'payments'; // SLACK_WEBHOOK_URL_PAYMENTS, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

/** Read settings lazily, after dotenv has loaded. All numbers validated by core.config. */
function loadSettings() {
  const s = config.load({
    PPS_MIN_DAYS_INCREASE: { type: 'number', default: 15, min: 0 },
    PPS_MIN_PCT_INCREASE: { type: 'number', default: 30, min: 0 },
    PPS_MIN_AVG_DAYS: { type: 'number', default: 40, min: 0 },
    PPS_MIN_LATE_POINTS: { type: 'number', default: 20, min: 0, max: 100 },
    PPS_MIN_LATE_PCT: { type: 'number', default: 30, min: 0, max: 100 },
    PPS_MAX_GAP_DAYS: { type: 'number', default: 400, min: 1 },
    PPS_MIN_REPORTS: { type: 'number', default: 1000, min: 1, integer: true },
    PPS_MIN_RETAINED_RATIO: { type: 'number', default: 0.9, min: 0, max: 1 },
    PPS_PREVIEW_DAYS: { type: 'number', default: 30, min: 0, integer: true },
    PPS_MAX_ALERTS: { type: 'number', default: 25, min: 1, max: 45, integer: true },
  });
  return {
    rules: {
      minDaysIncrease: s.PPS_MIN_DAYS_INCREASE, minPctIncrease: s.PPS_MIN_PCT_INCREASE, minAvgDays: s.PPS_MIN_AVG_DAYS,
      minLatePoints: s.PPS_MIN_LATE_POINTS, minLatePct: s.PPS_MIN_LATE_PCT, maxGapDays: s.PPS_MAX_GAP_DAYS,
    },
    minReports: s.PPS_MIN_REPORTS,
    minRetainedRatio: s.PPS_MIN_RETAINED_RATIO,
    previewDays: s.PPS_PREVIEW_DAYS,
    maxAlerts: s.PPS_MAX_ALERTS,
  };
}

async function deliver(message) {
  if (DRY_RUN) {
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  await slack.post(SLACK_CHANNEL, message);
}

/** Read-only screen; never touches the network or writes anything. */
function runCreditCheck(query) {
  const db = coreDb.connect(BOT, { dryRun: true });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    console.log(formatCreditCheck(creditCheck(db, query), query));
  } finally {
    db.close();
  }
}

async function main() {
  if (CREDIT_CHECK !== null) {
    runCreditCheck(CREDIT_CHECK);
    return;
  }
  const settings = loadSettings();
  if (!DRY_RUN) slack.resolveWebhook(SLACK_CHANNEL); // fail fast, loudly, before any work
  if (FROM_SNAPSHOT !== undefined && !/^\d+$/.test(FROM_SNAPSHOT)) throw new Error('--from-snapshot needs a numeric snapshot id');

  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    log.info(DRY_RUN ? 'Dry run: in-memory copies, nothing will be written' : 'Live run', { dataDir: config.dataDir() });

    // 1. Harvest (snapshot-first) or pick a stored snapshot.
    let snapshotId;
    if (FROM_SNAPSHOT !== undefined) {
      const row = store.get(Number(FROM_SNAPSHOT));
      if (!row || row.source !== SOURCE) throw new Error(`Snapshot ${FROM_SNAPSHOT} is not a ${SOURCE} snapshot`);
      snapshotId = row.id;
    } else {
      snapshotId = (await harvest({ store, log })).snapshot.id;
    }

    // 2. Process.
    let result;
    try {
      result = processSnapshot({ db, spine, store, snapshotId, settings, log });
    } catch (err) {
      if (err instanceof AnomalyError) {
        log.error(`Export rejected: ${err.message}`, err.details);
        await deliver(buildAnomalyAlert({ reason: err.message, ...err.details }));
        err.alerted = true;
      }
      throw err; // halt: health.run pings /fail and sets exit code 1
    }
    if (DRY_RUN && result.mapping) log.info('Column mapping', result.mapping);
    if (result.outcome === 'already-processed') log.info(`Snapshot ${snapshotId} already processed (${result.previousOutcome}); nothing new`);
    if (result.outcome === 'baseline') {
      log.info(`Baseline stored; no alerts on a first run. Preview: ${result.preview.length} jumps among reports filed in the last ${settings.previewDays} days`);
      for (const j of result.preview.slice(0, 10)) {
        log.info(`  ${j.report.companyName}: ${j.prev.avgDaysToPay ?? '?'} → ${j.report.avgDaysToPay ?? '?'} days, data as of period ending ${j.report.periodEndDate}`);
      }
    }

    // 3. Notify (includes jumps left over from an earlier failed post).
    const pending = pendingJumps(db);
    if (!pending.length) {
      log.info('No pending jumps; no Slack message');
      return;
    }
    await deliver(buildDigest({ jumps: pending, date: new Date().toISOString().slice(0, 10), maxAlerts: settings.maxAlerts }));
    if (!DRY_RUN) markNotified(db, pending.map((j) => j.id));
    log.info(`${DRY_RUN ? 'Would post' : 'Posted'} digest with ${pending.length} jumps`);
  } finally {
    db.close();
    spine.close();
    store.close();
  }
}

await health.run(BOT, main, {
  dryRun: DRY_RUN || CREDIT_CHECK !== null,
  log,
  onFailure: async (err) => {
    if (DRY_RUN || CREDIT_CHECK !== null || err.alerted) return;
    await slack.post(SLACK_CHANNEL, `:rotating_light: Payment Practices Scout failed: ${err.message}`);
  },
});