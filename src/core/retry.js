const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async function, retrying on failure with exponential backoff.
 *
 * `retries` is the number of retries AFTER the first attempt, so the default
 * of 3 means up to 4 attempts in total. Waits between attempts are
 * delayMs, 2*delayMs, 4*delayMs, ... plus up to 10% random jitter so that
 * several bots failing at once don't all retry in lockstep.
 *
 * @template T
 * @param {(attempt: number) => Promise<T> | T} fn - Receives the 0-based attempt number.
 * @param {number} [retries=3] - Retries after the first attempt (integer >= 0).
 * @param {number} [delayMs=1000] - Base delay before the first retry, in ms.
 * @returns {Promise<T>} The first successful result.
 * @throws The error from the final attempt if every attempt fails.
 */
export async function withRetry(fn, retries = 3, delayMs = 1000) {
  if (typeof fn !== 'function') {
    throw new TypeError('withRetry: fn must be a function');
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError('withRetry: retries must be an integer >= 0');
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('withRetry: delayMs must be a number >= 0');
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;

      const backoff = delayMs * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.1;
      await sleep(backoff + jitter);
    }
  }

  throw lastError;
}