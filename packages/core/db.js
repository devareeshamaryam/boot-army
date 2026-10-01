/**
 * core.db — SQLite connections and the migration runner.
 *
 * Live:    data/<name>.sqlite with journal_mode = WAL, foreign_keys = ON,
 *          busy_timeout = 5000. Every on-disk connection is opened this way.
 * Dry run: an in-memory COPY of the existing file (or an empty database), with
 *          foreign_keys = ON. Bots run their real code path — migrations,
 *          inserts, diffs — and nothing on disk changes. (In-memory databases
 *          cannot use WAL; they use SQLite's in-memory journal.)
 *
 * Any function here that opens a connection and then fails closes it before
 * rethrowing: on Windows an unclosed connection keeps the file locked.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir as defaultDataDir } from './config.js';

export const CORE_DB_NAME = 'spine';
export const CORE_MIGRATIONS = new URL('./migrations/', import.meta.url);
export const CORE_MIGRATION_FILE = '001_init.sql';

/** Tables the core database must contain after migration. */
export const CORE_TABLES = Object.freeze([
  'snapshots', 'entities', 'entity_aliases', 'persons', 'person_history', 'events', 'review_queue', 'approvals',
]);

export class MigrationError extends Error {
  constructor(message, { file, namespace, cause } = {}) {
    super(message, { cause });
    this.name = 'MigrationError';
    this.file = file;
    this.namespace = namespace;
  }
}

export function dbPath(name, dataDir = defaultDataDir()) {
  return path.join(dataDir, `${name}.sqlite`);
}

/** Close a connection, ignoring errors (used on failure paths). */
export function safeClose(db) {
  try {
    if (db?.open) db.close();
  } catch {
    // already closed or never fully opened
  }
}

/** Bytes of a database file for an in-memory copy, without creating -shm/-wal files. */
function imageOf(file) {
  const wal = `${file}-wal`;
  let image;
  if (existsSync(wal) && statSync(wal).size > 0) {
    // A live -wal exists (writer running, or unclean shutdown): let SQLite merge it.
    // The side files already exist, so opening read-only creates nothing new.
    const disk = new Database(file, { readonly: true, fileMustExist: true });
    try {
      image = disk.serialize();
    } finally {
      disk.close();
    }
  } else {
    // Even a read-only SQLite open of a WAL database creates side files, so read bytes.
    image = readFileSync(file);
  }
  // Header bytes 18-19 = 2 mark a WAL database, which an in-memory copy cannot be.
  image[18] = 1;
  image[19] = 1;
  return image;
}

/**
 * @param {string} name  database name, e.g. "sponsor-licence-scout" → data/sponsor-licence-scout.sqlite
 * @param {{ dryRun?: boolean, dataDir?: string }} [options]
 * @returns {import('better-sqlite3').Database & { botarmy: { name: string, path: string, dryRun: boolean } }}
 */
export function connect(name, { dryRun = false, dataDir = defaultDataDir() } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`db.connect: invalid database name "${name}"`);
  const file = dbPath(name, dataDir);
  let db;
  if (dryRun) {
    db = existsSync(file) ? new Database(imageOf(file)) : new Database(':memory:');
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
  }
  try {
    if (!dryRun) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 5000');
    }
    db.pragma('foreign_keys = ON');
  } catch (err) {
    safeClose(db);
    throw err;
  }
  db.botarmy = Object.freeze({ name, path: file, dryRun });
  return db;
}

const toDir = (dir) => (dir instanceof URL ? fileURLToPath(dir) : dir);

/** Migration files in a directory (regular files named NNN_*.sql), in version order. */
export function listMigrations(dir) {
  const abs = toDir(dir);
  if (!existsSync(abs)) return [];
  const files = readdirSync(abs)
    .map((f) => ({ name: f, match: f.match(/^(\d+)_.+\.sql$/i) }))
    .filter((f) => f.match && statSync(path.join(abs, f.name)).isFile())
    .map((f) => ({ name: f.name, version: Number(f.match[1]), path: path.join(abs, f.name) }))
    .sort((a, b) => a.version - b.version);
  const versions = new Set();
  for (const f of files) {
    if (versions.has(f.version)) throw new MigrationError(`Duplicate migration version ${f.version} in ${abs}`, { file: f.name });
    versions.add(f.version);
  }
  return files;
}

/** Migration SQL with a UTF-8 byte-order mark removed (Windows editors add one; SQLite rejects it). */
export function readMigrationSql(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * Apply NNN_name.sql files from `dir` that haven't run yet, in version order,
 * each inside its own transaction. Applied versions are tracked per namespace
 * in schema_migrations, so several migration sets can share one database.
 * @returns {string[]} migrations applied by this call
 * @throws {MigrationError} naming the file that failed; that migration is rolled back
 */
export function migrate(db, dir, { namespace = 'default' } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    namespace   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    PRIMARY KEY (namespace, version)
  )`);
  const applied = new Set(db.prepare(`SELECT version FROM schema_migrations WHERE namespace = ?`).pluck().all(namespace));
  const record = db.prepare(`INSERT INTO schema_migrations (namespace, version, name, applied_at) VALUES (?, ?, ?, ?)`);
  const done = [];
  for (const f of listMigrations(dir)) {
    if (applied.has(f.version)) continue;
    const sql = readMigrationSql(f.path);
    try {
      db.transaction(() => {
        db.exec(sql);
        record.run(namespace, f.version, f.name, new Date().toISOString());
      })();
    } catch (err) {
      throw new MigrationError(`Migration ${f.name} (namespace "${namespace}") failed: ${err.message}`, { file: f.path, namespace, cause: err });
    }
    done.push(f.name);
  }
  return done;
}

/** Run fn inside a transaction; returns fn's result. */
export function transaction(db, fn) {
  return db.transaction(fn)();
}

const missingTables = (db, tables) => {
  const present = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all());
  return tables.filter((t) => !present.has(t));
};

/**
 * Migrate the core database and prove the schema is there. If schema_migrations
 * claims the core migration ran but tables are missing (e.g. an older core wrote
 * the record), the migration is re-applied: every statement is IF NOT EXISTS.
 */
export function ensureCoreSchema(db, { migrations = CORE_MIGRATIONS } = {}) {
  const dir = toDir(migrations);
  const files = listMigrations(dir);
  if (!files.some((f) => f.name === CORE_MIGRATION_FILE)) {
    const found = existsSync(dir) ? readdirSync(dir).join(', ') || '(empty)' : '(folder missing)';
    throw new MigrationError(
      `Core migration ${CORE_MIGRATION_FILE} not found in ${dir} (found: ${found}). `
      + 'Copy packages/core/migrations/001_init.sql into that folder; the migrations/spine and migrations/snapshots subfolders from core 0.2 are no longer used.',
      { file: path.join(dir, CORE_MIGRATION_FILE), namespace: 'core' },
    );
  }

  migrate(db, dir, { namespace: 'core' });

  let missing = missingTables(db, CORE_TABLES);
  if (missing.length) {
    const core = files.find((f) => f.name === CORE_MIGRATION_FILE);
    try {
      db.exec(readMigrationSql(core.path));
    } catch (err) {
      throw new MigrationError(`Re-applying ${CORE_MIGRATION_FILE} failed: ${err.message}`, { file: core.path, namespace: 'core', cause: err });
    }
    missing = missingTables(db, CORE_TABLES);
  }
  if (missing.length) {
    throw new MigrationError(
      `Core schema incomplete after migrating: missing table(s) ${missing.join(', ')}. Is ${path.join(dir, CORE_MIGRATION_FILE)} the core 0.3 migration?`,
      { file: path.join(dir, CORE_MIGRATION_FILE), namespace: 'core' },
    );
  }
}

/**
 * The shared core database (data/spine.sqlite): raw snapshot index, entity
 * spine and approvals. Migrated and verified on every open; closed again if
 * anything fails, so no file lock is left behind.
 * @param {{ dryRun?: boolean, dataDir?: string, migrations?: string|URL }} [options]
 */
export function openCore({ dryRun = false, dataDir = defaultDataDir(), migrations = CORE_MIGRATIONS } = {}) {
  const db = connect(CORE_DB_NAME, { dryRun, dataDir });
  try {
    ensureCoreSchema(db, { migrations });
    importLegacySnapshotIndex(db, { dryRun, dataDir });
    return db;
  } catch (err) {
    safeClose(db);
    throw err;
  }
}

/**
 * core 0.2 kept the snapshot index in data/snapshots.sqlite. Copy it into the
 * core database once, preserving ids (bots store snapshot ids), then retire the
 * old file. Dry runs read it into memory and leave the file in place.
 */
function importLegacySnapshotIndex(db, { dryRun, dataDir }) {
  const legacyFile = dbPath('snapshots', dataDir);
  if (!existsSync(legacyFile)) return;
  if (db.prepare(`SELECT COUNT(*) FROM snapshots`).pluck().get() > 0) return;

  let rows = [];
  const legacy = connect('snapshots', { dryRun: true, dataDir }); // in-memory copy: never touches the old file
  try {
    rows = legacy.prepare(`SELECT * FROM snapshots ORDER BY id`).all();
  } catch {
    rows = []; // not a snapshot index after all
  } finally {
    safeClose(legacy);
  }
  if (!rows.length) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO snapshots (id, source, ref, url, sha256, bytes, content_type, fetched_at, path, meta)
    VALUES (@id, @source, @ref, @url, @sha256, @bytes, @content_type, @fetched_at, @path, @meta)`);
  db.transaction(() => rows.forEach((r) => insert.run(r)))();

  if (!dryRun) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${legacyFile}${suffix}`)) renameSync(`${legacyFile}${suffix}`, `${legacyFile}${suffix}.imported`);
    }
  }
}