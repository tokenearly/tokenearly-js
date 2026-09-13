// The package is CommonJS; make sure both ESM import styles work.
import test from 'node:test';
import assert from 'node:assert/strict';

import tokenearly, { Client, Listing, TokenearlyError, listings, exchanges, VERSION } from '../index.js';

test('default import exposes the whole API', () => {
  assert.equal(typeof tokenearly.Client, 'function');
  assert.equal(typeof tokenearly.listings, 'function');
  assert.equal(tokenearly.BASE_URL, 'https://tokenearly.com');
});

test('named imports work through CommonJS interop', () => {
  assert.equal(Client, tokenearly.Client);
  assert.equal(Listing, tokenearly.Listing);
  assert.equal(TokenearlyError, tokenearly.TokenearlyError);
  assert.equal(typeof listings, 'function');
  assert.equal(typeof exchanges, 'function');
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
