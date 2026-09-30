import fetch from 'node-fetch';

const HEALTHCHECK_TIMEOUT_MS = 10_000;

/**
 * Hit a healthchecks.io ping URL, e.g.
 *   https://hc-ping.com/<uuid>          success
 *   https://hc-ping.com/<uuid>/start    job started
 *   https://hc-ping.com/<uuid>/fail     job failed
 *   https://hc-ping.com/<uuid>/<code>   exit status (0 = success)
 *
 * @param {string} pingUrl - Full ping URL.
 * @returns {Promise<{ ok: true, status: number, body: string }>}
 * @throws {TypeError} On an invalid URL.
 * @throws {Error} On network failure, timeout, or a non-2xx response.
 */
export async function pingHealthcheck(pingUrl) {
  if (typeof pingUrl !== 'string' || !URL.canParse(pingUrl)) {
    throw new TypeError('pingHealthcheck: pingUrl must be a valid URL string');
  }

  const res = await fetch(pingUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`Healthcheck ping failed: ${res.status} ${res.statusText} - ${body}`);
  }

  return { ok: true, status: res.status, body };
}

/**
 * Build a ping URL from a base URL (e.g. HEALTHCHECKS_BASE_URL) and a check UUID.
 *
 * @param {string} baseUrl - e.g. "https://hc-ping.com".
 * @param {string} checkId - The check's UUID.
 * @param {'start'|'fail'|'log'|number} [event] - Optional ping type or exit code.
 * @returns {string}
 */
export function buildHealthcheckUrl(baseUrl, checkId, event) {
  if (typeof baseUrl !== 'string' || !URL.canParse(baseUrl)) {
    throw new TypeError('buildHealthcheckUrl: baseUrl must be a valid URL string');
  }
  if (typeof checkId !== 'string' || checkId.trim() === '') {
    throw new TypeError('buildHealthcheckUrl: checkId must be a non-empty string');
  }

  const parts = [baseUrl.replace(/\/+$/, ''), encodeURIComponent(checkId.trim())];
  if (event !== undefined) parts.push(encodeURIComponent(String(event)));
  return parts.join('/');
}