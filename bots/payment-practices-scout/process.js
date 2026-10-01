/**
 * B9 processor: raw export snapshot → payment_records → jumps → spine events.
 *
 * Reads only the snapshot store, never the network. The export holds every
 * report ever filed, so each run inserts only report IDs it has not seen, and
 * compares each new report with the same company's previous reporting period.
 */
import { parse } from 'csv-parse/sync';
import { normalizeEntityId } from '@botarmy/core';

export const BOT = 'payment-practices-scout';
export const EVENT_TYPE = 'PAYMENT_DAYS_JUMP';
export const REPORT_BASE = 'https://check-payment-practices.service.gov.uk/report/';

/** Thrown when an export snapshot fails the anomaly checks. Processing halts. */
export class AnomalyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AnomalyError';
    this.details = details;
  }
}

/* ========================================================= safe parsing */

export function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export const looksLikeHtml = (text) => /^\s*<(!doctype|html)/i.test(text.slice(0, 300));

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n) => String(n).padStart(2, '0');

function calendarDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** "YYYY-MM-DD" from ISO, dd/mm/yyyy or "30 June 2026"; null when unparseable or impossible. */
export function toIsoDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return calendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return calendarDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  return null;
}

/** Whole number from "53", "17%", "1,234"; null for blanks, text or non-finite values. Never 0 by default. */
export function toInt(value) {
  const s = String(value ?? '').replace(/[%,\s]/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* ===================================================== column detection */

/**
 * The export's headers are undocumented and have grown over time (e.g. the
 * 2025 "because of a dispute" figure), so columns are found by pattern.
 */
export const COLUMN_PATTERNS = Object.freeze({
  reportId: [/^report\s*id$/i, /^report\s*(number|no\.?)$/i],
  url: [/^url$/i, /report\s*url/i, /^link$/i],
  companyName: [/^company$/i, /^company\s*name$/i, /^business\s*name$/i, /^name$/i],
  companyNumber: [/^company\s*(number|no\.?|registration)/i],
  avgDaysToPay: [/average\s*(time|number of days)?.*\bto\s*pay/i, /average.*days/i],
  paymentsBeyondTerms: [/not\s*paid\s*within\s*(the\s*)?agreed(?!.*dispute)/i],
  periodStart: [/^start\s*date$/i, /(reporting\s*)?period\s*start/i],
  periodEnd: [/^end\s*date$/i, /(reporting\s*)?period\s*end/i],
  filingDate: [/^filing\s*date$/i, /(date\s*)?(filed|published|submitted)/i],
});
const REQUIRED = ['companyName', 'avgDaysToPay', 'periodEnd'];

/** @returns {{ mapping: Record<string, number>, columns: string[] }} */
export function resolveColumns(header) {
  const columns = header.map((h) => String(h ?? '').replace(/^\uFEFF/, '').trim());
  const mapping = {};
  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (const re of patterns) {
      const i = columns.findIndex((h, idx) => re.test(h) && !Object.values(mapping).includes(idx));
      if (i !== -1) { mapping[field] = i; break; }
    }
  }
  const missing = REQUIRED.filter((f) => mapping[f] === undefined);
  if (mapping.reportId === undefined && mapping.url === undefined) missing.push('reportId or url');
  if (missing.length) {
    throw new AnomalyError(`Export format not recognised; missing ${missing.join(', ')}. Columns found: ${columns.join(' | ') || '(none)'}`, { kind: 'columns' });
  }
  return { mapping, columns };
}

/** Companies House number → spine identity; without one, a normalised-name key (never a guessed number). */
export function companyIdentity(rawNumber, name) {
  const raw = String(rawNumber ?? '').trim();
  if (raw) {
    try {
      const spineId = normalizeEntityId(raw, 'UK');
      return { companyKey: spineId, companyNumber: spineId.slice(3) };
    } catch {
      // not a Companies House format
    }
  }
  return { companyKey: `name:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`, companyNumber: null };
}

/**
 * Parse the export into compact report objects.
 * @returns {{ reports: object[], rowCount: number, skipped: number, mapping: object, columns: string[] }}
 */
export function parseExport(text) {
  let resolved = null;
  let rowCount = 0;
  let skipped = 0;
  const get = (rec, field) => (resolved.mapping[field] === undefined ? '' : rec[resolved.mapping[field]] ?? '');

  const reports = parse(text, {
    bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true,
    on_record: (rec) => {
      if (!resolved) { resolved = resolveColumns(rec); return null; }
      rowCount += 1;
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
  if (!resolved) throw new AnomalyError('Export was empty (no header row)', { kind: 'empty' });
  const mapping = Object.fromEntries(Object.entries(resolved.mapping).map(([k, i]) => [k, resolved.columns[i]]));
  return { reports, rowCount, skipped, mapping, columns: resolved.columns };
}

/* ============================================================ anomalies */

/** @returns {string|null} rejection reason, or null if acceptable */
export function anomalyReason({ reportCount, storedCount, minReports, minRetainedRatio }) {
  if (reportCount === 0) return 'export parsed to 0 reports';
  if (reportCount < minReports) return `only ${reportCount} reports parsed (minimum ${minReports})`;
  if (storedCount > 0 && reportCount < storedCount * minRetainedRatio) {
    return `export has ${reportCount} reports but ${storedCount} are already stored (below ${Math.round(minRetainedRatio * 100)}%); the download looks truncated`;
  }
  return null;
}

/* ============================================================ detection */

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Index the export by company, newest period first (ties: latest filing first). */
export function buildHistory(reports) {
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

const rowToReport = (row) => row && ({
  reportId: row.report_id, companyKey: row.company_key, companyName: row.company_name, companyNumber: row.company_number,
  avgDaysToPay: row.avg_days_to_pay, paymentsBeyondTerms: row.payments_beyond_terms,
  periodStartDate: row.period_start_date, periodEndDate: row.period_end_date, filingDate: row.filing_date, reportUrl: row.report_url,
});

/** The company's latest report for an earlier period: the export first, then the database. */
export function previousReport(history, db, report) {
  const fromExport = history.get(report.companyKey)?.find((r) => r.periodEndDate < report.periodEndDate);
  if (fromExport) return fromExport;
  return rowToReport(db.prepare(`
    SELECT * FROM payment_records WHERE company_key = ? AND period_end_date < ?
    ORDER BY period_end_date DESC, filing_date DESC LIMIT 1`).get(report.companyKey, report.periodEndDate));
}

/** True if the company already filed a different report for this same period earlier. */
export function isRefiling(history, report) {
  return (history.get(report.companyKey) ?? []).some((r) => r.periodEndDate === report.periodEndDate
    && r.reportId !== report.reportId && (r.filingDate ?? '') <= (report.filingDate ?? ''));
}

/**
 * A jump is either:
 *  - average days to pay up by ≥ minDaysIncrease AND ≥ minPctIncrease %, ending at ≥ minAvgDays, or
 *  - % of payments outside agreed terms up by ≥ minLatePoints, ending at ≥ minLatePct.
 * Only roughly consecutive periods are compared (gap ≤ maxGapDays). Missing figures never count.
 * @returns {object|null}
 */
export function evaluateJump(report, prev, rules) {
  if (!prev) return null;
  const gapDays = daysBetween(prev.periodEndDate, report.periodEndDate);
  if (!Number.isFinite(gapDays) || gapDays <= 0 || gapDays > rules.maxGapDays) return null;

  const reasons = [];
  let score = 0;
  let daysDelta = null;
  let pctDelta = null;
  let lateDelta = null;

  const now = report.avgDaysToPay;
  const before = prev.avgDaysToPay;
  if (now !== null && before !== null && before > 0) {
    daysDelta = now - before;
    pctDelta = Math.round((daysDelta / before) * 100);
    if (daysDelta >= rules.minDaysIncrease && pctDelta >= rules.minPctIncrease && now >= rules.minAvgDays) {
      reasons.push('days');
      score += daysDelta;
    }
  }
  const lateNow = report.paymentsBeyondTerms;
  const lateBefore = prev.paymentsBeyondTerms;
  if (lateNow !== null && lateBefore !== null) {
    lateDelta = lateNow - lateBefore;
    if (lateDelta >= rules.minLatePoints && lateNow >= rules.minLatePct) {
      reasons.push('late');
      score += lateDelta;
    }
  }
  return reasons.length ? { report, prev, reasons, score, daysDelta, pctDelta, lateDelta, gapDays } : null;
}

export function detectJumps(candidates, history, db, rules) {
  return candidates
    .map((r) => {
      const jump = evaluateJump(r, previousReport(history, db, r), rules);
      return jump && { ...jump, refiled: isRefiling(history, r) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.report.reportId.localeCompare(b.report.reportId));
}

/* ============================================================== process */

const prevFigures = (p) => JSON.stringify({
  reportId: p.reportId, avgDaysToPay: p.avgDaysToPay, paymentsBeyondTerms: p.paymentsBeyondTerms,
  periodEndDate: p.periodEndDate, filingDate: p.filingDate ?? null, reportUrl: p.reportUrl ?? null,
});

/**
 * Process one stored export snapshot.
 *
 * - Already processed: { outcome: 'already-processed' }, no writes.
 * - Anomalies (HTML instead of CSV, unrecognised columns, too few reports, a
 *   download smaller than what is stored): a 'rejected' row, then AnomalyError.
 * - First accepted export: BASELINE. Every report stored, no jumps, no events;
 *   a preview of recent jumps is returned for the log only.
 * - Otherwise: new report IDs stored, jumps recorded, PAYMENT_DAYS_JUMP emitted.
 *
 * Spine writes run first (idempotent), then bot state in one transaction.
 */
export function processSnapshot({ db, spine, store, snapshotId, settings, now = new Date().toISOString(), log }) {
  const meta = store.get(snapshotId);
  if (!meta) throw new Error(`Snapshot ${snapshotId} not found in the store`);
  const done = db.prepare(`SELECT outcome FROM processed_snapshots WHERE snapshot_id = ?`).get(snapshotId);
  if (done) return { outcome: 'already-processed', previousOutcome: done.outcome, stats: {}, jumps: [], preview: [] };

  const stored = db.prepare(`SELECT COUNT(*) FROM payment_records`).pluck().get();
  const insertProcessed = db.prepare(`
    INSERT INTO processed_snapshots (snapshot_id, sha256, source_url, row_count, report_count, skipped, column_mapping, outcome, note, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const reject = (reason, counts = {}) => {
    insertProcessed.run(snapshotId, meta.sha256, meta.url ?? null, counts.rowCount ?? 0, counts.reportCount ?? 0, counts.skipped ?? 0,
      counts.mapping ? JSON.stringify(counts.mapping) : null, 'rejected', reason, now);
    throw new AnomalyError(reason, { snapshotId, storedCount: stored, ...counts });
  };

  const text = decode(store.readRaw(snapshotId));
  if (looksLikeHtml(text)) reject(`expected CSV but snapshot ${snapshotId} is an HTML page`);

  let parsed;
  try {
    parsed = parseExport(text);
  } catch (err) {
    if (err instanceof AnomalyError) reject(err.message);
    throw err;
  }
  const { reports, rowCount, skipped, mapping } = parsed;
  const reason = anomalyReason({ reportCount: reports.length, storedCount: stored, minReports: settings.minReports, minRetainedRatio: settings.minRetainedRatio });
  if (reason) reject(reason, { rowCount, reportCount: reports.length, skipped, mapping });

  const known = new Set(db.prepare(`SELECT report_id FROM payment_records`).pluck().all());
  const seenInExport = new Set();
  const fresh = reports.filter((r) => {
    if (known.has(r.reportId) || seenInExport.has(r.reportId)) return false;
    seenInExport.add(r.reportId);
    return true;
  });
  const history = buildHistory(reports);
  const isBaseline = !db.prepare(`SELECT 1 FROM processed_snapshots WHERE outcome != 'rejected' LIMIT 1`).get();

  let jumps = [];
  let preview = [];
  if (isBaseline) {
    // Alerting on years of history would flood Slack: the first export only records.
    const since = new Date(Date.parse(now) - settings.previewDays * 86_400_000).toISOString().slice(0, 10);
    preview = detectJumps(fresh.filter((r) => (r.filingDate ?? '') >= since), history, db, settings.rules);
  } else {
    jumps = detectJumps(fresh, history, db, settings.rules);
  }

  // 1. Spine: company entity + event per jump (UNIQUE(source, type, entity, period end) → idempotent).
  const links = new Map();
  if (jumps.length) {
    spine.db.transaction(() => {
      for (const j of jumps) {
        const r = j.report;
        const entityId = spine.upsertEntity({
          jurisdiction: 'UK',
          registryId: r.companyNumber,
          spineId: r.companyNumber ? r.companyKey : null,
          name: r.companyName,
          source: BOT,
          seenAt: now,
        });
        const { eventId } = spine.linkEvent({
          entityId, type: EVENT_TYPE, date: r.periodEndDate, source: `${BOT}:${meta.source}`, detectedAt: now,
          payload: {
            reportId: r.reportId, reportUrl: r.reportUrl, periodEndDate: r.periodEndDate, filingDate: r.filingDate,
            avgDaysToPay: r.avgDaysToPay, paymentsBeyondTerms: r.paymentsBeyondTerms,
            previous: { reportId: j.prev.reportId, periodEndDate: j.prev.periodEndDate, avgDaysToPay: j.prev.avgDaysToPay, paymentsBeyondTerms: j.prev.paymentsBeyondTerms },
            reasons: j.reasons, refiled: j.refiled, note: 'Self-reported figures for the period stated; not current payment behaviour.',
          },
        });
        links.set(r.reportId, { entityId, eventId });
      }
    })();
  }

  // 2. Bot state in one transaction.
  const insertRecord = db.prepare(`
    INSERT OR IGNORE INTO payment_records
      (report_id, company_number, company_key, company_name, avg_days_to_pay, payments_beyond_terms,
       period_start_date, period_end_date, filing_date, report_url, snapshot_id)
    VALUES (@reportId, @companyNumber, @companyKey, @companyName, @avgDaysToPay, @paymentsBeyondTerms,
            @periodStartDate, @periodEndDate, @filingDate, @reportUrl, @snapshotId)`);
  const insertJump = db.prepare(`
    INSERT OR IGNORE INTO payment_jumps
      (report_id, prev_report_id, company_key, reasons, days_delta, pct_delta, late_delta, gap_days, score, refiled, prev_snapshot, entity_id, event_id, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.transaction(() => {
    for (const r of fresh) insertRecord.run({ ...r, snapshotId });
    for (const j of jumps) {
      const l = links.get(j.report.reportId);
      insertJump.run(j.report.reportId, j.prev.reportId, j.report.companyKey, JSON.stringify(j.reasons), j.daysDelta, j.pctDelta, j.lateDelta,
        j.gapDays, j.score, j.refiled ? 1 : 0, prevFigures(j.prev), l.entityId, l.eventId, now);
    }
    insertProcessed.run(snapshotId, meta.sha256, meta.url ?? null, rowCount, reports.length, skipped, JSON.stringify(mapping),
      isBaseline ? 'baseline' : 'diffed', isBaseline ? 'first export; reports stored, no alerts' : null, now);
  })();

  const stats = { rowCount, reports: reports.length, skipped, newReports: fresh.length, jumps: jumps.length, preview: preview.length };
  log?.info(`${isBaseline ? 'Baseline' : 'Diffed'} export snapshot ${snapshotId}`, stats);
  return { outcome: isBaseline ? 'baseline' : 'diffed', stats, jumps, preview, mapping };
}

/* ======================================================== notification */

/** Jumps not yet delivered (includes ones left over from a failed Slack post), worst first. */
export function pendingJumps(db) {
  return db.prepare(`
    SELECT j.*, r.company_name, r.company_number, r.avg_days_to_pay, r.payments_beyond_terms,
           r.period_end_date, r.filing_date, r.report_url
    FROM payment_jumps j JOIN payment_records r ON r.report_id = j.report_id
    WHERE j.notified_at IS NULL
    ORDER BY j.score DESC, j.id`).all().map((row) => ({ ...row, reasons: JSON.parse(row.reasons), prev: JSON.parse(row.prev_snapshot) }));
}

export function markNotified(db, ids, now = new Date().toISOString()) {
  const update = db.prepare(`UPDATE payment_jumps SET notified_at = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => update.run(now, id)))();
}

/* ======================================================== credit check */

/**
 * On-demand screen for one company (Osbrooks): every stored report, newest
 * period first, matched by Companies House number or by name fragment.
 * @returns {{ companyKey: string, companyName: string, companyNumber: string|null, reports: object[] }[]}
 */
export function creditCheck(db, query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('credit-check needs a company number or name');
  let keys = [];
  try {
    keys = [normalizeEntityId(q, 'UK')];
  } catch {
    keys = db.prepare(`SELECT DISTINCT company_key FROM payment_records WHERE company_name LIKE ? ORDER BY company_name LIMIT 5`)
      .pluck().all(`%${q.replace(/[%_]/g, '')}%`);
  }
  return keys.map((key) => {
    const reports = db.prepare(`SELECT * FROM payment_records WHERE company_key = ? ORDER BY period_end_date DESC, filing_date DESC`).all(key).map(rowToReport);
    return reports.length ? { companyKey: key, companyName: reports[0].companyName, companyNumber: reports[0].companyNumber, reports } : null;
  }).filter(Boolean);
}