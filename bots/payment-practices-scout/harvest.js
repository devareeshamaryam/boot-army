/**
 * B9 harvester: download the full payment-practices export and store it, raw,
 * in the snapshot store. No parsing happens here.
 *
 *   Page: https://check-payment-practices.service.gov.uk/export
 *   CSV:  https://check-payment-practices.service.gov.uk/export/csv/   (30 MB+, every report ever filed)
 *
 * Overrides (read at call time):
 *   PPS_CSV_PATH   store a CSV you downloaded by hand instead of fetching (if the site blocks you)
 *   PPS_CSV_URL    fetch from a different URL
 *   PPS_USER_AGENT replace the browser-like User-Agent
 *
 * Runnable alone:  node bots/payment-practices-scout/harvest.js [--dry-run]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { http } from '@botarmy/core';

export const SOURCE = 'uk-payment-practices';
export const EXPORT_PAGE = 'https://check-payment-practices.service.gov.uk/export';
export const EXPORT_URL = 'https://check-payment-practices.service.gov.uk/export/csv/';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Snapshot-first: the export's bytes are written to the store before anything reads them.
 * @returns {Promise<{ snapshot: { id, isNew, sha256, bytes, fetchedAt }, origin: string }>}
 */
export async function harvest({ store, log, env = process.env }) {
  const localPath = env.PPS_CSV_PATH?.trim();
  let body;
  let meta;
  if (localPath) {
    body = await readFile(localPath);
    meta = { origin: `file:${path.basename(localPath)}`, contentType: 'text/csv' };
  } else {
    const url = env.PPS_CSV_URL?.trim() || EXPORT_URL;
    let res;
    try {
      res = await http.fetch(url, {
        headers: { Accept: 'text/csv,application/csv,text/plain;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9', Referer: EXPORT_PAGE },
        userAgent: env.PPS_USER_AGENT?.trim() || BROWSER_UA,
        timeoutMs: 300_000,
        retries: 2,
      });
    } catch (err) {
      if (err.status === 403) {
        throw new Error(`${err.message}. Blocked: download the CSV in a browser from ${EXPORT_PAGE} and set PPS_CSV_PATH to the file.`);
      }
      throw err;
    }
    body = res.body;
    meta = { url: res.url, origin: res.url, contentType: res.contentType };
  }

  const snapshot = store.writeRaw(SOURCE, 'payment-practices-export.csv', body, meta);
  log?.info(`${snapshot.isNew ? 'Stored new' : 'Unchanged'} export snapshot ${snapshot.id} (${(snapshot.bytes / 1e6).toFixed(1)} MB) from ${meta.origin}`);
  return { snapshot, origin: meta.origin };
}

/* --------------------------------------------------------- standalone run */

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  const { fileURLToPath } = await import('node:url');
  config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
  const { snapshot, logger } = await import('@botarmy/core');
  const log = logger.forBot('payment-practices-scout:harvest');
  const store = snapshot.openStore({ dryRun: process.argv.includes('--dry-run') });
  try {
    const result = await harvest({ store, log });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}