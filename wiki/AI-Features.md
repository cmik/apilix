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
- **Optional:** switch off **Send response bodies** (*shape only*) so that no response value leaves. What is sent then, per feature:
  - **Suggest assertions** and **Explain with AI**: the response body's structure only (field names and types), and **header names only** for both the response and the request, plus a small set of protocol values that carry no data: the media type of `content-type` plus `charset`, `content-length`, the codings listed in `content-encoding` (`gzip`, `deflate`, `br`, `zstd`, `compress`, `identity`), the standard directives of `cache-control` (`no-cache`, `max-age=60`, …; any other word is dropped), and the scheme word of `www-authenticate`. Every other header value (cookies, `location`, custom headers) is withheld, and a header name that is not a plain token (for example one containing an email address) is replaced by `<other>`. The **request** is reduced the same way: the URL keeps its scheme, host and path, but query **values** are replaced by `<value>` (parameter names stay), credentials in the URL and the fragment are dropped and id-like path segments (numbers, UUIDs, long hex or token-like strings, emails) become `:id`; the request body is sent as its structure (JSON field names and types, form field names, or just a length for other text); and the request name and status text have quoted strings, emails, URLs and numbers masked. **Suggest assertions** sends your existing tests as their `apx.test("…")` **titles only** (masked the same way), never their code. Explain also masks values in failure messages and does not send the test script (see below).
  - **Documentation descriptions**: a saved example response is sent as its structure (`bodyShape`), not its text; parameter examples are not sent (name, location and whether it is required only); the request body is sent as its structure; the request URL is reduced as above (no query values, ids as `:id`).
  - **Generate a request from a sentence**: no response is involved, so the setting does not change it. The request being modified and its neighbours are sent with their headers and bodies (credential values masked as usual), because the request is what you are asking the model to work on.
  - **See what will be sent** is built with the same code as the **Suggest assertions** payload, in both modes: it shows the request (method, URL, headers and body, plus the name; no auth or description, which are never sent), the response status and headers, the response body (or its structure) and your existing tests (or their titles), exactly as they would leave. It also lists the variable names.
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
| Explain failed tests | **Test Results** tab of the Response tab, **Explain with AI** (shown when a test failed) | *Explain and diagnose failures* |
| Generate or modify a request from a sentence | `Ctrl/Cmd+I` in the request builder, **Generate request here…** in a folder's menu | *Generate requests and tests from a description* |
| Generate, explain, fix or convert a script | **AI** button above the **Pre-request** and **Tests** editors; **Fix with AI** on a script error in the Console | *Scripting assistant* |
| Summarize a collection run | **Run summary** above the results of the Runner, **Summarize with AI** (shown when a request failed) | *Explain and diagnose failures* |

AI-written descriptions in exported docs carry a mark (HTML badge, Markdown note, `x-generated-by: ai` in OpenAPI). **Settings → AI → Exports → Mark AI-written content in exports** sets the default (on); the export dialog can override it per export, and the CLI has `--no-ai-mark`.

### Suggest assertions with AI

The **Suggest tests** panel always offers local, deterministic suggestions (status, headers, field types, formats). With the feature on, **Improve with AI** adds model suggestions: allowed values of enum-like fields, invariants between fields (a total equal to the sum of its items), volatile fields left out, readable titles.

- Nothing is sent when the panel opens. The call happens only when you click the button, and the panel says where the request and response go. With **Send response bodies** off, only the structure of the body is sent, and header values are replaced by names (plus a few protocol values, see above).
- **Where isolation is available, every suggestion is test-run before you see it.** The server runs each script, offline, in an isolated child process (see below), on the very response that inspired it. A suggestion that fails, does not parse, registers no test, or saves nothing (for captures) is dropped; the panel says how many were dropped. **Where isolation cannot be proven, nothing is run** ("parse-only" mode, see below): suggestions are only screened and syntax-checked, carry a **not executed** badge, may fail on this response, and are never pre-selected. Local suggestions stay as the fallback: if AI is off or the call fails, you still get them.
- AI suggestions carry an **AI** badge. Suggestions that may change between runs are flagged and never pre-checked; nothing is added to your script until you click **Add**, and a test already in the script is never duplicated.

### Explain failed tests

When a test fails, the **Test Results** tab shows **Explain with AI** (only when AI is on, consent is given and *Explain and diagnose failures* is enabled; it is **off by default**). The answer is a short diagnosis: a summary, up to four likely causes each with a low / medium / high confidence, and up to four suggested fixes (corrected assertion, missing header or variable, auth issue), optionally with a snippet.

- **What is sent**, after redaction, depends on **Send response bodies**:
  - **On (full)**: the request (method, URL, headers, body), the response (status, headers, a truncated body), the name and error message of each failed assertion, the test script, and the **names** of the variables you can use.
  - **Off (shape only)**: the request (URL without query values or ids, body as structure only, masked name) and the response status, with **header names only, no values** for both request and response headers (the only values kept are protocol metadata: the media type of `content-type` plus `charset`, `content-length`, the standard codings of `content-encoding`, the standard directives of `cache-control`, and the scheme word of `www-authenticate`), the response body's **structure only** (field names and types, no values), the failed assertion names and messages with every quoted string, email, URL and number replaced by `<string>` / `<number>` (so `expected 'a@b.c' to equal 'x'` becomes `expected <string> to equal <string>`), and the variable names. The **test script is not sent**, because it can contain literal values. The model is told the evidence is limited and to say what it cannot tell.
  - The panel says where it goes, and **Preview what is sent** shows the request and the response status and headers exactly as they are sent in the active mode, plus the failed assertions (masked as in the active mode), whether the test script is included (and its text when it is), the variable names and the active mode.
- The setting *Explain and diagnose failures* (Settings → AI → Features) covers this: when you click **Explain with AI** it sends the failed test names, their messages and the test script (secrets masked; with *Send response bodies* off the message values are masked and the script is not sent).
- **What is not sent**: the value of any variable, secret values (masked in every environment, including their base64 and URL-encoded forms), credentials and token-shaped strings, and the API key. Nothing is sent until you click the button; **Cancel** stops the call.
- **The answer is text only.** It is never applied to your request or script and never executed. A snippet is shown in a code block with a **Copy** button; paste it yourself if it helps. A snippet that reaches out (network calls, `require`, `import`, `eval`, `Function`, `process`, `constructor`, `__proto__`) or names a host outside your `{{variables}}` is removed from the answer; the fix description stays. Text is displayed without links, images or HTML, secret values are masked again, and the result carries an **AI-generated** badge. When the evidence is insufficient the model is told to say so with low confidence rather than guess.

#### Probable cause, without AI

When a request fails (no response, or an HTTP error status), the Response tab shows a **Probable cause** box built by fixed rules, with no AI and no network call, whether or not AI is enabled: an unresolved `{{variable}}` left in the URL, a refused connection, a host name that does not resolve, a TLS or certificate error, a `401` whose bearer token is a JWT with an `exp` in the past, a body sent without a `Content-Type`, and a `404` on a URL path containing `//`. The rules never read or show a token.

With *Explain and diagnose failures* on, **Explain with AI** is also offered for a failed request that has no failed test (a transport failure, or an HTTP error status with no test at all). The local findings are given to the model as context **by rule id only**: the server maps each id to its own fixed sentence and drops any other value, so nothing derived from your request (a variable name, a host, a token claim) travels through that channel, and a hostile id cannot inject text. **Preview what is sent** lists those sentences.

### Generate a request from a sentence

Press `Ctrl/Cmd+I` in the request builder, or choose **Generate request here…** in a folder's menu, and describe the request: *“POST /users with name and email, check 201 and that the id is a UUID”*.

What is sent: your sentence, the **names** (never the values) of the environment, global and collection variables, the `{{baseUrl}}` variable if you have one, and up to five neighbouring requests of the folder as style examples. Neighbouring requests are masked like any other AI payload, saved examples are not sent, and secret values from **all** environments are scrubbed.

In **New request** mode a **Destination** picker lists every collection and its folders (preselected to where you opened the bar). The chosen destination decides which neighbouring requests, collection variables, inherited authentication and known hosts are used as context (and for the security warning below), and where the request is created on **Apply**; it can only be changed before you generate, and **Regenerate** keeps it. Modify mode has no picker.

You then get a **proposal** to review: the request, and a diff of the generated scripts. Nothing is created until you click **Apply**; **Ignore** discards it and **Regenerate** asks again. Proposals carry an **AI-generated** badge.

- **New request** adds a separate request next to the current one (or in the folder you chose, or in a new unsaved tab). It never replaces an existing request.
- **Modify selected request** (builder only) shows what would change against the request as it is in the editor, including unsaved edits. Applying updates the editor only, marks it as unsaved, and an **Undo** link restores the previous state; your saved request changes only when you save. The request name is kept.
- Generated scripts are test-run in the isolated child process on a stand-in response (one automatic retry with the error), when isolation is available. In parse-only mode they are not run: the dialog says **Not executed** (the scripts passed the security screen and a syntax check, nothing more), `validation.executed` is `false`, and **Apply anyway** stays possible after you have read the warning. If a script passes the security screen but still fails its test run, the proposal is shown as **Not validated** with the reason, and the button reads **Apply anyway**. A script that the security screen **refuses** is never run and is removed from the proposal, with a warning: there is no "Apply anyway" for it. Passing validation means the scripts parse and call only known APIs; they have not run against your API.
- If the generated URL points to a host that is neither `{{baseUrl}}` nor the host of a neighbouring request, and the request uses a variable marked secret (URL, headers, auth, query or body), the dialog shows a warning and **Apply** stays disabled until you tick a confirmation.
- In **Modify** mode, disabled headers, file fields of a form-data body and path-variable values are kept as they are; the dialog lists what was kept.
- Credentials are never generated: authentication values, credential headers (`Authorization`, `X-Api-Key`, `X-Secret`, `X-*-Token`/`Key`/`Secret`...), and literal values of credential-looking query parameters and body fields (`api_key`, `password`, `client_secret`...) are kept only when they are `{{variable}}` references, otherwise they are left empty for you to fill in.
- HTTP/REST requests only. The command is hidden for GraphQL, SOAP, SQL, MongoDB and WebSocket requests.

### Scripting assistant

Above the **Pre-request** and **Tests** editors, the **AI** button (shown when AI is on, consent is given and *Scripting assistant* is enabled; **off by default**) opens a small panel with four modes:

| Mode | What it does |
|---|---|
| **Generate** | Writes the script your sentence describes (or updates the current one). |
| **Explain** | Explains the current script. Text only. |
| **Fix** | Takes the current script and an error message and proposes a corrected script. In the Console, a script error (a failed test script, or a `console.error`) shows **Fix with AI**: it only opens the panel on that request's script, with the error filled in; nothing is sent until you click **Fix**. |
| **Convert from Postman** | Rewrites `pm.*` scripts for `apx.*`. |

- **Nothing is sent when the panel opens.** The panel says what goes where, and **Preview what is sent** shows the exact, masked text (built by the same code as the payload). What is sent: your instruction (Generate), the current script, the error (Fix), and variable **names** (never values). Credentials, token-shaped strings and secret values are masked first. The script is the subject of the request and is **sent as written** (masked), also in shape-only mode; in shape-only mode, values quoted in an error message (which can come from a response) are replaced by `<string>` / `<number>`.
- **The model is given the real `apx` API.** The system prompt embeds `packages/ai/src/prompts/apx-reference.md`, generated by `scripts/gen-apx-reference.js` (`npm run gen:apx-reference`) from the real script runtime, so it cannot drift: a test fails when the committed file is stale. Members that Apilix has but the validation sandbox lacks (`softExpect`, `assertAll`, `response.xml*`, `request.*`, `deepProperty`, `matchSchema`) are listed apart as "not testable here"; a test keeps that list equal to what the sandbox really lacks. Network and flow-control members are not listed at all.
- **Conversion is deterministic first.** `pm` is an alias of `apx` in the runtime, so `pm.*` is renamed to `apx.*` (identifiers in code only; strings, comments, regular expressions and property names are untouched), and the legacy Postman forms with a one-to-one equivalent are rewritten (`postman.setEnvironmentVariable`, `responseBody`, `responseCode.code`, `tests["name"] = expr;`). Whatever apx does not have (`pm.cookies`, `pm.request.headers.add`, an unknown assertion…) is **reported, never guessed**. A script that converts completely makes **no AI call at all** (the dialog says "Converted without AI"); otherwise only the converted script and the list of missing members go to the model.
- **Every proposed script is validated.** The script is screened, then dry-run by the isolated child process described below (or only screened and syntax-checked in parse-only mode, which the dialog says: **Not executed**). A validation error triggers **one automatic retry** with the error; if it still fails the script is offered marked **Not validated**, with the reasons, and the button reads **Replace anyway**. A script the screen **refuses** (`require('fs')`, `eval`, `process`, `fetch`, unbounded loops…) is **never run and never offered**: the dialog shows the reason and the flagged names, and there is no way to apply it. (For a conversion the model rewrote, the automatic conversion is offered instead, marked not validated.) A deterministic conversion of your own script that the screen would refuse (for example a `while` loop) is shown, marked not validated, since you wrote it.
- **Nothing is applied or run automatically.** The answer opens in a dialog with a diff against the script in the editor; **Replace script** changes the editor only (the request is saved when you save), **Ignore** discards it, **Regenerate** asks again. A proposal identical to the current script cannot be replaced. Generated scripts never run against your API before you run the request yourself.
- **Save as snippet** stores the proposed script under **My snippets** in the **Snippets** library (browser storage, per script kind, at most 50 snippets of 20,000 characters; you can delete them there). Nothing is stored before you click.
- **Text is untrusted.** Explanations are shown without links, images or HTML, secret values are masked again, and a script containing something that looks like a credential gets a warning.

### Summarize a collection run

After a run with failures, the Runner shows a **Run summary**: the failures grouped by root cause (same method, URL template, status and message with quoted values and numbers replaced), biggest group first, with a one-paragraph summary. This is computed locally and needs no AI. With *Explain and diagnose failures* on, **Summarize with AI** asks the model for a short summary and a likely cause per group.

- **What is sent:** only the groups: counts, the method, the **URL template** (ids become `:id`, query values and credentials in the URL are dropped, whatever the mode), the status, the failure message and **at most 3 examples per group** (request name, status, up to 3 failed assertion names and messages). At most 30 groups; when the context limit is tight, examples then the smallest groups are dropped and the answer says how many groups were not sent. **Never** a request or response body, a header, or a variable value. In **every** mode (the setting does not matter here) quoted strings, emails, URLs and numbers in messages, example names and failure names and messages are replaced by placeholders (`expected <string> to equal <string>`), because an assertion message quotes values taken from the response. **Preview what is sent** shows exactly that data.
- The server re-sanitises everything the client sends. The answer is text only (AI-generated badge, no links or HTML, secret values masked again), is never applied, and is cleared when a new run replaces the results.

### How model-written scripts are handled

Model output is untrusted (it may be steered by text hidden in a response or in your collection). Scripts are never run on your API and never added to a request without your click.

**Threat model.** An attacker who can influence what the model writes (a prompt injection in a response body, in a neighbouring request, in a pasted instruction) may get a script that tries to read files, run programs, reach the network, exhaust memory or CPU, or forge a "this script passed" verdict. The server process holds your API key (in memory) and can reach your files, so **a model-written script must never run in it**. No code path of Apilix does that: `packages/ai` and `ai-routes.js` contain no `eval`, `new Function`, `vm.runIn*` or `runScript` for model text. The only `vm` that ever runs such a script lives in the worker file, in a separate process.

#### Two modes

The server decides once (and remembers) in which mode it works, in `resolveDryRunMode()` (`packages/ai/src/dry-run-mode.js`):

| | `isolated` | `parse-only` |
|---|---|---|
| Script screen (static) | yes | yes |
| Syntax check | yes (by running it) | yes: `new vm.Script` **compiles** it, never runs it, in the server process (compiling cannot execute code) |
| Script executed | **yes**, in a child process proven to run under the Node permission model | **never, anywhere** |
| Result | validated / dropped according to its test run | "not executed" in the UI; assertion suggestions are never pre-selected |

**When is it `isolated`?** Only after a **capability probe**, run once at first use with exactly the startup options of a real run: a child process (fixed code, no model text) tries to read a file outside its grant and to start a child process, and the answer must be `ERR_ACCESS_DENIED` for both. It is `parse-only` when:

- `APILIX_AI_DRY_RUN=off` is set (operator switch, read at every call);
- the runtime has no permission model flag, or the build is a `pkg` binary (the worker file cannot be forked from a `pkg` snapshot);
- the probe sees the flags ignored, an error other than `ERR_ACCESS_DENIED`, a launch error or a timeout. A definitive refusal is remembered for the life of the process; a probe that could not run at all is retried after 30 seconds.

`APILIX_AI_DRY_RUN=force` skips the probe and assumes isolation. It exists for tests and CI only: it trusts the runtime instead of checking it.

**Per runtime.** Plain Node 23.5+ takes `--permission`; Node 22.x takes `--experimental-permission` (22.12 is the minimum Apilix supports). Both only grant reading the worker's own file; nothing else. Electron (desktop) and `pkg` (the CLI binary, which does not run these scripts anyway) are not known to behave like plain Node: Apilix asks the Electron-embedded Node for the same flags and lets the probe decide; `pkg` is always parse-only. **This has been exercised on Node 24 only.** Whether a packaged Electron build or Node 22 passes the probe has not been verified; if they do not, they run in parse-only mode, which is the safe outcome by design. A failed or missing child never makes Apilix run a script in the server process.

#### What `isolated` does

1. **A dedicated child process** (`packages/ai/src/dry-run-worker.js`), JSON in and out, empty environment (no API keys, none of your variables), **64 MB V8 heap limit**, **SIGKILL after 3 seconds** whatever it does, killed as soon as the HTTP request is cancelled. At most two workers run at once and at most eight runs wait; beyond that a run is rejected at once as "busy" (the script is simply not validated; no server error, no model retry).
2. **The Node permission model**: no file-system read except the worker file, no write, no child process, no worker thread, no native addon. Node's permission model does **not** restrict the network in these versions: the barrier against the network is that the script has no reference to any host object.
3. **A hardened `vm` context.** The script sees only its own built-ins, no `Buffer`, `process`, `require`, `crypto` or timers; `eval`, `new Function` and WebAssembly are disabled; data crosses as one JSON string. The verdict collector (what records the tests) is **not a global**: the host holds it, so a script cannot redefine it to forge a verdict, and `apx`, `pm` and `console` are non-writable. Binary-memory globals (`ArrayBuffer`, typed arrays, `DataView`, `Atomics`, `SharedArrayBuffer`, `WebAssembly`) are removed from the context, because `--max-old-space-size` bounds the JavaScript heap but **not** memory held outside it. The runner implements the `apx.test`, `apx.expect`, `apx.response`, `apx.environment` and `apx.variables` APIs that suggestions need; a script using something else (`softExpect`, `assertAll`, `response.xml*`, `request.*`, `deepProperty`, `matchSchema`) is reported as not validated. The scripting assistant uses the same gate; its generated reference says which members are not testable.
4. **A static screen** (defence in depth, not the barrier), applied in both modes. It refuses `constructor`/`prototype`, reflection, `call`/`apply`/`bind`, `eval`, `Function`, `process`, `require`, `import`, `globalThis`, any name starting with `__`, computed property names, escapes, getters/setters, classes, unbounded loops and `await` next to a loop, network and flow-control calls, binary-memory types, and `repeat`/`padStart`/`padEnd`/`Array(n)` with a non-literal or large size. When it cannot tell what the engine would do it refuses. A refused script is never executed, not even in the worker, and is removed from the proposal.

**Limits of the cost control.** Apilix does not cap the child's total resident memory: Node has no such option and `ulimit`/job-object limits are not portable. Memory is bounded by the heap limit, by removing binary-memory APIs, and by the 3-second kill; a script can still burn up to 3 seconds of one CPU core. The AI routes `suggest-assertions`, `generate-request` and `script-assist` are also limited to 12 calls per minute and one call at a time (one lock for the whole server, not keyed on anything the caller sends), with `429 RATE_LIMIT` beyond.

#### What each mode guarantees, and what it does not

- `isolated`: model code never runs in the server process; it runs in a process that Node itself prevents from reading your files or starting programs (when the probe confirmed it). It does **not** guarantee a perfect sandbox: a hand-written screen cannot be proven complete, and the `vm` context and the worker share the Node binary, so a bug in V8 or Node's `vm` or permission model could in principle still be exploited. It can still use CPU for a few seconds and cannot be proven to bound all off-heap memory.
- `parse-only`: nothing the model wrote runs, so there is nothing to escape from. In exchange there is no assurance that a script works: it may fail on the response it was written for. The screen and a syntax check are all that was done. You review it before you add or apply it.
- Neither mode validates the script against your real API: scripts never run there before you run the request yourself.

Only enable these features with providers you trust. Anything the model writes that is shown as text (titles, warnings) has images, links and HTML neutralised, and unexpected fields are dropped before the answer reaches the interface.

### Threat-model notes for the scripting and diagnosis features

- **New data leaving the machine** (each only after a click, each previewable): the user's script (masked, sent as written even in shape-only mode, because it is the object of the request), a console error (value-masked in shape-only mode), the aggregated failure groups of a run, and local-diagnosis rule ids.
- **New untrusted channels:** the script and the error text are wrapped as untrusted data and cannot close the data block; the explanation, notes and warnings returned by the model are neutralised and scrubbed; a proposed script is the same class of artefact as in *Generate a request* and goes through the same screen and isolated dry-run. A model that is steered by text in a script or an error can at worst propose a wrong or refused script, which you review in a diff.
- **No new execution path.** `script-assist` never runs model text in the server process. `convert` without a model never runs anything (text rewriting only; its output is screened and dry-run like any other script before it is shown as validated).
- **The deterministic converter is not a security boundary.** It rewrites text; the screen and the child process remain the barrier.
- **Local diagnosis ids** are an allow-list on the server (an unknown id is dropped), so the client cannot smuggle free text through that field.
- **Summaries** are limited by construction to metadata (no body, header or variable value), and the server does not trust the client's grouping: it re-templates URLs, clips, masks and re-scrubs.
- **Not verified:** behaviour against a real model (prompt quality, the retry loop with real models), and the isolated dry-run in a packaged Electron build or on Node 22 (parse-only is the safe fallback); see above.

## Limits

- One AI request runs at a time. Assertion suggestions, request generation and the scripting assistant (the routes that dry-run scripts) are also limited to 12 calls per minute (`429` with code `RATE_LIMIT`).
- AI request bodies are limited to 2 MB. A response body longer than 900,000 characters is truncated before it is sent (the panel says so); a too-large payload gives a clear "too large" message.
- AI output is always shown for review; Apilix never runs or saves AI-generated content on its own.

## CLI

AI-enabled CLI options (currently `apilix docs --ai-describe`) read their configuration from environment variables only (never command-line arguments, which leak into shell history and process lists): `APILIX_AI_PROVIDER` (`anthropic` by default, or `openai-compat`), `APILIX_AI_MODEL`, `APILIX_AI_API_KEY`, `APILIX_AI_BASE_URL`. See [API Documentation](API-Documentation#ai-written-descriptions).
