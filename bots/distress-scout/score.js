/**
 * B4 severity state machine. Pure and deterministic.
 *
 * A company's state is recomputed from its whole event history every time, so
 * the order notices ARRIVE in never matters: only their event dates do.
 *
 *   early_warning      → accounts / confirmation statement overdue, creditors'
 *                        meetings, qualifying decision procedures
 *   active_distress    → winding-up petition, proposed strike-off, LPA receiver
 *   severe_insolvency  → administration, winding-up order, creditors' voluntary
 *                        liquidation, administrative receiver, court liquidator
 *   dissolved          → terminal
 *
 * Resolving events close earlier signals: a dismissed petition closes the
 * petition; filed accounts close "accounts overdue". Severe signals are never
 * auto-resolved. The plan's stages (EARLY / PRE_DISSOLUTION / FORMAL) are kept
 * alongside the tiers for spine consumers.
 */

export const TIERS = Object.freeze(['none', 'early_warning', 'active_distress', 'severe_insolvency', 'dissolved']);
export const TIER_LABEL = Object.freeze({
  none: 'No open signals', early_warning: 'Early warning', active_distress: 'Active distress',
  severe_insolvency: 'Severe insolvency', dissolved: 'Dissolved',
});
export const tierRank = (t) => TIERS.indexOf(t);

/**
 * Canonical event types. `resolves` lists the types this event closes.
 * `ref` is the general statutory basis, shown in the digest for orientation only.
 */
export const EVENT_TYPES = Object.freeze({
  accounts_overdue: { tier: 'early_warning', stage: 'EARLY', weight: 10, label: 'Accounts overdue', ref: 'Companies Act 2006 s.441' },
  confirmation_overdue: { tier: 'early_warning', stage: 'EARLY', weight: 6, label: 'Confirmation statement overdue', ref: 'Companies Act 2006 s.853A' },
  creditors_meeting: { tier: 'early_warning', stage: 'EARLY', weight: 12, label: "Creditors' meeting / decision procedure", ref: 'Insolvency (England and Wales) Rules 2016' },
  ccj: { tier: 'early_warning', stage: 'EARLY', weight: 8, label: 'County court judgment', ref: null },
  strike_off_proposed: { tier: 'active_distress', stage: 'PRE_DISSOLUTION', weight: 18, label: 'Proposed compulsory strike-off', ref: 'Companies Act 2006 s.1000' },
  winding_up_petition: { tier: 'active_distress', stage: 'FORMAL', weight: 25, label: 'Winding-up petition', ref: 'Insolvency Act 1986 s.124' },
  receiver_appointed: { tier: 'active_distress', stage: 'FORMAL', weight: 22, label: 'Receiver appointed (fixed charge / LPA)', ref: 'Law of Property Act 1925 s.109' },
  administrative_receiver: { tier: 'severe_insolvency', stage: 'FORMAL', weight: 30, label: 'Administrative receiver appointed', ref: 'Insolvency Act 1986 Part III' },
  administration: { tier: 'severe_insolvency', stage: 'FORMAL', weight: 32, label: 'Administration', ref: 'Insolvency Act 1986 Sch. B1' },
  winding_up_order: { tier: 'severe_insolvency', stage: 'FORMAL', weight: 34, label: 'Winding-up order', ref: 'Insolvency Act 1986 s.125' },
  creditors_voluntary_liquidation: { tier: 'severe_insolvency', stage: 'FORMAL', weight: 30, label: "Creditors' voluntary liquidation", ref: 'Insolvency Act 1986 s.84' },
  liquidator_appointed: { tier: 'severe_insolvency', stage: 'FORMAL', weight: 28, label: 'Liquidator appointed', ref: 'Insolvency Act 1986' },
  voluntary_arrangement: { tier: 'active_distress', stage: 'FORMAL', weight: 20, label: 'Company voluntary arrangement', ref: 'Insolvency Act 1986 Part I' },
  moratorium: { tier: 'active_distress', stage: 'FORMAL', weight: 20, label: 'Moratorium', ref: 'Insolvency Act 1986 Part A1' },
  dissolved: { tier: 'dissolved', stage: 'FORMAL', weight: 0, label: 'Dissolved', ref: null },

  // Resolving events (no tier of their own).
  petition_dismissed: { resolves: ['winding_up_petition'], label: 'Winding-up petition dismissed', ref: null },
  accounts_filed: { resolves: ['accounts_overdue'], label: 'Overdue accounts filed', ref: null },
  confirmation_filed: { resolves: ['confirmation_overdue'], label: 'Overdue confirmation statement filed', ref: null },
  strike_off_discontinued: { resolves: ['strike_off_proposed'], label: 'Strike-off action discontinued', ref: null },
});

/**
 * Gazette corporate-insolvency notice codes (thegazette.co.uk/noticecodes).
 * Members' voluntary liquidation (2431–2435) is a SOLVENT wind-down: excluded.
 * Codes not listed are ignored, never guessed.
 */
export const GAZETTE_CODES = Object.freeze({
  2409: 'creditors_meeting',          // qualifying decision procedure
  2410: 'administration',             // appointment of administrators
  2411: 'administration',             // administration orders
  2412: 'creditors_meeting',          // meetings of creditors (administration)
  2414: 'creditors_meeting',          // deemed consent (administration)
  2421: 'administrative_receiver',    // appointment of administrative receivers
  2423: 'receiver_appointed',         // appointment of receivers
  2441: 'creditors_voluntary_liquidation', // resolution for winding up (CVL)
  2442: 'creditors_meeting',          // meetings of creditors (CVL)
  2443: 'liquidator_appointed',       // appointment of liquidators (CVL)
  2446: 'creditors_meeting',          // notice to creditors (CVL)
  2447: 'creditors_meeting',          // deemed consent (CVL)
  2450: 'winding_up_petition',        // petitions to wind up (companies)
  2452: 'winding_up_order',           // winding-up order (companies)
  2454: 'liquidator_appointed',       // appointment of liquidators (court)
  2461: 'petition_dismissed',         // dismissal of winding-up petition
});
export const SOLVENT_GAZETTE_CODES = Object.freeze([2431, 2432, 2433, 2434, 2435]);

/** Companies House insolvency case types → event types. Unknown types are reported, not mapped. */
export const CH_CASE_TYPES = Object.freeze({
  'compulsory-liquidation': 'winding_up_order',
  'creditors-voluntary-liquidation': 'creditors_voluntary_liquidation',
  'in-administration': 'administration',
  'administration-order': 'administration',
  'administrative-receiver': 'administrative_receiver',
  'receiver-manager': 'receiver_appointed',
  receivership: 'receiver_appointed',
  'corporate-voluntary-arrangement': 'voluntary_arrangement',
  'corporate-voluntary-arrangement-moratorium': 'moratorium',
  moratorium: 'moratorium',
  'members-voluntary-liquidation': null, // solvent: deliberately ignored
});

/* --------------------------------------------------------------- engine */

const byDate = (a, b) => String(a.eventDate ?? '').localeCompare(String(b.eventDate ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''));

/**
 * Compute a company's state from all its events.
 * @param {{ id?: any, eventType: string, eventDate: string|null }[]} events
 * @returns {{ tier: string, stage: string|null, severity: number, open: object[], reasons: object }}
 */
export function evaluateState(events) {
  const open = new Map(); // eventType → latest open event
  let dissolved = null;
  for (const e of [...events].filter((x) => EVENT_TYPES[x.eventType]).sort(byDate)) {
    const def = EVENT_TYPES[e.eventType];
    if (def.resolves) {
      for (const t of def.resolves) {
        const o = open.get(t);
        // A resolution only closes signals dated on or before it (out-of-order safe).
        if (o && String(o.eventDate ?? '') <= String(e.eventDate ?? '')) open.delete(t);
      }
      continue;
    }
    if (e.eventType === 'dissolved') { dissolved = e; continue; }
    open.set(e.eventType, e);
  }

  if (dissolved) {
    return { tier: 'dissolved', stage: 'FORMAL', severity: 0, open: [], reasons: { dissolvedOn: dissolved.eventDate ?? null } };
  }
  const signals = [...open.values()].map((e) => ({ ...e, ...EVENT_TYPES[e.eventType] }));
  if (!signals.length) return { tier: 'none', stage: null, severity: 0, open: [], reasons: { note: 'no open distress signals' } };

  const top = signals.reduce((a, b) => (tierRank(b.tier) > tierRank(a.tier) || (b.tier === a.tier && b.weight > a.weight) ? b : a));
  return {
    tier: top.tier,
    stage: top.stage,
    severity: severityScore(signals, top.tier),
    open: signals.map((s) => ({ eventType: s.eventType, eventDate: s.eventDate ?? null, tier: s.tier })),
    reasons: {
      driver: { eventType: top.eventType, label: top.label, eventDate: top.eventDate ?? null },
      corroborating: signals.filter((s) => s !== top).map((s) => s.eventType).sort(),
    },
  };
}

const TIER_BASE = Object.freeze({ early_warning: 20, active_distress: 45, severe_insolvency: 70 });

/**
 * 0–100 within-tier severity: tier base + strongest signal weight (scaled) +
 * up to 10 for corroborating open signals. Tiers never overlap: an early
 * warning can never outrank active distress.
 */
export function severityScore(signals, tier) {
  const base = TIER_BASE[tier] ?? 0;
  const ceiling = tier === 'severe_insolvency' ? 100 : (TIER_BASE[TIERS[tierRank(tier) + 1]] ?? 100) - 1;
  const inTier = signals.filter((s) => s.tier === tier);
  const strongest = Math.max(...inTier.map((s) => s.weight));
  const corroboration = Math.min(10, (signals.length - 1) * 4);
  return Math.min(ceiling, base + Math.round(strongest / 2) + corroboration);
}

/** "escalation" | "de-escalation" | "unchanged" */
export function transitionKind(fromTier, toTier) {
  const d = tierRank(toTier) - tierRank(fromTier ?? 'none');
  return d > 0 ? 'escalation' : d < 0 ? 'de-escalation' : 'unchanged';
}

/* ----------------------------------------------------------------- tags */

/**
 * Tag rules from config. Each rule needs an id and a tag, and matches when
 * every condition it sets holds:
 *   { id, tag, tiers?: [tier], eventTypes?: [type among open signals],
 *     sicPrefixes?: [prefix], nameKeywords?: [word] }
 * @returns {{ tag: string, ruleHit: string }[]}  one entry per tag (first rule wins), sorted
 */
export function applyTagRules(state, company, rules) {
  const openTypes = new Set(state.open.map((o) => o.eventType));
  const name = String(company.name ?? '').toLowerCase();
  const sic = (company.sicCodes ?? []).map(String);
  const tags = new Map();
  for (const r of rules) {
    if (tags.has(r.tag)) continue;
    if (r.tiers?.length && !r.tiers.includes(state.tier)) continue;
    if (r.eventTypes?.length && !r.eventTypes.some((t) => openTypes.has(t))) continue;
    if (r.sicPrefixes?.length && !sic.some((c) => r.sicPrefixes.some((p) => c.startsWith(p)))) continue;
    if (r.nameKeywords?.length && !r.nameKeywords.some((k) => name.includes(k.toLowerCase()))) continue;
    tags.set(r.tag, { tag: r.tag, ruleHit: r.id });
  }
  return [...tags.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}