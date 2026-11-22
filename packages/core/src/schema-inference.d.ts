import type { SchemaInferenceOptions } from '../types';
export function inferSchema(value: unknown, options?: SchemaInferenceOptions): Record<string, unknown>;
export function inferFromSamples(samples: unknown[], options?: SchemaInferenceOptions): Record<string, unknown>;
export function mergeSchemas(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): Record<string, unknown>;
export function detectFormat(s: string): string | null;
export function isVolatileKey(key: string): boolean;
export function isSecretKey(key: string): boolean;
