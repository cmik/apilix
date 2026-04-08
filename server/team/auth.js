'use strict';
/**
 * Team Auth Helpers
 *
 * Uses the `jsonwebtoken` package (add to server/package.json if missing).
 * The secret is generated once and stored at `{dataDir}/team/.secret`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _jwt;
function jwt() {
  if (!_jwt) _jwt = require('jsonwebtoken');
  return _jwt;
}

let _secret = null;

function loadSecret(dataDir) {
  if (_secret) return _secret;
  const secretPath = path.join(dataDir, 'team', '.secret');
  if (fs.existsSync(secretPath)) {
    _secret = fs.readFileSync(secretPath, 'utf8').trim();
  } else {
    _secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, _secret, { mode: 0o600 });
  }
  return _secret;
}

/**
 * Sign a JWT for a user.
 * @param {{ sub: string, role: string }} payload
 * @param {string} dataDir
 * @returns {string}
 */
function signToken(payload, dataDir) {
  return jwt().sign(payload, loadSecret(dataDir), { expiresIn: '30d' });
}

/**
 * Express middleware — verifies Bearer JWT.
 * Attaches decoded payload to `req.user`.
 */
function requireAuth(dataDir) {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = header.slice(7);
    try {
      req.user = jwt().verify(token, loadSecret(dataDir));
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { signToken, requireAuth };
