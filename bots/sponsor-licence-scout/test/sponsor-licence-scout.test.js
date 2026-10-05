/**
 * B1 tests: the CSV parser and the pure diff. No network, no Google.
 *   Run: npm test -w bots/sponsor-licence-scout
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../harvest.js';
import { HEADER, diffSponsors } from '../sheets.js';

const TODAY = '2026-10-05';
const CSV_HEADER = 'Organisation Name,Town/City,County,Type & Rating,Route';
const csv = (...lines) => `\uFEFF${[CSV_HEADER, ...lines].join('\r\n')}\r\n`;
const sheetRow = (name, town, status, firstSeen = '2026-09-01', revokedOn = '') =>
  [name, town, 'Yorkshire', 'Worker (A rating)', 'Skilled Worker', status, firstSeen, revokedOn];
const row = (name, town) => ({ 'Organisation Name': name, 'Town/City': town, County: 'Yorkshire', 'Type & Rating': 'Worker (A rating)', Route: 'Skilled Worker' });

test('new: in the CSV, not in the sheet → appended as Active, First Seen today', () => {
  const d = diffSponsors([row('Acme Ltd', 'Leeds'), row('New Co Ltd', 'York')], [sheetRow('Acme Ltd', 'Leeds', 'Active')], TODAY);
  assert.deepEqual(d.appends, [['New Co Ltd', 'York', 'Yorkshire', 'Worker (A rating)', 'Skilled Worker', 'Active', TODAY, '']]);
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.updates, []);
});

test('revoked: Active in the sheet, not in the CSV → Status Revoked, Revoked On today, First Seen kept', () => {
  const sheet = [sheetRow('Acme Ltd', 'Leeds', 'Active'), sheetRow('Gone Ltd', 'Hull', 'Active', '2025-01-02')];
  const d = diffSponsors([row('Acme Ltd', 'Leeds')], sheet, TODAY);
  assert.deepEqual(d.updates, [{ row: 3, values: ['Revoked', '2025-01-02', TODAY] }]);
  assert.equal(d.revoked[0][0], 'Gone Ltd');
  assert.deepEqual(d.appends, []);
});

test('reinstated: Revoked in the sheet, back in the CSV → Active again, Revoked On cleared', () => {
  const d = diffSponsors([row('Acme Ltd', 'Leeds')], [sheetRow('Acme Ltd', 'Leeds', 'Revoked', '2025-01-02', '2026-09-20')], TODAY);
  assert.deepEqual(d.updates, [{ row: 2, values: ['Active', '2025-01-02', ''] }]);
  assert.equal(d.reinstated.length, 1);
  assert.equal(d.revoked.length, 0);
});

test('comma inside a quoted name is one field, and matches the sheet row', () => {
  const rows = parseRows(csv('"Smith, Jones & Co Ltd",Leeds,Yorkshire,Worker (A rating),Skilled Worker'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Organisation Name'], 'Smith, Jones & Co Ltd');
  const d = diffSponsors(rows, [sheetRow('Smith, Jones & Co Ltd', 'Leeds', 'Active')], TODAY);
  assert.deepEqual([d.appends.length, d.updates.length], [0, 0]);
});

test('duplicate rows: the same sponsor twice in the CSV is appended once; key is case-insensitive', () => {
  const rows = parseRows(csv('Acme Ltd,Leeds,Yorkshire,Worker (A rating),Skilled Worker', 'ACME LTD,LEEDS,YORKSHIRE,WORKER (A RATING),SKILLED WORKER'));
  const d = diffSponsors(rows, [], TODAY);
  assert.equal(d.appends.length, 1);
  // Same company on another route is a separate sponsor row.
  const twoRoutes = diffSponsors([row('Acme Ltd', 'Leeds'), { ...row('Acme Ltd', 'Leeds'), Route: 'Scale-up' }], [], TODAY);
  assert.equal(twoRoutes.appends.length, 2);
});

test('first run: empty sheet is a baseline load', () => {
  const d = diffSponsors([row('Acme Ltd', 'Leeds'), row('Beta Ltd', 'York')], [], TODAY);
  assert.equal(d.baseline, true);
  assert.equal(d.appends.length, 2);
});

test('safety: a CSV under 50% of the Active rows changes nothing', () => {
  const sheet = Array.from({ length: 10 }, (_, i) => sheetRow(`Co ${i} Ltd`, 'Leeds', 'Active'));
  const d = diffSponsors([row('Co 0 Ltd', 'Leeds'), row('Co 1 Ltd', 'Leeds'), row('Co 2 Ltd', 'Leeds'), row('Co 3 Ltd', 'Leeds')], sheet, TODAY);
  assert.match(d.blocked, /4 sponsors but the sheet has 10 Active/);
  assert.deepEqual([d.appends.length, d.updates.length], [0, 0]);
});

test('a CSV missing a column fails loudly, naming what was found', () => {
  assert.throws(() => parseRows('Organisation Name,Town/City\r\nAcme Ltd,Leeds\r\n'), /missing column\(s\): County, Type & Rating, Route\. Found: Organisation Name, Town\/City/);
  assert.equal(HEADER.length, 8);
});