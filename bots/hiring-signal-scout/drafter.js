import { askClaude } from '@botarmy/core';

const SYSTEM_PROMPT = [
  'You write first-touch B2B outreach emails for an executive search and recruitment firm.',
  'Use only the facts provided. Never invent numbers, names, dates, clients, results or claims.',
  'If a fact is missing, leave it out rather than guessing. Never use placeholders like [Name].',
  'Respond with a single JSON object and nothing else: {"subject": string, "body": string}.',
].join(' ');

/** Facts the model may use, per signal type. */
function signalFacts(signalType, signal) {
  if (signalType === 'contract_award') {
    return {
      signal: 'public contract award',
      awardConfidence: signal.confidence, // "awarded" or "tenderer"
      buyer: signal.buyer,
      subject: signal.title,
      value: signal.value !== null && signal.value !== undefined ? `${signal.currency ?? ''} ${Math.round(signal.value).toLocaleString('en-GB')}`.trim() : null,
      awardDate: signal.award_date,
      noticeSource: signal.source,
    };
  }
  return {
    signal: 'hiring spike on careers page',
    newRolesLast7Days: signal.new_jobs,
    windowDays: signal.window_days,
    exampleTitles: JSON.parse(signal.sample_titles_json).slice(0, 3),
  };
}

function buildPrompt({ signalType, signal, company, contact, sender, template }) {
  const brief = Object.fromEntries(
    Object.entries(template).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('{offering}', sender.offering) : v]),
  );
  const wording = signalType === 'contract_award' && signal.confidence === 'tenderer'
    ? 'The notice lists them as a tenderer, not necessarily the winner: do NOT congratulate them on winning; say they are named on the award notice.'
    : null;

  return [
    'Write the email described below.',
    `Brief: ${JSON.stringify(brief)}`,
    `Facts: ${JSON.stringify(signalFacts(signalType, signal))}`,
    `Recipient: ${JSON.stringify({ firstName: contact?.full_name?.split(' ')[0] ?? null, title: contact?.title ?? null, company: company.name })}`,
    `Sender: ${JSON.stringify({ name: sender.name, firm: sender.firm, offering: sender.offering })}`,
    wording,
    `Keep the body under ${template.maxWords} words, plain text, no markdown. Greet the recipient by first name if given, otherwise use "Hello". Sign off with the sender's name and firm.`,
    'Subject: under 9 words, specific, no clickbait.',
  ].filter(Boolean).join('\n');
}

/** Extract the JSON object even if the model wrapped it in code fences or prose. */
export function parseDraft(text) {
  const stripped = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Draft was not JSON');
  const draft = JSON.parse(stripped.slice(start, end + 1));
  if (typeof draft.subject !== 'string' || typeof draft.body !== 'string') throw new Error('Draft missing subject/body');
  return { subject: draft.subject.trim(), body: draft.body.trim() };
}

/** Catch the failure modes worth blocking before a human even sees the draft. */
export function validateDraft(draft, { maxWords }) {
  const problems = [];
  if (/\[[^\]]{2,40}\]|\{\{.*?\}\}/.test(draft.body + draft.subject)) problems.push('contains a placeholder');
  const words = draft.body.split(/\s+/).filter(Boolean).length;
  if (words > maxWords * 1.4) problems.push(`too long (${words} words)`);
  if (draft.subject.length > 90) problems.push('subject too long');
  return problems;
}

/**
 * Draft one proposal. Returns { subject, body } with the configured opt-out
 * line appended, or throws if the model output is unusable.
 */
export async function draftProposal({ signalType, signal, company, contact, sender, templates, apiKey }) {
  const template = templates[signalType];
  if (!template) throw new Error(`No template for ${signalType}`);

  const text = await askClaude(buildPrompt({ signalType, signal, company, contact, sender, template }), apiKey, {
    system: SYSTEM_PROMPT,
    maxTokens: 700,
  });
  const draft = parseDraft(text);
  const problems = validateDraft(draft, template);
  if (problems.length) throw new Error(`Draft rejected: ${problems.join('; ')}`);

  const optOut = sender.optOutLine?.trim();
  const body = optOut && !draft.body.includes(optOut) ? `${draft.body}\n\n${optOut}` : draft.body;
  return { subject: draft.subject, body };
}