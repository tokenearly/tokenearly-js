'use strict';

/** Tests for the client. No network: fetch is replaced by a canned responder. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DAYS,
  MAX_LIMIT,
  Client,
  Exchange,
  Listing,
  TokenearlyError,
} = require('../lib/client');
const { LISTING, EXCHANGE, fixture, fakeFetch, jsonResponse } = require('./helpers');

const LISTINGS_PATH = '/api/public/listings.json';
const EXCHANGES_PATH = '/api/public/exchanges.json';

function clientWith(routes, options = {}) {
  const f = fakeFetch(routes);
  const c = new Client({ fetch: f, ...options });
  c.fetchCalls = f.calls;
  return c;
}

// ---- Listing -------------------------------------------------------------------

test('Listing.fromObject maps every field', () => {
  const item = Listing.fromObject(LISTING);
  assert.equal(item.exchange, 'binance');
  assert.equal(item.exchangeName, 'Binance');
  assert.equal(item.type, 'spot');
  assert.deepEqual(item.symbols, ['ARB', 'OP']);
  assert.equal(item.publishedAt, '2026-09-10T08:12:00Z');
  assert.equal(item.sourceUrl, LISTING.source_url);
  assert.ok(item.permalink.endsWith('abc.html'));
  assert.equal(item.raw, LISTING);
});

test('Listing.headline falls back through languages', () => {
  const item = Listing.fromObject(LISTING);
  assert.ok(item.headline('ko').startsWith('바이낸스'));
  assert.ok(item.headline('zh').startsWith('币安'));
  // A language the feed does not carry falls back rather than returning ""
  assert.equal(item.headline('fr'), LISTING.title.en);
  assert.equal(item.headline(), LISTING.title.en);
});

test('Listing.headline of an empty title is empty, not an error', () => {
  assert.equal(Listing.fromObject({ title: {} }).headline(), '');
  assert.equal(Listing.fromObject({}).headline('zh'), '');
});

test('Listing.isFutures', () => {
  assert.equal(Listing.fromObject({ type: 'futures' }).isFutures, true);
  assert.equal(Listing.fromObject({ type: 'spot' }).isFutures, false);
});

test('Listing missing fields do not throw', () => {
  const item = Listing.fromObject({});
  assert.equal(item.exchange, '');
  assert.deepEqual(item.symbols, []);
  assert.deepEqual(item.title, {});
  assert.equal(item.publishedAt, null);
  const junk = Listing.fromObject(null);
  assert.equal(junk.exchange, '');
});

test('Listing symbols are coerced to strings', () => {
  assert.deepEqual(Listing.fromObject({ symbols: [1, 'OP'] }).symbols, ['1', 'OP']);
});

test('Listing.raw is not part of JSON output and the object is frozen', () => {
  const item = Listing.fromObject(LISTING);
  assert.equal(JSON.parse(JSON.stringify(item)).raw, undefined);
  assert.throws(() => {
    'use strict';
    item.exchange = 'x';
  }, TypeError);
  assert.match(String(item), /^\[Binance\] Binance Will List Arbitrum \(ARB\) \(ARB OP\)$/);
});

test('Listing.fromObject reads the live feed shape', () => {
  const feed = fixture('listings-feed.json');
  const items = feed.items.map(Listing.fromObject);
  assert.equal(items.length, feed.count);
  for (const item of items) {
    assert.ok(item.exchange);
    assert.ok(['spot', 'futures'].includes(item.type));
    assert.ok(item.headline('en'));
    assert.match(item.permalink, /^https:\/\/tokenearly\.com\//);
    assert.match(item.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
});

// ---- Exchange ------------------------------------------------------------------

test('Exchange.fromObject and websocket flag', () => {
  const ex = Exchange.fromObject(EXCHANGE);
  assert.equal(ex.id, 'gate');
  assert.equal(ex.name, 'Gate.io');
  assert.equal(ex.collection, 'websocket');
  assert.equal(ex.listings30d, 67);
  assert.equal(ex.spot30d, 26);
  assert.equal(ex.futures30d, 41);
  assert.equal(ex.websocket, true);
  assert.equal(ex.nameI18n.zh, '芝麻开门');
  assert.equal(ex.archiveUrl, EXCHANGE.archive_url);
});

test('Exchange polling is not websocket', () => {
  assert.equal(Exchange.fromObject({ collection: 'polling' }).websocket, false);
});

test('Exchange counts default to zero', () => {
  const ex = Exchange.fromObject({ id: 'x' });
  assert.deepEqual([ex.listings30d, ex.spot30d, ex.futures30d], [0, 0, 0]);
});

test('Exchange.fromObject reads the live feed shape', () => {
  const feed = fixture('exchanges-feed.json');
  const rows = feed.exchanges.map(Exchange.fromObject);
  assert.equal(rows.length, feed.exchanges_total);
  const total = rows.reduce((s, e) => s + e.listings30d, 0);
  assert.equal(total, feed.listings_30d_total);
  const ws = rows.filter((e) => e.websocket).map((e) => e.id).sort();
  assert.deepEqual(ws, [...feed.meta.collection.websocket_exchanges].sort());
});

// ---- listings() ----------------------------------------------------------------

test('listings() returns typed Listing objects', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { count: 1, items: [LISTING] } });
  const items = await c.listings();
  assert.equal(items.length, 1);
  assert.ok(items[0] instanceof Listing);
});

test('listings() sends the documented query parameters', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { items: [LISTING] } });
  await c.listings({ days: 3, exchange: 'BINANCE', type: 'spot', limit: 10 });
  const { url, init } = c.fetchCalls[0];
  assert.equal(url.pathname, LISTINGS_PATH);
  // exchange is lowercased for the caller, so "BINANCE" still matches
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    days: '3',
    exchange: 'binance',
    type: 'spot',
    limit: '10',
  });
  assert.equal(init.headers['User-Agent'], 'tokenearly-js');
  assert.equal(init.headers.Accept, 'application/json');
});

test('listings() drops empty parameters from the query', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { items: [] } });
  await c.listings({ days: 1, exchange: '', type: '', limit: 5 });
  const { url } = c.fetchCalls[0];
  assert.equal(url.searchParams.has('exchange'), false);
  assert.equal(url.searchParams.has('type'), false);
  assert.equal(url.searchParams.get('days'), '1');
  assert.equal(url.searchParams.get('limit'), '5');
});

for (const bad of [
  { days: 0 },
  { days: MAX_DAYS + 1 },
  { days: 1.5 },
  { limit: 0 },
  { limit: MAX_LIMIT + 1 },
  { type: 'perpetual' },
]) {
  test(`listings(${JSON.stringify(bad)}) fails locally instead of being clamped`, async () => {
    // The server clamps silently; failing here keeps the window honest.
    const c = clientWith({ [LISTINGS_PATH]: { items: [] } });
    await assert.rejects(c.listings(bad), RangeError);
    assert.equal(c.fetchCalls.length, 0); // never left the process
  });
}

test('listings() accepts the edges of the allowed range', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { items: [] } });
  await c.listings({ days: 1, limit: 1 });
  await c.listings({ days: MAX_DAYS, limit: MAX_LIMIT });
  assert.equal(c.fetchCalls.length, 2);
});

test('listings() response without items is an error, not an empty list', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { count: 0 } });
  await assert.rejects(c.listings(), (err) => err instanceof TokenearlyError && /items/.test(err.message));
});

test('listings() skips non-object entries', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { items: [LISTING, 'junk', null] } });
  assert.equal((await c.listings()).length, 1);
});

// ---- exchanges() ---------------------------------------------------------------

test('exchanges() returns typed Exchange objects', async () => {
  const c = clientWith({ [EXCHANGES_PATH]: { exchanges: [EXCHANGE] } });
  const rows = await c.exchanges();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'gate');
});

test('exchanges() response without array is an error', async () => {
  const c = clientWith({ [EXCHANGES_PATH]: { total: 10 } });
  await assert.rejects(c.exchanges(), (err) => err instanceof TokenearlyError && /exchanges/.test(err.message));
});

// ---- watch() -------------------------------------------------------------------

async function take(iter, n) {
  const out = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

test('watch() yields each listing once and oldest first', async () => {
  const newer = { ...LISTING, permalink: 'p2', published_at: '2026-09-10T09:00:00Z' };
  const older = { ...LISTING, permalink: 'p1', published_at: '2026-09-10T08:00:00Z' };
  // The feed returns newest first; watch should emit chronologically.
  const c = clientWith({ [LISTINGS_PATH]: { items: [newer, older] } });
  const seen = await take(c.watch({ interval: 0.001 }), 2);
  assert.deepEqual(seen.map((i) => i.permalink), ['p1', 'p2']);
});

test('watch() does not re-emit permalinks passed as seen', async () => {
  const routes = { [LISTINGS_PATH]: { items: [LISTING] } };
  const c = clientWith(routes);
  const gen = c.watch({ interval: 0.001, seen: [LISTING.permalink] });
  routes[LISTINGS_PATH] = { items: [LISTING, { ...LISTING, permalink: 'p9' }] };
  const [first] = await take(gen, 1);
  assert.equal(first.permalink, 'p9');
});

test('watch() survives a feed outage', async () => {
  let n = 0;
  const routes = {
    [LISTINGS_PATH]: () => {
      n += 1;
      return n < 3 ? new Response('down', { status: 503 }) : { items: [LISTING] };
    },
  };
  const c = clientWith(routes, { retries: 0 });
  const [first] = await take(c.watch({ interval: 0.001 }), 1);
  assert.equal(first.exchange, 'binance');
});

test('watch() stops when the signal aborts', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { items: [] } });
  const controller = new AbortController();
  const gen = c.watch({ interval: 60, signal: controller.signal });
  const pending = gen.next();
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.done, true);
});

test('watch() rejects a non-positive interval', async () => {
  await assert.rejects(new Client({ fetch: fakeFetch({}) }).watch({ interval: 0 }).next(), RangeError);
});

test('watch() passes filters through to the feed', async () => {
  const c = clientWith({ [LISTINGS_PATH]: { items: [LISTING] } });
  await take(c.watch({ interval: 0.001, days: 2, exchange: 'upbit', type: 'spot' }), 1);
  assert.deepEqual(Object.fromEntries(c.fetchCalls[0].url.searchParams), {
    days: '2',
    exchange: 'upbit',
    type: 'spot',
    limit: String(MAX_LIMIT),
  });
});

// ---- transport -----------------------------------------------------------------

test('base URL trailing slash is normalised', () => {
  assert.equal(new Client({ baseUrl: 'https://example.com/', fetch: fakeFetch({}) }).baseUrl, 'https://example.com');
});

test('a 4xx is not retried', async () => {
  let n = 0;
  const c = clientWith({ [LISTINGS_PATH]: () => { n += 1; return new Response('nope', { status: 404 }); } }, { retries: 3 });
  await assert.rejects(c.listings(), (err) => err instanceof TokenearlyError && /404/.test(err.message));
  assert.equal(n, 1); // a 404 will not become valid by asking again
});

test('a 5xx is retried then reported', async () => {
  let n = 0;
  const c = clientWith({ [LISTINGS_PATH]: () => { n += 1; return new Response('bad', { status: 503 }); } }, { retries: 2 });
  await assert.rejects(c.listings(), (err) => err instanceof TokenearlyError && /503/.test(err.message));
  assert.equal(n, 3);
});

test('a dropped connection is retried then reported with the cause', async () => {
  let n = 0;
  const c = clientWith(
    { [LISTINGS_PATH]: () => { n += 1; return new TypeError('fetch failed', { cause: new Error('ECONNRESET') }); } },
    { retries: 1 },
  );
  await assert.rejects(
    c.listings(),
    (err) => err instanceof TokenearlyError && /could not read/.test(err.message) && /ECONNRESET/.test(err.message),
  );
  assert.equal(n, 2);
});

test('a non-JSON body is reported clearly', async () => {
  const c = clientWith({ [LISTINGS_PATH]: new Response('<html>gateway</html>', { status: 200 }) });
  await assert.rejects(c.listings(), (err) => err instanceof TokenearlyError && /did not return JSON/.test(err.message));
});

test('every request carries a timeout signal', async () => {
  const c = clientWith({ [EXCHANGES_PATH]: jsonResponse({ exchanges: [] }) }, { timeout: 1234 });
  await c.exchanges();
  assert.ok(c.fetchCalls[0].init.signal instanceof AbortSignal);
});

test('a request that exceeds the timeout fails with a clear message', async () => {
  const c = clientWith(
    {
      [EXCHANGES_PATH]: (u, init) =>
        new Promise((_, reject) => {
          // A real socket keeps the event loop alive while waiting; a referenced
          // timer stands in for it here so the abort has a chance to fire.
          const pending = setTimeout(() => {}, 10000);
          init.signal.addEventListener('abort', () => {
            clearTimeout(pending);
            reject(init.signal.reason);
          });
        }),
    },
    { timeout: 20, retries: 0 },
  );
  await assert.rejects(c.exchanges(), (err) => err instanceof TokenearlyError && /timeout|abort/i.test(err.message));
});

test('package entry point exports the public API', () => {
  const pkg = require('..');
  for (const name of ['Client', 'Listing', 'Exchange', 'TokenearlyError', 'listings', 'exchanges', 'BASE_URL', 'VERSION']) {
    assert.ok(name in pkg, name);
  }
  assert.equal(pkg.VERSION, require('../package.json').version);
  assert.equal(pkg.BASE_URL, 'https://tokenearly.com');
});
