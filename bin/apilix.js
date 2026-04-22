#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/cli/index');

(async () => {
  process.exitCode = await runCli(process.argv.slice(2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});