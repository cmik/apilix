#!/usr/bin/env node
'use strict';

const { runCli } = require('../packages/cli/src/index');

(async () => {
  process.exitCode = await runCli(process.argv.slice(2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});