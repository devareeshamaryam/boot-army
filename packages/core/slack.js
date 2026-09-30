 import fetch from 'node-fetch';

const SLACK_TIMEOUT_MS = 10_000;

function toPayload(message) {
  if (typeof message === 'string') {
    if (message.trim() === '') throw new TypeError('sendSlackAlert: message must not be empty');
    return { text: message };
  }
  if (message && typeof message === 'object') {
    const hasText = typeof message.text === 'string' && message.text.trim() !== '';
    const hasBlocks = Array.isArray(message.blocks) && message.blocks.length > 0;
    if (!hasText && !hasBlocks) {
      throw new TypeError('sendSlackAlert: payload needs a non-empty "text" or "blocks"');
    }
    return message;
  }
  throw new TypeError('sendSlackAlert: message must be a string or a Slack payload object');
}

/**
 * Post to a Slack incoming webhook.
 *
 * @param {string} webhookUrl - Slack incoming webhook URL (treat as a secret).
 * @param {string|object} message - Plain text, or a full payload such as
 *   { text, blocks }. Include "text" with blocks: Slack uses it for notifications.
 * @returns {Promise<string>} Slack's response body (normally "ok").
 * @throws {TypeError} On invalid arguments.
 * @throws {Error} On network failure, timeout, or a non-2xx response.
 */
export async function sendSlackAlert(webhookUrl, message) {
  if (typeof webhookUrl !== 'string' || !URL.canParse(webhookUrl)) {
    throw new TypeError('sendSlackAlert: webhookUrl must be a valid URL string');
  }
  const payload = toPayload(message);

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });

  const body = await res.text();

  if (!res.ok) {
    // The webhook URL is deliberately left out of the error: it is a credential.
    throw new Error(`Slack webhook failed: ${res.status} ${res.statusText} - ${body}`);
  }

  return body;
}