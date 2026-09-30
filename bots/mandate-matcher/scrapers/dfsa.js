/**
 * DFSA (DIFC, Dubai) and FSRA (ADGM, Abu Dhabi) register delta parsers.
 *
 * Both regulators publish public registers of firms and their authorised/
 * approved individuals (e.g. Senior Executive Officer, Finance Officer,
 * Compliance Officer, MLRO, Licensed Director). Neither documents a bulk API,
 * so each firm needs a configured "source" (file export or robots-permitted
 * URL). Column names are best guesses; override them with source.fields.
 */
import { loadRoster, requireSource } from './generic.js';

const FIELD_MAP = Object.freeze({
  personRef: ['Individual Reference', 'Individual Reference Number', 'Reference Number', 'Individual ID', 'Approved Person Number', 'id'],
  name: ['Name', 'Individual Name', 'Full Name', 'name'],
  role: ['Function', 'Role', 'Controlled Function', 'Licensed Function', 'Authorised Function', 'Position'],
  since: ['Effective Date', 'Date of Approval', 'Approval Date', 'Start Date', 'effectiveDate'],
  status: ['Status', 'Individual Status'],
});

const makeAdapter = (regulator) =>
  Object.freeze({
    regulator,
    validate(firm) {
      requireSource(firm);
    },
    fetchRoster(firm, ctx) {
      return loadRoster(firm, ctx, FIELD_MAP);
    },
  });

export const dfsa = makeAdapter('DFSA');
export const fsra = makeAdapter('FSRA');