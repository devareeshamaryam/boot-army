import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/**
 * B3 TenderScout — entry point.
 *
 *   npm start -w bots/tender-scout
 *   npm run dry-run -w bots/tender-scout     # zero writes: in-memory DB copies, no Slack, no pings
 */
import { existsSync, readFileSync } from 'node:fs';
import { config, db as coreDb, health, logger, slack, snapshot, spine as coreSpine } from '@botarmy/core';
import { harvestAll } from './harvest.js';
import {
  BOT, activeProfiles, getCursor, markNotified, matchAndScore, pendingMatches, recordSourceRun, setCursor,
  storeTenders, syncProfiles, validateConfig, volumeAnomaly,
} from './process.js';
import { buildAnomalyAlert, buildDigest } from './digest.js';

const DRY_RUN = process.argv.includes('--dry-run');
const DEFAULT_CHANNEL = 'tenders'; // SLACK_WEBHOOK_URL_TENDERS, else SLACK_WEBHOOK_URL

const log = logger.forBot(BOT);

function loadSettings() {
  return config.load({
    TS_PROFILES: { default: fileURLToPath(new URL('./profiles.json', import.meta.url)) },
    TS_MAX_RANKED: { type: 'number', default: 20, min: 1, max: 40, integer: true },
    // Pin the clock (ISO timestamp): reproducible runs for tests, or re-running a past day's windows.
    TS_NOW: { description: 'override the run time (testing / backfill only)' },
  });
}

function loadConfigFile(file) {
  if (!existsSync(file)) throw new Error(`Profiles not found at ${file}. Copy profiles.example.json to profiles.json.`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`profiles.json is not valid JSON: ${err.message}`);
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
  if (s.TS_NOW && !Number.isFinite(Date.parse(s.TS_NOW))) throw new Error('TS_NOW must be an ISO timestamp');
  const cfg = loadConfigFile(s.TS_PROFILES);
  const channels = [...new Set([DEFAULT_CHANNEL, ...cfg.profiles.map((p) => p.slackChannel ?? DEFAULT_CHANNEL)])];
  if (!DRY_RUN) channels.forEach((c) => slack.resolveWebhook(c)); // fail fast, loudly, before any work

  const db = coreDb.connect(BOT, { dryRun: DRY_RUN });
  const store = snapshot.openStore({ dryRun: DRY_RUN });
  const spine = coreSpine.openSpine({ dryRun: DRY_RUN });
  try {
    coreDb.migrate(db, new URL('./migrations/', import.meta.url), { namespace: BOT });
    const now = s.TS_NOW ? new Date(s.TS_NOW).toISOString() : new Date().toISOString();
    syncProfiles(db, cfg.profiles, now);
    const runId = Number(db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(now).lastInsertRowid);
    log.info(`${DRY_RUN ? 'Dry run: in-memory copies, nothing will be written · ' : ''}${cfg.profiles.length} profiles`, { dataDir: config.dataDir() });

    // 1. Harvest: raw snapshots only.
    const harvest = await harvestAll({ sources: cfg.sources, store, getCursor: (id) => getCursor(db, id), now, log });
    const problems = harvest.failures.map((f) => `${f.sourceId}: ${f.error}`);
    for (const f of harvest.failures) recordSourceRun(db, { runId, sourceId: f.sourceId, notices: 0, outcome: 'failed', note: f.error, now });
    if (!harvest.fetches.length && problems.length) {
      await deliver(DEFAULT_CHANNEL, buildAnomalyAlert({ date: now.slice(0, 10), problems }));
      const err = new Error(`Every source failed (${problems.length})`);
      err.alerted = true;
      throw err;
    }

    // 2. Store tenders per source; advance a cursor only after a clean, plausible fetch.
    const changed = [];
    for (const fetch of harvest.fetches) {
      const anomaly = volumeAnomaly(db, fetch.sourceId, fetch.notices, cfg.volumeGuard);
      if (anomaly) {
        problems.push(anomaly);
        recordSourceRun(db, { runId, sourceId: fetch.sourceId, notices: fetch.notices, outcome: 'anomaly', note: anomaly, now });
        log.error(anomaly);
        continue;
      }
      const r = storeTenders({ db, store, fetch, now, log });
      changed.push(...r.changedIds);
      problems.push(...r.failures);
      recordSourceRun(db, { runId, sourceId: fetch.sourceId, notices: fetch.notices, outcome: r.failures.length ? 'failed' : 'ok', note: r.failures[0] ?? null, now });
      if (!r.failures.length && fetch.nextCursor) setCursor(db, fetch.sourceId, fetch.nextCursor, now);
    }
    if (problems.length) await deliver(DEFAULT_CHANNEL, buildAnomalyAlert({ date: now.slice(0, 10), problems }));

    // 3. Match, score, emit spine events.
    const profiles = activeProfiles(db);
    const counts = matchAndScore({ db, spine, profiles, tenderIds: changed, now, log });

    // 4. One digest per profile.
    let posted = 0;
    for (const p of profiles) {
      const pending = pendingMatches(db, p.profileId);
      if (!pending.length) continue;
      await deliver(p.slackChannel ?? DEFAULT_CHANNEL, buildDigest({ profile: p, matches: pending, now, warnings: problems, maxRanked: s.TS_MAX_RANKED }));
      if (!DRY_RUN) markNotified(db, pending.map((m) => m.matchId), now);
      posted += 1;
    }
    if (!posted) log.info('No new opportunities; no digest sent');

    const stats = { fetched: harvest.fetches.length, failed: harvest.failures.length, changedTenders: changed.length, ...counts, digests: posted };
    db.prepare(`UPDATE runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?`)
      .run(new Date().toISOString(), problems.length ? 'partial' : 'ok', JSON.stringify(stats), runId);
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
    await slack.post(DEFAULT_CHANNEL, `:rotating_light: TenderScout failed: ${err.message}`);
  },
});