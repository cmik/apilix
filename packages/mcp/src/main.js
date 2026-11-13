'use strict';

const path = require('node:path');
const { parseMcpArgs, helpText, runEnabled, runMode } = require('./args');
const { createWorkspaces } = require('./workspace');
const { createMcpServer } = require('./server');
const { installHostGuard } = require('./host-guard');

const pkg = require('../package.json');

/**
 * Entry point of `apilix mcp`. Returns the process exit code once stdin is closed.
 * @param {string[]} argv flags after "mcp"
 * @param {{cwd?:string, stdin?:NodeJS.ReadableStream, stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream}} [io]
 * @param {{extraTools?:Array, session?:object}} [hooks] used by later layers (run/write tools)
 */
async function runMcp(argv, io = {}, hooks = {}) {
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();
  const log = (m) => stderr.write(`apilix-mcp: ${m}\n`);

  let opts;
  try {
    opts = parseMcpArgs(argv, cwd);
  } catch (e) {
    stderr.write(`Error: ${e.message}\n\n${helpText()}\n`);
    return 2;
  }
  if (opts.help) { stdout.write(`${helpText()}\n`); return 0; }
  if (opts.version) { stdout.write(`${pkg.version}\n`); return 0; }

  let workspaces;
  try {
    workspaces = await createWorkspaces({ roots: opts.workspaces, maxFileBytes: opts.maxFileBytes, explicit: opts.workspaceExplicit });
  } catch (e) {
    stderr.write(`Error: ${e.message}\n`);
    return 2;
  }
  for (const w of workspaces.warnings) log(`warning: ${w}`);
  if (!opts.workspaceExplicit) log(`no --workspace given: using the current directory (${path.basename(workspaces.rootPaths[0])})`);

  const server = createMcpServer({
    opts, workspaces, version: pkg.version, log,
    extraTools: hooks.extraTools, session: hooks.session,
  });

  // stdout must carry protocol messages only: route stray console output from libraries to stderr.
  const realStdout = process.stdout;
  const restore = [];
  if (stdout === realStdout) {
    for (const k of ['log', 'info', 'debug']) {
      const orig = console[k];
      console[k] = (...a) => stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).map((s) => server.redactor.scrub(String(s))).join(' ')}\n`);
      restore.push(() => { console[k] = orig; });
    }
  }

  if (opts.includeCredentials) log('warning: --include-credentials is set: credentials are NOT redacted in what is returned to the agent (secret-flagged environment values stay hidden).');
  const mode = runMode(opts);
  const execution = {
    disabled: 'run tools DISABLED (--no-run)',
    off: 'run tools NOT ENABLED (no --allow-host / --allow-any-host): browsing only, nothing is sent and no script runs',
    restricted: `run tools ENABLED, limited to hosts: ${opts.allowHosts.join(', ')}`,
    any: 'run tools ENABLED FOR ALL HOSTS (--allow-any-host)',
  }[mode];
  log(`execution mode: ${execution}`);
  if (mode === 'any') log('WARNING: --allow-any-host: requests, and the secrets they carry (headers, tokens), can be sent to ANY host this machine can reach, and collection scripts run with your rights. Prefer --allow-host <pattern>.');
  if (opts.allowWrite && runEnabled(opts)) log('WARNING: --unsafe-allow-write-and-run: the agent can WRITE a collection (import_collection) and then RUN it (run_*): that is arbitrary code execution with your rights. The script sandbox is not a security boundary.');
  log(`ready (workspaces: ${workspaces.labels.join(', ')}; write ${opts.allowWrite ? 'ENABLED' : 'disabled'}; run ${mode === 'disabled' || mode === 'off' ? 'disabled' : 'enabled'})`);

  let guard = null;
  if (runEnabled(opts) && opts.allowHosts.length > 0) {
    guard = installHostGuard(opts.allowHosts, { onDeny: (h) => log(`blocked outgoing connection to "${h}" (not in --allow-host)`) });
  }
  try {
    await server.serve(stdin, stdout);
  } finally {
    if (guard) guard.uninstall();
    for (const r of restore) r();
  }
  await new Promise((resolve) => stdout.write('', resolve));
  return 0;
}

module.exports = { runMcp };
