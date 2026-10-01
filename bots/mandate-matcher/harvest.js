/**
 * B2 harvester: per-firm roster fetchers. Network → core.snapshot only.
 *
 * Registers are query-based, not bulk, so each watchlist firm's current
 * approved/registered persons are fetched and stored raw every run.
 *
 *   FCA        official Register API (free key: X-Auth-Email / X-Auth-Key).
 *              /Firm/{FRN}      firm profile (Companies House number for the spine)
 *              /Firm/{FRN}/CF   current controlled functions = roster + effective dates
 *              /Individuals/{IRN}/CF  where a leaver went (fetched only for leavers)
 *              Limit 50 req / 10 s; we stay at ≤ 4 req/s.
 *   MAS, DFSA, FSRA   no documented bulk API: a file export or a robots-permitted URL per firm.
 *   SFC        public register disallows automated access: file imports only.
 *
 * Every snapshot's meta carries what the processor needs to parse it, so
 * process.js never needs the watchlist or the network.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { http } from '@botarmy/core';

export const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FCA_BASE = 'https://register.fca.org.uk/services/V0.1';
const FCA_MIN_INTERVAL_MS = 250;
const MAX_FCA_PAGES = 50;

export const SOURCES = Object.freeze({
  rosterFor: (regulator) => `${regulator.toLowerCase()}-roster`,
  FCA_PROFILE: 'fca-firm-profile',
  FCA_INDIVIDUAL: 'fca-individual-cf',
});

/** Misconfiguration (missing key, missing source). Not retried. */
export class SourceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

export const firmKey = (firm) => `${firm.regulator}:${firm.ref}`;

/* ------------------------------------------------------------------ FCA */

function fcaHeaders(env) {
  const email = env.FCA_API_EMAIL?.trim();
  const key = env.FCA_API_KEY?.trim();
  if (!email || !key) throw new SourceConfigError('FCA: set FCA_API_EMAIL and FCA_API_KEY in the root .env');
  return { 'X-Auth-Email': email, 'X-Auth-Key': key, Accept: 'application/json' };
}

async function fcaGet(pathname, env) {
  return http.fetch(`${FCA_BASE}${pathname}`, { headers: fcaHeaders(env), minIntervalMs: FCA_MIN_INTERVAL_MS });
}

/** Total pages the FCA reports for a response, or 1. Numbers parsed safely. */
export function fcaPageCount(body) {
  const total = Number(body?.ResultInfo?.total_count);
  const perPage = Number(body?.ResultInfo?.per_page);
  if (!Number.isFinite(total) || !Number.isFinite(perPage) || perPage <= 0 || total <= perPage) return 1;
  return Math.min(Math.ceil(total / perPage), MAX_FCA_PAGES);
}

async function harvestFca(firm, { store, env }) {
  if (!/^\d{5,7}$/.test(firm.ref)) throw new SourceConfigError(`FCA: "${firm.ref}" is not a valid FRN`);
  const frn = encodeURIComponent(firm.ref);
  const meta = { firmKey: firmKey(firm), regulator: 'FCA', firmRef: firm.ref };

  const profileRes = await fcaGet(`/Firm/${frn}`, env);
  const profile = store.writeRaw(SOURCES.FCA_PROFILE, `${firm.ref}.json`, profileRes.body,
    { url: profileRes.url, contentType: profileRes.contentType, ...meta, kind: 'profile' });

  const first = await fcaGet(`/Firm/${frn}/CF`, env);
  const pages = [first];
  const pageCount = fcaPageCount(safeJson(first.body));
  for (let page = 2; page <= pageCount; page++) {
    const res = await fcaGet(`/Firm/${frn}/CF?page=${page}`, env);
    if (res.body.equals(first.body)) throw new Error(`FCA ${firm.ref}: pagination not honoured (page ${page} repeated page 1)`);
    pages.push(res);
  }
  const snapshotIds = pages.map((res, i) => store.writeRaw(SOURCES.rosterFor('FCA'), `${firm.ref}/CF/page-${i + 1}.json`, res.body,
    { url: res.url, contentType: res.contentType, ...meta, kind: 'roster', page: i + 1, pages: pages.length, format: 'fca-cf' }).id);

  return { snapshotIds, profileSnapshotId: profile.id, complete: true };
}

/**
 * Where FCA leavers went: one /Individuals/{IRN}/CF call each, stored raw.
 * @returns {Promise<Map<string, number>>} IRN → snapshot id (failures are skipped and logged)
 */
export async function harvestFcaDestinations(irns, { store, env = process.env, log }) {
  const out = new Map();
  for (const irn of irns) {
    try {
      const res = await fcaGet(`/Individuals/${encodeURIComponent(irn)}/CF`, env);
      out.set(irn, store.writeRaw(SOURCES.FCA_INDIVIDUAL, `${irn}.json`, res.body,
        { url: res.url, contentType: res.contentType, regulator: 'FCA', personRef: irn }).id);
    } catch (err) {
      log?.warn(`FCA destination lookup for ${irn} failed: ${err.message}`);
    }
  }
  return out;
}

/* ------------------------------------------------- file / URL sources */

function sourcesOf(firm) {
  if (!firm.source) throw new SourceConfigError(`${firm.regulator} ${firm.ref}: no "source" configured in watchlist.json`);
  return Array.isArray(firm.source) ? firm.source : [firm.source];
}

async function harvestTabular(firm, { store, baseDir }) {
  const meta = { firmKey: firmKey(firm), regulator: firm.regulator, firmRef: firm.ref, kind: 'roster' };
  const snapshotIds = [];
  for (const [i, src] of sourcesOf(firm).entries()) {
    const parseMeta = {
      ...meta, part: i + 1,
      format: src.format ?? null,
      jsonPath: src.jsonPath ?? null,
      defaultRole: src.defaultRole ?? null,
      fields: src.fields ?? null,
    };
    if (src.type === 'file') {
      if (!src.path) throw new SourceConfigError(`${firm.regulator} ${firm.ref}: file source needs "path"`);
      const abs = path.isAbsolute(src.path) ? src.path : path.join(baseDir, src.path);
      const bytes = await readFile(abs);
      const format = parseMeta.format ?? (abs.toLowerCase().endsWith('.json') ? 'json' : 'csv');
      snapshotIds.push(store.writeRaw(SOURCES.rosterFor(firm.regulator), `${firm.ref}/${path.basename(abs)}`, bytes,
        { ...parseMeta, format, origin: `file:${src.path}` }).id);
    } else if (src.type === 'url') {
      if (!src.url) throw new SourceConfigError(`${firm.regulator} ${firm.ref}: url source needs "url"`);
      const url = src.url.replaceAll('{ref}', encodeURIComponent(firm.ref));
      if (firm.regulator === 'SFC' && /(^|\.)sfc\.hk$/i.test(new URL(url).hostname)) {
        throw new SourceConfigError('SFC: the public register disallows automated access; use file sources');
      }
      if (!(await http.allowedByRobots(url))) {
        throw new SourceConfigError(`${firm.regulator} ${firm.ref}: robots.txt disallows ${new URL(url).origin}${new URL(url).pathname}`);
      }
      const res = await http.fetch(url, { headers: { Accept: parseMeta.format === 'csv' ? 'text/csv' : 'application/json' }, minIntervalMs: 1000 });
      snapshotIds.push(store.writeRaw(SOURCES.rosterFor(firm.regulator), `${firm.ref}/part-${i + 1}`, res.body,
        { ...parseMeta, format: parseMeta.format ?? 'json', url: res.url, contentType: res.contentType }).id);
    } else {
      throw new SourceConfigError(`${firm.regulator} ${firm.ref}: source.type must be "file" or "url"`);
    }
  }
  return { snapshotIds, profileSnapshotId: null, complete: true };
}

/* ---------------------------------------------------------------- run */

/**
 * Fetch every watchlist firm's roster. One firm failing never stops the others.
 * @returns {Promise<{ fetches: object[], failures: { firmKey: string, error: string, config: boolean }[] }>}
 */
export async function harvestRosters(firms, { store, env = process.env, baseDir = BOT_DIR, log }) {
  const fetches = [];
  const failures = [];
  for (const firm of firms) {
    try {
      const result = firm.regulator === 'FCA'
        ? await harvestFca(firm, { store, env })
        : await harvestTabular(firm, { store, baseDir });
      fetches.push({ firm, firmKey: firmKey(firm), ...result });
      log?.info(`${firmKey(firm)}: stored ${result.snapshotIds.length} roster snapshot(s)`);
    } catch (err) {
      failures.push({ firmKey: firmKey(firm), error: err.message, config: err instanceof SourceConfigError });
      log?.error(`${firmKey(firm)} (${firm.name}): ${err.message}`);
    }
  }
  return { fetches, failures };
}

function safeJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}