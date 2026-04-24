'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generatePKCEVerifier,
  generatePKCEChallenge,
  verifyPKCEChallenge,
  validateOAuth2Config,
} = require('../src/oauth');

// ─── PKCE ────────────────────────────────────────────────────────────────────

test('generatePKCEVerifier returns a 128-character string', () => {
  const verifier = generatePKCEVerifier();
  assert.equal(typeof verifier, 'string');
  assert.equal(verifier.length, 128);
});

test('generatePKCEVerifier only uses unreserved URI characters', () => {
  const verifier = generatePKCEVerifier();
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
});

test('generatePKCEVerifier produces different values on each call', () => {
  const a = generatePKCEVerifier();
  const b = generatePKCEVerifier();
  assert.notEqual(a, b);
});

test('generatePKCEChallenge produces a base64url string (no +, /, =)', () => {
  const verifier = generatePKCEVerifier();
  const challenge = generatePKCEChallenge(verifier);
  assert.equal(typeof challenge, 'string');
  assert.ok(challenge.length > 0);
  assert.equal(challenge.indexOf('+'), -1);
  assert.equal(challenge.indexOf('/'), -1);
  assert.equal(challenge.indexOf('='), -1);
});

test('generatePKCEChallenge is deterministic for the same verifier', () => {
  const verifier = 'abcdef1234567890';
  assert.equal(generatePKCEChallenge(verifier), generatePKCEChallenge(verifier));
});

test('verifyPKCEChallenge returns true for a matching pair', () => {
  const verifier = generatePKCEVerifier();
  const challenge = generatePKCEChallenge(verifier);
  assert.equal(verifyPKCEChallenge(verifier, challenge), true);
});

test('verifyPKCEChallenge returns false when verifier is tampered', () => {
  const verifier = generatePKCEVerifier();
  const challenge = generatePKCEChallenge(verifier);
  assert.equal(verifyPKCEChallenge(verifier + 'X', challenge), false);
});

test('verifyPKCEChallenge returns false when challenge is tampered', () => {
  const verifier = generatePKCEVerifier();
  const challenge = generatePKCEChallenge(verifier);
  const tampered = challenge.slice(0, -1) + (challenge.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyPKCEChallenge(verifier, tampered), false);
});

// ─── validateOAuth2Config ────────────────────────────────────────────────────

test('validateOAuth2Config returns invalid for null config', () => {
  const result = validateOAuth2Config(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('validateOAuth2Config returns invalid when grantType is missing', () => {
  const result = validateOAuth2Config({ clientId: 'id', tokenUrl: 'https://example.com/token' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /grantType/i.test(e)));
});

test('validateOAuth2Config returns invalid when clientId is missing', () => {
  const result = validateOAuth2Config({ grantType: 'client_credentials', tokenUrl: 'https://example.com/token', clientSecret: 'sec' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /clientId/i.test(e)));
});

test('validateOAuth2Config returns invalid when tokenUrl is missing', () => {
  const result = validateOAuth2Config({ grantType: 'client_credentials', clientId: 'id', clientSecret: 'sec' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /tokenUrl/i.test(e)));
});

test('validateOAuth2Config valid for client_credentials with required fields', () => {
  const result = validateOAuth2Config({
    grantType: 'client_credentials',
    clientId: 'id',
    clientSecret: 'sec',
    tokenUrl: 'https://example.com/token',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateOAuth2Config requires clientSecret for client_credentials', () => {
  const result = validateOAuth2Config({
    grantType: 'client_credentials',
    clientId: 'id',
    tokenUrl: 'https://example.com/token',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /clientSecret/i.test(e)));
});

test('validateOAuth2Config requires authorizationUrl for authorization_code', () => {
  const result = validateOAuth2Config({
    grantType: 'authorization_code',
    clientId: 'id',
    tokenUrl: 'https://example.com/token',
    clientSecret: 'sec',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /authorizationUrl/i.test(e)));
});
