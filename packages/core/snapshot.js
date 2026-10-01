/**
 * core.snapshot — immutable raw-response store (snapshot-first harvesting).
 *
 * Every harvested payload is written here BEFORE anything parses it. Bodies are
 * gzipped under data/raw/; the index lives in the core database. Identical
 * payloads from the same source are stored once (sha256): re-downloading an
 * unchanged file returns the existing id with isNew = false. Reads verify the
 * checksum.
 *
 * Dry run: bodies are kept in memory and the index is an in-memory copy, so
 * nothing on disk changes.
 *
 *   const store = snapshot.openStore({ dryRun });
 *   const { id, isNew } = store.writeRaw('uk-sponsor-register', 'file.csv', buffer, { url, contentType });
 *   const bytes = store.readRaw(id);
 *   for (const { row, payload } of store.iterRaw('uk-sponsor-register', { since: '2026-01-01' })) { ... }
 *
 * Module-level writeRaw/readRaw/iterRaw/get/latest use a default store
 * configured with configure({ dryRun }).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openCore, safeClose } from './db.js';
import { dataDir as defaultDataDir } from './config.js';

const EXTENSIONS = [[/csv/i, 'csv'], [/json/i, 'json'], [/html/i, 'html'], [/xml|rss|atom/i, 'xml'], [/pdf/i, 'pdf'], [/zip/i, 'zip']];

function extensionFor(contentType, ref) {
  const fromRef = String(ref ?? '').match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromRef) return fromRef.toLowerCase();
  return EXTENSIONS.find(([re]) => re.test(contentType ?? ''))?.[1] ?? 'bin';
}

const toBuffer = (payload) => {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.from(JSON.stringify(payload), 'utf8');
};

const parseRow = (row) => (row ? { ...row, meta: row.meta ? JSON.parse(row.meta) : {} } : null);

/**
 * @param {{ dryRun?: boolean, dataDir?: string, migrations?: string|URL }} [options]
 */
export function openStore({ dryRun = false, dataDir = defaultDataDir(), migrations } = {}) {
  const db = openCore({ dryRun, dataDir, ...(migrations ? { migrations } : {}) });
  try {
    return buildStore(db, { dryRun, dataDir });
  } catch (err) {
    safeClose(db); // never leave a locked file behind (Windows)
    throw err;
  }
}

function buildStore(db, { dryRun, dataDir }) {
  const memory = new Map(); // dry-run bodies by id

  const findBySha = db.prepare(`SELECT * FROM snapshots WHERE source = ? AND sha256 = ?`);
  const insert = db.prepare(`
    INSERT INTO snapshots (source, ref, url, sha256, bytes, content_type, fetched_at, path, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare(`SELECT * FROM snapshots WHERE id = ?`);

  const readBody = (row) => {
    const buffer = memory.get(row.id) ?? gunzipSync(readFileSync(path.join(dataDir, row.path)));
    if (createHash('sha256').update(buffer).digest('hex') !== row.sha256) {
      throw new Error(`snapshot ${row.id} is corrupt (checksum mismatch at ${row.path})`);
    }
    return buffer;
  };

  return {
    dryRun,
    db,

    /**
     * Store a raw payload (Buffer, Uint8Array, string, or JSON-serialisable value).
     * @param {string} source
     * @param {string|null} ref
     * @param {*} payload
     * @param {{ url?: string, contentType?: string, fetchedAt?: string, [k: string]: any }} [meta]
     * @returns {{ id: number, isNew: boolean, sha256: string, bytes: number, fetchedAt: string }}
     */
    writeRaw(source, ref, payload, meta = {}) {
      if (!source || typeof source !== 'string') throw new Error('snapshot.writeRaw: source is required');
      const buffer = toBuffer(payload);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const existing = findBySha.get(source, sha256);
      if (existing) return { id: existing.id, isNew: false, sha256, bytes: existing.bytes, fetchedAt: existing.fetched_at };

      const { url = null, contentType = null, fetchedAt = new Date().toISOString(), ...rest } = meta;
      const rel = path.join('raw', source, fetchedAt.slice(0, 7), `${sha256}.${extensionFor(contentType, ref)}.gz`);
      if (!dryRun) {
        const abs = path.join(dataDir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        if (!existsSync(abs)) {
          const tmp = `${abs}.tmp-${process.pid}`;
          writeFileSync(tmp, gzipSync(buffer));
          renameSync(tmp, abs); // atomic: a crash never leaves a half-written body
        }
      }
      const id = Number(insert.run(source, ref ?? null, url, sha256, buffer.length, contentType, fetchedAt, rel, JSON.stringify(rest)).lastInsertRowid);
      if (dryRun) memory.set(id, buffer);
      return { id, isNew: true, sha256, bytes: buffer.length, fetchedAt };
    },

    /** Snapshot metadata by id (meta parsed), or null. */
    get(id) {
      return parseRow(byId.get(id));
    },

    /** Raw payload by id, checksum-verified. */
    readRaw(id) {
      const row = byId.get(id);
      if (!row) throw new Error(`snapshot ${id} not found`);
      return readBody(row);
    },

    /** Most recent snapshot row for a source, or null. */
    latest(source) {
      return parseRow(db.prepare(`SELECT * FROM snapshots WHERE source = ? ORDER BY id DESC LIMIT 1`).get(source));
    },

    /** Snapshot rows for a source, oldest first. */
    list(source, { since } = {}) {
      const rows = since
        ? db.prepare(`SELECT * FROM snapshots WHERE source = ? AND fetched_at >= ? ORDER BY id`).all(source, since)
        : db.prepare(`SELECT * FROM snapshots WHERE source = ? ORDER BY id`).all(source);
      return rows.map(parseRow);
    },

    /**
     * Iterate stored snapshots oldest first, loading one body at a time —
     * the way to re-process history after a parser fix.
     * @returns {Generator<{ row: object, payload: Buffer }>}
     */
    *iterRaw(source, { since } = {}) {
      const stmt = since
        ? db.prepare(`SELECT * FROM snapshots WHERE source = ? AND fetched_at >= ? ORDER BY id`)
        : db.prepare(`SELECT * FROM snapshots WHERE source = ? ORDER BY id`);
      for (const row of since ? stmt.all(source, since) : stmt.all(source)) {
        yield { row: parseRow(row), payload: readBody(row) };
      }
    },

    close() {
      memory.clear();
      safeClose(db);
    },
  };
}

/* ----------------------------------------------------------- default store */

let defaultStore = null;
let defaultOptions = {};

/** Configure the module-level store (call before first use). */
export function configure(options = {}) {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
  defaultOptions = options;
}

const store = () => (defaultStore ??= openStore(defaultOptions));

export const writeRaw = (source, ref, payload, meta) => store().writeRaw(source, ref, payload, meta);
export const readRaw = (id) => store().readRaw(id);
export const iterRaw = (source, options) => store().iterRaw(source, options);
export const get = (id) => store().get(id);
export const latest = (source) => store().latest(source);
export function close() {
  defaultStore?.close();
  defaultStore = null;
}