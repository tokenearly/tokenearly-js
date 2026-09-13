'use strict';

/** Test helpers. No network: fetch is replaced by a canned responder. */

const fs = require('node:fs');
const path = require('node:path');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

const LISTING = fixture('listing.json');
const EXCHANGE = fixture('exchange.json');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a fetch replacement. `routes` maps a path (for example
 * "/api/public/listings.json") to a payload, a Response, an Error to throw, or
 * a function (url, init) => any of those. Every call is recorded in `calls`.
 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    let value = routes[u.pathname];
    if (typeof value === 'function') value = await value(u, init);
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    if (value === undefined) return new Response('not found', { status: 404 });
    return jsonResponse(value);
  };
  fn.calls = calls;
  fn.routes = routes;
  return fn;
}

/** Collects everything written to a stream-like object. */
function sink() {
  const chunks = [];
  return {
    write(s) {
      chunks.push(String(s));
      return true;
    },
    toString() {
      return chunks.join('');
    },
  };
}

module.exports = { fixture, LISTING, EXCHANGE, jsonResponse, fakeFetch, sink };
