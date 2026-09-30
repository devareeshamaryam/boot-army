/**
 * SFC (Hong Kong) register delta parser.
 *
 * The SFC public register (apps.sfc.hk/publicregWeb) disallows automated
 * access in robots.txt, so this adapter does NOT scrape it. Feed it files you
 * obtain legitimately (a licensed data vendor, or exports saved by hand from
 * the firm's "Responsible Officers" and "Representatives" tabs), e.g.:
 *
 *   "source": [
 *     { "type": "file", "path": "imports/sfc/AAA000-ro.csv",  "defaultRole": "Responsible Officer" },
 *     { "type": "file", "path": "imports/sfc/AAA000-rep.csv", "defaultRole": "Licensed Representative" }
 *   ]
 *
 * Person refs are SFC CE numbers (three letters + three digits, e.g. "ABC123").
 */
import { loadRoster, requireSource } from './generic.js';
import { SourceConfigError } from './http.js';

const FIELD_MAP = Object.freeze({
  personRef: ['CE Reference', 'CE No.', 'CE No', 'CE Number', 'ceRef', 'ceNo'],
  name: ['Name', 'English Name', 'Name in English', 'fullName', 'name'],
  role: ['Role', 'Capacity', 'Position'],
  since: ['Effective Date', 'Date of Approval', 'Start Date', 'effectiveDate'],
  status: ['Status', 'Licence Status'],
});

export const sfc = Object.freeze({
  regulator: 'SFC',
  validate(firm) {
    requireSource(firm);
    const sources = Array.isArray(firm.source) ? firm.source : [firm.source];
    if (sources.some((s) => s?.type === 'url' && /(^|\.)sfc\.hk$/i.test(new URL(s.url).hostname))) {
      throw new SourceConfigError('SFC: the public register disallows automated access; use file sources');
    }
  },
  fetchRoster(firm, ctx) {
    return loadRoster(firm, ctx, FIELD_MAP);
  },
});