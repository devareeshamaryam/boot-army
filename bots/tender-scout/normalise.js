/**
 * OCDS release -> TenderScout rows. Pure functions, no I/O.
 *
 * Built against real Contracts Finder releases (test/fixtures). Every field is
 * optional in practice, so nothing here assumes a field exists; a missing value
 * becomes null, never 0 or ''.
 */
import { toRegion } from './regions.js';

export const CF_NOTICE_URL = 'https://www.contractsfinder.service.gov.uk/Notice/';
export const FTS_NOTICE_URL = 'https://www.find-tender.service.gov.uk/Notice/';

/** Amounts at or below this are placeholders (real data has £1 tenders and £0 awards). */
export const PLACEHOLDER_MAX = 1;

/** Any ISO-ish date string -> UTC ISO, or null. Contracts Finder mixes "+01:00" and "Z". */
export function toUtc(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Collapse whitespace and strip zero-width characters (seen at the start of real titles). */
export function cleanText(value) {
  if (value == null) return null;
  const s = String(value).replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  return s || null;
}

export const keyOf = (name) => cleanText(name)?.toLowerCase() ?? null;

/** "<notice-guid>-916299" -> 916299. Contracts Finder appends a global sequence to each release id. */
export function releaseSeq(releaseId) {
  const m = String(releaseId ?? '').match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** { amount, currency } with placeholder amounts reported as null (the caller flags it). */
function money(value) {
  const amount = typeof value?.amount === 'number' && Number.isFinite(value.amount) ? value.amount : null;
  if (amount == null) return { amount: null, currency: null, placeholder: false };
  if (amount <= PLACEHOLDER_MAX) return { amount: null, currency: null, placeholder: true };
  return { amount, currency: value.currency ?? null, placeholder: false };
}

/** CPV codes from tender.classification, items[].classification and additionalClassifications (CPV scheme only). */
function cpvCodes(tender) {
  const all = [tender?.classification, ...(tender?.items ?? []).flatMap((i) => [i?.classification, ...(i?.additionalClassifications ?? [])])];
  const codes = all.filter((c) => c?.id && (!c.scheme || c.scheme.toUpperCase() === 'CPV')).map((c) => String(c.id).trim());
  return [...new Set(codes)];
}

/**
 * Delivery regions: `raw` = every non-empty value as published (Contracts Finder gives names,
 * Find a Tender NUTS codes; real data has many "" entries), `regions` = the ones we recognise,
 * as profile names. Raw values we can't map are kept so scoring can say "not recognised".
 */
export function regionsOf(tender) {
  const raw = [...new Set((tender?.items ?? []).flatMap((i) => (i?.deliveryAddresses ?? []).map((d) => cleanText(d?.region))).filter(Boolean))];
  return { regions: [...new Set(raw.map(toRegion).filter(Boolean))], raw };
}

const docUrl = (docs, type) => (docs ?? []).find((d) => d?.documentType === type && d.url)?.url ?? null;

/**
 * What differs between sources. Release ids:
 *   Contracts Finder  "<notice-guid>-916299"  (global sequence at the end)
 *   Find a Tender     "093058-2026"           (notice number - year)
 */
export const SOURCES = {
  'contracts-finder': {
    seq: releaseSeq,
    noticeUrl: (id) => {
      const guid = String(id ?? '').replace(/-\d+$/, '');
      return /^[0-9a-f-]{36}$/i.test(guid) ? CF_NOTICE_URL + guid : null;
    },
  },
  'find-a-tender': {
    seq: (id) => {
      const m = String(id ?? '').match(/^(\d+)-(\d{4})$/);
      return m ? Number(m[2]) * 1_000_000 + Number(m[1]) : 0;
    },
    noticeUrl: (id) => (/^\d+-\d{4}$/.test(String(id ?? '')) ? FTS_NOTICE_URL + id : null),
  },
};

const sourceOf = (source) => {
  const s = SOURCES[source];
  if (!s) throw new Error(`Unknown source "${source}"`);
  return s;
};

/** Public notice link: the notice document if present, else built from the release id. */
function noticeLink(release, docs, type, src) {
  return docUrl(docs, type) ?? docUrl(release.tender?.documents, type) ?? docUrl(release.tender?.documents, 'tenderNotice') ?? src.noticeUrl(release.id);
}

const buyerOf = (release) => {
  const party = (release.parties ?? []).find((p) => p?.roles?.includes('buyer'));
  const name = cleanText(release.buyer?.name ?? party?.name);
  return { buyer_id: release.buyer?.id ?? party?.id ?? null, buyer_name: name, buyer_key: keyOf(name) };
};

/** tender.value, else the sum of lot values when every lot has one (Find a Tender splits by lot). */
function tenderValue(t) {
  if (t.value?.amount != null) return money(t.value);
  const lots = t.lots ?? [];
  if (lots.length && lots.every((l) => typeof l?.value?.amount === 'number')) {
    return money({ amount: lots.reduce((sum, l) => sum + l.value.amount, 0), currency: lots[0].value.currency });
  }
  return money(null);
}

/** tenderPeriod.endDate, else the earliest lot deadline. */
function deadlineOf(t) {
  const own = toUtc(t.tenderPeriod?.endDate);
  if (own) return own;
  const lots = (t.lots ?? []).map((l) => toUtc(l?.tenderPeriod?.endDate)).filter(Boolean).sort();
  return lots[0] ?? null;
}

/**
 * @param {object} release  OCDS release of tender kind (tender, tenderUpdate, tenderAmendment, tenderCancellation)
 * @param {{ source?: string }} [options]
 * @returns {object|null} notices row (see migrations/001_init.sql), or null if the release has no ocid/id
 */
export function normaliseTender(release, { source = 'contracts-finder' } = {}) {
  if (!release?.ocid || !release?.id) return null;
  const src = sourceOf(source);
  const t = release.tender ?? {};
  const value = tenderValue(t);
  const where = regionsOf(t);
  const tags = release.tag ?? [];
  return {
    ocid: release.ocid,
    source,
    release_id: release.id,
    release_date: toUtc(release.date) ?? toUtc(t.datePublished) ?? '',
    release_seq: src.seq(release.id),
    tag: tags.join(','),
    // A cancellation notice without a status still closes the tender.
    status: t.status ?? (tags.includes('tenderCancellation') ? 'cancelled' : null),
    title: cleanText(t.title),
    description: cleanText(t.description),
    ...buyerOf(release),
    value_amount: value.amount,
    value_currency: value.currency,
    value_placeholder: value.placeholder, // lets scoring say "placeholder" rather than "not published"
    deadline: deadlineOf(t),
    published_at: toUtc(t.datePublished) ?? toUtc(release.date),
    cpv_codes: cpvCodes(t),
    regions: where.regions,
    regions_raw: where.raw,
    procurement_method: cleanText(t.procurementMethodDetails ?? t.procurementMethod),
    link: noticeLink(release, null, 'tenderNotice', src),
  };
}

/**
 * The supplier's best identifier. Companies House (GB-COH) wins wherever it appears
 * (identifier or additionalIdentifiers, as Find a Tender sometimes puts it there),
 * else the main identifier as published (e.g. GB-PPON). An id published without a
 * scheme is kept with scheme null: we don't guess that it is a company number.
 */
export function supplierIdentifier(party) {
  const all = [party?.identifier, ...(party?.additionalIdentifiers ?? [])].filter((i) => i?.id);
  const pick = all.find((i) => i.scheme === 'GB-COH') ?? all[0];
  return pick ? { scheme: pick.scheme ?? null, id: String(pick.id) } : { scheme: null, id: null };
}

/**
 * One row per award per supplier. Identifiers live on parties[] (awards[].suppliers[] has
 * only {id, name}). Value and date fall back to the award's contract (Find a Tender puts
 * them on contracts[] linked by awardID).
 * @returns {object[]} awards rows (see migrations/001_init.sql)
 */
export function extractAwards(release, { source = 'contracts-finder' } = {}) {
  if (!release?.ocid || !release?.id) return [];
  const src = sourceOf(source);
  const t = release.tender ?? {};
  const parties = new Map((release.parties ?? []).filter((p) => p?.id).map((p) => [p.id, p]));
  const base = {
    ocid: release.ocid,
    source,
    release_id: release.id,
    release_date: toUtc(release.date) ?? '',
    release_seq: src.seq(release.id),
    ...buyerOf(release),
    title: cleanText(t.title),
    category: t.mainProcurementCategory ?? null,
    cpv_codes: cpvCodes(t),
  };

  const rows = [];
  (release.awards ?? []).forEach((award, i) => {
    const contract = (release.contracts ?? []).find((c) => c?.awardID && c.awardID === award?.id);
    const value = money(award?.value ?? contract?.value);
    for (const s of award?.suppliers ?? []) {
      const name = cleanText(s?.name ?? parties.get(s?.id)?.name);
      const supplierKey = s?.id ?? keyOf(name);
      if (!supplierKey) continue; // nothing to identify the winner by
      const ident = supplierIdentifier(parties.get(s?.id));
      rows.push({
        ...base,
        award_id: award?.id ?? `${release.ocid}#${i + 1}`,
        status: award?.status ?? null,
        supplier_key: supplierKey,
        supplier_name: name,
        supplier_scheme: ident.scheme,
        supplier_identifier: ident.id,
        value_amount: value.amount,
        value_currency: value.currency,
        award_date: toUtc(award?.date) ?? toUtc(contract?.dateSigned),
        link: noticeLink(release, award?.documents, 'awardNotice', src),
      });
    }
  });
  return rows;
}
