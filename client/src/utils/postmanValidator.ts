/**
 * Validates a Postman Collection JSON against the official v2.0 / v2.1 schemas.
 * Version is detected from `info.schema` / `info._postman_schema`.
 */
import Ajv from 'ajv';
import schemaV20 from '../schemas/postman-v2.0.json';
import schemaV21 from '../schemas/postman-v2.1.json';
import draft04MetaSchema from 'ajv/lib/refs/json-schema-draft-04.json';

export type PostmanVersion = '2.0' | '2.1';

export interface PostmanValidationResult {
  version: PostmanVersion;
  valid: boolean;
  /** Human-readable list of validation errors (capped at 10). */
  errors: string[];
}

/** URL fragments used to identify each schema version. */
const V20_MARKERS = ['v2.0', '2.0.0', '#2.0'];
const V21_MARKERS = ['v2.1', '2.1.0'];

function detectVersion(json: Record<string, unknown>): PostmanVersion {
  const info = json.info as Record<string, string> | undefined;
  const schemaUrl: string = info?.schema ?? info?.['_postman_schema'] ?? '';
  if (V20_MARKERS.some(m => schemaUrl.includes(m))) return '2.0';
  if (V21_MARKERS.some(m => schemaUrl.includes(m))) return '2.1';
  // Default to v2.1 (most common)
  return '2.1';
}

/** Lazily initialised ajv instances (one per schema version). */
const validators: Partial<Record<PostmanVersion, Ajv.ValidateFunction>> = {};

function getValidator(version: PostmanVersion): Ajv.ValidateFunction {
  if (!validators[version]) {
    const ajv = new Ajv({
      schemaId: 'id',      // draft-04 uses "id", not "$id"
      allErrors: true,
      meta: false,          // skip meta-schema validation of the schema itself
      unknownFormats: 'ignore',
    });
    // Register draft-04 meta-schema so nested $schema references are recognised
    ajv.addMetaSchema(draft04MetaSchema);
    const rawSchema = version === '2.0' ? schemaV20 : schemaV21;
    validators[version] = ajv.compile(rawSchema);
  }
  return validators[version]!;
}

function humanise(err: Ajv.ErrorObject): string {
  const path = err.dataPath || '';
  const field = path ? `"${path.replace(/^\./, '')}"` : 'root';
  return `${field}: ${err.message}`;
}

export function validatePostmanCollection(json: unknown): PostmanValidationResult {
  const obj = json as Record<string, unknown>;
  const version = detectVersion(obj);
  const validate = getValidator(version);
  const valid = validate(json) as boolean;

  const errors: string[] = [];
  if (!valid && validate.errors) {
    const unique = new Set<string>();
    for (const err of validate.errors) {
      const msg = humanise(err);
      if (!unique.has(msg)) {
        unique.add(msg);
        errors.push(msg);
        if (errors.length >= 10) break;
      }
    }
  }

  return { version, valid, errors };
}
