'use strict';

/**
 * Opt-in smoke test against the real feed. Skipped unless TOKENEARLY_LIVE=1,
 * so the default `npm test` never touches the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Client, Listing, Exchange } = require('../lib/client');
const cli = require('../lib/cli');
const { sink } = require('./helpers');

const live = process.env.TOKENEARLY_LIVE === '1';

test('live: exchanges() and listings() read the public feed', { skip: !live && 'set TOKENEARLY_LIVE=1' }, async () => {
  const client = new Client();
  const rows = await client.exchanges();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((e) => e instanceof Exchange && e.id && e.name));
  assert.ok(rows.some((e) => e.websocket), 'at least one exchange is collected over WebSocket');

  const items = await client.listings({ days: 30, limit: 5 });
  assert.ok(items.length >= 1);
  assert.ok(items.every((i) => i instanceof Listing && i.permalink && i.headline('en')));
});

test('live: the CLI prints a table and JSON', { skip: !live && 'set TOKENEARLY_LIVE=1' }, async () => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(await cli.main(['exchanges'], { stdout, stderr }), 0);
  assert.match(stdout.toString(), /exchanges, \d+ listings in the last 30 days\./);

  const json = sink();
  assert.equal(await cli.main(['listings', '--days', '30', '--limit', '2', '--json'], { stdout: json, stderr }), 0);
  const items = JSON.parse(json.toString());
  assert.ok(Array.isArray(items) && items.length >= 1);
  assert.equal(stderr.toString(), '');
});
