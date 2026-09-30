import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { sendSlackAlert, pingHealthcheck, buildHealthcheckUrl, withRetry, normalizeEntityId } from '@botarmy/core';
import { fetchPaymentPracticesCsv } from './harvester.js';
import { openDb, countRecords, knownReportIds, getPreviousReport, insertReports } from './db.js';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const REPORT_BASE = 'https://check-payment-practices.service.gov.uk/report/';

const log = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

/** Read env lazily: static imports run before the dotenv call above. */
function loadSettings(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);
  return {
    dbPath: path.resolve(BOT_DIR, env.PPS_DB_PATH || 'data/payment-practices.db'),
    slackWebhookUrl: env.PPS_SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || '',
    healthchecksBaseUrl: env.HEALTHCHECKS_BASE_URL || '',
    healthcheckUuid: env.PPS_HC_UUID || '',
    rules: {
      minDaysIncrease: num(env.PPS_MIN_DAYS_INCREASE, 15),   // absolute rise in average days to pay
      minPctIncrease: num(env.PPS_MIN_PCT_INCREASE, 30),     // relative rise, %
      minAvgDays: num(env.PPS_MIN_AVG_DAYS, 40),             // ignore rises that stay fast (e.g. 10 -> 26)
      minLatePoints: num(env.PPS_MIN_LATE_POINTS, 20),       // rise in % paid outside agreed terms
      minLatePct: num(env.PPS_MIN_LATE_PCT, 30),
      maxGapDays: num(env.PPS_MAX_GAP_DAYS, 400),            // only compare roughly consecutive periods
    },
    maxAlerts: num(env.PPS_MAX_ALERTS, 25),
    previewDays: num(env.PPS_PREVIEW_DAYS, 30),
    minReports: num(env.PPS_MIN_REPORTS, 1000),
  };
}

/* --------------------------------------------------------------- parsing */

/**
 * The export's exact headers are not documented and have changed as new
 * metrics were added (e.g. dispute figures from 2025), so columns are found by
 * pattern. Required ones missing -> a clear error listing what was found.
 */
const COLUMN_PATTERNS = {
  reportId: [/^report\s*id$/i, /^report\s*(number|no\.?)$/i],
  url: [/^url$/i, /report\s*url/i, /^link$/i],
  companyName: [/^company$/i, /^company\s*name$/i, /^business\s*name$/i, /^name$/i],
  companyNumber: [/^company\s*(number|no\.?|registration)/i],
  avgDaysToPay: [/average\s*(time|number of days)?.*\bto\s*pay/i, /average.*days/i],
  paymentsBeyondTerms: [/not\s*paid\s*within\s*(the\s*)?agreed(?!.*dispute)/i],
  periodStart: [/^start\s*date$/i, /(reporting\s*)?period\s*start/i],
  periodEnd: [/^end\s*date$/i, /(reporting\s*)?period\s*end/i],
  filingDate: [/^filing\s*date$/i, /(date\s*)?(filed|published|submitted)/i],
};
const REQUIRED = ['companyName', 'avgDaysToPay', 'periodEnd'];

export function resolveColumns(header) {
  const clean = header.map((h) => String(h ?? '').replace(/^\uFEFF/, '').trim());
  const mapping = {};
  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (const re of patterns) {
      const i = clean.findIndex((h, idx) => re.test(h) && !Object.values(mapping).includes(idx));
      if (i !== -1) { mapping[field] = i; break; }
    }
  }
  const missing = REQUIRED.filter((f) => mapping[f] === undefined);
  if (mapping.reportId === undefined && mapping.url === undefined) missing.push('reportId or url');
  if (missing.length) {
    throw new Error(`Export format not recognised; missing ${missing.join(', ')}.\nColumns found: ${clean.join(' | ')}`);
  }
  return { mapping, columns: clean };
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, '0');

export function toIsoDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return null;
}

export function toInt(value) {
  const s = String(value ?? '').replace(/[%,\s]/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

function companyIdentity(rawNumber, name) {
  const raw = String(rawNumber ?? '').trim();
  if (raw) {
    try {
      const key = normalizeEntityId(raw, 'UK'); // "UK:01478292"
      return { companyKey: key, companyNumber: key.slice(3) };
    } catch {
      // not a Companies House format; fall through to name identity
    }
  }
  const byName = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return { companyKey: `name:${byName}`, companyNumber: raw || null };
}

/** @returns {{ reports: object[], columns: string[], mapping: object, skipped: number }} */
export function parseReports(text) {
  let resolved = null;
  let skipped = 0;
  const get = (rec, field) => (resolved.mapping[field] === undefined ? '' : rec[resolved.mapping[field]] ?? '');

  const reports = parse(text, {
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    // Keep only the fields we use, so a 30 MB+ export stays light in memory.
    on_record: (rec) => {
      if (!resolved) { resolved = resolveColumns(rec); return null; }
      const companyName = String(get(rec, 'companyName')).trim();
      const periodEndDate = toIsoDate(get(rec, 'periodEnd'));
      if (!companyName || !periodEndDate) { skipped += 1; return null; }

      const url = String(get(rec, 'url')).trim() || null;
      const reportId = String(get(rec, 'reportId')).trim() || url?.match(/\/report\/(\d+)/)?.[1] || null;
      if (!reportId) { skipped += 1; return null; }

      return {
        reportId,
        companyName,
        ...companyIdentity(get(rec, 'companyNumber'), companyName),
        avgDaysToPay: toInt(get(rec, 'avgDaysToPay')),
        paymentsBeyondTerms: toInt(get(rec, 'paymentsBeyondTerms')),
        periodStartDate: toIsoDate(get(rec, 'periodStart')),
        periodEndDate,
        filingDate: toIsoDate(get(rec, 'filingDate')),
        reportUrl: url ?? (/^\d+$/.test(reportId) ? `${REPORT_BASE}${reportId}` : null),
      };
    },
  });

  if (!resolved) throw new Error('Export was empty (no header row)');
  return { reports, columns: resolved.columns, mapping: resolved.mapping, skipped };
}

/* ------------------------------------------------------------- detection */

/** Index every report in the export by company, newest period first. */
function buildHistory(reports) {
  const byCompany = new Map();
  for (const r of reports) {
    if (!byCompany.has(r.companyKey)) byCompany.set(r.companyKey, []);
    byCompany.get(r.companyKey).push(r);
  }
  for (const list of byCompany.values()) {
    list.sort((a, b) => b.periodEndDate.localeCompare(a.periodEndDate) || (b.filingDate ?? '').localeCompare(a.filingDate ?? ''));
  }
  return byCompany;
}

/** Previous report for the same company and an earlier period: export first, then DB. */
function previousReport(history, db, report) {
  const fromExport = history.get(report.companyKey)?.find((r) => r.periodEndDate < report.periodEndDate);
  if (fromExport) return fromExport;
  const row = getPreviousReport(db, report.companyKey, report.periodEndDate);
  return row && {
    reportId: row.report_id, avgDaysToPay: row.avg_days_to_pay, paymentsBeyondTerms: row.payments_beyond_terms,
    periodEndDate: row.period_end_date, reportUrl: row.report_url,
  };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * A jump is either:
 *  - average days to pay up by >= minDaysIncrease AND >= minPctIncrease %, ending at >= minAvgDays, or
 *  - % of payments outside agreed terms up by >= minLatePoints, ending at >= minLatePct.
 */
export function evaluateJump(report, prev, rules) {
  if (!prev) return null;
  const gap = daysBetween(prev.periodEndDate, report.periodEndDate);
  if (gap <= 0 || gap > rules.maxGapDays) return null;

  const reasons = [];
  let score = 0;
  const { avgDaysToPay: now, paymentsBeyondTerms: lateNow } = report;
  const { avgDaysToPay: before, paymentsBeyondTerms: lateBefore } = prev;

  let daysDelta = null;
  let pctDelta = null;
  if (now !== null && before !== null && before > 0) {
    daysDelta = now - before;
    pctDelta = Math.round((daysDelta / before) * 100);
    if (daysDelta >= rules.minDaysIncrease && pctDelta >= rules.minPctIncrease && now >= rules.minAvgDays) {
      reasons.push('days');
      score += daysDelta;
    }
  }

  let lateDelta = null;
  if (lateNow !== null && lateBefore !== null) {
    lateDelta = lateNow - lateBefore;
    if (lateDelta >= rules.minLatePoints && lateNow >= rules.minLatePct) {
      reasons.push('late');
      score += lateDelta;
    }
  }

  return reasons.length ? { report, prev, daysDelta, pctDelta, lateDelta, reasons, score, gapDays: gap } : null;
}

/** True if the company already filed a different report for this same period (an amendment). */
function isRefiling(history, report) {
  return (history.get(report.companyKey) ?? []).some(
    (r) => r.periodEndDate === report.periodEndDate && r.reportId !== report.reportId
      && (r.filingDate ?? '') <= (report.filingDate ?? ''),
  );
}

function detectJumps(candidates, history, db, rules) {
  return candidates
    .map((r) => {
      const jump = evaluateJump(r, previousReport(history, db, r), rules);
      return jump && { ...jump, refiled: isRefiling(history, r) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

/* ----------------------------------------------------------------- Slack */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

function jumpLine(j) {
  const { report: r, prev: p } = j;
  const link = r.reportUrl ? ` · <${r.reportUrl}|report>` : '';
  const days = r.avgDaysToPay !== null && p.avgDaysToPay !== null
    ? `Avg days to pay ${p.avgDaysToPay} → *${r.avgDaysToPay}* (${sign(j.daysDelta)}, ${sign(j.pctDelta)}%)`
    : null;
  const late = r.paymentsBeyondTerms !== null && p.paymentsBeyondTerms !== null
    ? `Outside terms ${p.paymentsBeyondTerms}% → *${r.paymentsBeyondTerms}%* (${sign(j.lateDelta)} pts)`
    : null;
  return `*${esc(r.companyName)}*${r.companyNumber ? ` (${esc(r.companyNumber)})` : ''}${link}\n`
    + `${[days, late].filter(Boolean).join(' · ')}\n_Period ending ${r.periodEndDate} vs ${p.periodEndDate}`
    + `${j.refiled ? ' · re-filed report for this period, check against the original' : ''}_`;
}

export function buildSlackPayload(jumps, { maxAlerts, date }) {
  const shown = jumps.slice(0, maxAlerts);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Payment practices · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${jumps.length} compan${jumps.length === 1 ? 'y is' : 'ies are'} paying suppliers markedly slower than in their previous report` }],
    },
    { type: 'divider' },
    ...shown.map((j) => ({ type: 'section', text: { type: 'mrkdwn', text: jumpLine(j).slice(0, 2900) } })),
  ];
  if (jumps.length > shown.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${jumps.length - shown.length} more (raise PPS_MAX_ALERTS to see them)_` }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Figures are self-reported by each business. Source: <https://check-payment-practices.service.gov.uk/export|check-payment-practices.service.gov.uk>_' }] });

  const top = jumps[0];
  return {
    text: `Payment practices: ${jumps.length} slower payers, top ${top.report.companyName} (${top.prev.avgDaysToPay ?? '?'} → ${top.report.avgDaysToPay ?? '?'} days)`,
    blocks: blocks.slice(0, 50),
  };
}

/* ------------------------------------------------------------------ main */

function makePinger(s) {
  if (!s.healthchecksBaseUrl || !s.healthcheckUuid) return async () => {};
  return async (event) => {
    if (DRY_RUN) return;
    try {
      await withRetry(() => pingHealthcheck(buildHealthcheckUrl(s.healthchecksBaseUrl, s.healthcheckUuid, event)), 2, 1000);
    } catch (err) {
      log.warn(`Healthcheck ping (${event ?? 'success'}) failed: ${err.message}`);
    }
  };
}

function logJumps(jumps, limit = 10) {
  for (const j of jumps.slice(0, limit)) {
    const r = j.report;
    log.info(`  ${r.companyName} (${r.companyNumber ?? 'no number'}): days ${j.prev.avgDaysToPay ?? '?'} → ${r.avgDaysToPay ?? '?'}`
      + `, outside terms ${j.prev.paymentsBeyondTerms ?? '?'}% → ${r.paymentsBeyondTerms ?? '?'}% [${j.reasons.join('+')}]`
      + (j.refiled ? ' (re-filed)' : ''));
  }
  if (jumps.length > limit) log.info(`  …and ${jumps.length - limit} more`);
}

async function main() {
  const s = loadSettings();
  const ping = makePinger(s);
  await ping('start');
  let db;

  try {
    if (!DRY_RUN && !s.slackWebhookUrl) throw new Error('Set SLACK_WEBHOOK_URL (or PPS_SLACK_WEBHOOK_URL) in the root .env');

    const csv = await withRetry(() => fetchPaymentPracticesCsv(), 2, 10_000);
    log.info(`Downloaded ${(csv.bytes / 1e6).toFixed(1)} MB from ${csv.source}`);

    const { reports, columns, mapping, skipped } = parseReports(csv.text);
    log.info(`Parsed ${reports.length.toLocaleString('en-GB')} reports (${skipped} rows skipped)`);
    if (DRY_RUN) {
      log.info(`Column mapping: ${Object.entries(mapping).map(([k, i]) => `${k}="${columns[i]}"`).join(', ')}`);
      if (mapping.paymentsBeyondTerms === undefined) log.warn('No "% not paid within agreed terms" column found; only day jumps will be detected');
    }

    const opened = openDb(s.dbPath, { dryRun: DRY_RUN });
    db = opened.db;
    const stored = countRecords(db);

    // A truncated download must not look like a fresh dataset.
    if (reports.length < s.minReports || (stored > 0 && reports.length < stored * 0.9)) {
      throw new Error(`Export looks incomplete: ${reports.length} reports parsed, ${stored} already stored (minimum ${s.minReports})`);
    }

    const known = knownReportIds(db);
    const fresh = reports.filter((r) => !known.has(r.reportId));
    const history = buildHistory(reports);
    const isBaseline = stored === 0;

    if (isBaseline) {
      // Comparing every historical report would flood Slack, so the first run only records.
      const since = new Date(Date.now() - s.previewDays * 86_400_000).toISOString().slice(0, 10);
      const recent = fresh.filter((r) => (r.filingDate ?? '') >= since);
      const preview = detectJumps(recent, history, db, s.rules);
      log.info(`Baseline: ${fresh.length.toLocaleString('en-GB')} reports would be stored; no alerts on a first run`);
      log.info(`Preview: ${preview.length} jumps among ${recent.length} reports filed since ${since}`);
      logJumps(preview);

      if (DRY_RUN) {
        log.info(opened.persistent ? 'Dry run: database left unchanged' : `Dry run: no database created (would be ${s.dbPath})`);
      } else {
        const inserted = insertReports(db, fresh);
        log.info(`Baseline stored: ${inserted.toLocaleString('en-GB')} reports in ${s.dbPath}`);
      }
      await ping();
      return;
    }

    const jumps = detectJumps(fresh, history, db, s.rules);
    log.info(`${fresh.length} new reports since last run; ${jumps.length} show a significant jump`);
    logJumps(jumps);

    if (DRY_RUN) {
      if (jumps.length) console.log(JSON.stringify(buildSlackPayload(jumps, { maxAlerts: s.maxAlerts, date: new Date().toISOString().slice(0, 10) }), null, 2));
      log.info('Dry run: no rows written, no Slack message sent');
      await ping();
      return;
    }

    // Alert first, then store: if Slack fails, the same reports are retried next run.
    if (jumps.length) {
      const payload = buildSlackPayload(jumps, { maxAlerts: s.maxAlerts, date: new Date().toISOString().slice(0, 10) });
      await withRetry(() => sendSlackAlert(s.slackWebhookUrl, payload), 3, 2000);
      log.info(`Slack alert sent (${Math.min(jumps.length, s.maxAlerts)} of ${jumps.length} shown)`);
    }
    const inserted = insertReports(db, fresh);
    log.info(`Stored ${inserted} new reports`);
    await ping();
  } catch (err) {
    log.error(err.stack ?? err.message);
    process.exitCode = 1;
    await ping('fail');
    if (!DRY_RUN && s.slackWebhookUrl) {
      await sendSlackAlert(s.slackWebhookUrl, `:rotating_light: Payment Practices Scout failed: ${err.message}`)
        .catch((e) => log.error(`Could not send failure alert: ${e.message}`));
    }
  } finally {
    db?.close();
  }
}

await main();