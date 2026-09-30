/**
 * Downloads the full export of published UK payment practice reports.
 *
 *   Page:   https://check-payment-practices.service.gov.uk/export
 *   CSV:    https://check-payment-practices.service.gov.uk/export/csv/   (30 MB+, every report ever filed)
 *
 * Overrides (read at call time, after dotenv has loaded):
 *   PPS_CSV_PATH  read a CSV you downloaded by hand instead of fetching
 *   PPS_CSV_URL   fetch from a different URL
 */
import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';

export const EXPORT_URL = 'https://check-payment-practices.service.gov.uk/export/csv/';
const EXPORT_PAGE = 'https://check-payment-practices.service.gov.uk/export';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function browserHeaders() {
  return {
    'User-Agent': process.env.PPS_USER_AGENT || BROWSER_UA,
    Accept: 'text/csv,application/csv,text/plain;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    Referer: EXPORT_PAGE,
  };
}

/** Decode as UTF-8, falling back to Windows-1252 for legacy bytes. */
function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/**
 * Fetch the export and return the raw CSV text.
 * @returns {Promise<{ text: string, source: string, bytes: number }>}
 */
export async function fetchPaymentPracticesCsv({ timeoutMs = 300_000 } = {}) {
  const localPath = process.env.PPS_CSV_PATH?.trim();
  if (localPath) {
    const buffer = await readFile(localPath);
    return { text: decode(buffer), source: `file:${localPath}`, bytes: buffer.length };
  }

  const url = process.env.PPS_CSV_URL?.trim() || EXPORT_URL;
  const res = await fetch(url, {
    headers: browserHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const hint = res.status === 403
      ? ' (blocked: download the CSV in a browser from the export page and set PPS_CSV_PATH to the file)'
      : '';
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}${hint}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const text = decode(buffer);

  // A consent, error or challenge page served with 200 must never reach the parser.
  if (/^\s*<(!doctype|html)/i.test(text.slice(0, 300))) {
    throw new Error(`Expected CSV from ${url} but received an HTML page (${buffer.length} bytes)`);
  }
  return { text, source: url, bytes: buffer.length };
}