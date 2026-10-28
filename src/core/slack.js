/**
 * core.slack — Slack incoming webhooks.
 *
 *   await slack.post('sponsors', { text, blocks });   // SLACK_WEBHOOK_URL_SPONSORS, else SLACK_WEBHOOK_URL
 */
import fetch from 'node-fetch';
import { withRetry } from './retry.js';

const SLACK_TIMEOUT_MS = 10_000;

/* ---------------------------------------------------------------- post */

function toPayload(message) {
  if (typeof message === 'string') {
    if (message.trim() === '') throw new TypeError('slack: message must not be empty');
    return { text: message };
  }
  if (message && typeof message === 'object') {
    const hasText = typeof message.text === 'string' && message.text.trim() !== '';
    const hasBlocks = Array.isArray(message.blocks) && message.blocks.length > 0;
    if (!hasText && !hasBlocks) throw new TypeError('slack: payload needs a non-empty "text" or "blocks"');
    if (hasBlocks && message.blocks.length > 50) throw new TypeError('slack: Slack allows at most 50 blocks per message');
    return message;
  }
  throw new TypeError('slack: message must be a string or a Slack payload object');
}

/**
 * Legacy: post to a webhook URL. Kept for bots written before core 0.2.
 * @returns {Promise<string>} Slack's response body (normally "ok")
 */
export async function sendSlackAlert(webhookUrl, message) {
  if (typeof webhookUrl !== 'string' || !URL.canParse(webhookUrl)) {
    throw new TypeError('sendSlackAlert: webhookUrl must be a valid URL string');
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toPayload(message)),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  const body = await res.text();
  // The webhook URL is deliberately left out of errors: it is a credential.
  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${res.statusText} - ${body}`);
  return body;
}

/**
 * Channel name → webhook URL: SLACK_WEBHOOK_URL_<CHANNEL>, then SLACK_WEBHOOK_URL.
 * A full http(s) URL is returned unchanged.
 */
export function resolveWebhook(channel) {
  if (typeof channel === 'string' && /^https?:\/\//i.test(channel)) return channel;
  const specific = channel ? `SLACK_WEBHOOK_URL_${String(channel).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` : null;
  const url = (specific && process.env[specific]?.trim()) || process.env.SLACK_WEBHOOK_URL?.trim();
  if (!url) throw new Error(`No Slack webhook configured: set ${specific ? `${specific} or ` : ''}SLACK_WEBHOOK_URL in the environment`);
  return url;
}

/** Post text or a Block Kit payload, retrying transient failures. */
export function post(channel, message) {
  const url = resolveWebhook(channel);
  const payload = toPayload(message);
  return withRetry(() => sendSlackAlert(url, payload), 3, 2000);
}
