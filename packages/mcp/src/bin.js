#!/usr/bin/env node
'use strict';

// Standalone launcher (the usual entry point is `apilix mcp`).
const { runMcp } = require('./main');

runMcp(process.argv.slice(2)).then((code) => {
  process.exit(code);
}, (err) => {
  process.stderr.write(`apilix-mcp: fatal: ${err && err.message}\n`);
  process.exit(2);
});
