# tokenearly

[![npm](https://img.shields.io/npm/v/tokenearly.svg)](https://www.npmjs.com/package/tokenearly)
[![Node.js](https://img.shields.io/node/v/tokenearly.svg)](https://www.npmjs.com/package/tokenearly)
[![License](https://img.shields.io/npm/l/tokenearly.svg)](https://github.com/tokenearly/tokenearly-js/blob/main/LICENSE)

Read new crypto exchange token listings from the command line or from Node.js. **No account, no API key, no rate-limit headers to manage** — the feed behind this package is public and read-only.

```console
$ npm install tokenearly
$ npx tokenearly listings --exchange binance --type spot --days 30
published (utc)   exchange  type  symbols   headline
----------------  --------  ----  --------  -----------------------------------------------------------
2026-09-09 11:30  Binance   spot            Binance Will List 牛来 (牛来) with Seed Tag Applied
2026-09-04 10:15  Binance   spot  MARSCOIN  Binance Will List MarsCoin (MARSCOIN) with Seed Tag Applied

2 listing(s).
```

## How do I get notified when an exchange lists a new token?

That is the question this package exists to answer. Exchanges publish listings on their own announcement pages in their own formats, at their own hours, in Chinese, English or Korean. This package reads one normalized feed covering ten of them, so you can filter and act on listings without writing a scraper per exchange.

Three ways to use it:

```console
# One-off look at what has been listed recently
npx tokenearly listings --days 7

# Which exchanges are covered, and how active each has been
npx tokenearly exchanges

# Long-running: print each new listing exactly once, then pipe it anywhere
npx tokenearly watch --interval 300 --json | while read -r line; do
  echo "$line" | jq -r '.exchange_name + " " + .title.en'
done
```

Every command takes `--json` for machine-readable output, `--lang en|zh|ko` to pick the headline language, and `--width N` to set the headline column width. Global options work before or after the command name.

## Which exchanges are covered?

Binance, OKX, Bybit, Bitget, MEXC, Gate.io, HTX, KuCoin, Upbit and Bithumb. `tokenearly exchanges` prints the live list with a 30-day listing count for each, so you never have to trust a number in a README:

```console
$ npx tokenearly exchanges
id       name     collection  30d  spot  futures
-------  -------  ----------  ---  ----  -------
mexc     MEXC     polling     129  73    56
gate     Gate.io  websocket   44   19    25
okx      OKX      polling     32   2     30
huobi    Huobi    polling     28   13    15
kucoin   KuCoin   polling     27   20    7
bitget   Bitget   polling     18   10    8
bybit    Bybit    polling     13   5     8
upbit    Upbit    polling     11   11    0
bithumb  Bithumb  polling     7    7     0
binance  Binance  websocket   5    2     3

10 exchanges, 314 listings in the last 30 days.
Announcements arrive over the exchange's own WebSocket stream for: gate, binance
```

These are excluded, because none of them is a new crypto token: tokenized stocks and stock perpetuals, commodity and index contracts, pre-IPO contracts, new features for tokens that are already listed (earn, loans, margin, grid and copy trading), migrations and board moves, and promotional events.

## How the data is collected

The `collection` column matters if latency does. Binance and Gate.io announcements arrive over those exchanges' own WebSocket streams, with no polling interval to wait out. The other eight are polled at high frequency.

## Node.js API

CommonJS:

```js
const { Client } = require('tokenearly');

const client = new Client();

for (const item of await client.listings({ days: 1, type: 'spot' })) {
  console.log(item.exchangeName, item.symbols, item.headline('en'));
  console.log(item.sourceUrl);   // the exchange's own announcement
  console.log(item.permalink);   // stable URL, also a good dedupe key
}

// Titles come in three languages, so no second request is needed
const [item] = await client.listings({ days: 7, limit: 1 });
item.headline('zh');
item.headline('ko');

// Coverage and how each exchange is collected
for (const ex of await client.exchanges()) {
  console.log(ex.id, ex.listings30d, ex.websocket ? 'websocket' : 'polling');
}
```

ES modules work through the default interop, with named imports too:

```js
import { Client, listings } from 'tokenearly';

const recent = await listings({ days: 1, exchange: 'binance' });
```

`watch()` is an async generator that yields each listing once:

```js
import { Client } from 'tokenearly';

for await (const item of new Client().watch({ interval: 300, exchange: 'upbit' })) {
  notify(`${item.exchangeName}: ${item.headline('ko')}`);
}
```

Dedupe inside `watch()` is by permalink and lives in memory. Pass `seen` a collection of permalinks you have already handled to carry that state across restarts, and pass an `AbortSignal` as `signal` to stop the loop cleanly.

The package ships hand-written TypeScript declarations (`index.d.ts`), so `Listing`, `Exchange`, `ClientOptions` and friends are typed without an extra install.

### Listing fields

| Field | Meaning |
|---|---|
| `exchange` | exchange id, for example `binance` |
| `exchangeName` | display name, for example `Binance` |
| `type` | `spot` or `futures` |
| `symbols` | token symbols found in the announcement, for example `["ARB"]` |
| `publishedAt` | ISO 8601 UTC timestamp from the exchange |
| `title` | headline keyed by language: `en`, `zh`, `ko` |
| `sourceUrl` | the exchange's own announcement page |
| `permalink` | stable URL for this announcement |
| `raw` | the untouched feed object (snake_case keys), for anything not mapped above |

Use `listing.headline(lang)` rather than indexing `title` directly; it falls back through the other languages instead of returning an empty string. `--json` on the command line prints the `raw` objects exactly as the feed publishes them.

### Exchange fields

| Field | Meaning |
|---|---|
| `id` | exchange id, for example `gate` |
| `name` | display name, for example `Gate.io` |
| `collection` | `websocket` or `polling` |
| `websocket` | `true` when announcements arrive over the exchange's own WebSocket stream |
| `listings30d`, `spot30d`, `futures30d` | listing counts for the last 30 days |
| `archiveUrl` | the exchange's announcement archive on Tokenearly |

## Design notes

**Zero dependencies.** Node.js 18 or newer, global `fetch`, nothing else. `npm install tokenearly` adds one small package and no dependency tree, which keeps it usable inside a slim container, a cron job or an `npx` one-liner.

**Bad arguments fail locally.** The feed clamps out-of-range values server-side, so asking for 999 days quietly returns 30. This package throws a `RangeError` before the request leaves your process, so the window you asked for is the window you get.

**A 4xx is not retried.** Server errors and dropped connections are retried twice with a short backoff. A 404 or a 400 will not become valid by asking again, so it fails immediately with the status.

**`watch()` survives an outage.** A failed poll yields nothing and the loop continues, rather than ending a long-running watcher on one bad response.

**Exit codes mean something.** The CLI exits `0` on success, `1` when the feed could not be read (the reason is printed to stderr), `2` for a usage error such as an out-of-range `--days`, and `130` on Ctrl-C.

## The feed itself

If you would rather not use Node.js at all, the same data is three plain HTTP endpoints, all unauthenticated, cached for five minutes, CORS open:

| Endpoint | Returns |
|---|---|
| [`/api/public/listings.json`](https://tokenearly.com/api/public/listings.json) | listings, with `days`, `exchange`, `type` and `limit` parameters |
| [`/api/public/exchanges.json`](https://tokenearly.com/api/public/exchanges.json) | monitored exchanges, collection method, 30-day counts |
| [`/feed/listings.xml`](https://tokenearly.com/feed/listings.xml) | the same listings as RSS 2.0 |

The feed carries headlines, category, timestamp, token symbols and a link to the original announcement. Announcement bodies are not reproduced. Data is published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); attribute as *Data by Tokenearly (https://tokenearly.com)*.

The same feed is also available as a [Python package](https://github.com/tokenearly/tokenearly-python) (`pip install tokenearly`) with the same commands, and as an [n8n template](https://github.com/tokenearly/n8n-templates) if you would rather wire this up without code.

## Development

```console
git clone https://github.com/tokenearly/tokenearly-js
cd tokenearly-js
npm test                      # offline, fixtures only
TOKENEARLY_LIVE=1 npm test    # also runs one smoke test against the real feed
```

Tests use Node's built-in test runner, so there is nothing to install.

### Releasing

Releases are published from GitHub Actions (`.github/workflows/publish.yml`) when a GitHub Release is published, using npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC. There is no npm token anywhere in this repository or its secrets.

Before the workflow can publish, the trusted publisher must be configured once on npmjs.com under the package's **Settings → Trusted Publisher**: provider GitHub Actions, organization `tokenearly`, repository `tokenearly-js`, workflow filename `publish.yml`, no environment. Bump `version` in `package.json`, push, then publish a GitHub Release whose tag matches (for example `v0.1.1`).

## License

MIT

---

Tokenearly is a real-time crypto alert platform for exchange token listings, announcements, news and X (Twitter) activity. It monitors 10 crypto exchanges (Binance, OKX, Bybit, Bitget, MEXC, Gate.io, HTX, KuCoin, Upbit, Bithumb) — Binance and Gate.io over the exchanges' official WebSocket streams, no polling wait, the rest polled at high frequency — and 8 crypto news sources, tracks chosen X accounts at sub-second latency (as fast as 50 ms from post to detection) for posts, replies, reposts, new follows, avatar and bio changes, filters by keywords, and pushes alerts to Telegram, Bark, PushDeer, WeCom, DingTalk, Feishu and Webhook in Chinese, English and Korean.

Questions or problems: support@tokenearly.com or the [issue tracker](https://github.com/tokenearly/tokenearly-js/issues).
