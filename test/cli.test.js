'use strict';

/** Tests for the command line interface. No network. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cli = require('../lib/cli');
const { LISTING, EXCHANGE, fakeFetch, sink } = require('./helpers');

const LISTINGS_PATH = '/api/public/listings.json';
const EXCHANGES_PATH = '/api/public/exchanges.json';

/** Run the CLI against a stubbed feed and capture both streams. */
async function run(argv, routes = {}, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const fetch = fakeFetch({
    [LISTINGS_PATH]: { count: 1, items: [LISTING] },
    [EXCHANGES_PATH]: { exchanges: [EXCHANGE] },
    ...routes,
  });
  const code = await cli.main(argv, { stdout, stderr, fetch, ...extra });
  return { code, out: stdout.toString(), err: stderr.toString(), calls: fetch.calls };
}

// ---- listings ------------------------------------------------------------------

test('listings: table output contains the headline and exchange', async () => {
  const r = await run(['listings']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Binance/);
  assert.match(r.out, /Arbitrum/);
  assert.match(r.out, /1 listing\(s\)\./);
  assert.match(r.out, /^published \(utc\) {3}exchange {2}type {2}symbols {2}headline/);
});

test('listings: --lang switches the headline', async () => {
  const r = await run(['--lang', 'zh', 'listings']);
  assert.equal(r.code, 0);
  assert.match(r.out, /币安将上线/);
});

test('listings: --json prints the raw feed objects', async () => {
  const r = await run(['--json', 'listings']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), [LISTING]);
});

test('listings: empty window says so instead of printing an empty table', async () => {
  const r = await run(['listings'], { [LISTINGS_PATH]: { count: 0, items: [] } });
  assert.equal(r.code, 0);
  assert.match(r.out, /No listings/);
});

test('listings: bad --days exits 2 with a message, not a stack trace', async () => {
  const r = await run(['listings', '--days', '999']);
  assert.equal(r.code, 2);
  assert.match(r.err, /days must be between/);
  assert.doesNotMatch(r.err, /at .*\.js:\d+/);
  assert.equal(r.calls.length, 0);
});

test('listings: non-integer --days is a usage error', async () => {
  const r = await run(['listings', '--days', 'seven']);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid int value/);
});

test('listings: bad --type is rejected by the parser', async () => {
  const r = await run(['listings', '--type', 'perpetual']);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid choice: 'perpetual'/);
});

test('listings: feed failure exits 1', async () => {
  const r = await run(['listings'], { [LISTINGS_PATH]: new TypeError('fetch failed') });
  assert.equal(r.code, 1);
  assert.match(r.err, /could not read/);
});

test('listings: a 404 exits 1 with the status', async () => {
  const r = await run(['listings'], { [LISTINGS_PATH]: new Response('', { status: 404 }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /HTTP 404/);
});

test('listings: long headline is truncated to --width', async () => {
  const r = await run(['--width', '20', 'listings'], {
    [LISTINGS_PATH]: { items: [{ ...LISTING, title: { en: 'x'.repeat(200) } }] },
  });
  assert.equal(r.code, 0);
  // 19 characters plus the ellipsis
  assert.match(r.out, new RegExp('x{19}…'));
  assert.doesNotMatch(r.out, /x{20}/);
});

test('listings: filters and --limit reach the feed as query parameters', async () => {
  const r = await run(['listings', '--days', '3', '--exchange', 'Binance', '--type', 'futures', '--limit', '9']);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.fromEntries(r.calls[0].url.searchParams), {
    days: '3',
    exchange: 'binance',
    type: 'futures',
    limit: '9',
  });
});

test('listings: --base-url and --timeout configure the client', async () => {
  const r = await run(['--base-url', 'https://example.test/', '--timeout', '2.5', 'listings']);
  assert.equal(r.code, 0);
  assert.equal(r.calls[0].url.origin, 'https://example.test');
});

// ---- exchanges -----------------------------------------------------------------

test('exchanges: table lists counts and names the websocket exchanges', async () => {
  const r = await run(['exchanges']);
  assert.equal(r.code, 0);
  assert.match(r.out, /gate/);
  assert.match(r.out, /67/);
  assert.match(r.out, /1 exchanges, 67 listings in the last 30 days\./);
  assert.match(r.out, /WebSocket stream for: gate/);
});

test('exchanges: no websocket line when all are polled', async () => {
  const r = await run(['exchanges'], { [EXCHANGES_PATH]: { exchanges: [{ ...EXCHANGE, collection: 'polling' }] } });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /WebSocket/);
});

test('exchanges: --json output', async () => {
  const r = await run(['--json', 'exchanges']);
  assert.equal(r.code, 0);
  const rows = JSON.parse(r.out);
  assert.equal(rows[0].id, 'gate');
  assert.equal(rows[0].listings_30d, 67);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'name', 'collection', 'listings_30d', 'spot_30d', 'futures_30d', 'archive_url']);
});

test('exchanges: does not accept listing filters', async () => {
  const r = await run(['exchanges', '--days', '3']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unrecognized arguments: --days/);
});

// ---- watch ---------------------------------------------------------------------

test('watch: prints one line per new listing and stops on abort', async () => {
  const controller = new AbortController();
  const stdout = sink();
  const stderr = sink();
  const fetch = fakeFetch({
    [LISTINGS_PATH]: () => {
      // Abort once the first poll has been served, so the run is bounded.
      setTimeout(() => controller.abort(), 5);
      return { items: [LISTING] };
    },
  });
  const code = await cli.main(['watch', '--interval', '60'], { stdout, stderr, fetch, signal: controller.signal });
  assert.equal(code, 0);
  const out = stdout.toString();
  assert.match(out, /Binance/);
  assert.match(out, /\[ARB OP\]/);
  assert.equal(out.split('\n').filter(Boolean).length, 1);
});

test('watch: --json prints one JSON object per line', async () => {
  const controller = new AbortController();
  const stdout = sink();
  const fetch = fakeFetch({
    [LISTINGS_PATH]: () => {
      setTimeout(() => controller.abort(), 5);
      return { items: [LISTING] };
    },
  });
  const code = await cli.main(['watch', '--json', '--interval', '60'], { stdout, stderr: sink(), fetch, signal: controller.signal });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.toString().trim()), LISTING);
});

test('watch: non-positive interval is a usage error', async () => {
  const r = await run(['watch', '--interval', '0']);
  assert.equal(r.code, 2);
  assert.match(r.err, /interval must be positive/);
});

// ---- parser --------------------------------------------------------------------

test('no command prints help and exits 2', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.out.toLowerCase(), /usage/);
});

test('--help exits 0 and --help after a command shows that command', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /commands:/);
  const w = await run(['watch', '-h']);
  assert.equal(w.code, 0);
  assert.match(w.out, /--interval/);
});

test('--version prints the package version', async () => {
  const r = await run(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), `tokenearly ${require('../package.json').version}`);
});

test('unknown command is a usage error', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid choice: 'frobnicate'/);
});

test('unknown option is a usage error', async () => {
  const r = await run(['listings', '--colour']);
  assert.equal(r.code, 2);
  assert.match(r.err, /colour/);
});

test('defaults match the documented values', () => {
  const l = cli.parse(['listings']);
  assert.equal(l.days, 7);
  assert.equal(l.limit, 50);
  assert.equal(l.lang, 'en');
  assert.equal(l.width, 72);
  const w = cli.parse(['watch']);
  assert.equal(w.days, 1);
  assert.equal(w.interval, 300);
});

test('table helper aligns columns', () => {
  const text = cli.table([['a', 'bbb'], ['cccc', 'd']], ['h1', 'h2']);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('h1'));
  // every row starts at the same offset for the second column
  assert.equal(lines[2].indexOf('bbb'), lines[3].indexOf('d'));
});

test('truncate counts characters, not UTF-16 code units', () => {
  assert.equal(cli.truncate('😀😀😀😀', 3), '😀😀…');
  assert.equal(cli.truncate('abc', 3), 'abc');
});

// ---- global option position ----------------------------------------------------
// Global options must work before and after the subcommand, and a value given
// before the subcommand must not be overwritten by the subcommand's default.

for (const argv of [['--lang', 'zh', 'listings'], ['listings', '--lang', 'zh']]) {
  test(`--lang works at position: ${argv.join(' ')}`, async () => {
    const r = await run(argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /币安将上线/);
  });
}

for (const argv of [['--json', 'listings'], ['listings', '--json']]) {
  test(`--json works at position: ${argv.join(' ')}`, async () => {
    const r = await run(argv);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), [LISTING]);
  });
}

for (const argv of [['--width', '20', 'listings'], ['listings', '--width', '20']]) {
  test(`--width works at position: ${argv.join(' ')}`, async () => {
    const r = await run(argv, { [LISTINGS_PATH]: { items: [{ ...LISTING, title: { en: 'x'.repeat(200) } }] } });
    assert.equal(r.code, 0);
    assert.match(r.out, /x{19}…/);
  });
}

test('defaults apply when nothing is given', async () => {
  const r = await run(['listings']);
  assert.match(r.out, /Arbitrum/); // en headline
  assert.doesNotMatch(r.out, /币安/);
});

test('the value closest to the command wins when both are given', async () => {
  const r = await run(['--lang', 'en', 'listings', '--lang', 'zh']);
  assert.equal(r.code, 0);
  assert.match(r.out, /币安将上线/);
});

// ---- the real executable -------------------------------------------------------

test('bin/tokenearly.js runs as a process and reports usage errors with exit 2', () => {
  const bin = path.join(__dirname, '..', 'bin', 'tokenearly.js');
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: tokenearly/);
  const bad = spawnSync(process.execPath, [bin, 'listings', '--days', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid int value/);
  const none = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.equal(none.status, 2);
});
