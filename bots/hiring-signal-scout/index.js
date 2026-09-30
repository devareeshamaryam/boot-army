import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

// askClaude is used in drafter.js and normalizeEntityId in companies.js.
import { sendSlackAlert, pingHealthcheck, buildHealthcheckUrl, withRetry } from '@botarmy/core';
import { loadConfig, loadWatchlist } from './config.js';
import {
  openDb, startRun, finishRun, getCursor, setCursor, upsertCompanies,
  insertAward, listPendingAwards, markAwardProcessed,
  recordAtsSnapshot, listPendingSpikes, markSpikeProcessed,
  companyInCooldown, insertProposal, listUnpostedProposals, markProposalPosted,
  getAward, getSpike,
} from './db.js';
import { AWARD_SOURCES } from './harvesters/awards.js';
import { getPoller } from './harvesters/ats.js';
import { mapPool, SourceConfigError } from './harvesters/http.js';
import { buildCompanyIndex, companyEntityId } from './companies.js';
import { detectAndStoreSpike } from './spikes.js';
import { findDecisionMakers, createCreditBudget } from './enrichment.js';
import { draftProposal } from './drafter.js';
import { loadTemplates } from './templates.js';
import { buildProposalMessage, buildSummaryMessage, postDigest, esc } from './digest.js';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

const log = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

/* ---------------------------------------------------------- healthcheck */

function makePinger(cfg) {
  if (!cfg.healthchecksBaseUrl || !cfg.healthcheckUuid) {
    log.warn('Healthcheck disabled: set HEALTHCHECKS_BASE_URL and HSS_HC_UUID');
    return async () => {};
  }
  return async (event) => {
    if (DRY_RUN) return;
    try {
      await withRetry(() => pingHealthcheck(buildHealthcheckUrl(cfg.healthchecksBaseUrl, cfg.healthcheckUuid, event)), 2, 1000);
    } catch (err) {
      log.warn(`Healthcheck ping (${event ?? 'success'}) failed: ${err.message}`);
    }
  };
}

/* ---------------------------------------------------------------- stages */

async function harvestAwards(db, { cfg, watchlist, index, now, warnings }) {
  let inserted = 0;
  let attempted = 0;
  const failures = [];

  for (const [name, source] of Object.entries(AWARD_SOURCES)) {
    const options = watchlist.awards[name] ?? {};
    if (options.enabled === false) continue;
    if (name === 'hk' && !options.sources?.length) continue;
    attempted += 1;

    try {
      const cursor = getCursor(db, name);
      const result = await withRetry(
        () => source.harvest({ cursor, now, lookbackDays: cfg.lookbackDays, options, log, env: cfg.env }),
        cfg.fetchRetries,
        cfg.fetchRetryDelayMs,
      );

      let matched = 0;
      for (const award of result.awards) {
        if (options.minValue && award.value !== null && award.value < options.minValue) continue;
        for (const supplier of award.suppliers) {
          const hit = index.match(supplier);
          if (!hit) continue;
          const isNew = insertAward(db, {
            ...award,
            companyId: hit.company.id,
            supplierName: supplier.name,
            matchMethod: hit.method,
          }, now);
          if (isNew) matched += 1;
        }
      }
      inserted += matched;
      if (result.nextCursor) setCursor(db, name, result.nextCursor, now);
      log.info(`${name}: ${result.awards.length} awards scanned, ${matched} new at watchlist companies`);
    } catch (err) {
      failures.push(name);
      warnings.push(`Awards ${name}: ${err.message}`);
      log.error(`Awards ${name}: ${err.message}`);
    }
  }
  return { inserted, attempted, failures };
}

async function pollJobBoards(db, { cfg, watchlist, runId, now, warnings }) {
  const withAts = watchlist.companies.filter((c) => c.ats);
  const stats = { polled: 0, baselines: 0, rejected: 0, spikes: 0, failed: 0 };

  await mapPool(withAts, cfg.atsConcurrency, async (company) => {
    try {
      const poller = getPoller(company.ats.type);
      const { jobs, complete } = await withRetry(() => poller.fetchJobs(company.ats), cfg.fetchRetries, cfg.fetchRetryDelayMs);
      const result = recordAtsSnapshot(db, {
        runId, company, atsType: company.ats.type, jobs, complete,
        focus: watchlist.spikes.focusPattern, now, maxDropRatio: cfg.maxDropRatio,
      });
      stats.polled += 1;
      if (result.outcome === 'baseline') stats.baselines += 1;
      if (result.outcome === 'rejected') {
        stats.rejected += 1;
        warnings.push(`${company.name} (${company.ats.type}): snapshot rejected, ${result.note}`);
        return;
      }
      if (result.outcome === 'diffed') {
        const { spikeId, verdict } = detectAndStoreSpike(db, company, watchlist.spikes, now);
        if (spikeId) {
          stats.spikes += 1;
          log.info(`${company.name}: spike, ${verdict.newJobs} new roles (threshold ${verdict.threshold})`);
        }
      }
    } catch (err) {
      stats.failed += 1;
      const hint = err instanceof SourceConfigError ? ' (check watchlist)' : '';
      warnings.push(`${company.name} (${company.ats.type}): ${err.message}${hint}`);
      log.error(`${company.name}: ${err.message}`);
    }
  });
  return stats;
}

async function draftForSignals(db, { cfg, watchlist, templates, now, warnings, budget, enrich }) {
  const byId = new Map(watchlist.companies.map((c) => [c.id, c]));
  const signals = [
    ...listPendingAwards(db).map((s) => ({ type: 'contract_award', row: s, markDone: () => markAwardProcessed(db, s.id, now) })),
    ...listPendingSpikes(db).map((s) => ({ type: 'hiring_spike', row: s, markDone: () => markSpikeProcessed(db, s.id, now) })),
  ];
  let drafted = 0;

  for (const signal of signals) {
    if (drafted >= cfg.maxProposalsPerRun) break;
    const company = byId.get(signal.row.company_id);
    if (!company) { signal.markDone(); continue; } // removed from watchlist

    if (companyInCooldown(db, company.id, { now, days: cfg.companyCooldownDays })) {
      signal.markDone();
      continue;
    }
    if (!cfg.anthropicApiKey) {
      warnings.push('ANTHROPIC_API_KEY not set; signals kept for the next run');
      break;
    }

    try {
      const contacts = enrich
        ? await findDecisionMakers(db, company, {
          titles: company.contactTitles ?? watchlist.contactTitles,
          apolloApiKey: cfg.apolloApiKey,
          lushaApiKey: cfg.lushaApiKey,
          budget,
          now,
          cacheDays: cfg.contactCacheDays,
          log,
        })
        : [];
      const contact = contacts.find((c) => c.email) ?? contacts[0] ?? null;

      const draft = await draftProposal({
        signalType: signal.type,
        signal: signal.row,
        company,
        contact,
        sender: watchlist.sender,
        templates,
        apiKey: cfg.anthropicApiKey,
      });

      insertProposal(db, {
        companyId: company.id,
        signalType: signal.type,
        signalId: signal.row.id,
        contactId: contact?.id ?? null,
        subject: draft.subject,
        body: draft.body,
        template: signal.type,
      }, now);
      signal.markDone();
      drafted += 1;
    } catch (err) {
      // Unusable model output won't improve on retry; network/API errors might.
      if (/^Draft (rejected|was not JSON|missing)/.test(err.message)) signal.markDone();
      warnings.push(`${company.name}: proposal not drafted, ${err.message}`);
      log.error(`${company.name}: ${err.message}`);
    }
  }
  return drafted;
}

function signalSummary(db, proposal) {
  if (proposal.signal_type === 'contract_award') {
    const a = getAward(db, proposal.signal_id);
    if (!a) return '_Award record not found_';
    const value = a.value !== null ? ` · ${esc(a.currency ?? '')} ${Math.round(a.value).toLocaleString('en-GB')}` : '';
    const link = a.url && /^https:\/\//.test(a.url) ? ` · <${a.url}|notice>` : '';
    const tenderer = a.confidence === 'tenderer' ? ' · _named as tenderer, check the notice_' : '';
    return `*${esc(a.buyer ?? 'Buyer not stated')}*: ${esc(a.title ?? 'untitled')}${value} · ${esc(a.source)} · matched by ${a.match_method}${tenderer}${link}`;
  }
  const s = getSpike(db, proposal.signal_id);
  if (!s) return '_Spike record not found_';
  const baseline = s.baseline_weekly !== null ? `, usually ~${s.baseline_weekly}/week` : ', limited history';
  const titles = JSON.parse(s.sample_titles_json).slice(0, 3).map(esc).join('; ');
  return `*${s.new_jobs} new roles* in ${s.window_days} days (threshold ${s.threshold}${baseline}) · e.g. ${titles}`;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const cfg = loadConfig();
  const ping = makePinger(cfg);
  await ping('start');

  let db;
  let runId;
  try {
    const watchlist = loadWatchlist(cfg.watchlistPath);
    const templates = loadTemplates(cfg.templatesPath);
    if (!cfg.slackWebhookUrl && !DRY_RUN) throw new Error('Set SLACK_WEBHOOK_URL (or HSS_SLACK_WEBHOOK_URL)');

    // Dry runs use a separate database so real state and cursors stay untouched.
    db = openDb(DRY_RUN ? cfg.dbPath.replace(/\.db$/, '.dryrun.db') : cfg.dbPath);
    const now = new Date().toISOString();
    runId = startRun(db, now);
    const warnings = [];

    const companies = watchlist.companies.map((c) => ({ ...c, entityId: companyEntityId(c) }));
    upsertCompanies(db, companies, now);
    const index = buildCompanyIndex(companies);
    index.collisions.forEach((c) => warnings.push(`Watchlist name collision: ${c}`));
    log.info(`Run ${runId}: ${companies.length} companies${DRY_RUN ? ' (dry run: no enrichment, nothing posted)' : ''}`);

    const awards = await harvestAwards(db, { cfg, watchlist, index, now, warnings });
    const boards = await pollJobBoards(db, { cfg, watchlist, runId, now, warnings });

    const budget = createCreditBudget(cfg.maxEnrichmentCredits);
    const drafted = await draftForSignals(db, { cfg, watchlist, templates, now, warnings, budget, enrich: !DRY_RUN });

    const pending = listUnpostedProposals(db, cfg.maxProposalsPerRun);
    const stats = {
      newAwards: awards.inserted,
      spikes: boards.spikes,
      companiesPolled: boards.polled,
      proposals: pending.length,
      drafted,
      creditsUsed: budget.used,
      boardFailures: boards.failed,
      awardSourceFailures: awards.failures.length,
    };

    if (pending.length || warnings.length || cfg.sendEmptyDigest) {
      const summary = buildSummaryMessage({ date: now.slice(0, 10), stats, warnings });
      const messages = pending.map((p) => ({ id: p.id, message: buildProposalMessage(p, signalSummary(db, p)) }));
      if (DRY_RUN) {
        console.log(JSON.stringify({ summary, proposals: messages.map((m) => m.message) }, null, 2));
      } else {
        const posted = await postDigest(cfg.slackWebhookUrl, { summary, proposals: messages });
        posted.forEach((id) => markProposalPosted(db, id, now));
      }
    } else {
      log.info('Nothing new; no Slack message sent');
    }

    const boardsConfigured = watchlist.companies.some((c) => c.ats);
    const everythingFailed = (awards.attempted > 0 || boardsConfigured)
      && awards.failures.length === awards.attempted
      && boards.polled === 0;
    const status = everythingFailed ? 'failed' : warnings.length ? 'partial' : 'ok';
    finishRun(db, runId, { status, stats });
    log.info(`Run ${runId} ${status}: ${JSON.stringify(stats)}`);

    if (everythingFailed) {
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
      await sendSlackAlert(cfg.slackWebhookUrl, `:rotating_light: Hiring-Signal Scout run failed: ${err.message}`)
        .catch((e) => log.error(`Could not send failure alert: ${e.message}`));
    }
  } finally {
    db?.close();
  }
}

await main();