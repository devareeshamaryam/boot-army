/**
 * @botarmy/core — shared platform library (IMPLEMENTATION_PLAN.md Section 3).
 *
 *   import { config, logger, http, db, snapshot, spine, match, slack, health } from '@botarmy/core';
 */

// Tier 0 namespaces.
export * as config from './config.js';
export * as logger from './logger.js';
export * as http from './http.js';
export * as db from './db.js';
export * as snapshot from './snapshot.js';
export * as spine from './spine.js';
export * as match from './match.js';
export * as slack from './slack.js';
export * as health from './health.js';
export { ConfigError } from './config.js';

// Legacy flat exports, kept as working aliases for bots written before Tier 0.
export { sendSlackAlert } from './slack.js';
export { askClaude, DEFAULT_CLAUDE_MODEL } from './claude.js';
export { pingHealthcheck, buildHealthcheckUrl } from './healthcheck.js';
export { withRetry } from './retry.js';
export { normalizeEntityId, EntityIdError, SUPPORTED_JURISDICTIONS } from './entitySpine.js';