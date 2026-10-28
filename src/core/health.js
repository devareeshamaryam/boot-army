/**
 * core.health — wraps a bot run with healthchecks.io pings and exit codes.
 *
 *   await health.run('sponsor-licence-scout', async () => { ... }, { dryRun, log });
 *
 * Pings /start, then success, or /fail on an exception. The check UUID is read
 * from HC_UUID_<SLUG_IN_UPPER_SNAKE> (e.g. HC_UUID_SPONSOR_LICENCE_SCOUT) unless
 * `uuid` is passed. Dry runs never ping. A failure sets process.exitCode = 1
 * and is never swallowed silently: it is logged and handed to onFailure.
 */
import { pingHealthcheck, buildHealthcheckUrl } from './healthcheck.js';
import { withRetry } from './retry.js';

export const uuidEnvName = (slug) => `HC_UUID_${String(slug).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/**
 * @param {string} slug
 * @param {() => Promise<any>} fn
 * @param {{ dryRun?: boolean, uuid?: string, baseUrl?: string, log?: object, onFailure?: (err: Error) => any }} [options]
 * @returns {Promise<any>} fn's result, or undefined on failure
 */
export async function run(slug, fn, { dryRun = false, uuid, baseUrl, log = console, onFailure } = {}) {
  const base = (baseUrl ?? process.env.HEALTHCHECKS_BASE_URL ?? '').trim();
  const id = (uuid ?? process.env[uuidEnvName(slug)] ?? '').trim();
  const enabled = !dryRun && Boolean(base && id);
  if (!dryRun && !enabled) log.warn?.(`Healthcheck disabled: set HEALTHCHECKS_BASE_URL and ${uuidEnvName(slug)}`);

  const ping = async (event) => {
    if (!enabled) return;
    try {
      await withRetry(() => pingHealthcheck(buildHealthcheckUrl(base, id, event)), 2, 1000);
    } catch (err) {
      // Monitoring outages must never fail the job itself.
      log.warn?.(`Healthcheck ping (${event ?? 'success'}) failed: ${err.message}`);
    }
  };

  const started = Date.now();
  await ping('start');
  try {
    const result = await fn();
    await ping();
    log.info?.(`Run finished`, { slug, ms: Date.now() - started });
    return result;
  } catch (err) {
    process.exitCode = 1;
    log.error?.(`Run failed: ${err.message}`, { slug, err });
    await ping('fail');
    if (onFailure) {
      try {
        await onFailure(err);
      } catch (handlerErr) {
        log.error?.(`onFailure handler failed: ${handlerErr.message}`);
      }
    }
    return undefined;
  }
}                                                                                     