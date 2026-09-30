/**
 * Slack Block Kit messages for approve-to-send.
 *
 * Each proposal is posted as its own message so that, when someone clicks
 * Approve or Reject, server.js can replace exactly that message via the
 * interaction's response_url. Buttons only work if SLACK_WEBHOOK_URL belongs to
 * a Slack app with Interactivity enabled and pointed at server.js.
 */
import { sendSlackAlert, withRetry } from '@botarmy/core';

export const ACTION_APPROVE = 'hss_approve';
export const ACTION_REJECT = 'hss_reject';

const SECTION_LIMIT = 3000;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, max = SECTION_LIMIT) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const plain = (s, max = 150) => clip(String(s ?? ''), max);

const SIGNAL_LABEL = {
  contract_award: ':trophy: Contract award',
  hiring_spike: ':chart_with_upwards_trend: Hiring spike',
};

function contactLine(p) {
  if (!p.contact_name) return '_No decision-maker found; add one manually before sending._';
  const email = p.contact_email ? `\`${esc(p.contact_email)}\`${p.contact_email_status ? ` (${esc(p.contact_email_status)})` : ''}` : '_no email found_';
  const li = p.contact_linkedin && /^https:\/\//.test(p.contact_linkedin) ? ` · <${p.contact_linkedin}|LinkedIn>` : '';
  return `*To:* ${esc(p.contact_name)}${p.contact_title ? `, ${esc(p.contact_title)}` : ''} · ${email}${li}`;
}

/**
 * @param {object} proposal  Row from listUnpostedProposals / getProposal.
 * @param {string} signalSummary  One-line mrkdwn description of the signal.
 */
export function buildProposalMessage(proposal, signalSummary) {
  const canSend = Boolean(proposal.contact_email);
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: clip(`${SIGNAL_LABEL[proposal.signal_type]} · *${esc(proposal.company_name)}*\n${signalSummary}`),
      },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: clip(contactLine(proposal), 2000) }] },
    { type: 'section', text: { type: 'mrkdwn', text: clip(`*Subject:* ${esc(proposal.subject)}\n\n${esc(proposal.body)}`) } },
  ];

  const buttons = [];
  if (canSend) {
    buttons.push({
      type: 'button',
      action_id: ACTION_APPROVE,
      text: { type: 'plain_text', text: 'Approve & send' },
      style: 'primary',
      value: String(proposal.id),
      confirm: {
        title: { type: 'plain_text', text: 'Send this email?' },
        text: { type: 'plain_text', text: plain(`It will go to ${proposal.contact_email}.`, 300) },
        confirm: { type: 'plain_text', text: 'Send' },
        deny: { type: 'plain_text', text: 'Cancel' },
      },
    });
  }
  buttons.push({
    type: 'button',
    action_id: ACTION_REJECT,
    text: { type: 'plain_text', text: 'Reject' },
    style: 'danger',
    value: String(proposal.id),
  });

  blocks.push({ type: 'actions', block_id: `proposal_${proposal.id}`, elements: buttons });

  return {
    text: `Proposal for ${proposal.company_name}: ${proposal.subject}`,
    blocks,
  };
}

/** Replacement message after a decision (buttons removed). */
export function buildDecisionMessage(proposal, { outcome, userId, detail }) {
  const icon = { sent: ':white_check_mark:', approved: ':white_check_mark:', rejected: ':no_entry_sign:', failed: ':x:' }[outcome] ?? ':grey_question:';
  const verb = {
    sent: 'Approved and sent',
    approved: 'Approved (send it manually; transport is "manual")',
    rejected: 'Rejected',
    failed: 'Approved, but sending failed',
  }[outcome] ?? outcome;

  return {
    replace_original: true,
    text: `${verb}: ${proposal.company_name}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: clip(`${icon} *${verb}* by <@${userId}> · *${esc(proposal.company_name)}*\n*Subject:* ${esc(proposal.subject)}${detail ? `\n_${esc(detail)}_` : ''}`),
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: clip(esc(proposal.body)) } },
    ],
  };
}

export function buildSummaryMessage({ date, stats, warnings = [] }) {
  const lines = [
    `*Hiring-Signal Scout · ${date}*`,
    `${stats.newAwards ?? 0} new awards at watchlist companies · ${stats.spikes ?? 0} hiring spikes · ${stats.proposals ?? 0} proposals awaiting approval`,
    `_${stats.companiesPolled ?? 0} job boards polled · ${stats.creditsUsed ?? 0} enrichment credits used_`,
  ];
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (warnings.length) {
    const shown = warnings.slice(0, 12).map((w) => `• ${esc(w)}`).join('\n');
    const more = warnings.length > 12 ? `\n…and ${warnings.length - 12} more` : '';
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`:warning: ${shown}${more}`) }] });
  }
  return { text: lines[1], blocks };
}

/** Post summary then one message per proposal. Returns ids that were posted. */
export async function postDigest(webhookUrl, { summary, proposals }) {
  await withRetry(() => sendSlackAlert(webhookUrl, summary), 3, 2000);
  const posted = [];
  for (const { id, message } of proposals) {
    await withRetry(() => sendSlackAlert(webhookUrl, message), 3, 2000);
    posted.push(id);
  }
  return posted;
}