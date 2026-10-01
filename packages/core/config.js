/**
 * core.config — settings from the root .env, with a declarative schema.
 *
 * Nothing is read at import time. ES module imports are evaluated before an
 * entry point's own dotenv call, so values are read when first requested.
 * The root .env is loaded here too (idempotently, never overriding variables
 * already set), so a bot that forgets its dotenv call still gets its settings.
 *
 *   const settings = config.load({
 *     SLS_MIN_ORGS:       { type: 'number', default: 1000, min: 1 },
 *     SLACK_WEBHOOK_URL:  { type: 'url', required: true, secret: true },
 *     SLS_MODE:           { type: 'enum', values: ['daily', 'weekly'], default: 'daily' },
 *   });
 *   // -> frozen { SLS_MIN_ORGS: 1000, SLACK_WEBHOOK_URL: 'https://…', SLS_MODE: 'daily' }
 *
 * Every problem is reported in one ConfigError naming each variable.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const ENV_FILE = path.join(ROOT_DIR, '.env');

export class ConfigError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

let envLoaded = false;
/** Load the root .env once. Existing process.env values always win. */
export function loadEnv() {
  if (envLoaded) return;
  loadDotenv({ path: ENV_FILE, quiet: true });
  envLoaded = true;
}

function raw(name) {
  loadEnv();
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

/* ---------------------------------------------------------------- types */

const PARSERS = {
  string: (v) => v,
  number: (v, spec) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('must be a number');
    if (spec.integer && !Number.isInteger(n)) throw new Error('must be a whole number');
    if (spec.min !== undefined && n < spec.min) throw new Error(`must be >= ${spec.min}`);
    if (spec.max !== undefined && n > spec.max) throw new Error(`must be <= ${spec.max}`);
    return n;
  },
  boolean: (v) => {
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
    throw new Error('must be true or false');
  },
  url: (v) => {
    if (!URL.canParse(v)) throw new Error('must be a valid URL');
    return v;
  },
  enum: (v, spec) => {
    if (!spec.values?.includes(v)) throw new Error(`must be one of ${spec.values.join(', ')}`);
    return v;
  },
  list: (v) => v.split(',').map((s) => s.trim()).filter(Boolean),
  json: (v) => {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error('must be valid JSON');
    }
  },
};

/**
 * Validate a schema against the environment.
 * @param {Record<string, { type?: keyof PARSERS, required?: boolean, default?: any,
 *   min?: number, max?: number, integer?: boolean, values?: string[], secret?: boolean, description?: string }>} schema
 * @returns {Readonly<Record<string, any>>}
 * @throws {ConfigError} listing every missing or invalid variable
 */
export function load(schema) {
  const out = {};
  const problems = [];
  for (const [name, spec] of Object.entries(schema)) {
    const type = spec.type ?? 'string';
    const parse = PARSERS[type];
    if (!parse) throw new Error(`config.load: unknown type "${type}" for ${name}`);
    const value = raw(name);
    if (value === undefined) {
      if (spec.required) problems.push(`${name} is required${spec.description ? ` (${spec.description})` : ''}`);
      else out[name] = spec.default;
      continue;
    }
    try {
      out[name] = parse(value, spec);
    } catch (err) {
      problems.push(`${name} ${err.message}${spec.secret ? '' : ` (got "${value}")`}`);
    }
  }
  if (problems.length) {
    throw new ConfigError(`Invalid configuration in ${ENV_FILE}:\n  - ${problems.join('\n  - ')}`, problems);
  }
  return Object.freeze(out);
}

/* ------------------------------------------------------ single values */

export const required = (name) => load({ [name]: { required: true } })[name];
export const optional = (name, fallback) => load({ [name]: { default: fallback } })[name];
export const number = (name, fallback) => load({ [name]: { type: 'number', default: fallback } })[name];
export const bool = (name, fallback = false) => load({ [name]: { type: 'boolean', default: fallback } })[name];

/** Absolute path of the shared data directory (<repo>/data unless BOTARMY_DATA_DIR is set). */
export function dataDir() {
  return path.resolve(ROOT_DIR, raw('BOTARMY_DATA_DIR') ?? 'data');
}

/** Settings shared by every bot. */
export const CORE_SCHEMA = Object.freeze({
  NODE_ENV: { type: 'enum', values: ['development', 'production', 'test'], default: 'development' },
  SLACK_WEBHOOK_URL: { type: 'url', secret: true, description: 'default Slack incoming webhook' },
  SLACK_SIGNING_SECRET: { secret: true, description: 'Slack app signing secret, for approvals' },
  HEALTHCHECKS_BASE_URL: { type: 'url', default: 'https://hc-ping.com' },
  ANTHROPIC_API_KEY: { secret: true },
  BOTARMY_CONTACT: { description: 'contact appended to the default User-Agent' },
  LOG_LEVEL: { type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info' },
  LOG_FORMAT: { type: 'enum', values: ['json', 'text'], default: 'json' },
});

/** Core settings plus dataDir/rootDir. */
export function get() {
  return Object.freeze({ ...load(CORE_SCHEMA), dataDir: dataDir(), rootDir: ROOT_DIR });
}