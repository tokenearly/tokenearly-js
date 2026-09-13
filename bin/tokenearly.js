#!/usr/bin/env node
'use strict';

// Node 18 prints an ExperimentalWarning the first time global fetch is used.
// The API is stable from Node 21 on; hide that one notice so piped output stays
// clean, and re-emit every other warning the way Node would have.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /fetch/i.test(warning.message)) return;
  process.stderr.write(`(node) ${warning.name}: ${warning.message}\n`);
});

const { main } = require('../lib/cli');

const controller = new AbortController();
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
  controller.abort();
});

main(process.argv.slice(2), { signal: controller.signal })
  .then((code) => {
    process.exitCode = interrupted ? 130 : code;
  })
  .catch((err) => {
    process.stderr.write(`tokenearly: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
