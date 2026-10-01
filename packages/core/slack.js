/**
 * core.slack — Slack incoming webhooks, plus the approval gate for outbound content.
 *
 *   await slack.post('sponsors', { text, blocks });   // SLACK_WEBHOOK_URL_SPONSORS, else SLACK_WEBHOOK_URL
 *
 * Approvals (IMPLEMENTATION_PLAN.md Section 2, rule 7):
 *   const { token } = await slack.requestApproval('outreach', { bot, kind, ref, title, body });
 *   ... a human clicks Approve in Slack; your interactivity endpoint calls
 *       slack.handleInteraction(rawBody, headers) ...
 *   slack.assertApproved(token);   // throws unless approved — call right before sending
 *
 * Buttons only work if the webhook belongs to a Slack app with Interactivity
 * enabled and pointed at an endpoint that calls handleInteraction().
 */
import fetch from 'node-fetch';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withRetry } from './retry.js';
import { openCore } from './db.js';

const SLACK_TIMEOUT_MS = 10_000;
export const ACTION_APPROVE = 'botarmy_approve';
export const ACTION_REJECT = 'botarmy_reject';

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
  if (!url) throw new Error(`No Slack webhook configured: set ${specific ? `${specific} or ` : ''}SLACK_WEBHOOK_URL in the root .env`);
  return url;
}

/** Post text or a Block Kit payload, retrying transient failures. */
export function post(channel, message) {
  const url = resolveWebhook(channel);
  const payload = toPayload(message);
  return withRetry(() => sendSlackAlert(url, payload), 3, 2000);
}

/* ------------------------------------------------------------ approvals */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = 2900) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class ApprovalError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
  }
}

/** Block Kit for an approval request. */
export function buildApprovalBlocks({ token, title, summary, body, context }) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: clip(`*${esc(title)}*${summary ? `\n${esc(summary)}` : ''}`) } }];
  if (body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(esc(body)) } });
  if (context) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(esc(context), 2000) }] });
  blocks.push({
    type: 'actions',
    block_id: `approval_${token}`,
    elements: [
      {
        type: 'button', action_id: ACTION_APPROVE, style: 'primary', value: token,
        text: { type: 'plain_text', text: 'Approve' },
        confirm: {
          title: { type: 'plain_text', text: 'Approve this?' },
          text: { type: 'plain_text', text: clip(String(title), 280) },
          confirm: { type: 'plain_text', text: 'Approve' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      },
      { type: 'button', action_id: ACTION_REJECT, style: 'danger', value: token, text: { type: 'plain_text', text: 'Reject' } },
    ],
  });
  return blocks;
}

let approvalsDb = null;
const approvals = (options) => (approvalsDb ??= openCore(options));

/**
 * Record a pending approval and post it to Slack with Approve / Reject buttons.
 * Idempotent per (bot, kind, ref): asking twice returns the existing token.
 *
 * @param {string} channel
 * @param {{ bot: string, kind: string, ref: string, title: string, summary?: string, body?: string,
 *           context?: string, payload?: object, expiresInHours?: number }} request
 * @param {{ dryRun?: boolean, dataDir?: string }} [options]
 * @returns {Promise<{ token: string, status: string, isNew: boolean }>}
 */
export async function requestApproval(channel, request, { dryRun = false, dataDir } = {}) {
  const { bot, kind, ref, title, summary, body, context, payload = null, expiresInHours = 72 } = request;
  if (!bot || !kind || !ref || !title) throw new TypeError('requestApproval: bot, kind, ref and title are required');
  const db = dryRun ? openCore({ dryRun: true, dataDir }) : approvals({ dataDir });
  try {
    const existing = db.prepare(`SELECT token, status FROM approvals WHERE bot = ? AND kind = ? AND ref = ?`).get(bot, kind, String(ref));
    if (existing) return { token: existing.token, status: existing.status, isNew: false };

    const token = randomBytes(16).toString('hex');
    const now = new Date();
    db.prepare(`INSERT INTO approvals (token, bot, kind, ref, payload, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(token, bot, kind, String(ref), JSON.stringify({ title, summary, body, context, payload }),
        now.toISOString(), new Date(now.getTime() + expiresInHours * 3_600_000).toISOString());

    const message = { text: `Approval needed: ${title}`, blocks: buildApprovalBlocks({ token, title, summary, body, context }) };
    if (dryRun) console.log(JSON.stringify({ wouldPost: message }, null, 2));
    else await post(channel, message);
    return { token, status: 'pending', isNew: true };
  } finally {
    if (dryRun) db.close();
  }
}

/** Current approval row (payload parsed), or null. Pending approvals past expiry read as expired. */
export function getApproval(token, options = {}) {
  const db = approvals(options);
  const row = db.prepare(`SELECT * FROM approvals WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.status === 'pending' && row.expires_at && row.expires_at < new Date().toISOString()) {
    db.prepare(`UPDATE approvals SET status = 'expired' WHERE token = ? AND status = 'pending'`).run(token);
    row.status = 'expired';
  }
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
}

export function isApproved(token, options) {
  return getApproval(token, options)?.status === 'approved';
}

/** Throw unless the token is approved. Call immediately before any outbound send. */
export function assertApproved(token, options) {
  const a = getApproval(token, options);
  if (!a) throw new ApprovalError(`Unknown approval token`, 'missing');
  if (a.status !== 'approved') throw new ApprovalError(`Not approved (status: ${a.status})`, a.status);
  return a;
}

/**
 * Record a decision. Atomic: only a pending, unexpired approval can change, so
 * double clicks or two approvers cannot both win.
 * @returns {boolean} true if this call made the decision
 */
export function decideApproval(token, decision, userId, options) {
  if (!['approved', 'rejected'].includes(decision)) throw new TypeError('decideApproval: decision must be approved or rejected');
  getApproval(token, options); // applies expiry first
  return approvals(options).prepare(`
    UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
    WHERE token = ? AND status = 'pending'`).run(decision, userId, new Date().toISOString(), token).changes > 0;
}

/**
 * Verify Slack's v0 request signature (HMAC-SHA256 of "v0:{ts}:{body}"),
 * rejecting requests older than five minutes.
 */
export function verifySlackSignature({ signingSecret = process.env.SLACK_SIGNING_SECRET, timestamp, signature, rawBody, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`);
  const given = Buffer.from(String(signature));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Handle a Slack interactivity POST for approval buttons.
 * @param {string} rawBody   the exact request body (form-encoded)
 * @param {Record<string, string>} headers  lower-cased request headers
 * @returns {Promise<{ status: number, outcome: string, token?: string }>}
 *          status is the HTTP status to answer Slack with (answer within 3 s)
 */
export async function handleInteraction(rawBody, headers, { approverIds = (process.env.SLACK_APPROVER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...options } = {}) {
  const ok = verifySlackSignature({
    timestamp: headers['x-slack-request-timestamp'],
    signature: headers['x-slack-signature'],
    rawBody,
  });
  if (!ok) return { status: 401, outcome: 'bad_signature' };

  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '');
  } catch {
    return { status: 400, outcome: 'bad_payload' };
  }
  const action = payload?.actions?.[0];
  if (payload?.type !== 'block_actions' || ![ACTION_APPROVE, ACTION_REJECT].includes(action?.action_id)) {
    return { status: 200, outcome: 'ignored' };
  }
  const token = action.value;
  const userId = payload.user?.id ?? 'unknown';
  if (approverIds.length && !approverIds.includes(userId)) return { status: 200, outcome: 'forbidden', token };

  const decision = action.action_id === ACTION_APPROVE ? 'approved' : 'rejected';
  const decided = decideApproval(token, decision, userId, options);
  const current = getApproval(token, options);
  if (decided && payload.response_url && /^https:\/\/hooks\.slack\.com\//.test(payload.response_url)) {
    const title = current?.payload?.title ?? 'Request';
    await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace_original: true,
        text: `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${title}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: clip(`${decision === 'approved' ? ':white_check_mark: Approved' : ':no_entry_sign: Rejected'} by <@${userId}>: *${esc(title)}*`) } }],
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    }).catch(() => {});
  }
  return { status: 200, outcome: decided ? decision : `already_${current?.status ?? 'missing'}`, token };
}

/** Close the approvals connection (tests, long-running servers on shutdown). */
export function closeApprovals() {
  approvalsDb?.close();
  approvalsDb = null;
}