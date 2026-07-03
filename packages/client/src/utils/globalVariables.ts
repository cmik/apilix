import type { GlobalVariableMeta } from '../types';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface GlobalStateShape {
  values: Record<string, string>;
  meta: Record<string, GlobalVariableMeta>;
}

export function sanitizeGlobalValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const safe: Record<string, string> = Object.create(null);
  for (const key of Object.keys(input as object)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') safe[key] = value;
  }
  return safe;
}

export function sanitizeGlobalMeta(input: unknown): Record<string, GlobalVariableMeta> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const safe: Record<string, GlobalVariableMeta> = Object.create(null);
  for (const key of Object.keys(input as object)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const raw = (input as Record<string, unknown>)[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const meta = raw as Record<string, unknown>;
    const next: GlobalVariableMeta = {};
    if (meta.secret === true) next.secret = true;
    if (meta.enabled === false) next.enabled = false;
    if (typeof meta.type === 'string' && meta.type.length > 0) next.type = meta.type;
    if (Object.keys(next).length > 0) safe[key] = next;
  }
  return safe;
}

export function normalizeGlobalState(valuesInput: unknown, metaInput: unknown): GlobalStateShape {
  const values = sanitizeGlobalValues(valuesInput);
  const rawMeta = sanitizeGlobalMeta(metaInput);
  const meta: Record<string, GlobalVariableMeta> = Object.create(null);

  for (const key of Object.keys(values)) {
    if (rawMeta[key]) meta[key] = rawMeta[key];
  }

  return { values, meta };
}

export function mergeGlobalMetaWithValues(
  values: Record<string, string>,
  currentMeta: Record<string, GlobalVariableMeta>,
): Record<string, GlobalVariableMeta> {
  const next: Record<string, GlobalVariableMeta> = Object.create(null);
  for (const key of Object.keys(values)) {
    if (currentMeta[key]) next[key] = currentMeta[key];
  }
  return next;
}

export function collectGlobalSecretValues(
  values: Record<string, string>,
  meta: Record<string, GlobalVariableMeta>,
  minLen: number,
): Set<string> {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (meta[key]?.secret && value.length >= minLen) secrets.add(value);
  }
  return secrets;
}
