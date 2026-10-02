import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B4 Distress Scout — entry point.
 *
 *   npm start -w bots/distress-scout
 *   npm run dry-run -w bots/distress-scout     # zero writes: in-memory DB copies, no Slack, no pings
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { BOT_DIR, harvestCompaniesHouse, harvestCsvFeeds, harvestGazette, harvestNotices, windowHasWeekday } from './harvest.js';
import {
  BOT, companiesDueLookup, entriesNeedingFullText, evaluateCompanies, getCursor, markNotified, noticeTexts,
  pendingTransitions, processCompaniesHouse, processCsv, processGazette, recordSourceRun, setCursor, syncWatchlist,
  validateConfig, volumeAnomaly,
} from './process.js';
import { buildAnomalyAlert, buildDigest } from './digest.js';

const DRY_RUN = process.argv.includes('--dry-run');
const DEFAULT_CHANNEL = 'distress'; // SLACK_WEBHOOK_URL_DISTRESS, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

/** Read settings lazily, after dotenv has loaded. All numbers validated by core.config. */
function loadSettings() {
  return config.load({
    DS_CONFIG: { default: fileURLToPath(new URL('./distress.json', import.meta.url)) },
    DS_MAX_PER_TIER: { type: 'number', default: 15, min: 1, max: 40, integer: true },
    CH_API_KEY: { secret: true, description: 'Companies House REST API key' },
    DS_NOW: { description: 'override the run time (testing / backfill only)' },
  });
}

function loadConfigFile(file) {
  if (!existsSync(file)) throw new Error(`Config not found at ${file}. Copy distress.example.json to distress.json.`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`distress.json is not valid JSON: ${err.message}`);
  }
  return validateConfig(raw);
}

async function deliver(channel, message) {
  if (DRY_RUN) {
    console.log(JSON.stringify({ channel, ...message }, null, 2));
    return;
  }
  await slack.post(channel, message);
}

async function main() {
  const s = loadSettings();
  if (s.DS_NOW && !Number.isFinite(Date.parse(s.DS_NOW))) throw new Error('DS_NOW must be an ISO timestamp');
  const cfg = loadConfigFile(s.DS_CONFIG);
  const talentChannels = cfg.routes.TALENT ?? [];
  if (!DRY_RUN) for (const ch of new Set([DEFAULT_CHANNEL, ...Object.values(cfg.routes).flat()])) slack.resolveWebhook(ch); // fail fast

  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    const now = s.DS_NOW ? new Date(s.DS_NOW).toISOString() : new Date().toISOString();
    const date = now.slice(0, 10);
    const runId = Number(db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
    log.info(DRY_RUN ? 'Dry run: in-memory copies, nothing will be written' : 'Live run', { dataDir: config.dataDir(), watchlist: cfg.watchlist.length });
    syncWatchlist(db, cfg.watchlist, now);

    const touched = new Set();
    const problems = [];
    const warnings = [];
    const stats = { gazetteNotices: 0, solventSkipped: 0, historic: 0, chLookups: 0 };
    let attempted = 0;
    let succeeded = 0;

    // 1. The Gazette.
    if (cfg.gazette.enabled !== false) {
      attempted += 1;
      try {
        const g = await harvestGazette({ store, cursor: getCursor(db, 'gazette'), now, cfg: cfg.gazette });
        const weekday = windowHasWeekday(g.window);
        const anomaly = volumeAnomaly(db, 'gazette', g.items, weekday, cfg.volumeGuard);
        if (anomaly) {
          problems.push(anomaly);
          recordSourceRun(db, { runId, source: 'gazette', items: g.items, weekday, outcome: 'anomaly', note: anomaly, now });
        } else {
          const needFull = cfg.gazette.fetchFullNotices ? entriesNeedingFullText(store, g.snapshotIds, { db, limit: cfg.gazette.maxNoticeFetches }) : [];
          const noticeSnaps = needFull.length ? await harvestNotices(needFull, { store, log }) : new Map();
          const r = processGazette({ db, spine, store, snapshotIds: g.snapshotIds, fullTextById: noticeTexts(store, noticeSnaps), now });
          r.touched.forEach((k) => touched.add(k));
          stats.gazetteNotices = r.stats.entries;
          stats.solventSkipped = r.stats.solvent;
          warnings.push(...r.failures);
          if (r.stats.unresolved) warnings.push(`${r.stats.unresolved} Gazette notice(s) published no company number; kept by name only`);
          if (g.truncated) warnings.push('Gazette: stopped at the page limit; the rest of the window is collected next run');
          if (!r.failures.length) setCursor(db, 'gazette', g.nextCursor, now);
          recordSourceRun(db, { runId, source: 'gazette', items: g.items, weekday, outcome: r.failures.length ? 'failed' : 'ok', note: r.failures[0] ?? null, now });
          succeeded += 1;
          log.info(`Gazette ${g.window.from}..${g.window.to}: ${g.items} notices, ${r.stats.records} distress records`, r.stats);
        }
      } catch (err) {
        problems.push(`gazette: ${err.message}`);
        recordSourceRun(db, { runId, source: 'gazette', items: 0, weekday: true, outcome: 'failed', note: err.message, now });
        log.error(`gazette: ${err.message}`);
      }
    }

    // 2. Companies House: watchlist + companies just seen in the Gazette.
    if (cfg.companiesHouse.enabled !== false) {
      const keys = companiesDueLookup(db, {
        extraKeys: cfg.companiesHouse.lookupGazetteCompanies ? [...touched] : [],
        refreshDays: cfg.companiesHouse.refreshDays, limit: cfg.companiesHouse.maxLookups, now,
      });
      if (keys.length && !s.CH_API_KEY) {
        warnings.push(`Companies House lookups skipped for ${keys.length} compan${keys.length === 1 ? 'y' : 'ies'}: set CH_API_KEY`);
      } else if (keys.length) {
        attempted += 1;
        try {
          const lookups = await harvestCompaniesHouse(keys.map((k) => k.slice(3)), { store, log });
          for (const lookup of lookups) {
            const r = processCompaniesHouse({ db, spine, store, lookup, now });
            r.touched.forEach((k) => touched.add(k));
            warnings.push(...r.warnings);
          }
          stats.chLookups = lookups.length;
          if (lookups.some((l) => l.status !== 'failed')) succeeded += 1;
        } catch (err) {
          problems.push(`companies-house: ${err.message}`);
        }
      }
    }

    // 3. CSV feeds.
    if (cfg.csvFeeds.length) {
      attempted += 1;
      const { fetched, failures } = await harvestCsvFeeds(cfg.csvFeeds, { store, baseDir: BOT_DIR });
      problems.push(...failures.map((f) => `${f.source}: ${f.error}`));
      if (fetched.length) {
        succeeded += 1;
        const r = processCsv({ db, spine, store, fetched, feeds: cfg.csvFeeds, now });
        r.touched.forEach((k) => touched.add(k));
        warnings.push(...r.warnings);
      }
    }

    if (attempted && !succeeded) {
      await deliver(DEFAULT_CHANNEL, buildAnomalyAlert({ date, problems, halted: true }));
      const err = new Error(`Every source failed (${problems.length} problems)`);
      err.alerted = true;
      throw err;
    }

    // 4. State machine → transitions + tags.
    const counts = evaluateCompanies({ db, companyKeys: [...touched], tagRules: cfg.tagRules, alertWindowDays: cfg.alertWindowDays, now });
    stats.historic = counts.historic;

    // 5. Report: main digest, then TALENT-tagged changes to the talent channels.
    if (problems.length) await deliver(DEFAULT_CHANNEL, buildAnomalyAlert({ date, problems }));
    const pending = pendingTransitions(db);
    if (pending.length) {
      await deliver(DEFAULT_CHANNEL, buildDigest({ transitions: pending, date, warnings, stats, maxPerTier: s.DS_MAX_PER_TIER }));
      const talent = pending.filter((t) => t.tags.some((x) => x.tag === 'TALENT'));
      for (const ch of talentChannels) {
        if (talent.length) await deliver(ch, buildDigest({ transitions: talent, date, title: 'Distress Scout · TALENT', stats: {}, maxPerTier: s.DS_MAX_PER_TIER }));
      }
      if (!DRY_RUN) markNotified(db, pending.map((t) => t.id), now);
      log.info(`${DRY_RUN ? 'Would post' : 'Posted'} ${pending.length} transitions (${talent.length} TALENT)`);
    } else {
      log.info('No tier changes; no digest');
    }

    db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?`)
      .run(new Date().toISOString(), problems.length || warnings.length ? 'partial' : 'ok', JSON.stringify({ ...stats, ...counts, touched: touched.size }), runId);
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
    await slack.post(DEFAULT_CHANNEL, `:rotating_light: Distress Scout failed: ${err.message}`);
  },
});