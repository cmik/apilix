'use strict';

const { createProvider } = require('./provider');
const { AiError, httpStatusFor } = require('./errors');
const { buildPreviewContext, buildShapeSchema } = require('./context');
const { redactContext, scrubSecretValues, redactScript } = require('./redact');
const { estimateTokens } = require('./budget');
const { getPrompt, isValidLanguage } = require('./prompts');
const { validateOutput } = require('./validate');
const { describeDocs, collectEntries } = require('./doc-describe');

module.exports = {
  createProvider,
  AiError,
  httpStatusFor,
  buildPreviewContext,
  buildShapeSchema,
  redactContext,
  scrubSecretValues,
  redactScript,
  estimateTokens,
  getPrompt,
  isValidLanguage,
  validateOutput,
  describeDocs,
  collectEntries,
};
