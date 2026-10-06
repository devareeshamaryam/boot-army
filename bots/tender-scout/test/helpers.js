/**
 * Shared test helpers. Fixtures in test/fixtures are REAL Contracts Finder responses
 * (captured 2026-10-06, trimmed); anything synthetic is built inline in the test and says so.
 */
import { readFileSync } from 'node:fs';
import { http } from '@botarmy/core';

// Tests mock the network: switch off core.http's shared host pacing (5s for Contracts Finder),
// which would otherwise slow every test and write throttle files under data/.
for (const host of ['www.contractsfinder.service.gov.uk', 'www.find-tender.service.gov.uk']) http.setHostPolicy(host, null);

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
export const tenderPackage = () => fixture('cf-tender-2026-09-29.json');
export const awardPackage = () => fixture('cf-award-2026-10-01.json');

/** Find a release in a package by the end of its ocid. */
export const byOcid = (pkg, tail) => pkg.releases.find((r) => r.ocid.endsWith(tail));

/** A logger that records instead of printing. */
export function quietLog() {
  const lines = [];
  const rec = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

/** A fake fetch Response for core.http.setFetch. */
export function response(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}
