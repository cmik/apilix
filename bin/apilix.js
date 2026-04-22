#!/usr/bin/env node
'use strict';

const { runCli } = require('../server/cli-runner');

(async () => {
  process.exitCode = await runCli(process.argv.slice(2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});