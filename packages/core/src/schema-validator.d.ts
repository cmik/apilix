import type { SchemaValidationResult } from '../types';
export const MAX_ERRORS: number;
export class SchemaValidator {
  constructor(opts?: { schemas?: Array<{ name: string; schema: object }>; allErrors?: boolean });
  has(name: string): boolean;
  listNames(): string[];
  validate(nameOrSchema: string | object, data: unknown): SchemaValidationResult;
}
export function createSchemaValidator(opts?: { schemas?: Array<{ name: string; schema: object }>; allErrors?: boolean }): SchemaValidator;
export function validateAgainstSchema(nameOrSchema: string | object, data: unknown, opts?: { schemas?: Array<{ name: string; schema: object }>; allErrors?: boolean }): SchemaValidationResult;
