# MCP Server

`apilix mcp` lets an external agent (Claude Code, or any [Model Context Protocol](https://modelcontextprotocol.io) client) use Apilix as a tool: list collections, read requests, run them, and generate docs. **Apilix itself never calls a language model** here: the agent is the client, Apilix is the server, and they talk over **stdio** (JSON-RPC 2.0, one message per line).

The server is built on `@apilix/core`, like the CLI. It is part of the same `apilix` binary (`packages/mcp`, package `@apilix/mcp`).

> **Read this first.** `run_request` / `run_collection` send real HTTP requests from your machine and run the collection's pre-request and test scripts. An agent that can call them can make your machine contact any host it can reach (unless you restrict hosts with `--allow-host`) and run any script that is in a collection you exposed. Start with `--no-run` if you only want browsing. See the [threat model](#threat-model).

## Install

With the standalone binary or `npm run cli` from a checkout, `apilix` is on your PATH (or use `node bin/apilix.js`):

```bash
# Claude Code
claude mcp add apilix -- apilix mcp --workspace ./api

# read-only browsing, no network, no scripts
claude mcp add apilix -- apilix mcp --workspace ./api --no-run

# runs restricted to your API hosts, redaction on (default)
claude mcp add apilix -- apilix mcp --workspace ./api --allow-host api.example.com --allow-host '*.staging.example.com'
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
| `run_request` | send one request | open-world, destructive | environment, `variables`, `data`, `timeoutMs`, `maxBodyBytes`; hidden by `--no-run` |
| `run_collection` | run a collection or folder | open-world, destructive | `environment`, `folder`, `iterations` (max 20) or `data` rows, `delayMs`, `bail`, `reporter` (`json`/`junit`), `maxResults`; hidden by `--no-run` |
| `get_last_results` | summaries/failures of the latest runs of this session | read-only | at most 10 kept in memory |
| `export_docs` | `generateDocs` as `html`, `markdown`, `openapi` | read-only | redacted; returned inline, truncated with an explicit flag, never written to disk |
| `import_collection` | write a Postman collection file | **write**, destructive | listed only with `--allow-write` |

Resources (read-only): `apilix://collection/<id>` (redacted collection tree) and `apilix://environment/<id>` (secret values never returned).

Run precedence for `{{variables}}`: `data` > environment > `variables` > the collection's own variables. Auth inherited from a folder/collection is not resolved by the runner (same behaviour as the CLI).

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
| `--allow-write` | enable `import_collection` (default: read-only) |
| `--no-run` | hide and refuse `run_request` / `run_collection` (no network, no script execution) |
| `--allow-host <pattern>` | only allow connections to this host (repeatable): `api.example.com`, `*.example.com` (sub-domains only), optional `:port`. Without it, any host is reachable (a warning is printed on stderr) |
| `--ssl-verification` | verify TLS certificates of outgoing requests (default off, like the CLI) |
| `--include-credentials` | do not redact credentials in what is returned (prints a warning on stderr). Values of variables flagged `secret` are still never returned |
| `--run-timeout`, `--request-timeout`, `--max-requests`, `--max-run-seconds`, `--max-output`, `--max-file-size`, `--max-line-bytes` | limits above |

Nothing is read from environment variables, and no environment variable is ever returned.

## Protocol notes

Transport: stdio, newline-delimited JSON-RPC 2.0. Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are negotiated. Implemented: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list` (empty), `notifications/initialized` and `notifications/cancelled` (cancels an in-flight run). Batches are rejected. stdout carries protocol messages only; logs go to stderr and never contain secrets.

We implement the protocol by hand rather than depend on `@modelcontextprotocol/sdk`: the SDK is ESM-only, adds about 13 packages (~19 MB on disk, `express`, `hono`, `jose`, `zod`...), adds about 0.2 s to start-up and ~27 MB of memory, and, in our test, did **not** bundle with `pkg` (`Cannot find module '@modelcontextprotocol/sdk/server/index.js'` at run time because `pkg` does not honour package `exports`). `@apilix/mcp` adds no new dependency (it reuses `ajv`, already shipped with `@apilix/core`) and its source is about 100 KB.

## Threat model

Assumption: **the agent, and everything it reads (collection contents, response bodies), is untrusted** and may be steered by prompt injection. The operator (you) is trusted. What the server does and does not guarantee:

### What is enforced

- **File access is limited to the `--workspace` folders.** Paths from the agent are validated (no NUL, `..`, absolute, UNC, drive-relative, `:` / NTFS streams, backslashes, device names, non-`.json`); the real path is resolved before **and** after opening (`O_NOFOLLOW`, handle identity check) and must stay inside the folder; symbolic links that leave it are refused; files over `--max-file-size` are refused. Errors never contain absolute paths.
- **Read-only by default.** `import_collection` needs `--allow-write`; it never overwrites without `overwrite: true`, only replaces a file that is already a recognised collection, writes atomically (temporary file + rename, or hard link for no-clobber) and never through a symlink.
- **Host allow-list (`--allow-host`)** is enforced at the socket layer of the process, after `{{variables}}` are resolved, on every redirect hop, for `pm.sendRequest()` calls inside scripts, for OAuth token calls and for proxy connections. Per-request proxy settings in collections are ignored.
- **Redaction by default** of everything returned: URLs (userinfo, credential-looking query parameters), headers, auth blocks, body fields, cookies, and every known secret value wherever it appears in an output (raw, URL-encoded, base64): values of variables flagged `secret`, variables whose name looks like a credential, and literal credentials written in collections (auth blocks, `Authorization`-like headers, credential-looking query/form/JSON fields). Redaction is deny-by-default on names (so a response field called `code` or `key` is masked too).
- **Bounded output and budgets**: see [Limits](#limits). No shell, no `exec`; only `@apilix/core` runs requests.

### What is NOT guaranteed

- **Running requests is a network side effect you delegate to the agent.** Without `--allow-host`, the agent can make this machine contact internal services, cloud metadata addresses, `localhost`... by editing a collection (needs `--allow-write`) or by passing `variables`/`data` that change the URL of an existing request. Use `--allow-host`, or `--no-run`.
- **`--allow-host` checks the host name used to connect, before DNS.** It does not protect against an allowed name that resolves to an unexpected address (DNS rebinding), and IP literals must be listed explicitly. It covers this process only (no child process is started by the server).
- **Collection scripts run with exactly the guarantees Apilix has today** (Node `vm` sandbox, 5 s per script): not a security boundary against hostile code. If the agent can write collections (`--allow-write`) and run them, it can author scripts that execute. Prefer one or the other.
- **Redaction cannot recognise an unlabelled secret**: a token that is not flagged secret, not under a credential-looking name, and not a literal credential in a collection (for instance a one-off value in a free-text response field) is returned as is. Secrets shorter than 4 characters are not scrubbed. `--include-credentials` turns the structural redaction off.
- **Returned content may contain prompt-injection text.** The server marks it as untrusted and never adds instructions, but the agent decides what to do with it.
- The workspace check has a small time-of-check/time-of-use window between the checks and the final operation (mitigated by `O_NOFOLLOW` and the identity check, not eliminated). Do not point `--workspace` at a folder other local users can write to.
- Not verified on Windows; not tested against every MCP client.

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
