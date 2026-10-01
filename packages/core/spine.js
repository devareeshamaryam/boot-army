/**
 * core.spine — shared entity spine in data/spine.sqlite.
 *
 * Resolution rule (IMPLEMENTATION_PLAN.md Section 4): an exact registry id match
 * wins. Without one an entity is "unresolved", identified by jurisdiction +
 * normalised name + locality. Fuzzy matching never merges automatically:
 * candidates below certainty go to review_queue.
 *
 *   const spine = spine.openSpine({ dryRun });
 *   const entityId = spine.upsertEntity({ jurisdiction: 'UK', registryId: '01026167', name: 'Barclays Bank Plc' });
 *   spine.linkEvent({ entityId, type: 'SPONSOR_ADDED', date: '2026-09-30', source: 'sponsor-licence-scout', payload });
 */
import { openCore, safeClose } from './db.js';
import { nameNorm, fuzzyCompany } from './match.js';
import { dataDir as defaultDataDir } from './config.js';

/**
 * @param {{ dryRun?: boolean, dataDir?: string, migrations?: string|URL }} [options]
 */
export function openSpine({ dryRun = false, dataDir = defaultDataDir(), migrations } = {}) {
  const db = openCore({ dryRun, dataDir, ...(migrations ? { migrations } : {}) });
  try {
    return buildSpine(db);
  } catch (err) {
    safeClose(db); // never leave a locked file behind (Windows)
    throw err;
  }
}

function buildSpine(db) {
  const byRegistry = db.prepare(`SELECT * FROM entities WHERE jurisdiction = ? AND registry_id = ?`);
  const byName = db.prepare(`
    SELECT * FROM entities WHERE registry_id IS NULL AND jurisdiction = ? AND name_norm = ? AND IFNULL(locality, '') = ?`);
  const insertEntity = db.prepare(`
    INSERT INTO entities (jurisdiction, registry_id, spine_id, name, name_norm, locality, status, postcode, lat, lon, sic, first_seen, last_seen)
    VALUES (@jurisdiction, @registryId, @spineId, @name, @nameNorm, @locality, @status, @postcode, @lat, @lon, @sic, @seenAt, @seenAt)`);
  const touch = db.prepare(`
    UPDATE entities SET last_seen = @seenAt, name = @name, name_norm = @nameNorm,
      spine_id = COALESCE(@spineId, spine_id), status = COALESCE(@status, status),
      postcode = COALESCE(@postcode, postcode), lat = COALESCE(@lat, lat), lon = COALESCE(@lon, lon),
      sic = COALESCE(@sic, sic)
    WHERE entity_id = @entityId`);
  const addAlias = db.prepare(`INSERT OR IGNORE INTO entity_aliases (entity_id, name, name_norm, source) VALUES (?, ?, ?, ?)`);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (entity_id, person_id, type, event_date, detected_at, source, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const findEvent = db.prepare(`
    SELECT event_id FROM events WHERE source = ? AND type = ? AND entity_id IS ? AND event_date IS ?`);

  const api = {
    db,

    /**
     * Insert or refresh an entity. Returns entity_id.
     * Aliases are recorded whenever the name differs from a previous one.
     */
    upsertEntity({ jurisdiction, registryId = null, spineId = null, name, locality = null, status = null,
      postcode = null, lat = null, lon = null, sic = null, source = null, seenAt = new Date().toISOString() }) {
      if (!jurisdiction || !name) throw new Error('spine.upsertEntity: jurisdiction and name are required');
      const params = {
        jurisdiction, registryId: registryId ?? null, spineId, name, nameNorm: nameNorm(name),
        locality: locality ? nameNorm(locality) : null, status, postcode, lat, lon, sic, seenAt,
      };
      return db.transaction(() => {
        const existing = params.registryId
          ? byRegistry.get(jurisdiction, params.registryId)
          : byName.get(jurisdiction, params.nameNorm, params.locality ?? '');
        let entityId;
        if (existing) {
          entityId = existing.entity_id;
          touch.run({ ...params, entityId });
          if (existing.name_norm !== params.nameNorm) addAlias.run(entityId, existing.name, existing.name_norm, source);
        } else {
          entityId = Number(insertEntity.run(params).lastInsertRowid);
        }
        addAlias.run(entityId, name, params.nameNorm, source);
        return entityId;
      })();
    },

    /**
     * Exact lookup: by registry id, else unresolved by name + locality.
     * @returns {object|null} entity row
     */
    findEntity({ jurisdiction, registryId = null, name, locality = null }) {
      if (registryId) return byRegistry.get(jurisdiction, registryId) ?? null;
      if (!name) return null;
      return byName.get(jurisdiction, nameNorm(name), locality ? nameNorm(locality) : '') ?? null;
    },

    /**
     * Fuzzy candidates for a name within one jurisdiction (entity names and aliases).
     * Never merges: callers decide, or queueReview() when unsure.
     * @returns {{ entity: object, score: number }[]}
     */
    findCandidates({ jurisdiction, name, threshold = 85, limit = 5 }) {
      const rows = db.prepare(`
        SELECT e.*, a.name AS alias_name FROM entities e
        LEFT JOIN entity_aliases a ON a.entity_id = e.entity_id
        WHERE e.jurisdiction = ?`).all(jurisdiction);
      const byId = new Map();
      for (const r of rows) {
        const entry = byId.get(r.entity_id) ?? { entity: r, names: new Set([r.name]) };
        if (r.alias_name) entry.names.add(r.alias_name);
        byId.set(r.entity_id, entry);
      }
      const scored = [];
      for (const { entity, names } of byId.values()) {
        const best = fuzzyCompany(name, [...names], { threshold });
        if (best) scored.push({ entity, score: best.score });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    /**
     * Idempotent: (source, type, entity, date) is stored once.
     * @returns {{ eventId: number|null, isNew: boolean }}
     */
    linkEvent({ entityId = null, personId = null, type, date = null, source, payload = null, detectedAt = new Date().toISOString() }) {
      if (!type || !source) throw new Error('spine.linkEvent: type and source are required');
      const info = insertEvent.run(entityId, personId, type, date, detectedAt, source, payload === null ? null : JSON.stringify(payload));
      if (info.changes) return { eventId: Number(info.lastInsertRowid), isNew: true };
      return { eventId: findEvent.get(source, type, entityId, date)?.event_id ?? null, isNew: false };
    },

    /** Events of a type since a date, newest first, payload parsed. */
    events({ type, since = '0000', limit = 500 } = {}) {
      const rows = type
        ? db.prepare(`SELECT * FROM events WHERE type = ? AND IFNULL(event_date, '') >= ? ORDER BY event_date DESC LIMIT ?`).all(type, since, limit)
        : db.prepare(`SELECT * FROM events WHERE IFNULL(event_date, '') >= ? ORDER BY event_date DESC LIMIT ?`).all(since, limit);
      return rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
    },

    /** Put an item in front of a human. Returns item_id. */
    queueReview({ kind, payload }) {
      if (!kind) throw new Error('spine.queueReview: kind is required');
      return Number(db.prepare(`INSERT INTO review_queue (kind, payload, created_at) VALUES (?, ?, ?)`)
        .run(kind, JSON.stringify(payload ?? null), new Date().toISOString()).lastInsertRowid);
    },

    resolveReview(itemId, { status = 'resolved', resolution = null } = {}) {
      return db.prepare(`UPDATE review_queue SET status = ?, resolution = ?, resolved_at = ? WHERE item_id = ? AND status = 'pending'`)
        .run(status, resolution === null ? null : JSON.stringify(resolution), new Date().toISOString(), itemId).changes > 0;
    },

    pendingReviews({ kind } = {}) {
      const rows = kind
        ? db.prepare(`SELECT * FROM review_queue WHERE status = 'pending' AND kind = ? ORDER BY item_id`).all(kind)
        : db.prepare(`SELECT * FROM review_queue WHERE status = 'pending' ORDER BY item_id`).all();
      return rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
    },

    close() {
      safeClose(db);
    },
  };
  return api;
}

/* ----------------------------------------------------------- default spine */

let defaultSpine = null;
let defaultOptions = {};

export function configure(options = {}) {
  if (defaultSpine) {
    defaultSpine.close();
    defaultSpine = null;
  }
  defaultOptions = options;
}

const spine = () => (defaultSpine ??= openSpine(defaultOptions));

export const upsertEntity = (args) => spine().upsertEntity(args);
export const findEntity = (args) => spine().findEntity(args);
export const findCandidates = (args) => spine().findCandidates(args);
export const linkEvent = (args) => spine().linkEvent(args);
export const queueReview = (args) => spine().queueReview(args);
export function close() {
  defaultSpine?.close();
  defaultSpine = null;
}