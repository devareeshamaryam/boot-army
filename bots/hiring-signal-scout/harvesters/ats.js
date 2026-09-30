/**
 * Keyless ATS job-board pollers. Each returns { jobs, complete }, where a job is
 * { key, title, location, department, url } and complete=false means the list
 * was truncated (so missing jobs must not be treated as closed).
 *
 *   Greenhouse  GET  boards-api.greenhouse.io/v1/boards/{token}/jobs          (documented, public)
 *   Lever       GET  api.lever.co/v0/postings/{slug}?mode=json                (documented, public; EU: api.eu.lever.co)
 *   Workable    GET  apply.workable.com/api/v1/widget/accounts/{account}      (public widget feed)
 *   Workday     POST {host}/wday/cxs/{tenant}/{site}/jobs                     (undocumented; career-site API)
 */
import { getJson, postJson, isAllowedByRobots, createThrottle, SourceConfigError } from './http.js';

const clean = (s) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim() || null);

export const greenhouse = {
  async fetchJobs(ats) {
    const body = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ats.token)}/jobs`);
    const jobs = (body?.jobs ?? []).map((j) => ({
      key: String(j.id),
      title: clean(j.title) ?? 'Untitled role',
      location: clean(j.location?.name),
      department: clean(j.departments?.[0]?.name),
      url: j.absolute_url ?? null,
    }));
    return { jobs, complete: true };
  },
};

export const lever = {
  async fetchJobs(ats) {
    const host = ats.region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    const body = await getJson(`${host}/v0/postings/${encodeURIComponent(ats.slug)}?mode=json`);
    if (!Array.isArray(body)) throw new Error(`lever ${ats.slug}: unexpected response shape`);
    const jobs = body.map((j) => ({
      key: String(j.id),
      title: clean(j.text) ?? 'Untitled role',
      location: clean(j.categories?.location),
      department: clean(j.categories?.department ?? j.categories?.team),
      url: j.hostedUrl ?? null,
    }));
    return { jobs, complete: true };
  },
};

export const workable = {
  async fetchJobs(ats) {
    const body = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(ats.account)}`);
    const jobs = (body?.jobs ?? []).map((j) => ({
      key: String(j.shortcode ?? j.id ?? j.url),
      title: clean(j.title) ?? 'Untitled role',
      location: clean([j.city, j.state, j.country].filter(Boolean).join(', ')),
      department: clean(j.department),
      url: j.url ?? j.shortlink ?? null,
    }));
    return { jobs, complete: true };
  },
};

const WORKDAY_PAGE = 20; // Workday returns an empty list, not an error, above 20
const workdayThrottle = createThrottle(300);

export const workday = {
  async validate(ats) {
    const probe = `https://${ats.host}/wday/cxs/${ats.tenant}/${ats.site}/jobs`;
    if (!(await isAllowedByRobots(probe))) {
      throw new SourceConfigError(`workday ${ats.host}: robots.txt disallows the jobs endpoint`);
    }
  },
  async fetchJobs(ats) {
    await this.validate(ats);
    const endpoint = `https://${ats.host}/wday/cxs/${encodeURIComponent(ats.tenant)}/${encodeURIComponent(ats.site)}/jobs`;
    const maxPages = ats.maxPages ?? 50;
    const jobs = [];
    let total = null;

    for (let page = 0; page < maxPages; page++) {
      await workdayThrottle();
      const body = await postJson(
        endpoint,
        { appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: '' },
        { headers: { 'Accept-Language': 'en-US' } },
      );
      // "total" is only reliable on the first page.
      if (page === 0) total = Number(body?.total ?? 0);
      const postings = body?.jobPostings ?? [];
      for (const p of postings) {
        if (!p.externalPath) continue;
        jobs.push({
          key: p.externalPath,
          title: clean(p.title) ?? 'Untitled role',
          location: clean(p.locationsText),
          department: null,
          url: `https://${ats.host}/${ats.site}${p.externalPath}`,
        });
      }
      if (postings.length < WORKDAY_PAGE || jobs.length >= total) break;
    }
    return { jobs, complete: total !== null && jobs.length >= total };
  },
};

export const ATS_POLLERS = Object.freeze({ greenhouse, lever, workable, workday });

export function getPoller(type) {
  const poller = ATS_POLLERS[type];
  if (!poller) throw new SourceConfigError(`Unknown ATS type "${type}"`);
  return poller;
}