/**
 * FCA Financial Services Register API (official, free, key required).
 *   Sign up: https://register.fca.org.uk/Developer/s/
 *   Auth:    X-Auth-Email + X-Auth-Key headers (FCA_API_EMAIL, FCA_API_KEY)
 *   Limit:   50 requests / 10 seconds; we stay well under it.
 *
 * Roster source: GET /Firm/{FRN}/CF, the firm's controlled functions. Its
 * "Current" section lists every individual with a current role (SMFs,
 * certification functions, etc.) together with the role's effective date.
 * A day-over-day diff of that list is the approved/certified persons delta.
 */
import { createThrottle, fetchJson, SourceConfigError, toIsoDate } from './http.js';

const BASE_URL = 'https://register.fca.org.uk/services/V0.1';
const throttle = createThrottle(250); // 40 req / 10 s ceiling
const MAX_PAGES = 50;

function authHeaders(env) {
  if (!env.FCA_API_EMAIL || !env.FCA_API_KEY) {
    throw new SourceConfigError('FCA: set FCA_API_EMAIL and FCA_API_KEY in .env');
  }
  return { 'X-Auth-Email': env.FCA_API_EMAIL, 'X-Auth-Key': env.FCA_API_KEY };
}

async function call(pathname, env) {
  await throttle();
  return fetchJson(`${BASE_URL}${pathname}`, { headers: authHeaders(env) });
}

/**
 * Fetch every page of an endpoint. If the API reports more pages than one but
 * ignores the page parameter, fail loudly: a silently truncated roster would
 * look like a wave of leavers.
 */
async function callAllPages(pathname, env) {
  const first = await call(pathname, env);
  const pages = [first];
  const info = first?.ResultInfo;
  const total = Number(info?.total_count);
  const perPage = Number(info?.per_page);

  if (Number.isFinite(total) && Number.isFinite(perPage) && perPage > 0 && total > perPage) {
    const pageCount = Math.min(Math.ceil(total / perPage), MAX_PAGES);
    const firstJson = JSON.stringify(first.Data);
    for (let page = 2; page <= pageCount; page++) {
      const next = await call(`${pathname}?page=${page}`, env);
      if (JSON.stringify(next?.Data) === firstJson) {
        throw new Error(`FCA ${pathname}: pagination not honoured (page ${page} repeated page 1)`);
      }
      pages.push(next);
    }
  }
  return pages.flatMap((p) => (Array.isArray(p?.Data) ? p.Data : []));
}

const irnFromUrl = (url) => String(url ?? '').match(/\/Individuals\/([A-Z0-9]+)/i)?.[1]?.toUpperCase() ?? null;
const frnFromUrl = (url) => String(url ?? '').match(/\/Firm\/(\d+)/)?.[1] ?? null;
const codeFromKey = (key) => key.match(/^\((\d+)\)/)?.[1] ?? null;

function isEnded(entry, today) {
  const end = toIsoDate(entry['End Date']);
  return end !== null && end <= today;
}

export const fca = Object.freeze({
  regulator: 'FCA',

  validate(firm, { env }) {
    authHeaders(env);
    if (!/^\d{5,7}$/.test(firm.ref)) throw new SourceConfigError(`FCA: "${firm.ref}" is not a valid FRN`);
  },

  /** Firm details, including the Companies House number used for the entity spine. */
  async fetchFirmProfile(firm, { env }) {
    const body = await call(`/Firm/${encodeURIComponent(firm.ref)}`, env);
    const data = Array.isArray(body?.Data) ? body.Data[0] : null;
    if (!data) return null;
    return {
      name: data['Organisation Name'] || firm.name,
      status: data.Status || null,
      registrationNumber: data['Companies House Number'] || null,
    };
  },

  async fetchRoster(firm, { env }) {
    const today = new Date().toISOString().slice(0, 10);
    const data = await callAllPages(`/Firm/${encodeURIComponent(firm.ref)}/CF`, env);
    const people = new Map();

    for (const block of data) {
      for (const [key, entry] of Object.entries(block?.Current ?? {})) {
        if (!entry || isEnded(entry, today)) continue;
        const personRef = irnFromUrl(entry.URL);
        if (!personRef) continue;

        const person = people.get(personRef) ?? {
          personRef,
          name: String(entry['Individual Name'] ?? personRef).trim(),
          roles: [],
        };
        const title = String(entry.Name ?? key.replace(/^\(\d+\)/, '')).trim();
        if (!person.roles.some((r) => r.title === title)) {
          person.roles.push({ title, code: codeFromKey(key), since: toIsoDate(entry['Effective Date']) });
        }
        people.set(personRef, person);
      }
    }
    return [...people.values()];
  },

  /** Where a leaver went: their most recent current role at another firm, if any. */
  async resolveDestination(personRef, fromFirmRef, { env }) {
    const body = await call(`/Individuals/${encodeURIComponent(personRef)}/CF`, env);
    const blocks = Array.isArray(body?.Data) ? body.Data : [];
    const candidates = blocks
      .flatMap((b) => Object.values(b?.Current ?? {}))
      .map((e) => ({ firmName: e['Firm Name'], firmRef: frnFromUrl(e.URL), since: toIsoDate(e['Effective Date']) }))
      .filter((c) => c.firmName && c.firmRef !== fromFirmRef)
      .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''));
    return candidates[0] ?? null;
  },
});