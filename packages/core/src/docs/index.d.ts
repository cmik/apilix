import type { DocsExportOptions, DocsDeps, DocsResult, DocModel } from '../../types/docs';
import type { BaseCollection } from '../../types';

/**
 * Generate API documentation (HTML, Markdown or OpenAPI) from a collection.
 * Credentials are redacted unless `options.includeCredentials` is true.
 * @param deps Injected snippet generators, resolved by id from `options.snippetLanguages`.
 * @returns The rendered content plus warnings; `spec` is set for OpenAPI only.
 * @throws On an unsupported format, an invalid collection, or an unknown `options.folder`.
 */
export function generateDocs(collection: BaseCollection, options?: DocsExportOptions, deps?: DocsDeps): DocsResult;
/** Build the neutral, redacted model that the HTML, Markdown and OpenAPI renderers consume. */
export function buildDocModel(collection: BaseCollection, options?: DocsExportOptions): DocModel;
/** Serialize a plain JSON-compatible value to YAML (used for OpenAPI output). */
export function toYaml(value: unknown): string;
