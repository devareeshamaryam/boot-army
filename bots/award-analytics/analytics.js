/**
 * B6 analytics: pure metrics, the recompute step, and the read-only lookup
 * other bots use.
 *
 *   import { openAwardLookup } from 'award-analytics/analytics';   // add "award-analytics": "*" to the bot's dependencies
 *   const awards = openAwardLookup({ dryRun });
 *   awards.buyerConcentration({ buyerName: 'Leeds City Council', cpv: '72000000' });
 *   awards.incumbent({ buyerName: 'Leeds City Council', cpv: '72000000' });
 *   awards.close();
 *
 * Metric definitions (deterministic; every one documented here):
 *   share          a supplier's wins ÷ the buyer's awards. A multi-supplier award gives each supplier 1/n.
 *   HHI            Σ (share × 100)² over suppliers: 10000 = one supplier wins everything.
 *   concentration  insufficient_data below minSample awards; otherwise unconcentrated < 1000,
 *                  moderate 1000–1800, high > 1800 (the 1,800 line follows the 2023 US Merger
 *                  Guidelines; used here as a heuristic for buyer stickiness, not a legal test).
 *   incumbent      the top supplier, if it has ≥ minWins wins AND ≥ minShare of the buyer's awards.
 *   values         mean/median over single-supplier contract awards with a published value, in
 *                  the buyer's most common currency. Framework ceilings never count as contract values.
 *   win rate       NOT computed: award notices name winners, not losing bidders. Win share and
 *                  contested wins (≥ 2 published tenderers) are reported instead.
 */
import { existsSync } from 'node:fs';
import { config, db as coreDb, match } from '@botarmy/core';

export const DB_NAME = 'award-analytics';
export const DEFAULTS = Object.freeze({ windowMonths: 24, minSample: 5, minIncumbentWins: 2, minIncumbentShare: 0.4, includeTenderers: false });
export const WIN_RATE_NOTE = 'Award notices name winners only, so a true win rate (wins ÷ bids) cannot be computed from them.';

/* ================================================================ keys */

const UK_ALIASES = new Set(['UK', 'GB', 'GBR', 'UNITED KINGDOM']);
export function countryOf(country) {
  const c = String(country ?? 'UK').trim().toUpperCase();
  return UK_ALIASES.has(c) ? 'UK' : c || 'UK';
}

/** Buyer identity shared with other bots: country + normalised name. */
export const buyerKeyOf = (name, country = 'UK') => `${countryOf(country)}:${match.nameNorm(name)}`;

/** First two digits of an 8-digit CPV code (its division), or null. */
export function cpvDivisionOf(code) {
  const m = String(code ?? '').match(/^(\d{2})\d{6}/);
  return m ? m[1] : null;
}

/* ============================================================ pure maths */

export function hhi(shares) {
  const valid = shares.filter((s) => Number.isFinite(s) && s > 0);
  if (!valid.length) return null;
  return Math.round(valid.reduce((sum, s) => sum + (s * 100) ** 2, 0));
}

export function concentrationLabel(hhiValue, awards, minSample = DEFAULTS.minSample) {
  if (hhiValue === null || awards < minSample) return 'insufficient_data';
  if (hhiValue < 1000) return 'unconcentrated';
  if (hhiValue <= 1800) return 'moderate';
  return 'high';
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * Metrics for one set of awards (one buyer, optionally one CPV division).
 * @param {{ suppliers: string[], value: number|null, currency: string|null, valueKind: string, tenderers: number|null }[]} awards
 */
export function computeMetrics(awards, opts = {}) {
  const { minSample, minIncumbentWins, minIncumbentShare } = { ...DEFAULTS, ...opts };
  const credit = new Map();
  const wins = new Map();
  for (const a of awards) {
    const n = a.suppliers.length;
    for (const s of a.suppliers) {
      credit.set(s, (credit.get(s) ?? 0) + 1 / n);
      wins.set(s, (wins.get(s) ?? 0) + 1);
    }
  }
  const total = awards.length;
  const ranked = [...credit].map(([key, c]) => ({ key, share: total ? c / total : 0, wins: wins.get(key) }))
    .sort((a, b) => b.share - a.share || a.key.localeCompare(b.key));
  const h = total ? hhi(ranked.map((r) => r.share)) : null;
  const top = ranked[0] ?? null;
  const incumbent = top && top.wins >= minIncumbentWins && top.share >= minIncumbentShare ? top : null;

  const priced = awards.filter((a) => a.suppliers.length === 1 && a.valueKind === 'contract' && Number.isFinite(a.value) && a.currency);
  const byCurrency = new Map();
  for (const a of priced) byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a.value]);
  const [currency, values] = [...byCurrency].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0] ?? [null, []];
  const tenderers = awards.map((a) => a.tenderers).filter((t) => Number.isInteger(t) && t > 0);

  return {
    awards: total,
    distinctSuppliers: ranked.length,
    hhi: h,
    concentration: concentrationLabel(h, total, minSample),
    topSupplier: top ? { key: top.key, share: round2(top.share), wins: top.wins } : null,
    incumbent: incumbent ? { key: incumbent.key, share: round2(incumbent.share), wins: incumbent.wins } : null,
    avgValue: round2(mean(values)),
    medianValue: round2(median(values)),
    valueCurrency: currency,
    valueN: values.length,
    avgTenderers: round2(mean(tenderers)),
    ranked: ranked.map((r) => ({ ...r, share: round2(r.share) })),
  };
}

/* ============================================================ recompute */

const monthsAgo = (now, months) => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

function loadAwards(db, buyerKey, since, includeTenderers) {
  const rows = db.prepare(`
    SELECT a.id, a.buyer_name, a.value, a.currency, a.value_kind, a.number_of_tenderers, a.cpv_division,
           GROUP_CONCAT(s.supplier_key, '\u0001') AS suppliers
    FROM contract_awards a JOIN award_suppliers s ON s.award_id = a.id
    WHERE a.buyer_key = ? AND COALESCE(a.award_date, substr(a.first_seen, 1, 10)) >= ?
      ${includeTenderers ? '' : "AND a.confidence = 'awarded'"}
    GROUP BY a.id`).all(buyerKey, since);
  return rows.map((r) => ({
    id: r.id, buyerName: r.buyer_name, value: r.value, currency: r.currency, valueKind: r.value_kind,
    tenderers: r.number_of_tenderers, division: r.cpv_division, suppliers: r.suppliers.split('\u0001'),
  }));
}

/**
 * Recompute buyer_analytics for the given buyers (all categories + each CPV division).
 * @returns {object[]} rows whose concentration label or incumbent changed (for events and the digest)
 */
export function recomputeBuyers(db, buyerKeys, { now = new Date().toISOString(), ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const since = monthsAgo(now, o.windowMonths);
  const get = db.prepare(`SELECT * FROM buyer_analytics WHERE buyer_key = ? AND cpv_division = ?`);
  const upsert = db.prepare(`
    INSERT INTO buyer_analytics (buyer_key, cpv_division, buyer_name, window_months, awards, distinct_suppliers, hhi, concentration,
      top_supplier_key, top_share, incumbent_supplier_key, incumbent_share, incumbent_wins, avg_value, median_value, value_currency,
      value_n, avg_tenderers, prev_hhi, prev_concentration, prev_incumbent_key, computed_at, changed_at, shift_notified_at)
    VALUES (@buyerKey, @division, @buyerName, @windowMonths, @awards, @distinctSuppliers, @hhi, @concentration,
      @topKey, @topShare, @incKey, @incShare, @incWins, @avgValue, @medianValue, @valueCurrency,
      @valueN, @avgTenderers, @prevHhi, @prevConcentration, @prevIncumbent, @now, @changedAt, @shiftNotified)
    ON CONFLICT (buyer_key, cpv_division) DO UPDATE SET buyer_name = excluded.buyer_name, window_months = excluded.window_months,
      awards = excluded.awards, distinct_suppliers = excluded.distinct_suppliers, hhi = excluded.hhi, concentration = excluded.concentration,
      top_supplier_key = excluded.top_supplier_key, top_share = excluded.top_share, incumbent_supplier_key = excluded.incumbent_supplier_key,
      incumbent_share = excluded.incumbent_share, incumbent_wins = excluded.incumbent_wins, avg_value = excluded.avg_value,
      median_value = excluded.median_value, value_currency = excluded.value_currency, value_n = excluded.value_n,
      avg_tenderers = excluded.avg_tenderers, prev_hhi = excluded.prev_hhi, prev_concentration = excluded.prev_concentration,
      prev_incumbent_key = excluded.prev_incumbent_key, computed_at = excluded.computed_at, changed_at = excluded.changed_at,
      shift_notified_at = excluded.shift_notified_at`);

  const changed = [];
  db.transaction(() => {
    for (const buyerKey of new Set(buyerKeys)) {
      const awards = loadAwards(db, buyerKey, since, o.includeTenderers);
      if (!awards.length) continue;
      const groups = new Map([['*', awards]]);
      for (const a of awards) if (a.division) groups.set(a.division, [...(groups.get(a.division) ?? []), a]);
      for (const [division, list] of groups) {
        const m = computeMetrics(list, o);
        const prev = get.get(buyerKey, division);
        const labelChanged = prev && prev.concentration !== m.concentration;
        const incumbentChanged = prev && (prev.incumbent_supplier_key ?? null) !== (m.incumbent?.key ?? null);
        const isShift = Boolean(prev) && (labelChanged || incumbentChanged) && m.concentration !== 'insufficient_data';
        const row = {
          buyerKey, division, buyerName: list[0].buyerName, windowMonths: o.windowMonths, awards: m.awards, distinctSuppliers: m.distinctSuppliers,
          hhi: m.hhi, concentration: m.concentration, topKey: m.topSupplier?.key ?? null, topShare: m.topSupplier?.share ?? null,
          incKey: m.incumbent?.key ?? null, incShare: m.incumbent?.share ?? null, incWins: m.incumbent?.wins ?? null,
          avgValue: m.avgValue, medianValue: m.medianValue, valueCurrency: m.valueCurrency, valueN: m.valueN, avgTenderers: m.avgTenderers,
          prevHhi: prev ? prev.hhi : null, prevConcentration: prev ? prev.concentration : null, prevIncumbent: prev ? prev.incumbent_supplier_key : null,
          now, changedAt: isShift ? now : prev?.changed_at ?? null, shiftNotified: isShift ? null : prev?.shift_notified_at ?? null,
        };
        upsert.run(row);
        if (isShift || !prev) changed.push({ ...row, isShift });
      }
    }
  })();
  return changed;
}

/** Recompute supplier_profiles for the given suppliers. */
export function recomputeSuppliers(db, supplierKeys, { now = new Date().toISOString() } = {}) {
  const wins = db.prepare(`
    SELECT a.buyer_key, a.buyer_name, a.cpv_division, a.value, a.currency, a.value_kind, a.number_of_tenderers, a.award_date, a.supplier_count, s.raw_name
    FROM award_suppliers s JOIN contract_awards a ON a.id = s.award_id
    WHERE s.supplier_key = ? AND a.confidence = 'awarded'`);
  const upsert = db.prepare(`
    INSERT INTO supplier_profiles (supplier_key, display_name, company_number, aliases, wins, contested_wins, avg_competitors, first_win, last_win,
      top_buyers, cpv_divisions, value_by_currency, updated_at)
    VALUES (@key, @name, @number, @aliases, @wins, @contested, @avgCompetitors, @first, @last, @buyers, @divisions, @values, @now)
    ON CONFLICT (supplier_key) DO UPDATE SET display_name = excluded.display_name, company_number = excluded.company_number,
      aliases = excluded.aliases, wins = excluded.wins, contested_wins = excluded.contested_wins, avg_competitors = excluded.avg_competitors,
      first_win = excluded.first_win, last_win = excluded.last_win, top_buyers = excluded.top_buyers, cpv_divisions = excluded.cpv_divisions,
      value_by_currency = excluded.value_by_currency, updated_at = excluded.updated_at`);

  db.transaction(() => {
    for (const key of new Set(supplierKeys)) {
      const rows = wins.all(key);
      if (!rows.length) continue;
      const names = [...new Set(rows.map((r) => r.raw_name))];
      const nameCount = new Map();
      rows.forEach((r) => nameCount.set(r.raw_name, (nameCount.get(r.raw_name) ?? 0) + 1));
      const tally = (k, label) => {
        const m = new Map();
        for (const r of rows) {
          if (!r[k]) continue;
          const e = m.get(r[k]) ?? { [label]: r[k], ...(k === 'buyer_key' ? { buyerName: r.buyer_name } : {}), wins: 0 };
          e.wins += 1;
          m.set(r[k], e);
        }
        return [...m.values()].sort((a, b) => b.wins - a.wins || String(a[label]).localeCompare(String(b[label]))).slice(0, 5);
      };
      const values = {};
      for (const r of rows) {
        if (r.supplier_count !== 1 || r.value_kind !== 'contract' || !Number.isFinite(r.value) || !r.currency) continue;
        values[r.currency] ??= { total: 0, n: 0 };
        values[r.currency].total += r.value;
        values[r.currency].n += 1;
      }
      const tenderers = rows.map((r) => r.number_of_tenderers).filter((t) => Number.isInteger(t) && t > 0);
      const dates = rows.map((r) => r.award_date).filter(Boolean).sort();
      upsert.run({
        key, name: [...nameCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
        number: key.startsWith('UK:') ? key.slice(3) : null, aliases: JSON.stringify(names.sort()),
        wins: rows.length, contested: tenderers.filter((t) => t >= 2).length, avgCompetitors: round2(mean(tenderers)),
        first: dates[0] ?? null, last: dates.at(-1) ?? null,
        buyers: JSON.stringify(tally('buyer_key', 'buyerKey')), divisions: JSON.stringify(tally('cpv_division', 'division')),
        values: JSON.stringify(values), now,
      });
    }
  })();
}

/**
 * Consistency check (plan acceptance: aggregates reconcile with raw counts).
 * @returns {string[]} problems; empty when consistent
 */
export function reconcile(db) {
  const problems = [];
  const orphan = db.prepare(`SELECT COUNT(*) FROM contract_awards a WHERE NOT EXISTS (SELECT 1 FROM award_suppliers s WHERE s.award_id = a.id)`).pluck().get();
  if (orphan) problems.push(`${orphan} award(s) have no supplier rows`);
  const badCount = db.prepare(`
    SELECT COUNT(*) FROM contract_awards a WHERE supplier_count != (SELECT COUNT(*) FROM award_suppliers s WHERE s.award_id = a.id)`).pluck().get();
  if (badCount) problems.push(`${badCount} award(s) whose supplier_count disagrees with their supplier rows`);
  const profileWins = db.prepare(`SELECT COALESCE(SUM(wins), 0) FROM supplier_profiles`).pluck().get();
  const rawWins = db.prepare(`
    SELECT COUNT(*) FROM award_suppliers s JOIN contract_awards a ON a.id = s.award_id
    WHERE a.confidence = 'awarded' AND s.supplier_key IN (SELECT supplier_key FROM supplier_profiles)`).pluck().get();
  if (profileWins !== rawWins) problems.push(`supplier_profiles wins (${profileWins}) ≠ raw award wins (${rawWins})`);
  return problems;
}

/* ================================================================ lookup */

const unavailable = (reason) => ({ available: false, reason });

/**
 * Read-only lookup over an open award-analytics database.
 * Every answer says whether data was available and why not, so callers never guess.
 */
export function createAwardLookup(db) {
  const row = db.prepare(`SELECT * FROM buyer_analytics WHERE buyer_key = ? AND cpv_division = ?`);
  const profile = db.prepare(`SELECT * FROM supplier_profiles WHERE supplier_key = ?`);
  const nameOf = (key) => (key ? profile.get(key)?.display_name ?? key : null);

  const pickRow = ({ buyerKey, buyerName, country, cpv }) => {
    const key = buyerKey ?? (buyerName ? buyerKeyOf(buyerName, country) : null);
    if (!key) return { error: unavailable('no buyer given') };
    const division = cpvDivisionOf(cpv);
    const specific = division ? row.get(key, division) : null;
    const chosen = specific && specific.concentration !== 'insufficient_data' ? specific : row.get(key, '*');
    if (!chosen) return { error: unavailable(`no awards recorded for buyer ${key}`) };
    return { key, chosen, scope: chosen.cpv_division === '*' ? 'all categories' : `CPV division ${chosen.cpv_division}` };
  };

  return {
    available: true,

    /** @returns {{ available, buyerKey?, scope?, awards?, hhi?, concentration?, topSupplier?, windowMonths?, computedAt?, reason? }} */
    buyerConcentration(query) {
      const r = pickRow(query);
      if (r.error) return r.error;
      const c = r.chosen;
      if (c.concentration === 'insufficient_data') return { ...unavailable(`only ${c.awards} award(s) for this buyer in ${c.window_months} months`), buyerKey: r.key, awards: c.awards };
      return {
        available: true, buyerKey: r.key, scope: r.scope, awards: c.awards, hhi: c.hhi, concentration: c.concentration,
        topSupplier: c.top_supplier_key ? { key: c.top_supplier_key, name: nameOf(c.top_supplier_key), share: c.top_share } : null,
        windowMonths: c.window_months, computedAt: c.computed_at,
      };
    },

    /** @returns {{ available, incumbent?: { key, name, wins, share } | null, scope?, reason? }} */
    incumbent(query) {
      const r = pickRow(query);
      if (r.error) return r.error;
      const c = r.chosen;
      if (c.concentration === 'insufficient_data') return { ...unavailable(`only ${c.awards} award(s) for this buyer in ${c.window_months} months`), buyerKey: r.key };
      return {
        available: true, buyerKey: r.key, scope: r.scope, awards: c.awards,
        incumbent: c.incumbent_supplier_key ? { key: c.incumbent_supplier_key, name: nameOf(c.incumbent_supplier_key), wins: c.incumbent_wins, share: c.incumbent_share } : null,
      };
    },

    supplierProfile(supplierKey) {
      const p = profile.get(supplierKey);
      if (!p) return unavailable(`no wins recorded for supplier ${supplierKey}`);
      return {
        available: true, key: p.supplier_key, name: p.display_name, companyNumber: p.company_number, wins: p.wins,
        contestedWins: p.contested_wins, avgCompetitors: p.avg_competitors, firstWin: p.first_win, lastWin: p.last_win,
        topBuyers: JSON.parse(p.top_buyers), cpvDivisions: JSON.parse(p.cpv_divisions), valueByCurrency: JSON.parse(p.value_by_currency),
        winRate: null, winRateNote: WIN_RATE_NOTE,
      };
    },

    /** Top suppliers by wins, optionally within one CPV division. */
    topSuppliers({ cpv, limit = 10 } = {}) {
      const division = cpvDivisionOf(cpv);
      const rows = division
        ? db.prepare(`SELECT s.supplier_key AS key, COUNT(*) AS wins FROM award_suppliers s JOIN contract_awards a ON a.id = s.award_id
            WHERE a.cpv_division = ? AND a.confidence = 'awarded' GROUP BY s.supplier_key ORDER BY wins DESC, key LIMIT ?`).all(division, limit)
        : db.prepare(`SELECT supplier_key AS key, wins FROM supplier_profiles ORDER BY wins DESC, supplier_key LIMIT ?`).all(limit);
      return rows.map((r) => ({ ...r, name: nameOf(r.key) }));
    },
  };
}

/**
 * Open the lookup for another bot. Read-only by use: it only SELECTs. In dry
 * runs it reads an in-memory copy. Returns an "unavailable" lookup (not an
 * error) when B6 has not run yet, so callers can report the factor as unknown.
 */
export function openAwardLookup({ dryRun = false, dataDir = config.dataDir() } = {}) {
  if (!existsSync(coreDb.dbPath(DB_NAME, dataDir))) {
    const reason = 'award-analytics has no data yet (run B6 first)';
    return {
      available: false, close() {},
      buyerConcentration: () => unavailable(reason), incumbent: () => unavailable(reason),
      supplierProfile: () => unavailable(reason), topSuppliers: () => [],
    };
  }
  const db = coreDb.connect(DB_NAME, { dryRun, dataDir });
  return { ...createAwardLookup(db), close: () => db.close() };
}