/**
 * MAS (Singapore) register delta parser.
 *
 * Public sources: the MAS Financial Institutions Directory and the Register of
 * Representatives. MAS publishes no documented bulk API, so this adapter reads
 * whatever source you configure per firm in watchlist.json:
 *   - { "type": "file", "path": "imports/mas/<ref>.csv" }   an export you saved, or
 *   - { "type": "url",  "url": "https://...{ref}...", "format": "json", "jsonPath": "..." }
 * URL sources are checked against robots.txt and refused if disallowed.
 * Column names below are best guesses; override them with source.fields.
 */
import { loadRoster, requireSource } from './generic.js';

const FIELD_MAP = Object.freeze({
  personRef: ['Representative Number', 'Representative No', 'RNF Number', 'repNo', 'representativeNumber', 'Individual Reference'],
  name: ['Name', 'Representative Name', 'representativeName', 'Full Name'],
  role: ['Role', 'Designation', 'Regulated Activity', 'Type of Regulated Activity', 'Activity'],
  since: ['Date of Appointment', 'Start Date', 'Effective Date', 'appointmentDate', 'startDate'],
  status: ['Status', 'Representative Status', 'status'],
});

export const mas = Object.freeze({
  regulator: 'MAS',
  validate(firm) {
    requireSource(firm);
  },
  fetchRoster(firm, ctx) {
    return loadRoster(firm, ctx, FIELD_MAP);
  },
});