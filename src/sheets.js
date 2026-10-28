/**
 * Google Sheet storage for the sponsor register (the single source of truth),
 * plus the pure diff between today's CSV rows and the sheet.
 *
 * Env: GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to the service-account .json key, default
 * ./credentials/service-account.json, relative paths from the project root), GOOGLE_SHEET_ID.
 * The service account needs edit access to the spreadsheet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import { match } from './core/index.js';
import { legalName } from './companies.js';
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
 *             added: string[][], revoked: string[][], reinstated: string[][],
 *             changed: { from: string[], to: string[] }[], superseded: string[][], activeAfter: number }}
 *   revoked: the organisation is no longer anywhere on the register. superseded: rows whose
 *   organisation is still listed under other details; they get Status "Changed", never "Revoked".
 *   updates[].row is the 1-based sheet row; values are [Status, First Seen, Revoked On] for columns F:H,
 *   or all eight columns A:H for a moved/renamed sponsor.
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

  const result = { baseline: sheet.size === 0, blocked: null, appends: [], updates: [], added: [], revoked: [], reinstated: [], changed: [], superseded: [], activeAfter: 0 };
  const active = [...sheet.values()].filter((s) => s.values[5] === 'Active').length;

  if (!result.baseline && csv.size < active * 0.5) {
    result.blocked = `today's CSV has ${csv.size} sponsors but the sheet has ${active} Active: under 50%, nothing changed`;
    result.activeAfter = active;
    return result;
  }

  const added = [];
  for (const [k, fields] of csv) {
    const s = sheet.get(k);
    if (!s) {
      added.push(fields);
    } else if (s.values[5] === 'Revoked') {
      result.updates.push({ row: s.row, values: ['Active', s.values[6] ?? '', ''] });
      result.reinstated.push(fields);
    } else if (s.values[5] === 'Changed') {
      result.updates.push({ row: s.row, values: ['Active', s.values[6] ?? '', ''] }); // old details back: not news
    }
  }
  const orgsListed = new Set([...csv.values()].map((f) => orgKey(f[0])));
  const gone = [...sheet].filter(([k, s]) => s.values[5] === 'Active' && !csv.has(k)).map(([, s]) => s);

  // A sponsor that moved town or was renamed shows up as one "gone" + one "added".
  // Pair them up and update the existing row in place (First Seen kept) instead.
  const paired = new Set();
  for (const fields of added) {
    const s = gone.find((g) => !paired.has(g) && sameSponsor(g.values, fields));
    if (s) {
      paired.add(s);
      result.updates.push({ row: s.row, values: [...fields, 'Active', s.values[6] ?? '', ''] });
      result.changed.push({ from: s.values.slice(0, 5), to: fields });
    } else {
      result.appends.push([...fields, 'Active', today, '']);
      result.added.push(fields);
    }
  }
  for (const s of gone) {
    if (paired.has(s)) continue;
    if (orgsListed.has(orgKey(s.values[0]))) {
      // The organisation is still on the register (other route, town, county or
      // rating, already in another row): this row is out of date, not revoked.
      result.updates.push({ row: s.row, values: ['Changed', s.values[6] ?? '', ''] });
      result.superseded.push(s.values.slice(0, 5));
      continue;
    }
    result.updates.push({ row: s.row, values: ['Revoked', s.values[6] ?? '', today] });
    result.revoked.push(s.values.slice(0, 5));
  }
  result.activeAfter = csv.size;
  return result;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Organisation identity: registered name, trading name dropped, Ltd/Limited and punctuation normalised. */
export const orgKey = (name) => match.nameNorm(legalName(name));
export const RENAME_SIMILARITY = 90;

/**
 * Same sponsor despite a changed key? Route must match, and either
 *   moved:   same organisation, different town/county/rating, or
 *   renamed: same town, names at least RENAME_SIMILARITY similar.
 */
export function sameSponsor(oldFields, newFields) {
  if (norm(oldFields[4]) !== norm(newFields[4])) return false;
  if (orgKey(oldFields[0]) === orgKey(newFields[0])) return true;
  return norm(oldFields[1]) === norm(newFields[1]) && match.companySimilarity(oldFields[0], newFields[0]) >= RENAME_SIMILARITY;
}

/* ---------------------------------------------------------------- Google */

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_KEY_FILE = './credentials/service-account.json';

/** Absolute path of the service-account key file. */
export const keyFilePath = (env = process.env) => path.resolve(ROOT_DIR, env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim() || DEFAULT_KEY_FILE);

export function openSheets(env = process.env) {
  const id = env.GOOGLE_SHEET_ID?.trim();
  if (!id) throw new Error('Set GOOGLE_SHEET_ID in the environment');
  const keyFile = keyFilePath(env);
  if (!fs.existsSync(keyFile)) throw new Error(`Google service-account key not found at ${keyFile}: set GOOGLE_SERVICE_ACCOUNT_KEY_FILE`);
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(fs.readFileSync(keyFile, 'utf8')), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return { api: google.sheets({ version: 'v4', auth }), id };
}

/**
 * Does the Sponsors tab exist? With create (default), add it with its header row if missing.
 * @returns {Promise<number|null>} the tab's sheetId (gid), or null if it does not exist
 */
export async function ensureTab({ api, id }, { create = true } = {}) {
  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties(title,sheetId)' });
  const existing = meta.data.sheets?.find((s) => s.properties.title === TAB);
  if (existing) return existing.properties.sheetId;
  if (!create) return null;
  const res = await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
  await api.spreadsheets.values.update({ spreadsheetId: id, range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [HEADER] } });
  return res.data.replies[0].addSheet.properties.sheetId;
}

/** Browser link to the Sponsors tab (or the spreadsheet, if gid is null). */
export const sheetUrl = ({ id }, gid) => `https://docs.google.com/spreadsheets/d/${id}/edit${gid == null ? '' : `#gid=${gid}`}`;

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

/** Write Status / First Seen / Revoked On (F:H), or the whole row (A:H) for 8 values, in chunks of 5000. */
export async function updateRows({ api, id }, updates) {
  const range = (u) => `${TAB}!${u.values.length === HEADER.length ? 'A' : 'F'}${u.row}:H${u.row}`;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'RAW', data: updates.slice(i, i + CHUNK).map((u) => ({ range: range(u), values: [u.values] })) },
    });
  }
}