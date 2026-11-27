'use strict';

/**
 * Pure, dependency-free rules shared by the assertion suggester (client) and the
 * schema inference (core): which keys look volatile / secret, and which string formats
 * are recognised. Must stay loadable in a browser (no Node requires here).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Formats recognised in string values. `source`/`label` feed generated assertion scripts. */
const FORMATS = [
  { name: 'uuid', re: UUID_RE, source: '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', label: 'a UUID' },
  { name: 'iso-date', re: ISO_DATE_RE, source: '/^\\d{4}-\\d{2}-\\d{2}/', label: 'an ISO date' },
  { name: 'email', re: EMAIL_RE, source: '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/', label: 'an email address' },
  { name: 'url', re: URL_RE, source: '/^https?:\\/\\//i', label: 'a URL' },
];

// snake/kebab/plain names (case-insensitive) and camelCase suffixes (case-sensitive, so "valid" is not "…Id").
const VOLATILE_SNAKE_RE = /(^|[_-])(id|uuid|guid|token|jwt|nonce|etag|hash|signature)$|(created|updated|modified|deleted|expires?|issued|timestamp|date)(_?at)?$|(^|[_-])(at|time)$/i;
const VOLATILE_CAMEL_RE = /[a-z](Id|Uuid|Token|Hash|At|Time|Date)$/;
const STABLE_ENUM_KEYS = new Set(['status', 'state', 'type', 'kind', 'role', 'currency', 'locale', 'language', 'object']);
const CAPTURE_KEY_RE = /^(id|uuid|token|access_?token|refresh_?token|id_?token|jwt|session_?id|api_?key)$|(_id|Id)$/;

// Keys whose values are credentials / personal secrets. Matched anywhere in the (case-insensitive) key.
const SECRET_KEY_RE = /pass(word|wd|phrase)?|secret|token|api[_-]?key|apikey|private[_-]?key|credential|authorization|bearer|cookie|session|signature|jwt|otp|pin(code)?$|ssn|card[_-]?(number|no)|cvv|iban/i;

function isVolatileKey(key) {
  const k = String(key);
  return VOLATILE_SNAKE_RE.test(k) || VOLATILE_CAMEL_RE.test(k);
}

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

/** First recognised format name for a string, or null. */
function detectFormatName(s) {
  const f = FORMATS.find(x => x.re.test(s));
  return f ? f.name : null;
}

module.exports = {
  UUID_RE, ISO_DATE_RE, EMAIL_RE, URL_RE, FORMATS,
  VOLATILE_SNAKE_RE, VOLATILE_CAMEL_RE, STABLE_ENUM_KEYS, CAPTURE_KEY_RE, SECRET_KEY_RE,
  isVolatileKey, isSecretKey, detectFormatName,
};
