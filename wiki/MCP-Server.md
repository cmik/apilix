# MCP Server

`apilix mcp` lets an external agent (Claude Code, or any [Model Context Protocol](https://modelcontextprotocol.io) client) use Apilix as a tool: list collections, read requests, run them, and generate docs. **Apilix itself never calls a language model** here: the agent is the client, Apilix is the server, and they talk over **stdio** (JSON-RPC 2.0, one message per line).

The server is built on `@apilix/core`, like the CLI. It is part of the same `apilix` binary (`packages/mcp`, package `@apilix/mcp`).

> **Read this first.** By default the server is **read-only browsing**: nothing is sent and no script runs. `run_request` / `run_collection` send real HTTP requests from your machine and **execute the collection's pre-request and test scripts with your rights**; they exist only if you pass `--allow-host <pattern>` (requests limited to those hosts) or, explicitly, `--allow-any-host`. **Write + run = arbitrary code execution with your rights**, so the server refuses to start with `--allow-write` and the run tools unless you add `--unsafe-allow-write-and-run`. Even read-only, an untrusted collection present in the workspace (for instance a git clone) runs its scripts as soon as the agent runs it. See the [threat model](#threat-model).

## Install

With the standalone binary or `npm run cli` from a checkout, `apilix` is on your PATH (or use `node bin/apilix.js`):

```bash
# Claude Code: read-only browsing (the default: nothing is sent, no script runs)
claude mcp add apilix -- apilix mcp --workspace ./api

# also run requests, but only against your API hosts (this enables run_request / run_collection)
claude mcp add apilix -- apilix mcp --workspace ./api --allow-host api.example.com --allow-host '*.staging.example.com'

# run requests against ANY host (explicit opt-in, a warning is printed at every start)
claude mcp add apilix -- apilix mcp --workspace ./api --allow-any-host
```

Other clients: add a stdio server to their JSON configuration (Claude Desktop `claude_desktop_config.json`, Cursor `.cursor/mcp.json`, a project `.mcp.json`, ...):

```json
{
  "mcpServers": {
    "apilix": {
      "command": "apilix",
      "args": ["mcp", "--workspace", "/absolute/path/to/api", "--allow-host", "api.example.com"]
    }
  }
}
```

A copy lives in `packages/mcp/examples/mcp.json`. Use absolute paths when the client does not start the server from your project folder.

## Workspace folder convention

The server reads plain JSON files from the folder(s) you give with `--workspace` (repeatable). Default: the current directory, **refused if it is your home directory or `/`** (pass `--workspace` explicitly if you really want the home directory).

Files are recognised by their content, not their name (subfolders up to 4 levels, `.json` only, `node_modules` and dot-folders skipped, symbolic links never followed while listing):

| Content | Recognised as |
|---|---|
| `{ "info": {...}, "item": [...] }` (Postman Collection v2.0/v2.1, also wrapped in `{ "collection": ... }`) | a collection |
| `{ "name": "...", "values": [{ "key", "value", "enabled", "secret" }] }` (Postman/Apilix environment export) | an environment |
| `{ "collections": [...], "environments": [...] }` (an Apilix workspace data file, e.g. a copy of `workspaces/<id>.json` from the desktop app) | one collection/environment per entry, ids ending in `#<index>` |

Ids are the relative path (`api/users.postman_collection.json`, `ws.json#0`). With several workspaces they are prefixed by the workspace label (`api:users.json`). Collections that use database or MongoDB requests are supported only for their HTTP requests: other request types are skipped and reported.

## Tools

All tools take strict JSON input (unknown properties are rejected, every string/number is bounded). Argument validation failures come back as tool results with `isError: true` so the model can correct itself; an unknown tool is a JSON-RPC `-32602`.

| Tool | Effect | Annotations | Notes |
|---|---|---|---|
| `list_collections` | list collections and environments | read-only | paginated; never returns variable values |
| `list_requests` | list folders/requests of a collection | read-only | `ref`, path, method, redacted URL; optional `folder`, `offset`, `limit` |
| `get_request` | one request, redacted | read-only | headers, query, body, auth type, scripts (text), description |
| `run_request` | send one request | open-world, destructive | environment, `variables`, `data`, `timeoutMs`, `maxBodyBytes`; listed only with `--allow-host` / `--allow-any-host` (never with `--no-run`) |
| `run_collection` | run a collection or folder | open-world, destructive | `environment`, `folder`, `iterations` (max 20) or `data` rows, `delayMs`, `bail`, `reporter` (`json`/`junit`), `maxResults`; same availability as `run_request` |
| `get_last_results` | summaries/failures of the latest runs of this session | read-only | at most 10 kept in memory |
| `export_docs` | `generateDocs` as `html`, `markdown`, `openapi` | read-only | redacted; returned inline, truncated with an explicit flag, never written to disk |
| `import_collection` | write a Postman collection file | **write**, destructive | listed only with `--allow-write`; `overwrite: true` only replaces a file that holds exactly one collection |

Resources (read-only): `apilix://collection/<id>` (redacted collection tree) and `apilix://environment/<id>` (secret values never returned).

When the run tools are not enabled they are not listed, and calling them anyway returns an `isError` result that says how to enable them (`--allow-host` / `--allow-any-host`); with `--no-run` it says they were disabled.

Run precedence for `{{variables}}`: `data` > environment > `variables` > the collection's own variables. **`variables` / `data` cannot change where a request goes**: for each request, the `host:port` obtained with the agent's values is compared with the one obtained from the collection and the environment alone, and a difference refuses the whole call before anything is sent. A literal URL host cannot change at all. When the host variable is defined nowhere but in the agent's values there is no baseline to compare with, and the `--allow-host` list (enforced on the sockets) remains the only authority (with `--allow-any-host` there is none, by definition). Auth inherited from a folder/collection is not resolved by the runner (same behaviour as the CLI).

Every result containing names, URLs, scripts or response bodies carries `"untrustedContent": true` and the tool descriptions say it: that content comes from files and remote servers and must be treated as data, never as instructions.

### Limits

| Limit | Default | Flag |
|---|---|---|
| tool result size | 100000 chars (explicit `truncated`/`omittedResults` flags) | `--max-output` |
| response body per request | 4096 chars (`run_request`), 1024 and off by default (`run_collection`) | tool argument |
| requests per call | 200 (requests x iterations) | fixed |
| session total requests | 500 | `--max-requests` |
| session total run time | 3600 s | `--max-run-seconds` |
| wall-clock per run call | 120 s (max 900) | `--run-timeout` / `timeoutMs` |
| per-request timeout | 30000 ms | `--request-timeout` |
| JSON file read/written | 8 MiB | `--max-file-size` |
| one JSON-RPC line | 4 MiB (longer lines are dropped with `-32600`) | `--max-line-bytes` |

## Flags

| Flag | Meaning |
|---|---|
| `--workspace <dir>` | allow-listed folder (repeatable) |
| `--allow-host <pattern>` | **enable** the run tools, limited to this host (repeatable): `api.example.com`, `*.example.com` (sub-domains only), optional `:port` |
| `--allow-any-host` | **enable** the run tools with no host restriction (stderr warning at every start). Exclusive with `--allow-host` (exit 2) |
| `--no-run` | hide and refuse the run tools (no network, no script execution). Takes priority; combining it with `--allow-host` / `--allow-any-host` is an error (exit 2) |
| `--allow-write` | enable `import_collection` (default: read-only). **Refused (exit 2) together with an enabled run mode** unless `--unsafe-allow-write-and-run` is also given |
| `--unsafe-allow-write-and-run` | accept write + run (arbitrary code execution with your rights); a warning is printed at every start. Enables nothing by itself |
| `--ssl-verification` | verify TLS certificates of outgoing requests (default off, like the CLI). A collection can never turn verification off; it may turn it on for one request |
| `--include-credentials` | do not redact credentials in what is returned (prints a warning on stderr). Values flagged `secret` (environment values and collection variables of type `secret`) are still never returned |
| `--run-timeout`, `--request-timeout`, `--max-requests`, `--max-run-seconds`, `--max-output`, `--max-file-size`, `--max-line-bytes` | limits above |

At startup the server states its execution mode on stderr: `run tools DISABLED (--no-run)`, `NOT ENABLED (...)` (the default), `ENABLED, limited to hosts: ...`, or `ENABLED FOR ALL HOSTS` followed by a warning.

Nothing is read from environment variables, and no environment variable is ever returned.

## Protocol notes

Transport: stdio, newline-delimited JSON-RPC 2.0. Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are negotiated. Implemented: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list` (empty), `notifications/initialized` and `notifications/cancelled` (cancels an in-flight run, or a run still queued behind another: it then never reaches the network). Batches are rejected. stdout carries protocol messages only (every `console.*` method is redirected to stderr); logs go to stderr and are scrubbed of the secrets the server knows (see the limits below). When the client closes stdin, or on SIGTERM / SIGINT, in-flight runs are aborted (their sockets destroyed), temporary files are removed and the process exits 0; a broken stdout (EPIPE) also ends the session cleanly.

We implement the protocol by hand rather than depend on `@modelcontextprotocol/sdk`: the SDK is ESM-only, adds about 13 packages (~19 MB on disk, `express`, `hono`, `jose`, `zod`...), adds about 0.2 s to start-up and ~27 MB of memory, and, in our test, did **not** bundle with `pkg` (`Cannot find module '@modelcontextprotocol/sdk/server/index.js'` at run time because `pkg` does not honour package `exports`). `@apilix/mcp` adds no new dependency (it reuses `ajv`, already shipped with `@apilix/core`) and its source is about 100 KB.

## Threat model

> **Write + run = arbitrary code execution with your rights.** Collection scripts run in a Node `vm` context, which is **not** a security boundary. An agent that can write a collection (`import_collection`) and run it (`run_*`) controls code executed as you. That is why `--allow-write` together with the run tools is refused at startup unless you pass `--unsafe-allow-write-and-run`. `--allow-write` alone (with `--no-run` or no host flag) stays valid.

Assumption: **the agent, and everything it reads (collection contents, response bodies), is untrusted** and may be steered by prompt injection. The operator (you) is trusted.

### What is enforced

- **The run tools are opt-in and scoped.** They exist only with `--allow-host` (and then only those hosts are reachable) or an explicit `--allow-any-host`. `variables`/`data` cannot move a request to another host (see [Tools](#tools)).
- **File access is limited to the `--workspace` folders.** Paths from the agent are validated (no NUL, `..`, absolute, UNC, drive-relative, `:` / NTFS streams, backslashes, device names, non-`.json`); the real path is resolved before **and** after opening (`O_NOFOLLOW`, handle identity check) and must stay inside the folder; symbolic links are refused; files over `--max-file-size` are refused. Reading has the same reach as listing: hidden folders, `node_modules`, `package.json`-like files and paths deeper than the scan are unreadable, and every refusal returns the same "File not found in workspace" error (no existence oracle). Errors never contain absolute paths.
- **Writes** (`--allow-write`): `import_collection` never overwrites without `overwrite: true`, and then only a file that holds **exactly one collection** (never an environment, nor a file with several collections/environments); files are created `0600`, written atomically (temporary file + rename, or hard link for no-clobber), never through a symlink, never into hidden folders.
- **Host allow-list (`--allow-host`)** is enforced at the socket layer of the process, after `{{variables}}` are resolved, on every redirect hop, for `pm.sendRequest()` calls inside scripts, for OAuth token calls and for proxy connections. Per-request proxy settings in collections are ignored.
- **A collection cannot loosen the limits.** Its per-request `timeout` is kept only when between 1 ms and `--request-timeout` (a `0`, meaning "no timeout" for the engine, used to defeat the run timeout); `followRedirects` only when `false`; `sslVerification` only when `true`. After the hard timeout a stuck run has its sockets destroyed and is abandoned after a short grace period (the call returns a partial result with `timedOut`, the session is flagged `degraded`, the lock is released), so one stuck request cannot block the following calls.
- **Cancellation.** A call cancelled while queued behind another run never reaches the network; closing stdin aborts everything that is still running.
- **Redaction by default** of everything returned: URLs (userinfo, credential-looking query parameters), headers, auth blocks, body fields, cookies, and every known secret value wherever it appears in an output (raw, URL-encoded, base64): values flagged `secret`, values of variables whose name looks like a credential, and literal credentials written in collections. Redaction is deny-by-default on names (so a response field called `code` or `key` is masked too). Scrubbing acts on string leaves only: it never alters keys, numbers, booleans or the `initialize` / `tools/list` / `resources/list` payloads.
- **Bounded output and budgets**: see [Limits](#limits). No shell, no `exec`; only `@apilix/core` runs requests.

### What is NOT guaranteed

1. **Write + run** is code execution (above). Do not combine them with an agent you do not fully trust.
2. **An untrusted collection in the workspace runs its scripts.** Even read-only, a collection that comes from a git clone or a download executes its pre-request/test scripts with your rights as soon as the agent runs it (and `run_collection` runs every request of a folder). Only expose collections you would run yourself.
3. **Secrets can be sent to a host the agent chooses.** Redaction protects what is **returned**, not what is **sent**: with `--allow-any-host`, or with an `--allow-host` list that includes a host the agent controls, the agent can have a request carrying an environment secret (a header `{{token}}`) sent there if it can get a request pointing at that host (by writing a collection, or for a URL whose host is not defined by the collection or the environment). `variables`/`data` cannot redirect a request whose host the collection or environment already defines, but they decide it when the host variable is defined nowhere else. Prefer `--allow-host` with the narrowest pattern, and never an attacker-reachable host.
4. **`--allow-host` checks the host name used to connect, before DNS.** It does not protect against an allowed name that resolves to an unexpected address (DNS rebinding), and IP literals must be listed explicitly. It covers this process only. `pm.sendRequest()` calls made by scripts are limited by the host list, the run timeout and the per-call cap, but are **not counted** in `--max-requests` (the engine reports no event for them).
5. **What `--include-credentials` reveals exactly**: the structural redaction is off and name-recognised or literal credentials (Authorization headers, tokens in URLs/bodies, credential-named variables, literal auth in collections) are returned as is. Still never returned: environment values flagged `secret` and collection variables of type `secret`.
6. **Read access, hardlinks and TOCTOU.** There is a small time-of-check/time-of-use window between the checks and the final operation (mitigated by `O_NOFOLLOW` and the identity check, not eliminated). A **hardlink** inside the workspace to a file outside it cannot be detected reliably (it is the same file) and would be read if it looks like a collection. Do not point `--workspace` at a folder other local users can write to.
7. **Redaction limits.** A secret that is not flagged `secret`, not under a credential-looking name and not a literal credential in a collection is returned as is: in particular **a token produced at run time by a script and stored under a non-sensitive name is returned in clear**. Values of merely credential-named variables are masked only from **8 characters** and when not banal (not `true`, `object`, `bearer`, `undefined`, a single lowercase word...), a trade-off that keeps schemas and JSON intact; flag short secrets as `secret` to get them masked from 4 characters. Logs on stderr are scrubbed for the known secrets only.
8. **Platforms and packaging.** The automated suite has only been run on macOS: **nothing is tested on Windows or Linux** (symlink, hard-link, `O_NOFOLLOW` and signal behaviour differ there). The single-binary build (`pkg`) prints warnings (`Cannot find module '@apilix/core/redact'` and similar for `docs` / `variable-resolver`, because `pkg` does not follow package `exports`, and `xdg-open` from `open`); the macOS binary was checked to answer `mcp` with these flags, and the subpath modules do resolve at run time there, but no other target was built or run. Not tested against every MCP client.
- **Returned content may contain prompt-injection text.** The server marks it as untrusted and never adds instructions, but the agent decides what to do with it.

## Troubleshooting

- `apilix mcp` prints `ready (...)` on stderr when started; if your client shows nothing, run it by hand and send `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}` on stdin.
- "Refusing to use the home directory as the default workspace": pass `--workspace <folder>`.
- "MCP support is not available in this build of the CLI": the build was made without `packages/mcp`.

## Try it

```text
> List the collections available in Apilix.
> Show me the request "Users/List users" without its credentials.
> Run the "Users" folder of demo.postman_collection.json with the "Local" environment and tell me what fails.
> Generate OpenAPI docs for the "Users" folder.
```
