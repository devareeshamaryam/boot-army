import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

import {
  sendSlackAlert,
  askClaude,
  pingHealthcheck,
  buildHealthcheckUrl,
  withRetry,
  normalizeEntityId,
} from '@botarmy/core';
import { BOT_DIR, loadConfig, loadWatchlist } from './config.js';
import {
  openDb, startRun, finishRun, getFirm, upsertFirm, listFirms,
  recordRoster, pairMoves, setMoverDestination,
  listUnscoredMovers, saveScore, listDigestMovers, recentMoverNames,
  markMoversNotified, listDigestNews, markNewsNotified,
} from './db.js';
import { getAdapter } from './scrapers/index.js';
import { scoreMover, DEFAULT_MATRIX } from './scorer.js';
import { ingestFeeds } from './feeds.js';
import { buildDigestPayload, sendDigest } from './digest.js';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const NO_AI = args.has('--no-ai');

/** Markets whose company registration numbers @botarmy/core can normalize. */
const SPINE_JURISDICTIONS = new Set(['UK', 'SG', 'DIFC', 'ADGM']);

const log = {
  info: (msg) => console.log(`${new Date().toISOString()} INFO  ${msg}`),
  warn: (msg) => console.warn(`${new Date().toISOString()} WARN  ${msg}`),
  error: (msg) => console.error(`${new Date().toISOString()} ERROR ${msg}`),
};

const firmLabel = (firm) => `${firm.regulator} ${firm.ref} (${firm.name})`;

/* ---------------------------------------------------------- healthcheck */

function makePinger(cfg) {
  if (!cfg.healthchecksBaseUrl || !cfg.healthcheckUuid) {
    log.warn('Healthcheck disabled: set HEALTHCHECKS_BASE_URL and MANDATE_MATCHER_HC_UUID');
    return async () => {};
  }
  return async (event) => {
    if (DRY_RUN) return;
    try {
      const url = buildHealthcheckUrl(cfg.healthchecksBaseUrl, cfg.healthcheckUuid, event);
      await withRetry(() => pingHealthcheck(url), 2, 1000);
    } catch (err) {
      // A monitoring outage must never fail the job itself.
      log.warn(`Healthcheck ping (${event ?? 'success'}) failed: ${err.message}`);
    }
  };
}

/* -------------------------------------------------------- entity spine */

async function resolveEntityId(db, firm, adapter, ctx) {
  if (!SPINE_JURISDICTIONS.has(firm.market)) return null;

  const stored = getFirm(db, firm.regulator, firm.ref);
  if (stored?.entity_id) return stored.entity_id;

  let registrationNumber = firm.registrationNumber ?? null;
  if (!registrationNumber && adapter.fetchFirmProfile) {
    try {
      registrationNumber = (await adapter.fetchFirmProfile(firm, ctx))?.registrationNumber ?? null;
    } catch (err) {
      log.warn(`${firmLabel(firm)}: firm profile lookup failed: ${err.message}`);
    }
  }
  if (!registrationNumber) return null;

  try {
    return normalizeEntityId(registrationNumber, firm.market);
  } catch (err) {
    log.warn(`${firmLabel(firm)}: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------ pipeline */

async function ingestRegisters(db, { runId, firms, cfg, now }) {
  const ctx = { env: cfg.env, baseDir: BOT_DIR, log };
  const warnings = [];
  const failures = [];
  const stats = { firmsChecked: 0, baselines: 0, unchanged: 0, diffed: 0, rejected: 0, joiners: 0, leavers: 0 };
  let destinationLookups = 0;

  for (const firm of firms) {
    const adapter = getAdapter(firm.regulator);
    try {
      adapter.validate?.(firm, ctx); // config errors fail fast, without retries

      const entityId = await resolveEntityId(db, firm, adapter, ctx);
      upsertFirm(db, { ...firm, entityId, now });

      const records = await withRetry(
        () => adapter.fetchRoster(firm, ctx),
        cfg.fetchRetries,
        cfg.fetchRetryDelayMs,
      );
      const result = recordRoster(db, { runId, firm, records, now, maxDropRatio: cfg.maxDropRatio });

      stats.firmsChecked += 1;
      stats[result.outcome === 'baseline' ? 'baselines' : result.outcome] += 1;
      stats.joiners += result.joiners.length;
      stats.leavers += result.leavers.length;
      log.info(`${firmLabel(firm)}: ${records.length} people, ${result.outcome}`
        + (result.outcome === 'diffed' ? ` (+${result.joiners.length} / -${result.leavers.length})` : ''));

      if (result.outcome === 'rejected') warnings.push(`${firmLabel(firm)}: snapshot rejected, ${result.note}`);

      if (adapter.resolveDestination) {
        for (const leaver of result.leavers) {
          if (destinationLookups >= cfg.maxDestinationLookups) break;
          destinationLookups += 1;
          try {
            const dest = await adapter.resolveDestination(leaver.personRef, firm.ref, ctx);
            if (dest) setMoverDestination(db, leaver.id, dest);
          } catch (err) {
            log.warn(`${firmLabel(firm)}: destination lookup for ${leaver.personRef} failed: ${err.message}`);
          }
        }
      }
    } catch (err) {
      failures.push(firmLabel(firm));
      warnings.push(`${firmLabel(firm)}: ${err.message}`);
      log.error(`${firmLabel(firm)}: ${err.message}`);
    }
  }

  return { stats, warnings, failures };
}

function scorePending(db, matrix) {
  const firmsByKey = new Map(listFirms(db).map((f) => [`${f.regulator}:${f.firm_ref}`, f]));
  const pending = listUnscoredMovers(db);
  for (const mover of pending) {
    const { score, breakdown } = scoreMover(mover, firmsByKey, matrix);
    saveScore(db, mover.id, score, breakdown);
  }
  return pending.length;
}

async function summarise(movers, cfg) {
  if (!cfg.aiSummary || NO_AI || !cfg.anthropicApiKey || movers.length === 0) return null;
  const brief = movers.slice(0, 10).map((m) => ({
    score: m.score,
    name: m.name,
    change: m.change_type,
    from: m.from_firm_label,
    to: m.to_firm_label ?? m.to_firm_name,
    roles: JSON.parse(m.roles_json).map((r) => r.title),
  }));
  try {
    const text = await askClaude(
      `Today's regulated-person moves, ranked by relevance score:\n${JSON.stringify(brief, null, 2)}\n\n`
        + 'In at most three short bullet points (under 80 words total), note which moves most likely '
        + 'create backfill or team-build search mandates and why. Use only the data given; do not speculate '
        + 'about individuals beyond it.',
      cfg.anthropicApiKey,
      { maxTokens: 300, system: 'You are a concise analyst at an executive search firm covering financial services.' },
    );
    return text.trim() || null;
  } catch (err) {
    log.warn(`AI summary skipped: ${err.message}`);
    return null;
  }
}

async function main() {
  const cfg = loadConfig();
  const ping = makePinger(cfg);
  await ping('start');

  let db;
  let runId;
  try {
    const watchlist = loadWatchlist(cfg.watchlistPath);
    if (!cfg.slackWebhookUrl && !DRY_RUN) throw new Error('Set SLACK_WEBHOOK_URL (or MANDATE_MATCHER_SLACK_WEBHOOK_URL)');

    db = openDb(cfg.dbPath);
    const now = new Date().toISOString();
    runId = startRun(db, now);
    log.info(`Run ${runId}: ${watchlist.firms.length} firms, ${watchlist.feeds.length} feeds${DRY_RUN ? ' (dry run)' : ''}`);

    const registers = await ingestRegisters(db, { runId, firms: watchlist.firms, cfg, now });
    const moves = pairMoves(db, { runId, lookbackDays: cfg.moveLookbackDays, now });
    const scored = scorePending(db, DEFAULT_MATRIX);

    const feeds = await ingestFeeds(db, watchlist.feeds, {
      firms: watchlist.firms,
      moverNames: recentMoverNames(db, { now }),
      now,
      log,
      retries: cfg.fetchRetries,
      retryDelayMs: cfg.fetchRetryDelayMs,
    });

    const movers = listDigestMovers(db, { minScore: cfg.minScore, limit: cfg.maxMovers, windowDays: cfg.digestWindowDays, now });
    const news = listDigestNews(db, { limit: cfg.maxNews, windowDays: cfg.digestWindowDays, now });
    const warnings = [...registers.warnings, ...feeds.failures.map((f) => `Feed "${f.feed}": ${f.error}`)];

    const stats = { ...registers.stats, moves, scored, newsInserted: feeds.inserted, digestMovers: movers.length, digestNews: news.length };
    const shouldSend = movers.length > 0 || news.length > 0 || warnings.length > 0 || cfg.sendEmptyDigest;

    if (shouldSend) {
      const payload = buildDigestPayload({
        movers,
        news,
        date: now.slice(0, 10),
        warnings,
        aiSummary: await summarise(movers, cfg),
        stats: registers.stats,
      });

      if (DRY_RUN) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        await sendDigest(cfg.slackWebhookUrl, payload);
        markMoversNotified(db, movers.map((m) => m.id), now);
        markNewsNotified(db, news.map((n) => n.id), now);
      }
    } else {
      log.info('Nothing new to report; digest not sent');
    }

    const allFailed = watchlist.firms.length > 0 && registers.failures.length === watchlist.firms.length;
    const status = allFailed ? 'failed' : warnings.length ? 'partial' : 'ok';
    finishRun(db, runId, { status, stats, error: allFailed ? 'every register source failed' : null });
    log.info(`Run ${runId} ${status}: ${JSON.stringify(stats)}`);

    if (allFailed) {
      process.exitCode = 1;
      await ping('fail');
    } else {
      await ping();
    }
  } catch (err) {
    log.error(err.stack ?? err.message);
    process.exitCode = 1;
    if (db && runId) finishRun(db, runId, { status: 'failed', error: err.message });
    await ping('fail');
    if (cfg.slackWebhookUrl && !DRY_RUN) {
      await sendSlackAlert(cfg.slackWebhookUrl, `:rotating_light: Mandate Matcher run failed: ${err.message}`)
        .catch((e) => log.error(`Could not send failure alert: ${e.message}`));
    }
  } finally {
    db?.close();
  }
}

await main();