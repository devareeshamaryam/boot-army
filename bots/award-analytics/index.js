import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B6 Award Analytics — entry point.
 *
 *   npm start -w bots/award-analytics                     # daily incremental run
 *   npm run dry-run -w bots/award-analytics               # zero writes: in-memory DB copies, no Slack, no pings
 *   npm run backfill -w bots/award-analytics              # 24-month backfill, resumable: re-run until it reports 0 pending
 *   node bots/award-analytics/index.js --backfill --max-windows 10
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { SOURCE_IDS, harvestWindow } from './harvest.js';
import {
  BOT, backfillProgress, dailyWindow, emitBuyerEvents, getCursor, markAwardsNotified, markShiftsNotified, markWindow,
  pendingMajorAwards, pendingShifts, pendingWindows, planBackfill, processSnapshots, queueSupplierReviews, recordSourceRun,
  setCursor, topNewWinners, validateConfig, volumeAnomaly,
} from './process.js';
import { reconcile, recomputeBuyers, recomputeSuppliers } from './analytics.js';
import { buildAnomalyAlert, buildDigest } from './digest.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BACKFILL = args.includes('--backfill');
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const SLACK_CHANNEL = 'awards'; // SLACK_WEBHOOK_URL_AWARDS, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

function loadSettings() {
  return config.load({
    AA_CONFIG: { default: fileURLToPath(new URL('./awards.json', import.meta.url)) },
    AA_NOW: { description: 'override the run time (testing only)' },
  });
}

function loadConfigFile(file) {
  if (!existsSync(file)) return validateConfig({}); // every source on, documented defaults
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`awards.json is not valid JSON: ${err.message}`);
  }
  return validateConfig(raw);
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
  if (s.AA_NOW && !Number.isFinite(Date.parse(s.AA_NOW))) throw new Error('AA_NOW must be an ISO timestamp');
  const cfg = loadConfigFile(s.AA_CONFIG);
  const maxWindowsArg = argValue('--max-windows');
  if (maxWindowsArg !== undefined && !/^\d+$/.test(maxWindowsArg)) throw new Error('--max-windows needs a whole number');
  if (!DRY_RUN) slack.resolveWebhook(SLACK_CHANNEL); // fail fast

  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    const now = s.AA_NOW ? new Date(s.AA_NOW).toISOString() : new Date().toISOString();
    const runId = Number(db.prepare(`INSERT INTO runs (started_at, mode) VALUES (?, ?)`).run(now, BACKFILL ? 'backfill' : 'daily').lastInsertRowid);
    const enabled = SOURCE_IDS.filter((id) => cfg.sources[id].enabled !== false);
    log.info(`${DRY_RUN ? 'Dry run · ' : ''}${BACKFILL ? 'backfill' : 'daily'} run`, { sources: enabled });

    const buyers = new Set();
    const suppliers = new Set();
    const problems = [];
    const warnings = [];
    let newAwards = 0;
    let attempted = 0;
    let succeeded = 0;
    const absorb = (r) => {
      r.buyers.forEach((b) => buyers.add(b));
      r.suppliers.forEach((x) => suppliers.add(x));
      newAwards += r.newAwards;
      warnings.push(...r.failures);
    };

    if (BACKFILL) {
      // Windows are marked done only after their snapshots are processed: a killed backfill resumes here.
      const months = Number(argValue('--months') ?? cfg.backfill.months);
      if (!Number.isInteger(months) || months < 1) throw new Error('--months needs a whole number ≥ 1');
      const added = planBackfill(db, { sources: enabled, months, chunkDays: cfg.backfill.chunkDays, now });
      if (added) log.info(`Planned ${added} backfill windows`);
      for (const w of pendingWindows(db, Number(maxWindowsArg ?? cfg.backfill.maxWindowsPerRun))) {
        attempted += 1;
        try {
          const h = await harvestWindow(w.source, { from: w.from, to: w.to }, { store, cfg: { ...cfg.sources[w.source], maxPages: cfg.sources[w.source].backfillMaxPages ?? 200 } });
          const anomaly = volumeAnomaly(db, w.source, h.items, cfg.volumeGuard);
          if (anomaly) {
            warnings.push(`backfill ${w.source} ${w.from.slice(0, 10)}: ${anomaly}; window left pending`);
            recordSourceRun(db, { runId, source: w.source, items: h.items, outcome: 'anomaly', note: anomaly, now });
            continue;
          }
          const r = processSnapshots({ db, spine, store, snapshotIds: h.snapshotIds, now });
          absorb(r);
          if (r.failures.length) continue; // window stays pending: retried next run
          markWindow(db, { source: w.source, from: w.from, status: h.truncated ? 'truncated' : 'done', items: h.items, now });
          if (h.truncated) warnings.push(`backfill ${w.source} ${w.from.slice(0, 10)}: page limit reached; raise sources.${w.source}.backfillMaxPages or chunkDays smaller`);
          recordSourceRun(db, { runId, source: w.source, items: h.items, outcome: 'ok', now });
          succeeded += 1;
        } catch (err) {
          warnings.push(`backfill ${w.source} ${w.from.slice(0, 10)}: ${err.message}`);
          log.error(`backfill ${w.source} ${w.from}: ${err.message}`);
        }
      }
    } else {
      for (const source of enabled) {
        attempted += 1;
        const window = dailyWindow(getCursor(db, source), now, cfg.sources[source].lookbackDays);
        try {
          const h = await harvestWindow(source, window, { store, cfg: cfg.sources[source] });
          const anomaly = volumeAnomaly(db, source, h.items, cfg.volumeGuard);
          if (anomaly) {
            problems.push(anomaly);
            recordSourceRun(db, { runId, source, items: h.items, outcome: 'anomaly', note: anomaly, now });
            continue;
          }
          const r = processSnapshots({ db, spine, store, snapshotIds: h.snapshotIds, now });
          absorb(r);
          if (!r.failures.length && !h.truncated) setCursor(db, source, window.to, now);
          if (h.truncated) warnings.push(`${source}: page limit reached; the rest of the window is collected next run`);
          recordSourceRun(db, { runId, source, items: h.items, outcome: r.failures.length ? 'failed' : 'ok', note: r.failures[0] ?? null, now });
          succeeded += 1;
          log.info(`${source}: ${h.items} releases, ${r.newAwards} new awards`);
        } catch (err) {
          problems.push(`${source}: ${err.message}`);
          recordSourceRun(db, { runId, source, items: 0, outcome: 'failed', note: err.message, now });
          log.error(`${source}: ${err.message}`);
        }
      }
    }

    if (attempted && !succeeded && !BACKFILL) {
      await deliver(buildAnomalyAlert({ date: now.slice(0, 10), problems, halted: true }));
      const err = new Error(`Every source failed (${problems.length} problems)`);
      err.alerted = true;
      throw err;
    }

    // Analytics, reviews, spine events, consistency.
    recomputeSuppliers(db, [...suppliers], { now });
    const changed = recomputeBuyers(db, [...buyers], { now, ...cfg.analytics });
    const reviews = queueSupplierReviews({ db, spine, supplierKeys: [...suppliers], now });
    const events = emitBuyerEvents({ db, spine, changedRows: changed, now });
    const inconsistencies = reconcile(db);
    if (inconsistencies.length) warnings.push(...inconsistencies.map((p) => `reconcile: ${p}`));
    const progress = backfillProgress(db);
    log.info('Analytics updated', { newAwards, buyers: buyers.size, suppliers: suppliers.size, reviews, events, backfill: progress });

    // Report. Backfills record history silently: announcing years of old awards would flood Slack.
    if (problems.length) await deliver(buildAnomalyAlert({ date: now.slice(0, 10), problems }));
    if (BACKFILL) {
      if (!DRY_RUN) { markAwardsNotified(db, now); markShiftsNotified(db, now); }
      log.info(`Backfill: ${progress.pending ?? 0} windows pending${progress.pending ? ' — run again to continue' : ', complete'}`);
    } else {
      const since = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
      const awards = pendingMajorAwards(db, cfg.majorAward, cfg.digest.maxAwards);
      const shifts = pendingShifts(db, cfg.digest.maxShifts);
      const winners = newAwards ? topNewWinners(db, since, cfg.digest.topSuppliers) : [];
      if (awards.length || shifts.length || warnings.length) {
        await deliver(buildDigest({ awards, winners, shifts, date: now.slice(0, 10), warnings, stats: { newAwards, backfill: progress.pending ? progress : null } }));
      } else {
        log.info('Nothing to announce; no Slack message');
      }
      if (!DRY_RUN) { markAwardsNotified(db, now); markShiftsNotified(db, now); }
    }

    db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?`)
      .run(new Date().toISOString(), problems.length || warnings.length ? 'partial' : 'ok',
        JSON.stringify({ newAwards, buyers: buyers.size, suppliers: suppliers.size, reviews, events, backfill: progress }), runId);
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
    await slack.post(SLACK_CHANNEL, `:rotating_light: Award analytics failed: ${err.message}`);
  },
});