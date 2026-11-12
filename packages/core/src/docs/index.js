'use strict';

/**
 * API documentation export.
 *
 * generateDocs(collection, options, deps) -> { format, content, mimeType, extension, warnings, spec? }
 *
 * Pure and browser-safe (no Node built-ins): used by the CLI, the server and the client.
 * deps.snippetLanguages injects code-snippet generators ({ id, label, generate(requestModel) }).
 */

const { buildDocModel } = require('./doc-model');
const { renderHtml } = require('./doc-html');
const { renderMarkdown } = require('./doc-markdown');
const { buildOpenApi } = require('./doc-openapi');
const { toYaml } = require('./doc-yaml');

const FORMATS = ['html', 'markdown', 'openapi'];

function generateDocs(collection, options, deps) {
  const opts = Object.assign({ format: 'html' }, options || {});
  if (!FORMATS.includes(opts.format)) {
    throw new Error(`Unsupported docs format "${opts.format}". Use one of: ${FORMATS.join(', ')}`);
  }
  if (opts.openapiFormat && !['json', 'yaml'].includes(opts.openapiFormat)) {
    throw new Error(`Unsupported OpenAPI format "${opts.openapiFormat}". Use json or yaml`);
  }
  const model = buildDocModel(collection, opts);

  if (opts.format === 'html') {
    const { content, warnings } = renderHtml(model, opts, deps);
    return { format: 'html', content, mimeType: 'text/html', extension: 'html', warnings: model.warnings.concat(warnings) };
  }
  if (opts.format === 'markdown') {
    const { content, warnings } = renderMarkdown(model, opts, deps);
    return { format: 'markdown', content, mimeType: 'text/markdown', extension: 'md', warnings: model.warnings.concat(warnings) };
  }
  const { spec, warnings } = buildOpenApi(model, opts, model.warnings);
  const yaml = opts.openapiFormat === 'yaml';
  return {
    format: 'openapi',
    content: yaml ? toYaml(spec) : `${JSON.stringify(spec, null, 2)}\n`,
    mimeType: yaml ? 'application/yaml' : 'application/json',
    extension: yaml ? 'yaml' : 'json',
    warnings,
    spec,
  };
}

module.exports = { generateDocs, buildDocModel, toYaml };
