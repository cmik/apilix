'use strict';

const path = require('node:path');
const { Writable } = require('node:stream');
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

  // stdout must carry protocol messages only: route every console method (also table/dir/warn/error/trace)
  // from libraries and scripts to stderr, scrubbed of the secrets we know.
  const realStdout = process.stdout;
  const restore = [];
  if (stdout === realStdout) {
    const sink = new Writable({ write(chunk, enc, cb) { stderr.write(server.redactor.scrub(chunk.toString('utf8'))); cb(); } });
    const redirected = new console.Console({ stdout: sink, stderr: sink });
    for (const k of ['log', 'info', 'debug', 'dir', 'dirxml', 'table', 'warn', 'error', 'trace']) {
      const orig = console[k];
      console[k] = (...a) => redirected[k](...a);
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
  if (opts.unsafeAllowWriteAndRun && !(opts.allowWrite && runEnabled(opts))) log('warning: --unsafe-allow-write-and-run has no effect here: it only matters together with --allow-write AND a run flag (--allow-host / --allow-any-host); nothing was enabled by it.');
  if (opts.allowWrite && runEnabled(opts)) log('WARNING: --unsafe-allow-write-and-run: the agent can WRITE a collection (import_collection) and then RUN it (run_*): that is arbitrary code execution with your rights. The script sandbox is not a security boundary.');
  log(`ready (workspaces: ${workspaces.labels.join(', ')}; write ${opts.allowWrite ? 'ENABLED' : 'disabled'}; run ${mode === 'disabled' || mode === 'off' ? 'disabled' : 'enabled'})`);

  let guard = null;
  if (runEnabled(opts) && opts.allowHosts.length > 0) {
    guard = installHostGuard(opts.allowHosts, { onDeny: (h) => log(`blocked outgoing connection to "${h}" (not in --allow-host)`) });
  }
  // SIGTERM / SIGINT: abort the runs, remove temp files, then end cleanly (only when we own the process streams).
  const onSignal = (sig) => {
    log(`received ${sig}: stopping`);
    workspaces.cleanupTmpSync();
    server.rpc.stop();
  };
  const signalHandlers = [];
  if (stdout === realStdout && !io.noSignals) {
    for (const sig of ['SIGTERM', 'SIGINT']) { const h = () => onSignal(sig); process.on(sig, h); signalHandlers.push([sig, h]); }
  }
  try {
    await server.serve(stdin, stdout);
  } finally {
    for (const [sig, h] of signalHandlers) process.removeListener(sig, h);
    workspaces.cleanupTmpSync();
    if (guard) guard.uninstall();
    for (const r of restore) r();
  }
  await new Promise((resolve) => stdout.write('', resolve));
  return 0;
}

module.exports = { runMcp };
