/**
 * Decision-maker lookup, called only when a signal fires.
 *
 *   1. Apollo People API Search   POST /api/v1/mixed_people/api_search  (no credits; master key;
 *                                 returns ids, titles, obfuscated surnames, no emails)
 *   2. Apollo People Enrichment   POST /api/v1/people/match {id}        (1 credit; business email)
 *   3. Lusha Person Enrichment    GET  /v2/person?firstName&lastName&companyDomain  (fallback if
 *                                 Apollo has no email; phones flagged do-not-call are dropped)
 *
 * Results are cached per company (contacts table) so repeat signals don't
 * spend credits, and a per-run credit budget caps spend.
 */
import { getCachedContacts, saveContact } from './db.js';
import { getJson, postJson, HttpError } from './harvesters/http.js';

const APOLLO = 'https://api.apollo.io/api/v1';
const LUSHA = 'https://api.lusha.com';
const SENIORITIES = ['c_suite', 'vp', 'head', 'director'];

export function createCreditBudget(limit) {
  let used = 0;
  return {
    take() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    get used() {
      return used;
    },
  };
}

/** Lower index = better match for the configured title priority list. */
function titleRank(title, priorities) {
  const t = String(title ?? '').toLowerCase();
  const i = priorities.findIndex((p) => t.includes(p.toLowerCase()));
  return i === -1 ? priorities.length : i;
}

async function apolloSearch(domain, titles, apiKey) {
  const body = await postJson(`${APOLLO}/mixed_people/api_search`, {
    q_organization_domains_list: [domain],
    person_titles: titles,
    include_similar_titles: true,
    person_seniorities: SENIORITIES,
    per_page: 10,
    page: 1,
  }, { headers: { 'x-api-key': apiKey, 'Cache-Control': 'no-cache' } });
  return body?.people ?? [];
}

async function apolloEnrich(personId, apiKey) {
  const body = await postJson(`${APOLLO}/people/match`, { id: personId, reveal_personal_emails: false }, {
    headers: { 'x-api-key': apiKey, 'Cache-Control': 'no-cache' },
  });
  return body?.person ?? null;
}

async function lushaEnrich({ firstName, lastName, domain }, apiKey) {
  const qs = new URLSearchParams({ firstName, lastName, companyDomain: domain });
  try {
    const body = await getJson(`${LUSHA}/v2/person?${qs}`, { headers: { api_key: apiKey } });
    return body?.contact?.data ?? null;
  } catch (err) {
    // 404: not found. 451: Lusha declines under GDPR. Neither is a run failure.
    if (err instanceof HttpError && (err.status === 404 || err.status === 451)) return null;
    throw err;
  }
}

const lushaEmail = (data) =>
  data?.emailAddresses?.find((e) => e.emailType === 'work')?.address ?? data?.emailAddresses?.[0]?.address ?? null;

const lushaPhone = (data) => data?.phoneNumbers?.find((p) => p.doNotCall === false)?.number ?? null;

/**
 * @returns {Promise<object[]>} contact rows (best first), possibly empty.
 */
export async function findDecisionMakers(db, company, {
  titles, apolloApiKey, lushaApiKey, budget, now, cacheDays = 90, maxContacts = 2, log,
}) {
  const cached = getCachedContacts(db, company.id, { now, cacheDays });
  if (cached.length) return cached;
  if (!company.domain) {
    log.warn(`${company.id}: no domain in watchlist; cannot look up contacts`);
    return [];
  }
  if (!apolloApiKey) {
    log.warn(`${company.id}: APOLLO_API_KEY not set; contact lookup skipped`);
    return [];
  }

  const people = (await apolloSearch(company.domain, titles, apolloApiKey))
    .sort((a, b) => titleRank(a.title, titles) - titleRank(b.title, titles))
    .slice(0, maxContacts);

  const saved = [];
  for (const candidate of people) {
    if (!budget.take()) {
      log.warn(`Enrichment credit budget reached; ${company.id} partially enriched`);
      break;
    }
    const person = await apolloEnrich(candidate.id, apolloApiKey);
    if (!person) continue;

    let email = person.email && !/email_not_unlocked/i.test(person.email) ? person.email : null;
    let emailStatus = email ? person.email_status ?? null : null;
    let phone = null;
    let source = 'apollo';

    if (!email && lushaApiKey && person.first_name && person.last_name && budget.take()) {
      const data = await lushaEnrich({ firstName: person.first_name, lastName: person.last_name, domain: company.domain }, lushaApiKey);
      if (data) {
        email = lushaEmail(data);
        emailStatus = email ? 'lusha' : null;
        phone = lushaPhone(data);
        source = 'lusha';
      }
    }

    saved.push(saveContact(db, {
      companyId: company.id,
      source,
      externalId: String(candidate.id),
      fullName: person.name ?? [person.first_name, person.last_name].filter(Boolean).join(' '),
      title: person.title ?? candidate.title ?? null,
      email,
      emailStatus,
      phone,
      linkedinUrl: person.linkedin_url ?? null,
    }, now));
  }

  return saved.sort((a, b) => Number(!a.email) - Number(!b.email));
}