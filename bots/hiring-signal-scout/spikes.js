import { spikeStats, insertSpike } from './db.js';

/**
 * Decide whether a company's recent job openings are a spike.
 *
 *   newJobs   = non-baseline jobs first seen in the last `windowDays`
 *               (only roles matching spikes.roleFocus, if configured)
 *   baseline  = average new jobs per week over the previous `baselineWeeks`
 *   threshold = max(minNewJobs, ceil(baseline * multiplier))
 *
 * Until two weeks of history exist there is no trustworthy baseline, so the
 * bar is doubled (minNewJobs * 2) instead. Pure function: easy to unit test.
 */
export function evaluateSpike(stats, rules, now) {
  const { windowDays, baselineWeeks, multiplier, minNewJobs, cooldownDays } = rules;
  const newJobs = stats.newTitles.length;
  const baselineDays = Math.min(baselineWeeks * 7, Math.max(0, stats.trackedDays - windowDays));
  const baselineWeekly = baselineDays >= 7 ? stats.baselineCount / (baselineDays / 7) : null;

  const threshold = baselineWeekly === null
    ? minNewJobs * 2
    : Math.max(minNewJobs, Math.ceil(baselineWeekly * multiplier));

  const inCooldown = stats.lastSpikeAt
    && Date.parse(now) - Date.parse(stats.lastSpikeAt) < cooldownDays * 86_400_000;

  return {
    isSpike: newJobs >= threshold && !inCooldown,
    newJobs,
    baselineWeekly: baselineWeekly === null ? null : Math.round(baselineWeekly * 10) / 10,
    threshold,
    inCooldown: Boolean(inCooldown),
    sampleTitles: stats.newTitles.slice(0, 8),
  };
}

/** Evaluate and, if it is a spike, store it. Returns the spike id or null. */
export function detectAndStoreSpike(db, company, rules, now) {
  const stats = spikeStats(db, company.id, {
    now,
    windowDays: rules.windowDays,
    baselineWeeks: rules.baselineWeeks,
    focusOnly: Boolean(rules.focusPattern),
  });
  const verdict = evaluateSpike(stats, rules, now);
  if (!verdict.isSpike) return { spikeId: null, verdict };

  const spikeId = insertSpike(db, {
    companyId: company.id,
    windowDays: rules.windowDays,
    newJobs: verdict.newJobs,
    baselineWeekly: verdict.baselineWeekly,
    threshold: verdict.threshold,
    sampleTitles: verdict.sampleTitles,
  }, now);
  return { spikeId, verdict };
}