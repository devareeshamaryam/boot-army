 import { fca } from './fca.js';
import { mas } from './mas.js';
import { sfc } from './sfc.js';
import { dfsa, fsra } from './dfsa.js';

export const ADAPTERS = Object.freeze({ FCA: fca, MAS: mas, SFC: sfc, DFSA: dfsa, FSRA: fsra });

export function getAdapter(regulator) {
  const adapter = ADAPTERS[regulator];
  if (!adapter) throw new Error(`No scraper registered for regulator "${regulator}"`);
  return adapter;
}