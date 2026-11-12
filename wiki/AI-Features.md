# AI Features

Apilix can optionally call a language model. **AI is off by default** and nothing is sent anywhere until you enable it in **Settings → AI** and use an AI feature. Apilix stays fully functional offline.

> **Status:** the foundation (provider setup, key storage, redaction, payload preview) and these features are available: documentation descriptions, assertion suggestions and request generation. Failure diagnosis, scripting help and the other switches in Settings → AI take effect as each one ships.

## Setting up a provider

Open **Settings → AI**.

| Field | Notes |
|---|---|
| **Provider** | **Anthropic**, or **OpenAI-compatible** (OpenAI, Ollama, LM Studio, vLLM, …). |
| **Model** | The model name your provider expects. |
| **Base URL** | Optional. Defaults to the provider's public endpoint. For local servers use e.g. `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio). |
| **API key** | Optional for local servers. See [where the key is stored](#where-the-api-key-is-stored). |

Click **Test connection** to verify the setup. Turning AI on for the first time shows a short disclosure of what is sent and to where.

Not supported yet: Azure OpenAI (different authentication and URL scheme).

### Local models

Use the **OpenAI-compatible** provider and point **Base URL** at your local server. No key is needed and no data leaves your machine. Structured output is less reliable on some local servers; Apilix validates every reply and retries once before reporting an error.

Output-length parameter: requests to the default OpenAI endpoint send `max_completion_tokens` (newer OpenAI models reject `max_tokens`); other servers receive `max_tokens`. If a server rejects the parameter by name, Apilix retries once with the other one and remembers the choice for that server and model.

## What is sent, and what is masked

When you use an AI feature, Apilix builds a context from the active request and response, **masks it**, and sends it to your provider:

- **Sent:** method, URL, headers, body, scripts, response status/headers/body, and the *names* of available variables.
- **Always masked:** the values of variables marked **secret** (environment and global). They are removed from every part of the payload, including scripts and response bodies. This cannot be turned off.
- **Masked by default:** values that look like credentials, based on their name (`token`, `password`, `api_key`, `Authorization`, cookies, …), literals assigned in scripts (`apx.environment.set('token', '…')`), and `Bearer …` literals. `{{variable}}` references are always kept as-is. Turn this off with **Mask credential-looking values**.
- **Optional:** switch off **Send response bodies** to send only the structure (field names and types) of a response, never its values.
- **Size:** payloads are truncated to **Max context (tokens)** (default 8000; arrays and deep nesting are shortened first).

Use **See what will be sent** in Settings → AI to see the exact, masked payload for your active request. The preview makes no call to the AI provider.

Apilix keeps a local usage log (`ai-log.jsonl` in the Apilix data folder, desktop app only): feature, model, token counts, latency and success. It never contains prompts, replies, or keys.

## Where the API key is stored

| Mode | Storage |
|---|---|
| **Desktop app** | Encrypted with your OS keychain (Electron `safeStorage`) in `ai-config.json`. If the keychain is unavailable the key is **not written to disk**; it stays in memory for the session. |
| **Web mode** | Optionally in the browser's `localStorage`, **unencrypted**. Untick **Remember on this device** to keep it in memory only. |

If a stored key cannot be decrypted (different machine, new OS user, reinstalled keychain), Settings → AI asks you to enter it again. The key is never part of workspace files, snapshots, sync data or exports.

The key is sent only from the app to the local Apilix server, then to your provider. Apilix's AI routes accept connections from the local machine only, so a network-exposed Apilix cannot be used to spend your key. Provider requests always verify TLS and honour your proxy and custom CA settings.

## Features

| Feature | Where | Setting |
|---|---|---|
| Fill missing documentation descriptions | Export documentation dialog, `apilix docs --ai-describe` | *Complete missing documentation descriptions* |
| Suggest assertions from a response | **Suggest tests** panel of the Response tab, **Improve with AI** | *Suggest assertions from a response* |
| Generate or modify a request from a sentence | `Ctrl/Cmd+I` in the request builder, **Generate request here…** in a folder's menu | *Generate requests and tests from a description* |

AI-written descriptions in exported docs carry a mark (HTML badge, Markdown note, `x-generated-by: ai` in OpenAPI). **Settings → AI → Exports → Mark AI-written content in exports** sets the default (on); the export dialog can override it per export, and the CLI has `--no-ai-mark`.

### Suggest assertions with AI

The **Suggest tests** panel always offers local, deterministic suggestions (status, headers, field types, formats). With the feature on, **Improve with AI** adds model suggestions: allowed values of enum-like fields, invariants between fields (a total equal to the sum of its items), volatile fields left out, readable titles.

- Nothing is sent when the panel opens. The call happens only when you click the button, and the panel says where the request and response go. With **Send response bodies** off, only the structure of the body is sent.
- **Every suggestion is test-run before you see it.** The server runs each script, offline, in an isolated child process (see below), on the very response that inspired it. A suggestion that fails, does not parse, registers no test, or saves nothing (for captures) is dropped; the panel says how many were dropped. Local suggestions stay as the fallback: if AI is off or the call fails, you still get them.
- AI suggestions carry an **AI** badge. Suggestions that may change between runs are flagged and never pre-checked; nothing is added to your script until you click **Add**, and a test already in the script is never duplicated.

### Generate a request from a sentence

Press `Ctrl/Cmd+I` in the request builder, or choose **Generate request here…** in a folder's menu, and describe the request: *“POST /users with name and email, check 201 and that the id is a UUID”*.

What is sent: your sentence, the **names** (never the values) of the environment, global and collection variables, the `{{baseUrl}}` variable if you have one, and up to five neighbouring requests of the folder as style examples. Neighbouring requests are masked like any other AI payload, saved examples are not sent, and secret values from **all** environments are scrubbed.

You then get a **proposal** to review: the request, and a diff of the generated scripts. Nothing is created until you click **Apply**; **Ignore** discards it and **Regenerate** asks again. Proposals carry an **AI-generated** badge.

- **New request** adds a separate request next to the current one (or in the folder you chose, or in a new unsaved tab). It never replaces an existing request.
- **Modify selected request** (builder only) shows what would change against the request as it is in the editor, including unsaved edits. Applying updates the editor only, marks it as unsaved, and an **Undo** link restores the previous state; your saved request changes only when you save. The request name is kept.
- Generated scripts are test-run in the isolated child process on a stand-in response (one automatic retry with the error). If a script passes the security screen but still fails its test run, the proposal is shown as **Not validated** with the reason, and the button reads **Apply anyway**. A script that the security screen **refuses** is never run and is removed from the proposal, with a warning: there is no "Apply anyway" for it. Passing validation means the scripts parse and call only known APIs; they have not run against your API.
- If the generated URL points to a host that is neither `{{baseUrl}}` nor the host of a neighbouring request, and the request uses a variable marked secret (URL, headers, auth, query or body), the dialog shows a warning and **Apply** stays disabled until you tick a confirmation.
- In **Modify** mode, disabled headers, file fields of a form-data body and path-variable values are kept as they are; the dialog lists what was kept.
- Credentials are never generated: authentication values, credential headers (`Authorization`, `X-Api-Key`, `X-Secret`, `X-*-Token`/`Key`/`Secret`...), and literal values of credential-looking query parameters and body fields (`api_key`, `password`, `client_secret`...) are kept only when they are `{{variable}}` references, otherwise they are left empty for you to fill in.
- HTTP/REST requests only. The command is hidden for GraphQL, SOAP, SQL, MongoDB and WebSocket requests.

### How model-written scripts are handled

Model output is untrusted (it may be steered by text hidden in a response or in your collection). Scripts are never run on your API and never added to a request without your click. The dry-runs described above work like this, in this order of importance:

1. **A dedicated child process.** A model-written script never runs in the Apilix server process. The server forks a worker (`packages/ai/src/dry-run-worker.js`) for each script and exchanges JSON only: the script and the response in, test results and variables set out (output size bounded). The worker has an **empty environment** (no API keys, no variables of yours), a **64 MB heap limit**, and is **killed with SIGKILL after 3 seconds** whatever it does (an endless loop, a promise storm, an out-of-memory crash or a catastrophic regular expression only costs that one script). It is killed as soon as the HTTP request is cancelled, at most two workers exist at once, and a worker that dies means the script is rejected, not a server error.
2. **Node's permission model, when it is available.** On plain Node 23.5+ the worker starts with `--permission`, on Node 22.x with `--experimental-permission`, and with no file-system, child-process, worker-thread or native-addon grant (it may only read its own source file). **Under Electron (the desktop app) and in a `pkg` binary these flags are not used**: the guarantees there are process isolation, the empty environment, the heap limit and the kill deadline, without a file-system barrier at the Node level. (The CLI does not run these scripts at all; `pkg` builds report the scripts as not validatable.) Node's permission model does **not** restrict the network in these versions.
3. **A hardened `vm` context inside the worker.** The script sees only its own built-ins (nothing is shared with the worker), no `Buffer`, `process`, `require`, `crypto` or timers, `eval` and `new Function` are disabled, and the host hands over data as one JSON string, so there is no host object whose `constructor` could be reached. Promise jobs run inside the time-limited evaluation. The runner implements the `apx.test`, `apx.expect`, `apx.response`, `apx.environment` and `apx.variables` APIs that suggestions need; it does not support everything the regular script sandbox does (for example `matchSchema`, XML helpers, `btoa`/`atob`), and a script using something missing is reported as not validated.
4. **A static screen** (defence in depth, not the barrier). Before anything runs, the script is checked for `constructor`/`prototype`, reflection (`getOwnPropertyDescriptor`, `getPrototypeOf`, `Reflect`, `Proxy`, `Symbol`...), `call`/`apply`/`bind`, `eval`, `Function`, `process`, `require`, `import`, `globalThis`, computed property names, escapes, getters/setters, classes, unbounded loops (`while`, `do`, `for` without an obvious end) and `await` next to a loop, and network or flow-control calls. When it cannot tell what the engine would do (a `/` after `)`, non-ASCII characters in code...) it refuses. A script the screen refuses is **never executed, not even in the worker**, and is removed from the proposal.

What this is not: it is not a perfect sandbox. A hand-written screen cannot be proven complete; the vm context and the worker share the Node binary, so a bug in V8 or Node's `vm` could in principle still be exploited; Electron and `pkg` builds have no Node-level permission barrier; and a script can still burn up to 3 seconds of one CPU core. Only enable these features with providers you trust. If this residual risk is not acceptable for a deployment, the model-written scripts can be shown without being test-run at all (parse only); that is not the current behaviour.

Anything the model writes that is shown as text (titles, warnings) has images, links and HTML neutralised, and unexpected fields are dropped before the answer reaches the interface.

## Limits

- One AI request runs at a time.
- AI request bodies are limited to 2 MB. A response body longer than 900,000 characters is truncated before it is sent (the panel says so); a too-large payload gives a clear "too large" message.
- AI output is always shown for review; Apilix never runs or saves AI-generated content on its own.

## CLI

AI-enabled CLI options (currently `apilix docs --ai-describe`) read their configuration from environment variables only (never command-line arguments, which leak into shell history and process lists): `APILIX_AI_PROVIDER` (`anthropic` by default, or `openai-compat`), `APILIX_AI_MODEL`, `APILIX_AI_API_KEY`, `APILIX_AI_BASE_URL`. See [API Documentation](API-Documentation#ai-written-descriptions).
