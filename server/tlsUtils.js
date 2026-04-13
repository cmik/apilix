'use strict';

const https = require('https');
const tls = require('tls');

// Cached merged CA array: Node's built-in Mozilla bundle + OS certificate store.
// Using null as sentinel so an empty result is also cached correctly.
let _systemCAs = null;

/**
 * Return a deduplicated array of PEM CA certificates combining:
 *   1. Node's built-in Mozilla CA bundle (tls.rootCertificates)
 *   2. On Windows: the Windows certificate store (via win-ca)
 *
 * Using this list as the `ca` option in an https.Agent ensures that certificates
 * issued by enterprise / corporate CAs that are trusted by the OS but absent from
 * Mozilla's bundle are still accepted when SSL verification is enabled.
 *
 * Result is memoised for the lifetime of the process.
 */
function getSystemCAs() {
  if (_systemCAs !== null) return _systemCAs;

  // Start with Node's built-in bundle so no existing trust is removed.
  const cas = new Set(tls.rootCertificates);

  if (process.platform === 'win32') {
    try {
      const winca = require('win-ca');
      const winCerts = winca.all(winca.der2.pem);
      if (Array.isArray(winCerts)) {
        for (const cert of winCerts) cas.add(cert);
      }
    } catch (_) {
      // win-ca not available — fall back to Node's built-in bundle only.
    }
  }

  _systemCAs = Array.from(cas);
  return _systemCAs;
}

/**
 * Create an https.Agent with the given options.
 *
 * When rejectUnauthorized is true the agent is configured with the merged
 * system CA list so that OS-trusted CAs (e.g. corporate root CAs) are
 * honoured in addition to Mozilla's bundle.
 *
 * When rejectUnauthorized is false the agent disables SSL verification
 * entirely (no CA list needed).
 *
 * @param {boolean} rejectUnauthorized
 * @param {object}  [extraOptions]  Any additional https.Agent options.
 */
function makeHttpsAgent(rejectUnauthorized, extraOptions = {}) {
  const opts = { ...extraOptions, rejectUnauthorized };
  if (rejectUnauthorized) {
    opts.ca = getSystemCAs();
  }
  return new https.Agent(opts);
}

module.exports = { getSystemCAs, makeHttpsAgent };
