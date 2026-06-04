'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMergeMongoAuth() {
  const requestEnginePath = path.join(__dirname, '../src/request-engine.js');
  const source = fs.readFileSync(requestEnginePath, 'utf8');
  const match = source.match(/function mergeMongoAuth\(baseAuth, overrideAuth\) \{[\s\S]*?\n\}\n\nfunction extractMongoConnection/);
  if (!match) {
    throw new Error('Could not locate mergeMongoAuth in request-engine.js');
  }

  const fnSource = match[0].replace(/\n\nfunction extractMongoConnection[\s\S]*$/, '');
  return vm.runInNewContext(`${fnSource}\nmergeMongoAuth;`);
}

const mergeMongoAuth = loadMergeMongoAuth();

test('mergeMongoAuth: mode override to x509 clears inherited username/password', () => {
  const baseAuth = {
    mode: 'scram',
    username: 'savedUser',
    password: 'savedPass',
    authSource: 'admin',
  };

  const merged = mergeMongoAuth(baseAuth, { mode: 'x509' });

  assert.equal(merged.mode, 'x509');
  assert.equal(merged.username, undefined);
  assert.equal(merged.password, undefined);
  assert.equal(merged.authSource, 'admin');
});

test('mergeMongoAuth: mode override to oidc clears inherited username/password', () => {
  const baseAuth = {
    mode: 'ldap-plain',
    username: 'savedUser',
    password: 'savedPass',
    authSource: 'admin',
  };

  const merged = mergeMongoAuth(baseAuth, { mode: 'oidc' });

  assert.equal(merged.mode, 'oidc');
  assert.equal(merged.username, undefined);
  assert.equal(merged.password, undefined);
  assert.equal(merged.authSource, 'admin');
});

test('mergeMongoAuth: mode override to ldap-plain retains inherited credentials unless explicitly overridden', () => {
  const baseAuth = {
    mode: 'scram',
    username: 'savedUser',
    password: 'savedPass',
    authSource: 'admin',
  };

  const merged = mergeMongoAuth(baseAuth, { mode: 'ldap-plain' });

  assert.equal(merged.mode, 'ldap-plain');
  assert.equal(merged.username, 'savedUser');
  assert.equal(merged.password, 'savedPass');
  assert.equal(merged.authSource, 'admin');
});
