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
- **Every suggestion is test-run before you see it.** The server runs each script in the real script sandbox, offline, on the very response that inspired it. A suggestion that fails, does not parse, registers no test, or saves nothing (for captures) is dropped; the panel says how many were dropped. Local suggestions stay as the fallback: if AI is off or the call fails, you still get them.
- AI suggestions carry an **AI** badge. Suggestions that may change between runs are flagged and never pre-checked; nothing is added to your script until you click **Add**, and a test already in the script is never duplicated.

### Generate a request from a sentence

Press `Ctrl/Cmd+I` in the request builder, or choose **Generate request here…** in a folder's menu, and describe the request: *“POST /users with name and email, check 201 and that the id is a UUID”*.

What is sent: your sentence, the **names** (never the values) of the environment, global and collection variables, the `{{baseUrl}}` variable if you have one, and up to five neighbouring requests of the folder as style examples. Neighbouring requests are masked like any other AI payload, saved examples are not sent, and secret values from **all** environments are scrubbed.

You then get a **proposal** to review: the request, and a diff of the generated scripts. Nothing is created until you click **Apply**; **Ignore** discards it and **Regenerate** asks again. Proposals carry an **AI-generated** badge.

- **New request** adds a separate request next to the current one (or in the folder you chose, or in a new unsaved tab). It never replaces an existing request.
- **Modify selected request** (builder only) shows what would change against the request as it is in the editor, including unsaved edits. Applying updates the editor only, marks it as unsaved, and an **Undo** link restores the previous state; your saved request changes only when you save. The request name is kept.
- Generated scripts are test-run in the sandbox on a stand-in response (one automatic retry with the error). If they still fail, the proposal is shown as **Not validated** with the reason, and the button reads **Apply anyway**. Passing validation means the scripts parse and call only known APIs; they have not run against your API.
- Credentials are never generated: authentication values and credential headers are kept only when they are `{{variable}}` references, otherwise they are left empty for you to fill in.
- HTTP/REST requests only. The command is hidden for GraphQL, SOAP, SQL, MongoDB and WebSocket requests.

### How model-written scripts are handled

Model output is untrusted. Scripts are never run on your API and never added to a request without your click. For the dry-runs described above they are first screened (no `constructor`/`prototype` access, no computed property names, no `eval`, `Function`, `process` or `require`, no network or flow-control calls, no changes to built-ins), then executed offline with a short time limit. A script that fails the screen is not executed at all. The screen is a safety net on top of the script sandbox, which is not a security boundary against deliberately hostile code: only enable these features with providers you trust.

Anything the model writes that is shown as text (titles, warnings) has images, links and HTML neutralised, and unexpected fields are dropped before the answer reaches the interface.

## Limits

- One AI request runs at a time.
- AI request bodies are limited to 2 MB.
- AI output is always shown for review; Apilix never runs or saves AI-generated content on its own.

## CLI

AI-enabled CLI options (currently `apilix docs --ai-describe`) read their configuration from environment variables only (never command-line arguments, which leak into shell history and process lists): `APILIX_AI_PROVIDER` (`anthropic` by default, or `openai-compat`), `APILIX_AI_MODEL`, `APILIX_AI_API_KEY`, `APILIX_AI_BASE_URL`. See [API Documentation](API-Documentation#ai-written-descriptions).
