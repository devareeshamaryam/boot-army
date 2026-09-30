import Parser from 'rss-parser';
import { withRetry } from '@botarmy/core';
import { insertRssItem } from './db.js';
import { userAgent } from './scrapers/http.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build whole-word, case-insensitive matchers for firm names, aliases and mover names. */
export function buildMatchers({ firms = [], names = [] }) {
  const terms = new Map();
  const add = (term, label) => {
    const clean = String(term ?? '').trim();
    if (clean.length < 3) return;
    terms.set(clean.toLowerCase(), { label, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(clean)}($|[^\\p{L}\\p{N}])`, 'iu') });
  };
  for (const firm of firms) {
    add(firm.name, firm.name);
    for (const alias of firm.aliases ?? []) add(alias, firm.name);
  }
  for (const name of names) add(name, name);
  return [...terms.values()];
}

export function matchText(text, matchers) {
  const labels = new Set();
  for (const { label, re } of matchers) if (re.test(text)) labels.add(label);
  return [...labels];
}

const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Read every configured feed, store new items, and tag each with the
 * watchlist firms / mover names it mentions. One broken feed never stops the others.
 *
 * @returns {Promise<{ inserted: number, failures: { feed: string, error: string }[] }>}
 */
export async function ingestFeeds(db, feeds, { firms, moverNames, now, log, retries = 2, retryDelayMs = 2000 }) {
  const parser = new Parser({ timeout: 20_000, headers: { 'User-Agent': userAgent() } });
  const matchers = buildMatchers({ firms, names: moverNames });
  const failures = [];
  let inserted = 0;

  for (const feed of feeds) {
    try {
      const parsed = await withRetry(() => parser.parseURL(feed.url), retries, retryDelayMs);
      for (const item of parsed.items ?? []) {
        const title = stripHtml(item.title);
        if (!title) continue;
        const summary = stripHtml(item.contentSnippet ?? item.content ?? item.summary).slice(0, 500);
        const guid = item.guid || item.id || item.link || `${title}|${item.isoDate ?? item.pubDate ?? ''}`;
        const publishedAt = item.isoDate ?? (item.pubDate && !Number.isNaN(Date.parse(item.pubDate))
          ? new Date(item.pubDate).toISOString()
          : null);

        const isNew = insertRssItem(db, {
          feedUrl: feed.url,
          feedName: feed.name,
          guid: String(guid).slice(0, 500),
          title,
          link: item.link,
          publishedAt,
          summary,
          matched: matchText(`${title} ${summary}`, matchers),
        }, now);
        if (isNew) inserted += 1;
      }
    } catch (err) {
      failures.push({ feed: feed.name, error: err.message });
      log.warn(`Feed "${feed.name}" failed: ${err.message}`);
    }
  }
  return { inserted, failures };
}