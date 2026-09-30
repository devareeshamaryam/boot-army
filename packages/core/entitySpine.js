/**
 * Entity spine: one canonical ID format for company registrations across
 * jurisdictions, so the same company always maps to the same key.
 *
 * Canonical form: "<JURISDICTION>:<ID>", e.g. "UK:00445790", "SG:201912345K".
 */

export const SUPPORTED_JURISDICTIONS = Object.freeze(['UK', 'SG', 'DIFC', 'ADGM']);

const JURISDICTION_ALIASES = Object.freeze({
  UK: 'UK',
  GB: 'UK',
  GBR: 'UK',
  SG: 'SG',
  SGP: 'SG',
  DIFC: 'DIFC',
  AEDIFC: 'DIFC', // matches "AE-DIFC", "AE DIFC", etc. after cleaning
  ADGM: 'ADGM',
  AEADGM: 'ADGM',
});

export class EntityIdError extends Error {
  constructor(message, { registrationNumber, countryCode } = {}) {
    super(message);
    this.name = 'EntityIdError';
    this.registrationNumber = registrationNumber;
    this.countryCode = countryCode;
  }
}

/** Uppercase and strip spaces, dashes, dots, slashes and other separators. */
const clean = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * UK (Companies House): always 8 characters.
 * - England & Wales: 8 digits, left-padded with zeros ("445790" -> "00445790").
 * - Prefixed (SC, NI, OC, SO, LP, SL, FC, ...): 2 letters + 6 digits ("SC12345" -> "SC012345").
 * - "R0" + 6 digits (older Northern Ireland numbers) is also accepted.
 */
function normalizeUK(raw) {
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, '0');

  const prefixed = raw.match(/^([A-Z]{2})(\d{1,6})$/);
  if (prefixed) return prefixed[1] + prefixed[2].padStart(6, '0');

  if (/^[A-Z][A-Z0-9]\d{6}$/.test(raw)) return raw;

  return null;
}

/**
 * Singapore (ACRA UEN), check letter kept as-is:
 * - Businesses:      8 digits + letter        (e.g. 53123456A)
 * - Local companies: 4-digit year + 5 digits + letter (e.g. 201912345K)
 * - Other entities:  T/S/R + 2-digit year + 2-letter type + 4 digits + letter (e.g. T09LL0001B)
 */
function normalizeSG(raw) {
  const patterns = [
    /^\d{8}[A-Z]$/,
    /^(18|19|20)\d{7}[A-Z]$/,
    /^[TSR]\d{2}[A-Z]{2}\d{4}[A-Z]$/,
  ];
  return patterns.some((re) => re.test(raw)) ? raw : null;
}

/**
 * DIFC and ADGM registration numbers are numeric. An optional leading
 * "DIFC"/"ADGM" label is dropped, and leading zeros are stripped so that
 * "0001234" and "1234" produce the same key.
 */
function normalizeNumericFreeZone(raw, label) {
  const withoutLabel = raw.startsWith(label) ? raw.slice(label.length) : raw;
  if (!/^\d{1,12}$/.test(withoutLabel)) return null;

  const stripped = withoutLabel.replace(/^0+/, '');
  return stripped === '' ? null : stripped;
}

const NORMALIZERS = Object.freeze({
  UK: normalizeUK,
  SG: normalizeSG,
  DIFC: (raw) => normalizeNumericFreeZone(raw, 'DIFC'),
  ADGM: (raw) => normalizeNumericFreeZone(raw, 'ADGM'),
});

/**
 * Standardize a company registration number into a canonical spine ID.
 *
 * @param {string|number} registrationNumber - Raw ID as scraped or typed.
 * @param {string} [countryCode='UK'] - UK/GB, SG, DIFC, or ADGM (case-insensitive).
 * @returns {string} Canonical ID, e.g. "UK:00445790".
 * @throws {EntityIdError} If the jurisdiction is unsupported or the ID is malformed.
 */
export function normalizeEntityId(registrationNumber, countryCode = 'UK') {
  const context = { registrationNumber, countryCode };

  if (registrationNumber === null || registrationNumber === undefined) {
    throw new EntityIdError('registrationNumber is required', context);
  }

  const jurisdiction = JURISDICTION_ALIASES[clean(countryCode ?? '')];

  if (!jurisdiction) {
    throw new EntityIdError(
      `Unsupported jurisdiction "${countryCode}". Supported: ${SUPPORTED_JURISDICTIONS.join(', ')}`,
      context,
    );
  }

  const raw = clean(registrationNumber);
  if (raw === '') {
    throw new EntityIdError('registrationNumber is empty after cleaning', context);
  }

  const normalized = NORMALIZERS[jurisdiction](raw);
  if (normalized === null) {
    throw new EntityIdError(
      `Invalid ${jurisdiction} registration number "${registrationNumber}"`,
      context,
    );
  }

  return `${jurisdiction}:${normalized}`;
}