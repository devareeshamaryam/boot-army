import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B7 Incorporation Scout — entry point.
 *
 *   npm start -w bots/incorporation-scout
 *   npm run dry-run -w bots/incorporation-scout     # zero writes: in-memory DB copies, no Slack, no pings
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { harvestOfficers, harvestSearch, streamSession } from './harvest.js';
import {
  BOT, companiesNeedingOfficers, countPending, getCursor, markNotified, pendingLeads, processOfficers, processSearch,
  processStream, querySicCodes, recordSourceRun, scoreCompanies, searchWindow, setCursor, syncWatchlists, validateConfig,
  volumeAnomaly, windowDays, windowHasWeekday,
} from './process.js';
import { buildAnomalyAlert, buildDigest } from './digest.js';

const DRY_RUN = process.argv.includes('--dry-run');
const ALERT_CHANNEL = 'incorporations'; // SLACK_WEBHOOK_URL_INCORPORATIONS, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

function loadSettings() {
  return config.load({
    IS_CONFIG: { default: fileURLToPath(new URL('./incorporations.json', import.meta.url)) },
    CH_API_KEY: { secret: true, description: 'Companies House REST API key' },
    IS_NOW: { description: 'override the run time (testing only)' },
  });
}

function loadConfigFile(file) {
  if (!existsSync(file)) throw new Error(`Config not found at ${file}. Copy incorporations.example.json to incorporations.json.`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`incorporations.json is not valid JSON: ${err.message}`);
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
  if (s.IS_NOW && !Number.isFinite(Date.parse(s.IS_NOW))) throw new Error('IS_NOW must be an ISO timestamp');
  const cfg = loadConfigFile(s.IS_CONFIG);
  if (!DRY_RUN) for (const ch of new Set([ALERT_CHANNEL, ...cfg.watchlists.map((w) => w.slackChannel)])) slack.resolveWebhook(ch); // fail fast

  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    const now = s.IS_NOW ? new Date(s.IS_NOW).toISOString() : new Date().toISOString();
    const date = now.slice(0, 10);
    const runId = Number(db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
    log.info(DRY_RUN ? 'Dry run: in-memory copies, nothing will be written' : 'Live run', { dataDir: config.dataDir(), watchlists: cfg.watchlists.length });
    syncWatchlists(db, cfg.watchlists, now);

    const touched = new Set();
    const problems = [];
    const warnings = [];
    const stats = { incorporations: 0, matched: 0, added: 0 };
    let attempted = 0;
    let succeeded = 0;

    // 1. Advanced search, one incorporation day at a time. The cursor advances to the last
    //    fully collected day, so a day that hits the page limit is resumed, never skipped or looped on.
    if (cfg.search.enabled !== false) {
      attempted += 1;
      const window = searchWindow(getCursor(db, 'search'), now, cfg.search);
      const weekday = windowHasWeekday(window);
      const sicCodes = querySicCodes(cfg.watchlists);
      if (!sicCodes.length) log.info('A watchlist uses SIC class/division prefixes: searching every incorporation and filtering locally');
      let items = 0;
      let lastComplete = null;
      try {
        const snapshotIds = [];
        for (const day of windowDays(window)) {
          const h = await harvestSearch({ store, window: { from: day, to: day }, sicCodes, cfg: cfg.search });
          snapshotIds.push(...h.snapshotIds);
          items += h.items;
          if (h.truncated) {
            warnings.push(`search ${day}: page limit reached (${h.hits ?? '?'} hits); the rest of that day is collected next run — raise sources.search.maxPages or pageSize`);
            break;
          }
          lastComplete = day;
        }
        const anomaly = volumeAnomaly(db, 'search', items, weekday, cfg.volumeGuard);
        if (anomaly) {
          problems.push(anomaly);
          recordSourceRun(db, { runId, source: 'search', items, weekday, outcome: 'anomaly', note: anomaly, now });
        } else {
          const r = processSearch({ db, spine, store, snapshotIds, watchlists: cfg.watchlists, formationAgents: cfg.formationAgents, now });
          r.touched.forEach((n) => touched.add(n));
          Object.assign(stats, { incorporations: stats.incorporations + r.items, matched: stats.matched + r.touched.length, added: stats.added + r.added });
          warnings.push(...r.failures);
          if (!r.failures.length && lastComplete) setCursor(db, 'search', lastComplete, now);
          recordSourceRun(db, { runId, source: 'search', items, weekday, outcome: r.failures.length ? 'failed' : 'ok', note: r.failures[0] ?? null, now });
          succeeded += 1;
          log.info(`Search ${window.from}..${window.to}: ${items} incorporations, ${r.touched.length} in target SIC codes`);
        }
      } catch (err) {
        problems.push(`search: ${err.message}`);
        recordSourceRun(db, { runId, source: 'search', items, weekday, outcome: 'failed', note: err.message, now });
        log.error(`search: ${err.message}`);
      }
    }

    // 2. Streaming API (optional): one bounded session from the last timepoint.
    if (cfg.stream.enabled) {
      attempted += 1;
      try {
        const sess = await streamSession({ store, timepoint: getCursor(db, 'stream'), ...cfg.stream, log });
        const r = processStream({ db, spine, store, snapshotIds: sess.snapshotIds, watchlists: cfg.watchlists, formationAgents: cfg.formationAgents, maxAgeDays: cfg.stream.maxAgeDays, now });
        r.touched.forEach((n) => touched.add(n));
        Object.assign(stats, { matched: stats.matched + r.touched.length, added: stats.added + r.added, streamEvents: r.events });
        if (r.malformed) warnings.push(`stream: ${r.malformed} malformed line(s) skipped`);
        if (sess.lastTimepoint) setCursor(db, 'stream', sess.lastTimepoint, now);
        if (sess.endedBy === 'gave-up') warnings.push(`stream: gave up after ${sess.reconnects} reconnects (${sess.error}); resumes from timepoint ${sess.lastTimepoint ?? 'live edge'} next run`);
        if (sess.events > 0 || sess.endedBy !== 'gave-up') succeeded += 1;
        log.info(`Stream: ${sess.events} events, ${r.touched.length} matched, ended by ${sess.endedBy}`);
      } catch (err) {
        problems.push(`stream: ${err.message}`);
      }
    }

    if (attempted && !succeeded) {
      await deliver(ALERT_CHANNEL, buildAnomalyAlert({ date, problems, halted: true }));
      const err = new Error(`Every source failed (${problems.length} problems)`);
      err.alerted = true;
      throw err;
    }

    // 3. Officers for matched companies (counts by role only).
    if (cfg.officers.enabled !== false) {
      const need = companiesNeedingOfficers(db, cfg.officers.maxLookups);
      if (need.length && !s.CH_API_KEY) warnings.push(`officer lookups skipped for ${need.length} compan${need.length === 1 ? 'y' : 'ies'}: set CH_API_KEY`);
      else if (need.length) {
        const results = await harvestOfficers(need, { store, log });
        processOfficers({ db, store, results, now }).forEach((n) => touched.add(n));
      }
    }

    // 4. Score and report: one digest per watchlist.
    scoreCompanies({ db, companyNumbers: [...touched], watchlists: cfg.watchlists, now });
    if (problems.length) await deliver(ALERT_CHANNEL, buildAnomalyAlert({ date, problems }));
    let posted = 0;
    for (const w of cfg.watchlists) {
      const leads = pendingLeads(db, w, cfg.digest.maxPerWatchlist);
      if (!leads.length) continue;
      await deliver(w.slackChannel, buildDigest({ watchlist: w, leads, total: countPending(db, w), date, warnings, stats }));
      if (!DRY_RUN) markNotified(db, w, now);
      posted += 1;
    }
    if (!posted) log.info('No new leads above any watchlist threshold; no digest');

    db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?`)
      .run(new Date().toISOString(), problems.length || warnings.length ? 'partial' : 'ok', JSON.stringify({ ...stats, posted }), runId);
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
    await slack.post(ALERT_CHANNEL, `:rotating_light: Incorporation Scout failed: ${err.message}`);
  },
});