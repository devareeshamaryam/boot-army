import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchText, isAllowedByRobots, SourceConfigError, toIsoDate } from './http.js';

const INACTIVE_STATUS = /cease|revok|inactive|terminat|withdrawn|former|lapsed|suspend/i;

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.trim());
  return body
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const getPath = (obj, dotted) =>
  dotted ? dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj) : obj;

/**
 * Load rows from one source definition:
 *   { type: 'file', path: 'imports/sfc/AAA000-ro.csv', format?: 'csv'|'json', jsonPath?, defaultRole? }
 *   { type: 'url',  url: 'https://...{ref}...',         format:  'csv'|'json', jsonPath?, defaultRole? }
 * URL sources are checked against robots.txt first.
 */
export async function loadSourceRows(source, { firm, baseDir }) {
  if (!source || typeof source !== 'object') {
    throw new SourceConfigError(`${firm.regulator} ${firm.ref}: no "source" configured in the watchlist`);
  }

  let text;
  let format = source.format;

  if (source.type === 'file') {
    if (!source.path) throw new SourceConfigError(`${firm.regulator} ${firm.ref}: file source needs "path"`);
    const filePath = path.isAbsolute(source.path) ? source.path : path.join(baseDir, source.path);
    text = await readFile(filePath, 'utf8');
    format ??= filePath.toLowerCase().endsWith('.json') ? 'json' : 'csv';
  } else if (source.type === 'url') {
    if (!source.url) throw new SourceConfigError(`${firm.regulator} ${firm.ref}: url source needs "url"`);
    const url = source.url.replaceAll('{ref}', encodeURIComponent(firm.ref));
    if (!(await isAllowedByRobots(url))) {
      throw new SourceConfigError(`${firm.regulator} ${firm.ref}: robots.txt disallows ${new URL(url).origin}${new URL(url).pathname}`);
    }
    text = await fetchText(url);
    format ??= 'json';
  } else {
    throw new SourceConfigError(`${firm.regulator} ${firm.ref}: source.type must be "file" or "url"`);
  }

  let rows;
  if (format === 'json') {
    const data = getPath(JSON.parse(text), source.jsonPath);
    if (!Array.isArray(data)) {
      throw new Error(`${firm.regulator} ${firm.ref}: JSON source did not yield an array${source.jsonPath ? ` at "${source.jsonPath}"` : ''}`);
    }
    rows = data;
  } else {
    rows = parseCsv(text);
  }

  return source.defaultRole ? rows.map((r) => ({ __defaultRole: source.defaultRole, ...r })) : rows;
}

/** First non-empty value among candidate column names (case-insensitive). */
function pick(row, candidates) {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const candidate of candidates) {
    const key = lower.get(candidate.toLowerCase());
    const value = key === undefined ? undefined : row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

/**
 * Turn tabular rows into roster records, grouping multiple rows per person.
 * fieldMap: { personRef: [...], name: [...], role: [...], since: [...], status?: [...] }
 * @returns {{ personRef: string, name: string, roles: { title: string, since: string|null }[] }[]}
 */
export function rowsToRoster(rows, fieldMap, { normalizeRef = (v) => v.toUpperCase().replace(/\s+/g, '') } = {}) {
  const people = new Map();
  let missingRef = 0;

  for (const row of rows) {
    const status = fieldMap.status ? pick(row, fieldMap.status) : null;
    if (status && INACTIVE_STATUS.test(status)) continue;

    const rawRef = pick(row, fieldMap.personRef);
    if (!rawRef) { missingRef += 1; continue; }

    const personRef = normalizeRef(rawRef);
    const name = pick(row, fieldMap.name) ?? personRef;
    const title = pick(row, fieldMap.role) ?? row.__defaultRole ?? 'Registered individual';
    const since = toIsoDate(pick(row, fieldMap.since ?? []));

    const person = people.get(personRef) ?? { personRef, name, roles: [] };
    if (!person.roles.some((r) => r.title === title)) person.roles.push({ title, since });
    people.set(personRef, person);
  }

  if (rows.length > 0 && people.size === 0 && missingRef > 0) {
    const columns = Object.keys(rows[0]).filter((k) => k !== '__defaultRole').join(', ');
    throw new SourceConfigError(
      `No person reference column found. Columns present: ${columns}. Add the right name to source.fields.personRef.`,
    );
  }

  return [...people.values()];
}

/** Load one or many sources for a firm and merge them into one roster. */
export async function loadRoster(firm, ctx, defaultFieldMap, options) {
  const sources = Array.isArray(firm.source) ? firm.source : [firm.source];
  const merged = new Map();

  for (const source of sources) {
    const fieldMap = { ...defaultFieldMap, ...(source?.fields ?? {}) };
    const rows = await loadSourceRows(source, { firm, baseDir: ctx.baseDir });
    for (const person of rowsToRoster(rows, fieldMap, options)) {
      const existing = merged.get(person.personRef);
      if (!existing) merged.set(person.personRef, person);
      else for (const role of person.roles) {
        if (!existing.roles.some((r) => r.title === role.title)) existing.roles.push(role);
      }
    }
  }
  return [...merged.values()];
}

export function requireSource(firm) {
  if (!firm.source) {
    throw new SourceConfigError(`${firm.regulator} ${firm.ref}: no "source" configured in the watchlist`);
  }
}