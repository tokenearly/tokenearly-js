'use strict';

/**
 * Command line interface.
 *
 *   tokenearly listings --exchange binance --type spot
 *   tokenearly exchanges
 *   tokenearly watch --interval 300
 *
 * Every command takes `--json` so the output can be piped into jq or another
 * program instead of read by a person.
 */

const { parseArgs } = require('node:util');
const {
  MAX_DAYS,
  MAX_LIMIT,
  LANGS,
  LISTING_TYPES,
  Client,
  TokenearlyError,
} = require('./client');
const { version } = require('../package.json');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://tokenearly.com',
  timeout: 20, // seconds, as typed on the command line
  json: false,
  lang: 'en',
  width: 72,
});

const COMMANDS = Object.freeze({
  listings: 'recent listing announcements',
  exchanges: 'monitored exchanges and 30-day counts',
  watch: 'poll and print each new listing once',
});

// Options accepted before or after the subcommand.
const GLOBAL_OPTIONS = {
  'base-url': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
  lang: { type: 'string' },
  width: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const FILTER_OPTIONS = {
  days: { type: 'string' },
  exchange: { type: 'string' },
  type: { type: 'string' },
};

const COMMAND_OPTIONS = {
  listings: { ...FILTER_OPTIONS, limit: { type: 'string' } },
  exchanges: {},
  watch: { ...FILTER_OPTIONS, interval: { type: 'string' } },
};

class UsageError extends Error {}

// ---- output helpers ----------------------------------------------------------

/** Plain text table. No dependency, and it stays aligned in a pipe. */
function table(rows, headers) {
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length);
    });
  }
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(headers), widths.map((w) => '-'.repeat(w)).join('  ').trimEnd()];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

function truncate(text, width) {
  const chars = Array.from(text);
  return chars.length <= width ? text : chars.slice(0, Math.max(width - 1, 0)).join('') + '…';
}

function when(publishedAt) {
  return String(publishedAt || '').slice(0, 16).replace('T', ' ');
}

function listingRow(item, lang, width) {
  return [
    when(item.publishedAt),
    item.exchangeName || item.exchange,
    item.type,
    item.symbols.join(',').slice(0, 24),
    truncate(item.headline(lang), width),
  ];
}

function dump(io, payload) {
  io.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

// ---- commands ----------------------------------------------------------------

async function cmdListings(args, io) {
  const items = await io.client.listings({
    days: args.days,
    exchange: args.exchange,
    type: args.type,
    limit: args.limit,
  });
  if (args.json) {
    dump(io, items.map((i) => i.raw));
    return 0;
  }
  if (items.length === 0) {
    io.stdout.write('No listings in that window.\n');
    return 0;
  }
  const rows = items.map((i) => listingRow(i, args.lang, args.width));
  io.stdout.write(table(rows, ['published (utc)', 'exchange', 'type', 'symbols', 'headline']) + '\n');
  io.stdout.write(`\n${items.length} listing(s).\n`);
  return 0;
}

async function cmdExchanges(args, io) {
  const rows = await io.client.exchanges();
  if (args.json) {
    dump(
      io,
      rows.map((e) => ({
        id: e.id,
        name: e.name,
        collection: e.collection,
        listings_30d: e.listings30d,
        spot_30d: e.spot30d,
        futures_30d: e.futures30d,
        archive_url: e.archiveUrl,
      })),
    );
    return 0;
  }
  const cells = rows.map((e) => [
    e.id,
    e.name,
    e.collection,
    String(e.listings30d),
    String(e.spot30d),
    String(e.futures30d),
  ]);
  io.stdout.write(table(cells, ['id', 'name', 'collection', '30d', 'spot', 'futures']) + '\n');
  const total = rows.reduce((sum, e) => sum + e.listings30d, 0);
  const ws = rows.filter((e) => e.websocket).map((e) => e.id);
  io.stdout.write(`\n${rows.length} exchanges, ${total} listings in the last 30 days.\n`);
  if (ws.length) {
    io.stdout.write(
      "Announcements arrive over the exchange's own WebSocket stream for: " + ws.join(', ') + '\n',
    );
  }
  return 0;
}

async function cmdWatch(args, io) {
  const stream = io.client.watch({
    interval: args.interval,
    days: args.days,
    exchange: args.exchange,
    type: args.type,
    signal: io.signal,
  });
  for await (const item of stream) {
    if (args.json) {
      io.stdout.write(JSON.stringify(item.raw) + '\n');
    } else {
      const syms = item.symbols.length ? `  [${item.symbols.join(' ')}]` : '';
      io.stdout.write(
        `${when(item.publishedAt)}  ${item.exchangeName}  ${item.type}${syms}  ` +
          `${truncate(item.headline(args.lang), args.width)}\n`,
      );
    }
  }
  return 0;
}

const HANDLERS = { listings: cmdListings, exchanges: cmdExchanges, watch: cmdWatch };

// ---- argument handling -------------------------------------------------------

function helpText(command) {
  const global = [
    '  --json              print raw JSON instead of a table',
    `  --lang <en|zh|ko>   headline language (default: ${DEFAULTS.lang})`,
    `  --width <n>         headline column width (default: ${DEFAULTS.width})`,
    `  --timeout <sec>     request timeout in seconds (default: ${DEFAULTS.timeout})`,
    '  -h, --help          show this help',
    '  --version           print the package version',
  ].join('\n');
  const filters = (defaultDays) =>
    [
      `  --days <n>          look back N days, 1-${MAX_DAYS} (default: ${defaultDays})`,
      '  --exchange <id>     exchange id, for example binance',
      `  --type <t>          listing type: ${LISTING_TYPES.join(' or ')} (default: both)`,
    ].join('\n');
  if (command === 'listings') {
    return [
      'usage: tokenearly listings [options]',
      '',
      COMMANDS.listings,
      '',
      filters(7),
      `  --limit <n>         max rows, 1-${MAX_LIMIT} (default: 50)`,
      global,
      '',
    ].join('\n');
  }
  if (command === 'exchanges') {
    return ['usage: tokenearly exchanges [options]', '', COMMANDS.exchanges, '', global, ''].join('\n');
  }
  if (command === 'watch') {
    return [
      'usage: tokenearly watch [options]',
      '',
      COMMANDS.watch,
      '',
      filters(1),
      '  --interval <sec>    seconds between polls (default: 300)',
      global,
      '',
    ].join('\n');
  }
  return [
    'usage: tokenearly [options] <command> [options]',
    '',
    'Read new crypto exchange token listings from the public Tokenearly feed.',
    'No account, no API key.',
    '',
    'commands:',
    ...Object.entries(COMMANDS).map(([name, desc]) => `  ${name.padEnd(12)}${desc}`),
    '',
    'options:',
    global,
    '',
    'Run `tokenearly <command> --help` for the options of one command.',
    '',
  ].join('\n');
}

function toInt(name, value) {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(String(value).trim())) {
    throw new UsageError(`argument --${name}: invalid int value: '${value}'`);
  }
  return Number(value);
}

function toFloat(name, value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(n)) {
    throw new UsageError(`argument --${name}: invalid float value: '${value}'`);
  }
  return n;
}

function choice(name, value, allowed) {
  if (value !== undefined && !allowed.includes(value)) {
    const shown = allowed.map((a) => `'${a}'`).join(', ');
    throw new UsageError(`argument --${name}: invalid choice: '${value}' (choose from ${shown})`);
  }
  return value;
}

/**
 * Parse argv into a plain object. Global options work before and after the
 * subcommand, and when both are given the later one wins.
 */
function parse(argv) {
  const allOptions = { ...GLOBAL_OPTIONS, ...FILTER_OPTIONS, limit: { type: 'string' }, interval: { type: 'string' } };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: allOptions, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;

  if (values.version) return { command: 'version' };
  const command = positionals[0];
  if (values.help) return { command: 'help', topic: command };
  if (positionals.length === 0) return { command: 'help', topic: undefined, missing: true };
  if (!COMMANDS[command]) {
    const shown = Object.keys(COMMANDS).map((c) => `'${c}'`).join(', ');
    throw new UsageError(`argument command: invalid choice: '${command}' (choose from ${shown})`);
  }
  if (positionals.length > 1) {
    throw new UsageError(`unrecognized arguments: ${positionals.slice(1).join(' ')}`);
  }
  const allowed = { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command] };
  for (const key of Object.keys(values)) {
    if (!allowed[key]) throw new UsageError(`unrecognized arguments: --${key}`);
  }

  const args = {
    command,
    baseUrl: values['base-url'] || DEFAULTS.baseUrl,
    timeout: toFloat('timeout', values.timeout) ?? DEFAULTS.timeout,
    json: Boolean(values.json),
    lang: choice('lang', values.lang, LANGS) || DEFAULTS.lang,
    width: toInt('width', values.width) ?? DEFAULTS.width,
  };
  if (command === 'listings' || command === 'watch') {
    args.days = toInt('days', values.days) ?? (command === 'listings' ? 7 : 1);
    args.exchange = values.exchange || '';
    args.type = choice('type', values.type, ['', ...LISTING_TYPES]) || '';
  }
  if (command === 'listings') args.limit = toInt('limit', values.limit) ?? 50;
  if (command === 'watch') args.interval = toFloat('interval', values.interval) ?? 300;
  return args;
}

/**
 * Run the CLI. Returns the process exit code instead of calling process.exit,
 * so it can be tested and embedded.
 *
 * @param {string[]} argv       arguments after the program name
 * @param {object} [io]
 * @param {{write(s:string):any}} [io.stdout]
 * @param {{write(s:string):any}} [io.stderr]
 * @param {typeof fetch} [io.fetch]   fetch implementation handed to the Client
 * @param {AbortSignal} [io.signal]   stops `watch`
 */
async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try {
    args = parse(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(helpText(undefined).split('\n')[0] + '\n');
      stderr.write(`tokenearly: error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (args.command === 'version') {
    stdout.write(`tokenearly ${version}\n`);
    return 0;
  }
  if (args.command === 'help') {
    stdout.write(helpText(args.topic));
    return args.missing ? 2 : 0;
  }
  const client = new Client({
    baseUrl: args.baseUrl,
    timeout: args.timeout * 1000,
    fetch: io.fetch,
  });
  try {
    return await HANDLERS[args.command](args, { stdout, stderr, client, signal: io.signal });
  } catch (err) {
    if (err instanceof RangeError) {
      stderr.write(`tokenearly: ${err.message}\n`);
      return 2;
    }
    if (err instanceof TokenearlyError) {
      stderr.write(`tokenearly: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

module.exports = { main, parse, table, truncate, helpText, DEFAULTS, UsageError };
