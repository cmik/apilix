'use strict';

const path = require('node:path');

const DEFAULTS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxOutputChars: 100000,
  requestTimeoutMs: 30000,
  runTimeoutSec: 120,
  maxRequests: 500,
  maxRunSeconds: 3600,
  maxLineBytes: 4 * 1024 * 1024,
};

function helpText() {
  return [
    'Usage: apilix mcp [options]',
    '',
    'Run the Apilix MCP server on stdio (JSON-RPC 2.0). stdout carries protocol messages only;',
    'diagnostics go to stderr. Intended to be launched by an MCP client, e.g.:',
    '  claude mcp add apilix -- apilix mcp --workspace ./api',
    '',
    'Scope:',
    '  --workspace <dir>        Folder holding collection/environment JSON files (repeatable).',
    '                           Default: the current directory (refused if it is the home dir or "/").',
    '  --max-file-size <bytes>  Largest JSON file read or written (default 8388608)',
    '',
    'Permissions. Read-only browsing is the default; running requests and writing files are opt-in:',
    '  --allow-host <pattern>   ENABLE run_request / run_collection, restricted to this host (repeatable; "example.com",',
    '                           "*.example.com", optional ":port"). Enforced at the socket layer, so redirects, scripts',
    '                           and OAuth calls are covered. Without --allow-host or --allow-any-host the run tools are',
    '                           not available.',
    '  --allow-any-host         ENABLE the run tools with NO host restriction: requests (and the secrets they carry) can',
    '                           be sent to any host this machine can reach. Cannot be combined with --allow-host.',
    '  --no-run                 Disable run_request / run_collection explicitly (no network, no script execution).',
    '                           Takes priority; cannot be combined with --allow-host / --allow-any-host.',
    '  --allow-write            Enable import_collection (writes inside the workspace; no overwrite without overwrite:true).',
    '                           Refused together with the run tools (write + run = arbitrary code execution with your',
    '                           rights), unless --unsafe-allow-write-and-run is added.',
    '  --unsafe-allow-write-and-run',
    '                           Accept --allow-write together with the run tools. Collection scripts run in a Node "vm"',
    '                           sandbox that is NOT a security boundary: an agent that can write a collection and run it',
    '                           can execute arbitrary code as you. A warning is printed at every start.',
    '  --ssl-verification       Verify TLS certificates for outgoing requests (default: off, like the CLI)',
    '  --include-credentials    Do NOT redact credentials in what is returned to the agent (secret-flagged env values stay hidden)',
    '',
    'Limits:',
    '  --run-timeout <sec>      Default wall-clock limit per run tool call (default 120, max 900)',
    '  --request-timeout <ms>   Per-request timeout (default 30000)',
    '  --max-requests <n>       Total requests the session may execute (default 500)',
    '  --max-run-seconds <sec>  Total run time the session may consume (default 3600)',
    '  --max-output <chars>     Maximum size of one tool result (default 100000)',
    '',
    '  -h, --help               Show this help',
    '  --version                Print the version',
  ].join('\n');
}

/** Run tools are available only when explicitly enabled: at least one --allow-host, or --allow-any-host; --no-run wins. */
function runEnabled(o) {
  return !o.noRun && ((Array.isArray(o.allowHosts) && o.allowHosts.length > 0) || o.allowAnyHost === true);
}

/** 'disabled' (--no-run), 'off' (not enabled), 'restricted' (--allow-host) or 'any' (--allow-any-host). */
function runMode(o) {
  if (o.noRun) return 'disabled';
  if (!runEnabled(o)) return 'off';
  return o.allowAnyHost ? 'any' : 'restricted';
}

function intFlag(name, value, { min, max }) {
  if (value === undefined || !/^\d+$/.test(String(value))) throw new Error(`${name} expects a non-negative integer`);
  const n = parseInt(value, 10);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

/**
 * Parse `apilix mcp` flags. `cwd` is used to resolve relative --workspace values.
 * @returns {object} options (never reads the environment: nothing is taken from env vars)
 */
function parseMcpArgs(argv, cwd = process.cwd()) {
  const o = {
    help: false,
    version: false,
    workspaces: [],
    workspaceExplicit: false,
    allowWrite: false,
    unsafeAllowWriteAndRun: false,
    noRun: false,
    allowAnyHost: false,
    allowHosts: [],
    sslVerification: false,
    includeCredentials: false,
    maxFileBytes: DEFAULTS.maxFileBytes,
    maxOutputChars: DEFAULTS.maxOutputChars,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    runTimeoutSec: DEFAULTS.runTimeoutSec,
    maxRequests: DEFAULTS.maxRequests,
    maxRunSeconds: DEFAULTS.maxRunSeconds,
    maxLineBytes: DEFAULTS.maxLineBytes,
  };
  const args = Array.isArray(argv) ? argv.slice() : [];
  const take = (flag, i) => {
    const v = args[i + 1];
    if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let inline;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const value = (i2) => { if (inline !== undefined) return inline; const v = take(a, i2); i += 1; return v; };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--version': o.version = true; break;
      case '--workspace': {
        const v = value(i);
        if (v.includes('\0')) throw new Error('--workspace contains a NUL byte');
        o.workspaces.push(path.resolve(cwd, v));
        o.workspaceExplicit = true;
        break;
      }
      case '--allow-write': o.allowWrite = true; break;
      case '--unsafe-allow-write-and-run': o.unsafeAllowWriteAndRun = true; break;
      case '--no-run': o.noRun = true; break;
      case '--allow-any-host': o.allowAnyHost = true; break;
      case '--allow-host': {
        const v = value(i).trim().toLowerCase();
        if (!/^(\*\.)?[a-z0-9._\-\[\]:]+$/.test(v) || v === '*' || v.includes('/')) throw new Error(`--allow-host: invalid pattern "${v}" (use host, *.domain or host:port; a bare "*" is not accepted)`);
        o.allowHosts.push(v);
        break;
      }
      case '--ssl-verification': o.sslVerification = true; break;
      case '--include-credentials': o.includeCredentials = true; break;
      case '--max-file-size': o.maxFileBytes = intFlag(a, value(i), { min: 1024, max: 256 * 1024 * 1024 }); break;
      case '--max-output': o.maxOutputChars = intFlag(a, value(i), { min: 1000, max: 2000000 }); break;
      case '--request-timeout': o.requestTimeoutMs = intFlag(a, value(i), { min: 100, max: 300000 }); break;
      case '--run-timeout': o.runTimeoutSec = intFlag(a, value(i), { min: 1, max: 900 }); break;
      case '--max-requests': o.maxRequests = intFlag(a, value(i), { min: 1, max: 100000 }); break;
      case '--max-run-seconds': o.maxRunSeconds = intFlag(a, value(i), { min: 1, max: 86400 }); break;
      case '--max-line-bytes': o.maxLineBytes = intFlag(a, value(i), { min: 4096, max: 64 * 1024 * 1024 }); break;
      default:
        throw new Error(`Unknown option: ${args[i]}`);
    }
  }
  if (o.noRun && o.allowHosts.length > 0) throw new Error('--allow-host has no effect with --no-run');
  if (o.noRun && o.allowAnyHost) throw new Error('--allow-any-host has no effect with --no-run');
  if (o.allowAnyHost && o.allowHosts.length > 0) throw new Error('--allow-any-host and --allow-host are mutually exclusive: either restrict the run tools to some hosts or explicitly allow every host');
  if (o.allowWrite && runEnabled(o) && !o.unsafeAllowWriteAndRun) {
    throw new Error('--allow-write together with the run tools (--allow-host / --allow-any-host) is refused: write + run = arbitrary code execution with your rights: an agent that can write a collection and run it controls what runs (the script sandbox is not a security boundary). Drop --allow-write, or drop the run flags (--allow-host / --allow-any-host), or add --unsafe-allow-write-and-run if you accept that risk.');
  }
  if (o.workspaces.length === 0) o.workspaces.push(path.resolve(cwd));
  return o;
}

module.exports = { parseMcpArgs, helpText, runEnabled, runMode, DEFAULTS };
