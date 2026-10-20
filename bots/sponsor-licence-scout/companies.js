/**
 * Companies House links for the Slack message.
 *
 * The register has no company number, so each listed sponsor is looked up on
 * the public Companies House search and linked straight to its company page
 * when the top results contain a confident name match. Otherwise the link is
 * the search page itself, so it is never a dead end.
 */
import { http, match } from '@botarmy/core';

const ORIGIN = 'https://find-and-update.company-information.service.gov.uk';
export const MATCH_SIMILARITY = 90;
const MIN_INTERVAL_MS = 250; // be polite: at most 4 searches a second

/** Registered name without a trading name: "Dynamic Pizza 2 Ltd T/A Pizza Hut" → "Dynamic Pizza 2 Ltd". */
export const legalName = (name) => String(name ?? '').split(/\s+(?:t\/as?|ta|trading as)\s+/i)[0].trim();

export const searchUrl = (name) => `${ORIGIN}/search/companies?q=${encodeURIComponent(legalName(name))}`;

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** Search results in page order: [{ number, title }]. */
export function parseResults(html) {
  return [...String(html).matchAll(/href="\/company\/([A-Z0-9]{8})"[^>]*>([^<]+)</g)]
    .map((m) => ({ number: m[1], title: decode(m[2]) }));
}

/** Company page URL for the best match among the first five results, or null. */
export function pickCompany(html, name) {
  const wanted = legalName(name);
  let best = null;
  for (const r of parseResults(html).slice(0, 5)) {
    const score = match.companySimilarity(wanted, r.title);
    if (score >= MATCH_SIMILARITY && (!best || score > best.score)) best = { ...r, score };
  }
  return best ? `${ORIGIN}/company/${best.number}` : null;
}

/**
 * Resolve a link for every name: the company page if found, else the search page.
 * Lookup failures never fail the run; they just fall back to the search link.
 * @returns {Promise<Map<string, string>>}
 */
export async function resolveLinks(names, { log } = {}) {
  const links = new Map();
  let direct = 0;
  for (const name of new Set(names)) {
    let url = null;
    try {
      const res = await http.fetch(searchUrl(name), { minIntervalMs: MIN_INTERVAL_MS, retries: 2, timeoutMs: 15_000 });
      url = pickCompany(res.text(), name);
    } catch (err) {
      log?.warn(`Companies House lookup failed for "${name}": ${err.message}`);
    }
    if (url) direct++;
    links.set(name, url ?? searchUrl(name));
  }
  log?.info(`Companies House: ${direct}/${links.size} linked to the company page, rest to search`);
  return links;
}
