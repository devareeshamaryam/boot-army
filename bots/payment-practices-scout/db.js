import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * payment_records holds the columns you specified plus four needed to run
 * safely every day against a full-history export:
 *   report_id     unique per filed report, so re-downloads never duplicate rows
 *   company_key   normalised identity (spine ID, or name if the number is missing)
 *   period_start_date / filing_date / report_url  context for alerts
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_records (
  id                     INTEGER PRIMARY KEY,
  report_id              TEXT NOT NULL UNIQUE,
  company_number         TEXT,
  company_key            TEXT NOT NULL,
  company_name           TEXT NOT NULL,
  avg_days_to_pay        INTEGER,
  payments_beyond_terms  INTEGER,        -- % of payments not made within agreed terms
  period_start_date      TEXT,
  period_end_date        TEXT,
  filing_date            TEXT,
  report_url             TEXT,
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_records_company
  ON payment_records (company_key, period_end_date);
`;

/**
 * Open (and in live mode create/migrate) the database.
 *
 * In dry-run mode nothing is ever written: an existing file is opened without
 * running the schema or changing pragmas, and a missing file is replaced by an
 * empty in-memory database so the run can still report what it *would* do.
 */
export function openDb(dbPath, { dryRun = false } = {}) {
  if (dryRun) {
    if (!existsSync(dbPath)) {
      const mem = new Database(':memory:');
      mem.exec(SCHEMA);
      return { db: mem, persistent: false };
    }
    return { db: new Database(dbPath, { fileMustExist: true }), persistent: true };
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return { db, persistent: true };
}

export function countRecords(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM payment_records`).get().n;
}

/** All report IDs already stored, for fast "is this new?" checks. */
export function knownReportIds(db) {
  return new Set(db.prepare(`SELECT report_id FROM payment_records`).pluck().all());
}

/**
 * The company's most recent stored report for a period ending strictly before
 * `beforeEndDate` (so re-filed or amended reports for the same period are not
 * compared with themselves). This is the baseline a new report is judged against.
 */
export function getPreviousReport(db, companyKey, beforeEndDate) {
  return db.prepare(`
    SELECT * FROM payment_records
    WHERE company_key = ? AND period_end_date < ?
    ORDER BY period_end_date DESC, filing_date DESC
    LIMIT 1
  `).get(companyKey, beforeEndDate) ?? null;
}

/** Insert new snapshots in one transaction. Returns the number actually inserted. */
export function insertReports(db, reports) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO payment_records
      (report_id, company_number, company_key, company_name, avg_days_to_pay, payments_beyond_terms,
       period_start_date, period_end_date, filing_date, report_url)
    VALUES (@reportId, @companyNumber, @companyKey, @companyName, @avgDaysToPay, @paymentsBeyondTerms,
            @periodStartDate, @periodEndDate, @filingDate, @reportUrl)
  `);
  return db.transaction((rows) => rows.reduce((n, r) => n + insert.run(r).changes, 0))(reports);
}