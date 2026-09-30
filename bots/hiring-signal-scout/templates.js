import { existsSync, readFileSync } from 'node:fs';

/**
 * Drafting briefs, one per signal type. These steer Claude; they are not
 * mail-merge text. Override any field by putting the same keys in
 * templates.json (path: HSS_TEMPLATES), e.g.
 *   { "hiring_spike": { "maxWords": 120, "callToAction": "..." } }
 */
export const DEFAULT_TEMPLATES = Object.freeze({
  contract_award: {
    goal: 'Offer help staffing the delivery team for a newly awarded public contract.',
    opening: 'Reference the specific award (buyer and subject) in the first sentence, factually.',
    valueProp: 'Explain in one or two sentences how {offering} helps teams scale quickly after a win.',
    callToAction: 'Ask for a 20-minute call in the next two weeks.',
    tone: 'Warm, concise, peer-to-peer. No hype, no flattery, no exclamation marks.',
    maxWords: 140,
  },
  hiring_spike: {
    goal: 'Offer support with an evident surge in hiring.',
    opening: 'Mention that their careers page shows a notable number of new roles recently, citing one or two example titles.',
    valueProp: 'Explain in one or two sentences how {offering} can take pressure off the in-house team.',
    callToAction: 'Offer a short call to compare notes on the roles that are hardest to fill.',
    tone: 'Warm, concise, peer-to-peer. No hype, no flattery, no exclamation marks.',
    maxWords: 130,
  },
});

export function loadTemplates(templatesPath) {
  if (!templatesPath || !existsSync(templatesPath)) return DEFAULT_TEMPLATES;
  const overrides = JSON.parse(readFileSync(templatesPath, 'utf8'));
  return Object.fromEntries(
    Object.entries(DEFAULT_TEMPLATES).map(([key, base]) => [key, { ...base, ...(overrides[key] ?? {}) }]),
  );
}