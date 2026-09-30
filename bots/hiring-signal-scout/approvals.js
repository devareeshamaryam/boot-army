import { createHmac, timingSafeEqual } from 'node:crypto';
import { getProposal, transitionProposal } from './db.js';
import { ACTION_APPROVE, ACTION_REJECT, buildDecisionMessage } from './digest.js';

const MAX_SKEW_SECONDS = 300;

/**
 * Verify a Slack request signature (v0 scheme): HMAC-SHA256 of
 * "v0:{timestamp}:{raw body}" with the app's signing secret. Rejects requests
 * older than five minutes to stop replays.
 */
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack sends interactions as application/x-www-form-urlencoded with a "payload" field. */
export function parseInteraction(rawBody) {
  const payload = new URLSearchParams(rawBody).get('payload');
  if (!payload) throw new Error('No payload in interaction body');
  return JSON.parse(payload);
}

/* ------------------------------------------------------------ transports */

/**
 * How an approved email leaves the building.
 *   manual  - record approval; a human sends it (default, safest)
 *   webhook - POST the email as JSON to HSS_OUTREACH_WEBHOOK_URL, e.g. a Zapier
 *             or Make hook wired to a "send email" step in Gmail or Outlook
 */
export function createTransport(cfg) {
  if (cfg.outreachTransport === 'webhook') {
    if (!cfg.outreachWebhookUrl) throw new Error('HSS_OUTREACH_TRANSPORT=webhook needs HSS_OUTREACH_WEBHOOK_URL');
    return {
      name: 'webhook',
      async send(p) {
        const res = await fetch(cfg.outreachWebhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.outreachWebhookSecret ? { 'X-HSS-Secret': cfg.outreachWebhookSecret } : {}),
          },
          body: JSON.stringify({
            proposalId: p.id,
            to: p.contact_email,
            toName: p.contact_name,
            subject: p.subject,
            body: p.body,
            company: p.company_name,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Outreach webhook -> ${res.status} ${(await res.text()).slice(0, 200)}`);
        return { status: 'sent' };
      },
    };
  }
  return { name: 'manual', async send() { return { status: 'approved' }; } };
}

async function respond(responseUrl, message) {
  if (!responseUrl || !/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) return;
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`response_url -> ${res.status}`);
}

/**
 * Handle one block_actions payload. The pending -> approving transition is an
 * atomic UPDATE, so double clicks or two approvers can never send twice.
 *
 * @returns {Promise<{ outcome: string, proposalId?: number }>}
 */
export async function handleInteraction(db, payload, { cfg, transport, log, respondFn = respond }) {
  if (payload.type !== 'block_actions') return { outcome: 'ignored' };
  const action = payload.actions?.[0];
  if (!action || ![ACTION_APPROVE, ACTION_REJECT].includes(action.action_id)) return { outcome: 'ignored' };

  const userId = payload.user?.id ?? 'unknown';
  const proposalId = Number(action.value);
  const reply = (message) => respondFn(payload.response_url, message).catch((e) => log.warn(`Slack update failed: ${e.message}`));

  if (cfg.slackApproverIds.length && !cfg.slackApproverIds.includes(userId)) {
    await respondFn(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: false,
      text: 'You are not on the approver list for outreach (SLACK_APPROVER_IDS).',
    }).catch(() => {});
    return { outcome: 'forbidden', proposalId };
  }

  const proposal = getProposal(db, proposalId);
  if (!proposal) return { outcome: 'missing', proposalId };

  if (action.action_id === ACTION_REJECT) {
    if (!transitionProposal(db, proposalId, 'pending', 'rejected', { by: userId })) {
      return { outcome: `already_${getProposal(db, proposalId).status}`, proposalId };
    }
    await reply(buildDecisionMessage(proposal, { outcome: 'rejected', userId }));
    return { outcome: 'rejected', proposalId };
  }

  if (!proposal.contact_email) return { outcome: 'no_email', proposalId };
  if (!transitionProposal(db, proposalId, 'pending', 'approving', { by: userId })) {
    return { outcome: `already_${getProposal(db, proposalId).status}`, proposalId };
  }

  try {
    const { status } = await transport.send(proposal);
    transitionProposal(db, proposalId, 'approving', status, { by: userId });
    await reply(buildDecisionMessage(proposal, { outcome: status, userId }));
    log.info(`Proposal ${proposalId} ${status} by ${userId}`);
    return { outcome: status, proposalId };
  } catch (err) {
    transitionProposal(db, proposalId, 'approving', 'failed', { by: userId, error: err.message });
    await reply(buildDecisionMessage(proposal, { outcome: 'failed', userId, detail: err.message }));
    log.error(`Proposal ${proposalId} send failed: ${err.message}`);
    return { outcome: 'failed', proposalId };
  }
}