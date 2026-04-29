/**
 * Utilities for normalizing and validating environment/globals/collection
 * variable key names at save time and in real-time UI validation.
 */

/**
 * Normalizes a variable key for storage:
 *   1. Trim leading/trailing whitespace.
 *   2. Collapse any remaining internal whitespace runs to a single underscore.
 */
export function normalizeVariableName(key: string): string {
  return key.trim().replace(/\s+/g, '_');
}

/**
 * Returns true when the key is non-empty after normalization.
 */
export function isValidVariableName(key: string): boolean {
  return key.trim().length > 0;
}

/**
 * Regex for data-storage variable keys: non-empty, no whitespace, no braces.
 * Allows hyphens, dots, and other non-whitespace chars (e.g. api-key, X.Token).
 */
const STORAGE_KEY_REGEX = /^[^\s{}]+$/;

/**
 * Returns a user-facing error message when the key fails the data-storage
 * format rule, or null when the key is valid (or empty — empty rows are
 * dropped silently on save and need no message).
 */
export function storageKeyError(key: string): string | null {
  const trimmedKey = key.trim();
  if (!trimmedKey) return null;
  if (/\s/.test(trimmedKey)) return 'Variable names cannot contain spaces or whitespace';
  if (/[{}]/.test(trimmedKey)) return 'Variable names cannot contain { or }';
  if (!STORAGE_KEY_REGEX.test(trimmedKey)) return 'Invalid variable name';
  return null;
}
