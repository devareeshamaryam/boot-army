/**
 * TenderScout CLI. One-shot: harvest -> score -> digest, then exit. Scheduling is external (cron / systemd timer).
 *
 *   node index.js [--since YYYY-MM-DD] [--sources contracts-finder,find-a-tender] [--stages tender,award]
 *                 [--dry-run] [--send] [--cache] [--offline]
 *
 * Dry run is the DEFAULT: the database is an in-memory copy (nothing on disk changes)
 * and digests are printed, not posted. Only --send writes data/tender-scout-v2.sqlite
 * and posts to Slack (per profile, when its webhook env var is set). --dry-run wins over --send.
 * Dry runs only:
 *   --cache    keep a scratch DB (data/tender-scout-v2-dryrun.sqlite) so repeat dry runs fetch only what is new
 *   --offline  no API calls at all: re-score and print from the database as it is
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

import { health, logger } from '@botarmy/core';
import { buyerHistory, deleteScore, finishRun, openDb, openNotices, saveScore, startRun } from './db.js';
import { deliverDigest } from './digest.js';
import { ADAPTERS, contractsFinder, runHarvest } from './harvest.js';
import { loadProfiles } from './profiles.js';
import { score } from './score.js';

export const BOT = 'tender-scout';

/** @returns {{ since?: string, sources: string[], stages: string[], send: boolean, dryRun: boolean, cache: boolean, offline: boolean }} */
export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string' }, sources: { type: 'string' }, stages: { type: 'string' }, 'dry-run': { type: 'boolean' }, send: { type: 'boolean' },
      cache: { type: 'boolean' }, offline: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) throw new Error(`--since must be YYYY-MM-DD, got "${values.since}"`);
  if (values.since && Number.isNaN(Date.parse(`${values.since}T00:00:00Z`))) throw new Error(`--since is not a real date: ${values.since}`);
  const stages = values.stages ? values.stages.split(',').map((s) => s.trim()).filter(Boolean) : contractsFinder.stages;
  const unknown = stages.filter((s) => !contractsFinder.stages.includes(s));
  if (unknown.length || !stages.length) throw new Error(`--stages must be a comma list of: ${contractsFinder.stages.join(', ')} (Contracts Finder only)`);
  const sources = values.sources ? values.sources.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(ADAPTERS);
  const badSources = sources.filter((s) => !ADAPTERS[s]);
  if (badSources.length || !sources.length) throw new Error(`--sources must be a comma list of: ${Object.keys(ADAPTERS).join(', ')}`);
  const dryRun = Boolean(values['dry-run']) || !values.send;
  if (!dryRun && (values.cache || values.offline)) throw new Error('--cache and --offline are for dry runs; drop --send');
  return { since: values.since, sources, stages, send: !dryRun, dryRun, cache: Boolean(values.cache), offline: Boolean(values.offline) };
}

/** Score every open notice for every profile; excluded notices lose any old score. */
export function scoreAll(db, profiles, now) {
  const counts = {};
  db.transaction(() => {
    const notices = openNotices(db, now);
    for (const p of profiles) {
      counts[p.entity] = { scored: 0, excluded: 0 };
      for (const n of notices) {
        const r = score(n, p, { now, buyerHistory: buyerHistory(db, n.buyer_key, p.cpvPrefixes) });
        if (r.excluded) { deleteScore(db, n.ocid, p.entity); counts[p.entity].excluded++; }
        else { saveScore(db, n.ocid, p.entity, r, now); counts[p.entity].scored++; }
      }
    }
  })();
  return counts;
}

/**
 * One full run against an open database. Exported for tests.
 * @returns {Promise<{ runId, harvest, scored, digests }>}
 */
export async function runOnce({ db, profiles, sources = Object.keys(ADAPTERS), stages, since, send = false, offline = false, now = new Date().toISOString(), env = process.env, log, print, httpOptions }) {
  const runId = startRun(db, { sources, stages, since: since ?? null, send, offline }, now);
  const counts = {};
  try {
    counts.harvest = offline ? 'skipped (--offline)' : await runHarvest(db, { adapters: sources.map((s) => ADAPTERS[s]), stages, since, now, log, httpOptions });
    counts.scored = scoreAll(db, profiles, now);
    counts.digests = [];
    for (const p of profiles) counts.digests.push(await deliverDigest(db, p, { runId, now, send, env, log, print }));
    finishRun(db, runId, { status: 'ok', counts }, new Date().toISOString());
    return { runId, ...counts };
  } catch (err) {
    finishRun(db, runId, { status: 'failed', counts, error: err.message }, new Date().toISOString());
    throw err;
  }
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const log = logger.forBot(BOT);
  await health.run(BOT, async () => {
    const profiles = loadProfiles({ allowExample: args.dryRun, log });
    const db = openDb({ dryRun: args.dryRun, cache: args.cache });
    try {
      if (args.cache) log.info(`DRY RUN with cache: ${db.botarmy.path} (the live database is not touched; nothing is posted)`);
      else if (args.dryRun) log.info('DRY RUN: in-memory database, nothing is written or posted (use --send for a live run)');
      if (args.offline) log.info('OFFLINE: no API calls; scoring and printing what the database already holds');
      const r = await runOnce({ db, profiles, sources: args.sources, stages: args.stages, since: args.since, send: args.send, offline: args.offline, log });
      log.info('Summary', { harvest: r.harvest, digests: r.digests.map((d) => `${d.entity}: ${d.count}${d.posted ? ' posted' : ` (${d.note})`}`) });
    } finally {
      db.close();
    }
  }, { dryRun: args.dryRun, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
