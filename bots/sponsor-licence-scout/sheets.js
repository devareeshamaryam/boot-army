/**
 * Google Sheet storage for the sponsor register (the single source of truth),
 * plus the pure diff between today's CSV rows and the sheet.
 *
 * Env: GOOGLE_CREDS_JSON (service-account key: the JSON text itself, or a path to the .json file), GOOGLE_SHEET_ID.
 * The service account needs edit access to the spreadsheet.
 */
import fs from 'node:fs';
import { google } from 'googleapis';
import { COLUMNS } from './harvest.js';

export const TAB = 'Sponsors';
export const HEADER = [...COLUMNS, 'Status', 'First Seen', 'Revoked On'];
const CHUNK = 5000;

/** Key = all five CSV fields, lowercased, joined. */
export const keyOf = (fields) => fields.map((f) => String(f ?? '').toLowerCase()).join('|');

/**
 * Compare today's CSV rows with the sheet. Pure: no I/O.
 * @param {object[]} csvRows    from harvest.parseRows()
 * @param {string[][]} sheetRows  sheet data rows (no header), in HEADER order
 * @param {string} today        YYYY-MM-DD
 * @returns {{ baseline: boolean, blocked: string|null, appends: string[][], updates: { row: number, values: string[] }[],
 *             added: string[][], revoked: string[][], reinstated: string[][], activeAfter: number }}
 *   updates[].row is the 1-based sheet row; values are [Status, First Seen, Revoked On] for columns F:H.
 */
export function diffSponsors(csvRows, sheetRows, today) {
  const csv = new Map();
  for (const r of csvRows) {
    const fields = COLUMNS.map((c) => r[c] ?? '');
    const k = keyOf(fields);
    if (!csv.has(k)) csv.set(k, fields); // duplicate CSV rows count once
  }

  const sheet = new Map();
  sheetRows.forEach((row, i) => {
    const k = keyOf(row.slice(0, 5));
    if (!sheet.has(k)) sheet.set(k, { row: i + 2, values: row }); // row 1 is the header
  });

  const result = { baseline: sheet.size === 0, blocked: null, appends: [], updates: [], added: [], revoked: [], reinstated: [], activeAfter: 0 };
  const active = [...sheet.values()].filter((s) => s.values[5] === 'Active').length;

  if (!result.baseline && csv.size < active * 0.5) {
    result.blocked = `today's CSV has ${csv.size} sponsors but the sheet has ${active} Active: under 50%, nothing changed`;
    result.activeAfter = active;
    return result;
  }

  for (const [k, fields] of csv) {
    const s = sheet.get(k);
    if (!s) {
      result.appends.push([...fields, 'Active', today, '']);
      result.added.push(fields);
    } else if (s.values[5] === 'Revoked') {
      result.updates.push({ row: s.row, values: ['Active', s.values[6] ?? '', ''] });
      result.reinstated.push(fields);
    }
  }
  for (const [k, s] of sheet) {
    if (s.values[5] === 'Active' && !csv.has(k)) {
      result.updates.push({ row: s.row, values: ['Revoked', s.values[6] ?? '', today] });
      result.revoked.push(s.values.slice(0, 5));
    }
  }
  result.activeAfter = csv.size;
  return result;
}

/* ---------------------------------------------------------------- Google */

export function openSheets(env = process.env) {
  const id = env.GOOGLE_SHEET_ID?.trim();
  if (!id || !env.GOOGLE_CREDS_JSON?.trim()) throw new Error('Set GOOGLE_CREDS_JSON and GOOGLE_SHEET_ID in the root .env');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(/^\s*\{/.test(env.GOOGLE_CREDS_JSON) ? env.GOOGLE_CREDS_JSON : fs.readFileSync(env.GOOGLE_CREDS_JSON.trim(), 'utf8')), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return { api: google.sheets({ version: 'v4', auth }), id };
}

/**
 * Does the Sponsors tab exist? With create (default), add it with its header row if missing.
 * @returns {Promise<boolean>} true if the tab exists (or was just created)
 */
export async function ensureTab({ api, id }, { create = true } = {}) {
  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' });
  if (meta.data.sheets?.some((s) => s.properties.title === TAB)) return true;
  if (!create) return false;
  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
  await api.spreadsheets.values.update({ spreadsheetId: id, range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [HEADER] } });
  return true;
}

/** All data rows (without the header), padded to 8 columns. */
export async function readRows({ api, id }) {
  const res = await api.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB}!A2:H` });
  return (res.data.values ?? []).map((r) => HEADER.map((_, i) => r[i] ?? ''));
}

/** Append rows in chunks of 5000. RAW input: names are stored as text, never as formulas. */
export async function appendRows({ api, id }, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await api.spreadsheets.values.append({
      spreadsheetId: id, range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows.slice(i, i + CHUNK) },
    });
  }
}

/** Write Status / First Seen / Revoked On (F:H) for the given rows, in chunks of 5000. */
export async function updateRows({ api, id }, updates) {
  for (let i = 0; i < updates.length; i += CHUNK) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'RAW', data: updates.slice(i, i + CHUNK).map((u) => ({ range: `${TAB}!F${u.row}:H${u.row}`, values: [u.values] })) },
    });
  }
}