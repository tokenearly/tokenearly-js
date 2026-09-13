'use strict';

/**
 * Read new crypto exchange token listings from the public Tokenearly feed.
 *
 * The feed is read-only and needs no account and no API key:
 *
 *   const { listings } = require('tokenearly');
 *   for (const item of await listings({ days: 1, exchange: 'binance' })) {
 *     console.log(item.exchangeName, item.headline());
 *   }
 *
 * There is also a command line entry point:
 *
 *   tokenearly listings --exchange binance --type spot
 *   tokenearly exchanges
 *   tokenearly watch --interval 300
 */

const client = require('./lib/client');
const { version } = require('./package.json');

// Assigned one by one (not as an object literal) so that
// `import { Client } from 'tokenearly'` works from ES modules too.
exports.BASE_URL = client.BASE_URL;
exports.MAX_DAYS = client.MAX_DAYS;
exports.MAX_LIMIT = client.MAX_LIMIT;
exports.LISTING_TYPES = client.LISTING_TYPES;
exports.LANGS = client.LANGS;
exports.Client = client.Client;
exports.Listing = client.Listing;
exports.Exchange = client.Exchange;
exports.TokenearlyError = client.TokenearlyError;
exports.listings = client.listings;
exports.exchanges = client.exchanges;
exports.VERSION = version;
