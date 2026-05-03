'use strict';

/**
 * @apilix/core — public API barrel
 *
 * All public exports from the core package are re-exported here.
 * Consumers can import from the package root or from a specific module.
 */

const requestEngine = require('./request-engine');
const scriptRuntime = require('./script-runtime');
const collectionRunner = require('./collection-runner');
const oauth = require('./oauth');
const tlsUtils = require('./tls-utils');
const runnerReporters = require('./runner-reporters');
const variableResolver = require('./variable-resolver');

module.exports = {
  // request engine
  executeRequest: requestEngine.executeRequest,
  flattenItems: requestEngine.flattenItems,
  flattenItemsWithScripts: requestEngine.flattenItemsWithScripts,
  setExecutorConfig: requestEngine.setExecutorConfig,
  buildBody: requestEngine.buildBody,
  buildProxyOption: requestEngine.buildProxyOption,
  applyAuth: requestEngine.applyAuth,
  resolveHeaderPairs: requestEngine.resolveHeaderPairs,
  resolveParamPairs: requestEngine.resolveParamPairs,
  executeMongoTest: requestEngine.executeMongoTest,
  executeMongoIntrospect: requestEngine.executeMongoIntrospect,

  // script runtime
  runScript: scriptRuntime.runScript,
  createScriptContext: scriptRuntime.createScriptContext,

  // collection runner
  InputError: collectionRunner.InputError,
  prepareCollectionRun: collectionRunner.prepareCollectionRun,
  executePreparedCollectionRun: collectionRunner.executePreparedCollectionRun,

  // oauth
  generatePKCEVerifier: oauth.generatePKCEVerifier,
  generatePKCEChallenge: oauth.generatePKCEChallenge,
  verifyPKCEChallenge: oauth.verifyPKCEChallenge,
  refreshOAuth2Token: oauth.refreshOAuth2Token,
  exchangeAuthorizationCodeForToken: oauth.exchangeAuthorizationCodeForToken,
  validateOAuth2Config: oauth.validateOAuth2Config,

  // TLS utils
  getSystemCAs: tlsUtils.getSystemCAs,
  makeHttpsAgent: tlsUtils.makeHttpsAgent,

  // runner reporters
  summarizeRun: runnerReporters.summarizeRun,
  buildJsonReport: runnerReporters.buildJsonReport,
  buildJUnitReport: runnerReporters.buildJUnitReport,

  // variable resolver — single canonical export
  resolveVariables: variableResolver.resolveVariables,
};
