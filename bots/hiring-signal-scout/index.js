import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sendSlackAlert, pingHealthcheck, buildHealthcheckUrl, withRetry, normalizeEntityId } from '@botarmy/core';
import { harvestAll, parseSnapshots } from './harvester.js';
import {
  openDb, startRun, finishRun, getCursor, setCursors, syncWatchlist, recordSnapshots,
  knownAwardKeys, insertAwards, activeJobKeys, hasJobHistory, applyBoard, velocityHistory,
  knownFundingKeys, insertFunding, lastSignalAt, knownSignalKeys, insertSignals, markSignalsNotified, pendingSignals,
} from './db.js';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const FULL_DATASET_SOURCES = new Set(['gebiz', 'hk', 'etimad', 'meaAggregator']); // first read = baseline

const log = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

/* ----------------------------------------------------------- settings */

function loadSettings(env = process.env) {
  return {
    env,
    dbPath: path.resolve(BOT_DIR, env.HSS_DB_PATH || 'data/hiring-signals.db'),
    watchlistPath: path.resolve(BOT_DIR, env.HSS_WATCHLIST || 'watchlist.json'),
    slackWebhookUrl: env.HSS_SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || '',
    healthchecksBaseUrl: env.HEALTHCHECKS_BASE_URL || '',
    healthcheckUuid: env.HSS_HC_UUID || '',
    saveRaw: /^(1|true|yes)$/i.test(env.HSS_SAVE_RAW ?? ''),
    maxDropRatio: Number(env.HSS_MAX_DROP_RATIO ?? 0.6),
    maxPerType: Number(env.HSS_MAX_ALERTS_PER_TYPE ?? 15),
  };
}

function loadWatchlist(file) {
  if (!existsSync(file)) throw new Error(`Watchlist not found at ${file}`);
  const w = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  const ids = new Set();
  (w.companies ?? []).forEach((c, i) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id ?? '')) problems.push(`companies[${i}].id must be a lowercase slug`);
    if (ids.has(c.id)) problems.push(`companies[${i}].id "${c.id}" is duplicated`);
    ids.add(c.id);
    if (!c.name) problems.push(`companies[${i}].name is required`);
    const need = { greenhouse: ['token'], lever: ['slug'], workable: ['account'], workday: ['host', 'tenant', 'site'] }[c.ats?.type];
    if (c.ats && !need) problems.push(`companies[${i}].ats.type must be greenhouse, lever, workable or workday`);
    for (const k of need ?? []) if (!c.ats[k]) problems.push(`companies[${i}].ats.${k} is required`);
  });
  if (!w.companies?.length) problems.push('"companies" must list at least one company');
  if (problems.length) throw new Error(`watchlist.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);

  return {
    ...w,
    companies: w.companies.map((c) => ({ ...c, aliases: c.aliases ?? [], entityId: entityIdFor(c) })),
    thresholds: {
      majorAward: { default: 1_000_000, ...(w.thresholds?.majorAward ?? {}) },
      includeUnknownAwardValue: w.thresholds?.includeUnknownAwardValue ?? false,
      majorFunding: { default: 5_000_000, ...(w.thresholds?.majorFunding ?? {}) },
      includeUnknownFundingAmount: w.thresholds?.includeUnknownFundingAmount ?? true,
    },
    spikes: { windowDays: 7, baselineWeeks: 8, multiplier: 2, minNewJobs: 5, cooldownDays: 14, ...(w.spikes ?? {}) },
  };
}

/* ------------------------------------------------------ company matching */

const SPINE = new Set(['UK', 'SG', 'DIFC', 'ADGM']);
function entityIdFor(c) {
  if (!c.registrationNumber || !SPINE.has(c.country)) return null;
  try { return normalizeEntityId(c.registrationNumber, c.country); } catch { return null; }
}

const SUFFIXES = new Set(['limited', 'ltd', 'plc', 'llp', 'llc', 'inc', 'corp', 'corporation', 'co', 'company', 'pte', 'pty',
  'gmbh', 'ag', 'sa', 'bv', 'nv', 'spa', 'srl', 'holdings', 'holding', 'group', 'uk', 'international', 'services', 'fzco', 'fze', 'wll']);
export function normalizeName(name) {
  const t = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (t[0] === 'the') t.shift();
  while (t.length > 1 && SUFFIXES.has(t.at(-1))) t.pop();
  return t.join(' ');
}

const SCHEMES = { 'GB-COH': 'UK', 'SG-ACRA': 'SG' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildMatcher(companies) {
  const byName = new Map(); const byEntity = new Map(); const textTerms = [];
  for (const c of companies) {
    for (const label of [c.name, ...c.aliases]) {
      const n = normalizeName(label);
      if (n) byName.set(n, c);
      // For free text (news), use the full label and, if distinctive enough, its core name.
      for (const term of new Set([label, n.split(' ').length >= 2 || n.length >= 8 ? n : null].filter(Boolean))) {
        textTerms.push({ c, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}($|[^\\p{L}\\p{N}])`, 'iu') });
      }
    }
    if (c.entityId) byEntity.set(c.entityId, c);
  }
  return {
    supplier(s) {
      for (const id of s.identifiers ?? []) {
        const j = SCHEMES[String(id.scheme ?? '').toUpperCase()];
        if (!j || !id.id) continue;
        try { const c = byEntity.get(normalizeEntityId(id.id, j)); if (c) return { company: c, method: 'registration' }; } catch { /* malformed id */ }
      }
      const c = byName.get(normalizeName(s.name));
      return c ? { company: c, method: 'name' } : null;
    },
    name: (n) => byName.get(normalizeName(n)) ?? null,
    text: (t) => [...new Set(textTerms.filter((x) => x.re.test(t)).map((x) => x.c))],
  };
}

/* ------------------------------------------------------------ signals */

const threshold = (map, currency) => map[String(currency ?? '').toUpperCase()] ?? map.default;
const fmtMoney = (v, cur) => (v == null ? 'value not stated' : `${cur ?? ''} ${Math.round(v).toLocaleString('en-GB')}`.trim());

const FUNDING_RE = /\b(rais(es|ed|ing)|secur(es|ed)|clos(es|ed)|lands?|bags?)\b[^.]{0,80}\b(funding|round|investment|series\s+[a-f]|seed|pre-seed|growth\s+equity)\b|\bseries\s+[a-f]\b[^.]{0,40}\b(round|funding)\b/i;
const AMOUNT_RE = /(US\$|S\$|HK\$|A\$|\$|£|€|SAR|AED|USD|GBP|EUR)\s?(\d+(?:[.,]\d+)?)\s?(bn|billion|m|mn|million|k)?\b/i;
const CUR = { 'US$': 'USD', $: 'USD', '£': 'GBP', '€': 'EUR', 'S$': 'SGD', 'HK$': 'HKD', 'A$': 'AUD' };

export function parseAmount(text) {
  const m = String(text).match(AMOUNT_RE);
  if (!m) return { amount: null, currency: null };
  const mult = { bn: 1e9, billion: 1e9, m: 1e6, mn: 1e6, million: 1e6, k: 1e3 }[m[3]?.toLowerCase()] ?? 1;
  return { amount: Number(m[2].replace(',', '.')) * mult, currency: CUR[m[1]] ?? m[1].toUpperCase() };
}

/** Pure spike rule, shared with tests. */
export function evaluateSpike({ newInWindow, baselineNew, trackedDays, lastSpikeAt }, rules, day) {
  const baselineDays = Math.min(rules.baselineWeeks * 7, Math.max(0, trackedDays - rules.windowDays));
  const baselineWeekly = baselineDays >= 7 ? baselineNew / (baselineDays / 7) : null;
  const limit = baselineWeekly === null ? rules.minNewJobs * 2 : Math.max(rules.minNewJobs, Math.ceil(baselineWeekly * rules.multiplier));
  const cooling = lastSpikeAt && Date.parse(day) - Date.parse(lastSpikeAt) < rules.cooldownDays * 86_400_000;
  return { isSpike: newInWindow >= limit && !cooling, limit, baselineWeekly: baselineWeekly === null ? null : Math.round(baselineWeekly * 10) / 10 };
}

/* -------------------------------------------------------------- Slack */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url, text) => (url && /^https?:\/\//.test(url) ? `<${url}|${esc(text).replace(/\|/g, '¦')}>` : esc(text));

function signalLine(s) {
  const x = s.summary;
  if (s.type === 'contract_award') {
    const conf = x.confidence === 'tenderer' ? ' · _named as tenderer, check notice_' : '';
    return `*${esc(x.company)}* · ${link(x.url, x.title ?? 'award notice')}\n${esc(x.buyer ?? 'Buyer not stated')} · *${esc(fmtMoney(x.value, x.currency))}* · ${esc(x.source)} (${x.region})${conf}`;
  }
  if (s.type === 'funding') {
    return `*${esc(x.company)}* · ${link(x.link, x.title)}\n${x.amount ? `*${esc(fmtMoney(x.amount, x.currency))}* · ` : ''}${esc(x.feed ?? '')}`;
  }
  const base = x.baselineWeekly === null ? 'limited history' : `usually ~${x.baselineWeekly}/week`;
  return `*${esc(x.company)}* · *${x.newInWindow} new roles* in ${x.windowDays} days (threshold ${x.limit}, ${base})\n_${esc(x.sources.join(', '))}_ · e.g. ${esc(x.sampleTitles.slice(0, 3).join('; '))}`;
}

export function buildSlackPayload(signals, { date, warnings, maxPerType }) {
  const groups = [
    ['contract_award', ':trophy: Major contract awards'],
    ['funding', ':moneybag: Funding'],
    ['job_spike', ':chart_with_upwards_trend: Hiring spikes'],
  ];
  const count = (t) => signals.filter((s) => s.type === t).length;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Hiring signals · ${date}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${count('contract_award')} awards · ${count('funding')} funding · ${count('job_spike')} hiring spikes` }] },
  ];
  for (const [type, title] of groups) {
    const list = signals.filter((s) => s.type === type).sort((a, b) => b.score - a.score);
    if (!list.length) continue;
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*${title}* (${list.length})` } });
    for (const s of list.slice(0, maxPerType)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: signalLine(s).slice(0, 2900) } });
    if (list.length > maxPerType) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${list.length - maxPerType} more_` }] });
  }
  if (warnings.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:warning: ${warnings.slice(0, 10).map(esc).join('\n')}${warnings.length > 10 ? `\n…and ${warnings.length - 10} more` : ''}`.slice(0, 2900) }] });
  }
  return { text: `Hiring signals ${date}: ${signals.length} new`, blocks: blocks.slice(0, 50) };
}

/* --------------------------------------------------------------- main */

function makePinger(s) {
  if (!s.healthchecksBaseUrl || !s.healthcheckUuid) return async () => {};
  return async (event) => {
    if (DRY_RUN) return;
    try { await withRetry(() => pingHealthcheck(buildHealthcheckUrl(s.healthchecksBaseUrl, s.healthcheckUuid, event)), 2, 1000); }
    catch (err) { log.warn(`Healthcheck ping failed: ${err.message}`); }
  };
}

function saveRawBodies(snapshots, runId, dir) {
  const base = path.join(dir, 'snapshots', String(runId));
  mkdirSync(base, { recursive: true });
  snapshots.forEach((s, i) => {
    const ext = { json: 'json', csv: 'csv', xml: 'xml' }[s.format] ?? 'txt';
    s.bodyPath = path.join(base, `${String(i).padStart(4, '0')}-${s.source}-${String(s.key).replace(/[^a-z0-9-]+/gi, '_')}.${ext}`);
    writeFileSync(s.bodyPath, s.body);
  });
}

async function main() {
  const s = loadSettings();
  const ping = makePinger(s);
  await ping('start');
  let db; let runId;

  try {
    if (!DRY_RUN && !s.slackWebhookUrl) throw new Error('Set SLACK_WEBHOOK_URL (or HSS_SLACK_WEBHOOK_URL) in the root .env');
    const watchlist = loadWatchlist(s.watchlistPath);
    const matcher = buildMatcher(watchlist.companies);
    const opened = openDb(s.dbPath, { dryRun: DRY_RUN });
    db = opened.db;
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    if (!DRY_RUN) { runId = startRun(db, now); syncWatchlist(db, watchlist.companies, now); }
    log.info(`${DRY_RUN ? 'DRY RUN · ' : ''}${watchlist.companies.length} companies · db ${opened.persistent ? s.dbPath : '(in-memory, nothing saved)'}`);

    /* 1. Raw snapshots */
    const harvest = await harvestAll(watchlist, { getCursor: (id) => getCursor(db, id), now, env: s.env, log });
    const bytes = harvest.snapshots.reduce((n, x) => n + x.bytes, 0);
    log.info(`Fetched ${harvest.snapshots.length} snapshots (${(bytes / 1e6).toFixed(1)} MB), ${harvest.failures.length} source failures`);
    // Failures always reach Slack; routine notes ("dataset unchanged") stay in the log.
    const failures = harvest.failures.map((f) => `${f.source}: ${f.error}`);
    const warnings = [...failures];
    harvest.notes.forEach((n) => log.info(n));

    /* 2. Parse */
    const parsed = parseSnapshots(harvest.snapshots, watchlist);
    parsed.parseErrors.forEach((e) => { const m = `parse ${e.source}/${e.key}: ${e.error}`; warnings.push(m); failures.push(m); });
    log.info(`Parsed ${parsed.awards.length} awards, ${parsed.boards.length} boards, ${parsed.feedJobs.length} feed jobs, ${parsed.funding.length} news items`);

    const signals = [];
    const seenSignals = knownSignalKeys(db);
    const addSignal = (sig) => { if (!seenSignals.has(sig.refKey)) { seenSignals.add(sig.refKey); signals.push(sig); } };

    /* 3. Contract awards */
    const seededSources = new Set();
    const knownAwards = knownAwardKeys(db);
    const newAwards = [];
    for (const a of parsed.awards) {
      const baseSource = a.source.split(':')[0];
      const isBaselineSource = FULL_DATASET_SOURCES.has(baseSource) && !getCursor(db, baseSource);
      if (isBaselineSource) seededSources.add(baseSource);
      for (const supplier of a.suppliers) {
        const hit = matcher.supplier(supplier);
        if (!hit) continue;
        const key = `${a.source}|${a.noticeId}|${hit.company.id}`;
        if (knownAwards.has(key)) continue;
        knownAwards.add(key);
        const award = { ...a, companyId: hit.company.id, supplierName: supplier.name, matchMethod: hit.method };
        newAwards.push(award);
        if (isBaselineSource) continue; // first read of a full dataset: store, don't alert on history

        const limit = threshold(watchlist.thresholds.majorAward, a.currency);
        const major = a.value !== null ? a.value >= limit : watchlist.thresholds.includeUnknownAwardValue;
        if (!major) continue;
        const region = harvest.snapshots.find((x) => x.source === baseSource)?.region ?? '';
        addSignal({
          type: 'contract_award', companyId: hit.company.id, refKey: `award:${key}`,
          score: a.value !== null ? Math.min(10, a.value / limit) : 0.5,
          summary: { company: hit.company.name, source: a.source, region, title: a.title, buyer: a.buyer, value: a.value, currency: a.currency, url: a.url, confidence: a.confidence, matchMethod: hit.method },
        });
      }
    }
    log.info(`Awards: ${newAwards.length} new at watchlist companies${seededSources.size ? ` (baseline for ${[...seededSources].join(', ')})` : ''}`);

    /* 4. Job boards and licensed feeds -> velocity */
    const boards = [...parsed.boards];
    const feedGroups = new Map();
    for (const j of parsed.feedJobs) {
      const c = matcher.name(j.company);
      if (!c) continue;
      const k = `${c.id}|${j.source}`;
      if (!feedGroups.has(k)) feedGroups.set(k, { companyId: c.id, source: j.source, jobs: [], complete: false });
      feedGroups.get(k).jobs.push(j);
    }
    boards.push(...feedGroups.values());

    const todayNew = new Map(); // companyId -> { count, titles, sources }
    const writes = [];
    for (const b of boards) {
      const active = activeJobKeys(db, b.companyId, b.source);
      const isBaseline = !hasJobHistory(db, b.companyId, b.source);
      const current = new Set(b.jobs.map((j) => j.key));
      if (!isBaseline && active.size > 0 && (b.jobs.length === 0 || (b.complete && active.size >= 10 && b.jobs.length < active.size * (1 - s.maxDropRatio)))) {
        const msg = `${b.companyId} (${b.source}): board fell from ${active.size} to ${b.jobs.length} jobs; snapshot ignored`;
        warnings.push(msg);
        log.warn(msg);
        continue;
      }
      const delta = { newKeys: [...current].filter((k) => !active.has(k)), closedKeys: b.complete ? [...active].filter((k) => !current.has(k)) : [] };
      writes.push({ ...b, delta, isBaseline });
      if (isBaseline) continue;
      const t = todayNew.get(b.companyId) ?? { count: 0, titles: [], sources: new Set() };
      t.count += delta.newKeys.length;
      t.titles.push(...b.jobs.filter((j) => delta.newKeys.includes(j.key)).map((j) => j.title));
      if (delta.newKeys.length) t.sources.add(b.source);
      todayNew.set(b.companyId, t);
    }

    for (const [companyId, t] of todayNew) {
      const h = velocityHistory(db, companyId, { day, windowDays: watchlist.spikes.windowDays, baselineWeeks: watchlist.spikes.baselineWeeks });
      const newInWindow = h.windowPrior + h.todayPrior + t.count;
      const verdict = evaluateSpike({ newInWindow, baselineNew: h.baselineNew, trackedDays: h.trackedDays, lastSpikeAt: lastSignalAt(db, companyId, 'job_spike') }, watchlist.spikes, day);
      if (!verdict.isSpike) continue;
      const company = watchlist.companies.find((c) => c.id === companyId);
      addSignal({
        type: 'job_spike', companyId, refKey: `spike:${companyId}:${day}`, score: newInWindow / verdict.limit,
        summary: { company: company.name, newInWindow, windowDays: watchlist.spikes.windowDays, limit: verdict.limit, baselineWeekly: verdict.baselineWeekly, sources: [...t.sources], sampleTitles: t.titles.slice(0, 8) },
      });
    }
    log.info(`Jobs: ${writes.length} boards processed, ${writes.filter((w) => w.isBaseline).length} baselines, ${[...todayNew.values()].reduce((n, t) => n + t.count, 0)} new postings`);

    /* 5. Funding news */
    const knownFunding = knownFundingKeys(db);
    const newFunding = [];
    for (const item of parsed.funding) {
      const text = `${item.title} ${item.summary}`;
      if (!FUNDING_RE.test(text)) continue;
      for (const c of matcher.text(text)) {
        const itemKey = `${item.guid || item.link || item.title}|${c.id}`;
        if (knownFunding.has(itemKey)) continue;
        knownFunding.add(itemKey);
        const { amount, currency } = parseAmount(text);
        newFunding.push({ itemKey, companyId: c.id, title: item.title, link: item.link || null, feed: item.feed, amount, currency, published: item.published || null });
        const limit = threshold(watchlist.thresholds.majorFunding, currency);
        const major = amount !== null ? amount >= limit : watchlist.thresholds.includeUnknownFundingAmount;
        if (!major) continue;
        addSignal({
          type: 'funding', companyId: c.id, refKey: `funding:${itemKey}`, score: amount !== null ? Math.min(10, amount / limit) : 1,
          summary: { company: c.name, title: item.title, link: item.link, feed: item.feed, amount, currency },
        });
      }
    }
    log.info(`Funding: ${newFunding.length} new items about watchlist companies`);

    /* 6. Persist (live only) */
    if (!DRY_RUN) {
      if (s.saveRaw) saveRawBodies(harvest.snapshots, runId, path.dirname(s.dbPath));
      db.transaction(() => {
        recordSnapshots(db, runId, harvest.snapshots);
        insertAwards(db, newAwards, now);
        for (const w of writes) applyBoard(db, { ...w, day, now });
        insertFunding(db, newFunding, now);
        insertSignals(db, signals, now);
        const cursors = { ...harvest.cursors };
        for (const src of seededSources) if (!cursors[src]) cursors[src] = JSON.stringify({ seeded: now });
        for (const src of ['hk', 'etimad', 'meaAggregator']) {
          if (harvest.snapshots.some((x) => x.source === src || x.source.startsWith(`${src}:`)) && !getCursor(db, src)) cursors[src] = JSON.stringify({ seeded: now });
        }
        setCursors(db, cursors, now);
      })();
    }

    /* 7. Report */
    const toSend = DRY_RUN ? signals : pendingSignals(db);
    for (const sig of [...toSend].sort((a, b) => b.score - a.score).slice(0, 20)) log.info(`  [${sig.type}] ${sig.summary.company}: ${signalLine(sig).split('\n')[0].replace(/[*_]/g, '').replace(/<[^|]+\|([^>]+)>/g, '$1')}`);
    log.info(`${toSend.length} signals ${DRY_RUN ? 'would be sent' : 'to send'}`);

    // Post when there is something to act on: new signals, or a source that failed outright.
    if (toSend.length || failures.length) {
      const payload = buildSlackPayload(toSend, { date: day, warnings, maxPerType: s.maxPerType });
      if (DRY_RUN) {
        console.log(JSON.stringify(payload, null, 2));
        log.info('Dry run: nothing written, no Slack message sent');
      } else {
        await withRetry(() => sendSlackAlert(s.slackWebhookUrl, payload), 3, 2000);
        markSignalsNotified(db, toSend.map((x) => x.refKey), now);
      }
    }

    const status = harvest.snapshots.length === 0 && harvest.failures.length ? 'failed' : warnings.length ? 'partial' : 'ok';
    if (!DRY_RUN) finishRun(db, runId, { status, stats: { snapshots: harvest.snapshots.length, awards: newAwards.length, boards: writes.length, funding: newFunding.length, signals: signals.length } });
    if (status === 'failed') { process.exitCode = 1; await ping('fail'); } else await ping();
  } catch (err) {
    log.error(err.stack ?? err.message);
    process.exitCode = 1;
    if (db && runId && !DRY_RUN) finishRun(db, runId, { status: 'failed', error: err.message });
    await ping('fail');
    if (!DRY_RUN && s.slackWebhookUrl) {
      await sendSlackAlert(s.slackWebhookUrl, `:rotating_light: Hiring-Signal Scout failed: ${err.message}`).catch(() => {});
    }
  } finally {
    db?.close();
  }
}

await main();