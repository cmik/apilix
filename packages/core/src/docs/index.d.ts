import type { DocsExportOptions, DocsDeps, DocsResult, DocModel } from '../../types/docs';
import type { BaseCollection } from '../../types';

export function generateDocs(collection: BaseCollection, options?: DocsExportOptions, deps?: DocsDeps): DocsResult;
export function buildDocModel(collection: BaseCollection, options?: DocsExportOptions): DocModel;
export function toYaml(value: unknown): string;
