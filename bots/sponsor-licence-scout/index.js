import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sendSlackAlert, pingHealthcheck, buildHealthcheckUrl, withRetry, normalizeEntityId } from '@botarmy/core';
import {
  openDb, startRun, finishRun, lastAcceptedSnapshot, insertSnapshot,
  loadActiveSponsors, applyRegister, listPendingDiffs, markDiffsNotified,
} from './db.js';
import { discoverRegisterCsv, downloadCsv, parseRegister, computeDelta, normalizeName } from './harvester.js';
import { buildDigestPayload, sendDigest } from './digest.js';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const log = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

/** Read env lazily: static imports run before the dotenv call above. */
function loadSettings(env = process.env) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(BOT_DIR, p));
  return {
    dbPath: resolve(env.SLS_DB_PATH || 'data/sponsor-licence-scout.db'),
    watchlistPath: resolve(env.SLS_WATCHLIST || 'watchlist.json'),
    slackWebhookUrl: env.SLS_SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || '',
    healthchecksBaseUrl: env.HEALTHCHECKS_BASE_URL || '',
    healthcheckUuid: env.SLS_HC_UUID || '',
    // A register that shrinks by more than this in one day is treated as a bad download.
    maxDropRatio: Number(env.SLS_MAX_DROP_RATIO ?? 0.1),
    minOrgs: Number(env.SLS_MIN_ORGS ?? 1000),
  };
}

/**
 * Optional watchlist of companies to star in the digest. The register has no
 * company number, so matching is by normalised name; the Companies House
 * number, if given, is normalised into a spine ID and stored on matching
 * diffs so other bots can join on it.
 */
function loadWatchlist(watchlistPath) {
  if (!existsSync(watchlistPath)) return { additionRoutes: [], match: () => null };
  const raw = JSON.parse(readFileSync(watchlistPath, 'utf8'));
  const byName = new Map();
  for (const c of raw.companies ?? []) {
    let entityId = null;
    if (c.registrationNumber) {
      try {
        entityId = normalizeEntityId(c.registrationNumber, 'UK');
      } catch (err) {
        log.warn(`Watchlist "${c.name}": ${err.message}`);
      }
    }
    for (const label of [c.name, ...(c.aliases ?? [])]) byName.set(normalizeName(label), { name: c.name, entityId });
  }
  return {
    additionRoutes: raw.additionRoutes ?? [],
    match: (org) => byName.get(normalizeName(org.name)) ?? null,
  };
}

function makePinger(s) {
  if (!s.healthchecksBaseUrl || !s.healthcheckUuid) {
    log.warn('Healthcheck disabled: set HEALTHCHECKS_BASE_URL and SLS_HC_UUID');
    return async () => {};
  }
  return async (event) => {
    if (DRY_RUN) return;
    try {
      await withRetry(() => pingHealthcheck(buildHealthcheckUrl(s.healthchecksBaseUrl, s.healthcheckUuid, event)), 2, 1000);
    } catch (err) {
      log.warn(`Healthcheck ping (${event ?? 'success'}) failed: ${err.message}`);
    }
  };
}

async function main() {
  const s = loadSettings();
  const ping = makePinger(s);
  await ping('start');

  let db;
  let runId;
  try {
    if (!s.slackWebhookUrl && !DRY_RUN) throw new Error('Set SLACK_WEBHOOK_URL (or SLS_SLACK_WEBHOOK_URL)');
    const watchlist = loadWatchlist(s.watchlistPath);

    db = openDb(DRY_RUN ? s.dbPath.replace(/\.db$/, '.dryrun.db') : s.dbPath);
    const now = new Date().toISOString();
    runId = startRun(db, now);

    const source = await withRetry(() => discoverRegisterCsv(), 3, 5000);
    log.info(`Register: ${source.filename} (${source.url})`);
    const file = await withRetry(() => downloadCsv(source.url), 3, 5000);

    const previous = lastAcceptedSnapshot(db);
    const base = { runId, url: source.url, filename: source.filename, publishedDate: source.publishedDate, sha256: file.sha256, bytes: file.bytes, now };

    if (previous?.sha256 === file.sha256) {
      insertSnapshot(db, { ...base, rowCount: previous.row_count, orgCount: previous.org_count, outcome: 'unchanged' });
      finishRun(db, runId, { status: 'unchanged' });
      log.info('Register unchanged since the last run');
      await ping();
      return;
    }

    const { orgs, rowCount, skipped } = parseRegister(file.text);
    const stats = { rowCount, orgCount: orgs.size, skipped };

    // A truncated or malformed download must never become a wave of "removals".
    const shrink = previous ? 1 - orgs.size / previous.org_count : 0;
    const rejectReason = orgs.size < s.minOrgs
      ? `only ${orgs.size} organisations parsed (minimum ${s.minOrgs})`
      : shrink > s.maxDropRatio
        ? `register shrank ${(shrink * 100).toFixed(1)}% (${previous.org_count} → ${orgs.size}); limit ${s.maxDropRatio * 100}%`
        : null;

    if (rejectReason) {
      insertSnapshot(db, { ...base, rowCount, orgCount: orgs.size, outcome: 'rejected', note: rejectReason });
      finishRun(db, runId, { status: 'rejected', stats, error: rejectReason });
      log.error(`Snapshot rejected: ${rejectReason}`);
      if (!DRY_RUN) {
        await sendSlackAlert(s.slackWebhookUrl, `:warning: Sponsor register snapshot rejected (${source.filename}): ${rejectReason}. No diffs recorded.`)
          .catch((e) => log.error(`Could not send alert: ${e.message}`));
      }
      process.exitCode = 1;
      await ping('fail');
      return;
    }

    const isBaseline = !previous;
    const active = loadActiveSponsors(db);
    const delta = isBaseline ? { added: [], removed: [], ratingChanged: [], relocated: [] } : computeDelta(active, orgs);
    const snapshotId = insertSnapshot(db, { ...base, rowCount, orgCount: orgs.size, outcome: isBaseline ? 'baseline' : 'diffed', note: isBaseline ? 'first snapshot; no diffs emitted' : null });
    applyRegister(db, { snapshotId, orgs, delta, now, watchMatch: watchlist.match, isBaseline });

    Object.assign(stats, {
      added: delta.added.length,
      removed: delta.removed.length,
      ratingChanged: delta.ratingChanged.length,
      relocated: delta.relocated.length,
    });
    log.info(`${isBaseline ? 'Baseline' : 'Diffed'}: ${JSON.stringify(stats)}`);

    const pending = listPendingDiffs(db);
    if (pending.length) {
      const payload = buildDigestPayload({
        diffs: pending,
        additionRoutes: watchlist.additionRoutes,
        meta: { publishedDate: source.publishedDate, orgCount: orgs.size, relocated: delta.relocated.length, sourceUrl: source.url },
      });
      if (DRY_RUN) console.log(JSON.stringify(payload, null, 2));
      else {
        await sendDigest(s.slackWebhookUrl, payload);
        markDiffsNotified(db, pending.map((d) => d.id), now);
      }
    }

    finishRun(db, runId, { status: 'ok', stats });
    await ping();
  } catch (err) {
    log.error(err.stack ?? err.message);
    process.exitCode = 1;
    if (db && runId) finishRun(db, runId, { status: 'failed', error: err.message });
    await ping('fail');
    if (s.slackWebhookUrl && !DRY_RUN) {
      await sendSlackAlert(s.slackWebhookUrl, `:rotating_light: Sponsor Licence Scout failed: ${err.message}`)
        .catch((e) => log.error(`Could not send failure alert: ${e.message}`));
    }
  } finally {
    db?.close();
  }
}

await main();