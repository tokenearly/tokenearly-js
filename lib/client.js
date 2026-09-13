'use strict';

/**
 * Client for the public Tokenearly listings feed.
 *
 * The feed is read-only and unauthenticated, so there is nothing to configure
 * and no account to create. Everything here uses the Node.js standard library
 * only (global fetch, Node 18+), so the install has no dependency tree.
 */

const BASE_URL = 'https://tokenearly.com';
const USER_AGENT = 'tokenearly-js';

// Server-side caps, mirrored here so a bad argument fails locally with a clear
// message instead of being silently clamped and returning a surprising window.
const MAX_DAYS = 30;
const MAX_LIMIT = 500;
const LISTING_TYPES = Object.freeze(['spot', 'futures']);
const LANGS = Object.freeze(['en', 'zh', 'ko']);

/** Raised when the feed cannot be read or returns something unusable. */
class TokenearlyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TokenearlyError';
  }
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function i18n(value) {
  const out = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v) out[k] = String(v);
    }
  }
  return out;
}

/**
 * One listing announcement.
 *
 * `title` holds the headline in every language the feed publishes, so
 * `listing.headline('ko')` works without a second request.
 */
class Listing {
  constructor(fields = {}) {
    this.exchange = str(fields.exchange);
    this.exchangeName = str(fields.exchangeName);
    this.type = str(fields.type);
    this.symbols = Array.isArray(fields.symbols) ? fields.symbols.map(String) : [];
    this.publishedAt = fields.publishedAt === undefined ? null : fields.publishedAt;
    this.title = fields.title && typeof fields.title === 'object' ? { ...fields.title } : {};
    this.sourceUrl = str(fields.sourceUrl);
    this.permalink = str(fields.permalink);
    // The untouched feed object, for anything not mapped above.
    Object.defineProperty(this, 'raw', {
      value: fields.raw === undefined ? {} : fields.raw,
      enumerable: false,
      writable: false,
    });
    Object.freeze(this);
  }

  static fromObject(d) {
    const src = d && typeof d === 'object' ? d : {};
    return new Listing({
      exchange: src.exchange,
      exchangeName: src.exchange_name,
      type: src.type,
      symbols: Array.isArray(src.symbols) ? src.symbols : [],
      publishedAt: src.published_at === undefined ? null : src.published_at,
      title: i18n(src.title),
      sourceUrl: src.source_url,
      permalink: src.permalink,
      raw: src,
    });
  }

  /** Headline in `lang`, falling back through the other languages. */
  headline(lang = 'en') {
    for (const key of [lang, ...LANGS]) {
      const value = this.title[key];
      if (value) return value;
    }
    return '';
  }

  get isFutures() {
    return this.type === 'futures';
  }

  toString() {
    const syms = this.symbols.join(' ');
    return `[${this.exchangeName}] ${this.headline()}` + (syms ? ` (${syms})` : '');
  }
}

/** One monitored exchange and how its announcements are collected. */
class Exchange {
  constructor(fields = {}) {
    this.id = str(fields.id);
    this.name = str(fields.name);
    this.collection = str(fields.collection);
    this.listings30d = int(fields.listings30d);
    this.spot30d = int(fields.spot30d);
    this.futures30d = int(fields.futures30d);
    this.archiveUrl = str(fields.archiveUrl);
    this.nameI18n = fields.nameI18n && typeof fields.nameI18n === 'object' ? { ...fields.nameI18n } : {};
    Object.freeze(this);
  }

  static fromObject(d) {
    const src = d && typeof d === 'object' ? d : {};
    return new Exchange({
      id: src.id,
      name: src.name,
      collection: src.collection,
      listings30d: src.listings_30d,
      spot30d: src.spot_30d,
      futures30d: src.futures_30d,
      archiveUrl: src.archive_url,
      nameI18n: i18n(src.name_i18n),
    });
  }

  /** True when announcements arrive over the exchange's own WebSocket stream. */
  get websocket() {
    return this.collection === 'websocket';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function validateListingArgs({ days, limit, type }) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new RangeError(`days must be between 1 and ${MAX_DAYS}, got ${days}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${MAX_LIMIT}, got ${limit}`);
  }
  if (type && !LISTING_TYPES.includes(type)) {
    throw new RangeError(`type must be one of ${LISTING_TYPES.join(', ')}, got '${type}'`);
  }
}

/**
 * Reads the public feed.
 *
 *   const { Client } = require('tokenearly');
 *   for (const item of await new Client().listings({ days: 1, exchange: 'binance' })) {
 *     console.log(item.exchangeName, item.headline());
 *   }
 */
class Client {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]   feed origin, default https://tokenearly.com
   * @param {number} [options.timeout]   per-request timeout in milliseconds, default 20000
   * @param {number} [options.retries]   retries for dropped connections and 5xx, default 2
   * @param {string} [options.userAgent]
   * @param {typeof fetch} [options.fetch]  fetch implementation, default global fetch
   */
  constructor(options = {}) {
    const {
      baseUrl = BASE_URL,
      timeout = 20000,
      retries = 2,
      userAgent = USER_AGENT,
      fetch: fetchImpl,
    } = options;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeout = Number(timeout);
    // Retries cover the ordinary case of a dropped connection. They are
    // deliberately not applied to 4xx, which will not become valid by asking again.
    this.retries = Math.max(0, Math.trunc(Number(retries)) || 0);
    this.userAgent = userAgent;
    this._fetch = fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new TokenearlyError('global fetch is not available; Node.js 18 or newer is required');
    }
  }

  // ---- transport ---------------------------------------------------------

  async _get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const href = url.toString();
    let last = null;
    let body = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this._fetch(href, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (response.status >= 400 && response.status < 500) {
          // A 4xx will not fix itself; fail immediately with the status.
          throw new TokenearlyError(`${href} returned HTTP ${response.status}`);
        }
        if (!response.ok) {
          last = new Error(`HTTP ${response.status}`);
        } else {
          body = await response.text();
          break;
        }
      } catch (err) {
        if (err instanceof TokenearlyError) throw err;
        last = err;
      }
      if (attempt < this.retries) await sleep(500 * (attempt + 1));
    }
    if (body === null) {
      let reason = last && last.message ? last.message : String(last);
      if (last && last.cause && last.cause.message) reason += ` (${last.cause.message})`;
      throw new TokenearlyError(`could not read ${href}: ${reason}`, { cause: last });
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new TokenearlyError(`${href} did not return JSON`, { cause: err });
    }
  }

  // ---- endpoints ---------------------------------------------------------

  /**
   * Listing announcements from the last `days` days, newest first.
   *
   * `exchange` takes an exchange id such as `binance`; `type` takes `spot` or
   * `futures`. Both default to everything.
   */
  async listings(options = {}) {
    const { days = 7, exchange = '', type = '', limit = 200 } = options;
    validateListingArgs({ days, limit, type });
    const payload = await this._get('/api/public/listings.json', {
      days,
      exchange: String(exchange).toLowerCase(),
      type,
      limit,
    });
    const items = payload && typeof payload === 'object' ? payload.items : undefined;
    if (!Array.isArray(items)) {
      throw new TokenearlyError('listings response had no items array');
    }
    return items.filter((d) => d && typeof d === 'object').map(Listing.fromObject);
  }

  /** The monitored exchanges, busiest first. */
  async exchanges() {
    const payload = await this._get('/api/public/exchanges.json');
    const rows = payload && typeof payload === 'object' ? payload.exchanges : undefined;
    if (!Array.isArray(rows)) {
      throw new TokenearlyError('exchanges response had no exchanges array');
    }
    return rows.filter((d) => d && typeof d === 'object').map(Exchange.fromObject);
  }

  // ---- polling -----------------------------------------------------------

  /**
   * Yield each listing once, polling every `interval` seconds until `signal`
   * aborts (or forever).
   *
   * Dedupe is by permalink and lives in memory, so a restart may re-emit
   * whatever is still inside the `days` window. Pass `seen` to carry state
   * across restarts yourself.
   */
  async *watch(options = {}) {
    const { interval = 300, days = 1, exchange = '', type = '', seen, signal } = options;
    if (!(Number(interval) > 0)) {
      throw new RangeError('interval must be positive');
    }
    validateListingArgs({ days, limit: MAX_LIMIT, type });
    const known = new Set(seen || []);
    while (!(signal && signal.aborted)) {
      let batch;
      try {
        batch = await this.listings({ days, exchange, type, limit: MAX_LIMIT });
      } catch (err) {
        // A transient outage should not end a long-running watcher.
        if (!(err instanceof TokenearlyError)) throw err;
        batch = [];
      }
      // The feed is newest first; emit oldest first so output reads chronologically.
      for (let i = batch.length - 1; i >= 0; i -= 1) {
        const item = batch[i];
        const key = item.permalink || `${item.exchange}:${item.publishedAt}:${item.headline()}`;
        if (known.has(key)) continue;
        known.add(key);
        yield item;
      }
      await sleep(Number(interval) * 1000, signal);
    }
  }
}

let defaultClient = null;
function getDefault() {
  if (!defaultClient) defaultClient = new Client();
  return defaultClient;
}

/** Shortcut for `new Client().listings(options)`. */
function listings(options) {
  return getDefault().listings(options);
}

/** Shortcut for `new Client().exchanges()`. */
function exchanges() {
  return getDefault().exchanges();
}

module.exports = {
  BASE_URL,
  USER_AGENT,
  MAX_DAYS,
  MAX_LIMIT,
  LISTING_TYPES,
  LANGS,
  Client,
  Listing,
  Exchange,
  TokenearlyError,
  listings,
  exchanges,
};
