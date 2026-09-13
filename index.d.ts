/**
 * Read new crypto exchange token listings from the public Tokenearly feed.
 * No account, no API key.
 */

/** Feed origin: https://tokenearly.com */
export const BASE_URL: string;
/** Largest `days` window the feed accepts. */
export const MAX_DAYS: number;
/** Largest `limit` the feed accepts. */
export const MAX_LIMIT: number;
export const LISTING_TYPES: readonly ['spot', 'futures'];
/** Headline languages carried by the feed. */
export const LANGS: readonly ['en', 'zh', 'ko'];
/** Package version. */
export const VERSION: string;

export type ListingType = 'spot' | 'futures';
export type Lang = 'en' | 'zh' | 'ko';

/** The untouched listing object as published by the feed. */
export interface RawListing {
  exchange: string;
  exchange_name: string;
  type: ListingType | string;
  symbols: string[];
  published_at: string | null;
  title: Partial<Record<Lang, string>> & Record<string, string>;
  source_url: string;
  permalink: string;
  [key: string]: unknown;
}

/** The untouched exchange object as published by the feed. */
export interface RawExchange {
  id: string;
  name: string;
  name_i18n?: Partial<Record<Lang, string>> & Record<string, string>;
  collection: 'websocket' | 'polling' | string;
  listings_30d: number;
  spot_30d: number;
  futures_30d: number;
  archive_url?: string;
  [key: string]: unknown;
}

/** Raised when the feed cannot be read or returns something unusable. */
export class TokenearlyError extends Error {
  name: 'TokenearlyError';
}

/**
 * One listing announcement.
 *
 * `title` holds the headline in every language the feed publishes, so
 * `listing.headline('ko')` works without a second request.
 */
export class Listing {
  /** exchange id, for example `binance` */
  readonly exchange: string;
  /** display name, for example `Binance` */
  readonly exchangeName: string;
  /** `spot` or `futures` */
  readonly type: ListingType | string;
  /** token symbols found in the announcement, for example `["ARB"]` */
  readonly symbols: string[];
  /** ISO 8601 UTC timestamp from the exchange */
  readonly publishedAt: string | null;
  /** headline keyed by language: `en`, `zh`, `ko` */
  readonly title: Partial<Record<Lang, string>> & Record<string, string>;
  /** the exchange's own announcement page */
  readonly sourceUrl: string;
  /** stable URL for this announcement, also a good dedupe key */
  readonly permalink: string;
  /** the untouched feed object, for anything not mapped above (not enumerable) */
  readonly raw: RawListing;

  static fromObject(d: unknown): Listing;
  /** Headline in `lang`, falling back through the other languages. */
  headline(lang?: Lang | string): string;
  readonly isFutures: boolean;
  toString(): string;
}

/** One monitored exchange and how its announcements are collected. */
export class Exchange {
  readonly id: string;
  readonly name: string;
  readonly nameI18n: Partial<Record<Lang, string>> & Record<string, string>;
  /** `websocket` or `polling` */
  readonly collection: 'websocket' | 'polling' | string;
  readonly listings30d: number;
  readonly spot30d: number;
  readonly futures30d: number;
  readonly archiveUrl: string;

  static fromObject(d: unknown): Exchange;
  /** True when announcements arrive over the exchange's own WebSocket stream. */
  readonly websocket: boolean;
}

export interface ClientOptions {
  /** Feed origin. Default `https://tokenearly.com`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 20000. */
  timeout?: number;
  /** Retries for dropped connections and 5xx responses. 4xx is never retried. Default 2. */
  retries?: number;
  /** Default `tokenearly-js`. */
  userAgent?: string;
  /** fetch implementation. Default the global fetch (Node 18+). */
  fetch?: typeof fetch;
}

export interface ListingsOptions {
  /** Look back N days, 1-30. Default 7. */
  days?: number;
  /** Exchange id such as `binance`. Default every exchange. */
  exchange?: string;
  /** `spot` or `futures`. Default both. */
  type?: ListingType | '';
  /** Max rows, 1-500. Default 200. */
  limit?: number;
}

export interface WatchOptions {
  /** Seconds between polls. Default 300. */
  interval?: number;
  /** Look back N days on each poll, 1-30. Default 1. */
  days?: number;
  exchange?: string;
  type?: ListingType | '';
  /** Permalinks already handled, so a restart does not re-emit them. */
  seen?: Iterable<string>;
  /** Abort to end the watch. */
  signal?: AbortSignal;
}

/** Reads the public feed. */
export class Client {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly retries: number;
  readonly userAgent: string;

  constructor(options?: ClientOptions);

  /**
   * Listing announcements from the last `days` days, newest first.
   * Throws `RangeError` locally for out-of-range arguments and
   * `TokenearlyError` when the feed cannot be read.
   */
  listings(options?: ListingsOptions): Promise<Listing[]>;

  /** The monitored exchanges, busiest first. */
  exchanges(): Promise<Exchange[]>;

  /**
   * Yield each listing once, polling every `interval` seconds until `signal`
   * aborts. A failed poll yields nothing and the loop continues.
   */
  watch(options?: WatchOptions): AsyncGenerator<Listing, void, undefined>;
}

/** Shortcut for `new Client().listings(options)`. */
export function listings(options?: ListingsOptions): Promise<Listing[]>;

/** Shortcut for `new Client().exchanges()`. */
export function exchanges(): Promise<Exchange[]>;
