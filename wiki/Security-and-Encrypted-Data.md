# Security and Encrypted Data

Apilix is designed to keep your credentials, tokens, and secrets safe at rest and in transit. This page covers every security layer in the application — from how sensitive environment variables are stored on disk to how TLS certificates are verified when making requests.

---

## Table of Contents

- [Secret Environment Variables](#secret-environment-variables)
- [UI Secret Masking](#ui-secret-masking)
- [OS Keychain Encryption (Electron)](#os-keychain-encryption-electron)
- [Browser Mode Limitations](#browser-mode-limitations)
- [Sync Credential Encryption](#sync-credential-encryption)
- [Remote Data Encryption](#remote-data-encryption)
- [TLS and SSL Verification](#tls-and-ssl-verification)
- [OAuth 2.0 Security](#oauth-20-security)
- [S3 Presigned URLs](#s3-presigned-urls)
- [Electron Security Model](#electron-security-model)
- [Script Sandbox Isolation](#script-sandbox-isolation)
- [File System Path Protection](#file-system-path-protection)
- [Proxy and Traffic Interception](#proxy-and-traffic-interception)
- [Security Best Practices](#security-best-practices)

---

## Secret Environment Variables

Any environment variable value can be marked as **secret**. Secret variables are:

- Displayed as `••••••••` in the environment editor and the quick-panel.
- Encrypted on disk using the OS keychain before being written to `workspaces/<id>.json`.
- Decrypted transparently when the workspace is loaded, so they are available to requests and scripts as normal.

### Marking a variable as secret

1. Open **Environments** in the sidebar (or the quick-panel via the environment selector in the toolbar).
2. Add or edit a variable row.
3. Click the **lock icon** (🔒) next to the value field to toggle the secret flag.
   - Orange lock = secret (encrypted at rest).
   - Grey lock = plain (stored as-is).
4. Click **Save**.

> **Tip:** Use secret variables for tokens, passwords, API keys, and any other value you would not want visible in a screenshot or a shared screen.

### What the secret flag does — and does not — protect

| Scenario | Protected? |
|---|---|
| Value written to disk in Electron | ✅ Encrypted via OS keychain |
| Value in memory (Redux state) at runtime | ❌ Plain — required for request execution |
| Value written to localStorage in browser mode | ❌ No encryption available |
| Value transmitted during remote sync | ⚠️ Only if **Encrypt remote data** is enabled — see [Remote Data Encryption](#remote-data-encryption) |
| Value visible in request history / console | ✅ Redacted by default when **Mask secret variable values** is enabled |

---

## UI Secret Masking

Apilix can redact known secret values in user-facing logs to reduce accidental exposure during demos, screenshots, and screen sharing.

### What gets masked

When **Mask secret variable values in console, logs, and history** is enabled (default), Apilix replaces matching secret values with `••••••••` in:

- Console row URL
- Console request details (URL, request headers, request body)
- Console script log lines
- Request History URL rows
- Console pop-out window (including live updates)

### Which values are considered secrets

Redaction values are built from the **active environment** only, using rows that are:

- Marked secret (lock enabled)
- Enabled
- At least 4 characters long

### Important scope note

Masking is a UI redaction layer. It does not change the underlying request/response data used by execution, scripts, exports, or sync.

### Turning masking off

Open **Settings → Requests** and disable **Mask secret variable values in console, logs, and history**.

---

## OS Keychain Encryption (Electron)

When running as a desktop app, Apilix uses Electron's `safeStorage` API to encrypt and decrypt secret values. This API delegates to the platform's native keychain:

| Platform | Keychain backend |
|---|---|
| macOS | Keychain Services |
| Windows | DPAPI (Data Protection API) |
| Linux | libsecret / Gnome Keyring |

Encrypted values are stored as **base64-encoded ciphertext** inside the JSON workspace files. The encryption key is tied to the OS user account — encrypted data cannot be decrypted on a different machine or by a different OS user.

### Key properties

- The encryption key is managed by the OS, not by Apilix.
- No passphrase is required from the user for local encryption.
- Reinstalling Apilix or resetting the OS keychain will make previously encrypted values unrecoverable. Back up plain-text copies of critical secrets before reinstalling.

### What happens when decryption fails

If `safeStorage` cannot decrypt a value (e.g., after an app reinstall or machine migration), Apilix logs a warning and returns the raw ciphertext as a fallback. The variable will appear with garbled content — this is intentional to surface the problem rather than silently losing data.

---

## Browser Mode Limitations

When Apilix runs in a browser (no Electron wrapper), `window.electronAPI` is absent and the `safeStorage` API is not available. In this mode:

- Secret variable values are stored in `localStorage` **without encryption**.
- Sync credentials are stored in `localStorage` in plaintext.
- No OS keychain integration is available.

**Browser mode is intended for development and evaluation only.** Use the desktop (Electron) build for any work involving real credentials or sensitive data.

---

## Sync Credential Encryption

Sync provider credentials (S3 access keys, Git tokens, HTTP auth headers, team API tokens) are written to `sync-config.json` in the userData directory. In Electron mode these credentials are encrypted with `safeStorage` before being persisted, matching the same mechanism used for secret environment variables.

In browser mode, sync credentials are stored in `localStorage` as plaintext.

---

## Remote Data Encryption

When syncing a workspace to a remote store (S3, MinIO, HTTP backend, Git, or team server), you can enable **Encrypt remote data** to protect the workspace payload at rest on the remote side.

### How it works

1. In the **Sync** panel, enable the **Encrypt remote data** toggle.
2. Enter a **passphrase**. This passphrase is used as the encryption key — it is never sent to the remote; only you (and anyone you share the passphrase with) can decrypt the data.
3. When Apilix pushes a workspace, the JSON payload is encrypted with the passphrase before upload.
4. When Apilix pulls, the ciphertext is decrypted locally using the stored passphrase.

> **Important:** If you lose the passphrase, the remote data cannot be recovered. Store it in a password manager.

### Shared workspaces

When sharing a workspace with team members via a share link or team sync, the receiving user imports the workspace and is prompted for the passphrase if the workspace was encrypted. Apilix marks imported encrypted workspaces with an `importedEncrypted` flag so the UI can prompt for the passphrase at the right time.

---

## TLS and SSL Verification

### SSL verification setting

By default, SSL certificate verification is **disabled** to allow testing against local development servers and self-signed certificates. You can enable it globally in **Settings → Requests → SSL certificate verification**.

When verification is enabled, Apilix merges:

1. **Node's built-in Mozilla CA bundle** (`tls.rootCertificates`)
2. **OS certificate store** (Windows only — via `win-ca`, which pulls from the Windows Certificate Store)

This means enterprise or corporate root CAs that are trusted by your OS are also honoured — HTTPS requests to internal services with corporate-issued certificates work without needing to import extra CA files manually.

### Per-request SSL control (OAuth token endpoints)

OAuth 2.0 token requests respect the **sslVerification** field on the OAuth2 configuration object. When `sslVerification` is `true`, the same merged CA list is used. When `false`, verification is skipped entirely for that token endpoint.

### HTTPS agents

Apilix reuses pre-created `https.Agent` instances (one for verify, one for insecure) to preserve TCP connection pooling. The agent for verified connections includes the full merged CA list.

---

## OAuth 2.0 Security

Apilix implements several security measures for OAuth 2.0 flows:

### PKCE (Proof Key for Code Exchange)

The Authorization Code flow with PKCE is supported. Apilix:

1. Generates a cryptographically random **code verifier** (128 characters from the unreserved character set, using `crypto.randomInt`).
2. Derives the **code challenge** by SHA-256 hashing the verifier and base64url-encoding the result.
3. Sends only the challenge to the authorization server; the verifier never leaves the client until the token exchange step.

### Token storage

Access tokens and refresh tokens are stored within the collection/request auth configuration in the workspace data. If the variable holding the token is marked as **secret**, it is encrypted on disk. For maximum security, store OAuth tokens in secret environment variables and reference them via `{{variableName}}` in the auth configuration.

### Automatic token refresh

Apilix automatically refreshes expired tokens before executing a request when:

- A **refresh token** is available (any grant type).
- The grant type is **client_credentials** (a new token is fetched directly).

If a token cannot be refreshed (e.g., for an Authorization Code flow where the user has not yet authorized), Apilix surfaces an explicit error rather than silently sending an unauthenticated request.

---

## S3 Presigned URLs

When using S3 or MinIO as a sync backend, Apilix generates **short-lived presigned URLs** in the Electron main process rather than exposing your AWS/MinIO credentials to the renderer process. This means:

- The `accessKeyId` and `secretAccessKey` are never passed to renderer-side JavaScript.
- Presigned URLs expire after **60 seconds**, limiting the window of exposure if a URL is intercepted.
- Supported operations are restricted to `GET`, `PUT`, and `HEAD` — arbitrary S3 operations cannot be requested.

---

## Electron Security Model

The Apilix desktop app enforces Electron's recommended security settings:

| Setting | Value | Effect |
|---|---|---|
| `nodeIntegration` | `false` | Renderer process cannot access Node.js APIs directly |
| `contextIsolation` | `true` | Renderer and preload script run in separate JavaScript contexts |
| `devTools` | Disabled in production | DevTools are off in packaged builds by default |

The renderer communicates with the main process only through the `contextBridge`-exposed `window.electronAPI` object, which provides a narrow, audited API surface. The main process enforces path traversal checks on all file system operations (see [File System Path Protection](#file-system-path-protection)).

External `http://` and `https://` links opened within the app are redirected to the system browser via `shell.openExternal` instead of opening in a new Electron window — preventing arbitrary web content from gaining access to the Electron context.

---

## Script Sandbox Isolation

Pre-request and test scripts run inside a Node.js `vm` context (a separate V8 context). The sandbox:

- Does not expose Node.js built-in modules (`fs`, `child_process`, `net`, etc.) to script code.
- Provides a controlled `crypto` object (the Web Crypto API) for hashing and signing operations.
- Limits `apx.sendRequest()` calls to HTTP/HTTPS requests only, using a dedicated Axios instance.
- Surfaces test failures and assertion errors back to the response viewer without crashing the server process.

Scripts can read and write environment variables, globals, and collection variables via the `apx.*` API, but they cannot access the file system, spawn processes, or interact with other OS resources.

---

## File System Path Protection

All file system IPC handlers in the main process validate that the requested path is inside the Electron `userData` directory before performing any read, write, or delete operation. A path traversal attempt (e.g., `../../etc/passwd`) throws an error and is rejected.

```
Path traversal detected: path must be inside userData
```

This ensures that renderer-side code — even if compromised — cannot read or overwrite arbitrary files on the host system.

---

## Proxy and Traffic Interception

Apilix supports routing all outgoing requests through an HTTP/HTTPS proxy (**Settings → Proxy**). This is useful for:

- Corporate proxy servers that require authentication.
- Security research tools such as Burp Suite or OWASP ZAP for inspecting traffic.

When using an intercepting proxy for security testing, combine it with **SSL verification disabled** (Settings → Requests) so that the proxy's certificate is accepted. Do not use this combination against production systems.

The `noProxy` list lets you exclude specific hostnames (e.g., `localhost, .internal.corp`) from proxy routing so that local services are not accidentally routed through the proxy.

---

## MongoDB Connection Registry

Named MongoDB connections are stored in an AES-256-GCM encrypted file on disk:

- **Path:** `~/.apilix/mongo-connections.enc.json`
- **Encryption key:** Derived from the `APILIX_MONGO_SETTINGS_KEY` environment variable if set, otherwise derived from the system hostname. Set `APILIX_MONGO_SETTINGS_KEY` to a stable secret in production environments to survive hostname changes.
- **Auth tag:** Each record includes a 12-byte random IV and a GCM authentication tag, ensuring integrity verification on read.

### What is encrypted

| Field | Encrypted? |
|---|---|
| Connection URI (may contain password) | ✅ Yes — entire file is encrypted at rest |
| Connection name / alias | ✅ Yes |
| Database default | ✅ Yes |
| Connection list (names only, no URIs) returned by `GET /api/mongo/connections` | ❌ No — only metadata; URIs are never returned over the API |

### Introspect endpoints

The `POST /api/mongo/introspect/databases` and `POST /api/mongo/introspect/collections` endpoints accept a MongoDB URI as input and contact the target server on behalf of the Apilix server process. To limit misuse as an SSRF vector, both endpoints enforce:

- The URI **must** use the `mongodb://` or `mongodb+srv://` scheme. Requests with any other scheme (e.g. `http://`, `file://`) are rejected with HTTP 400.
- These endpoints are intended for use only by the Apilix UI on `localhost`. Do **not** expose the Apilix server port (`3001`) to the public internet.

### Rotating the encryption key

1. Export your connections by calling `GET /api/mongo/connections` and noting the IDs and names (URIs are not included).
2. Re-add each connection via `POST /api/mongo/connections` with the new `APILIX_MONGO_SETTINGS_KEY` set.
3. The old encrypted file is overwritten with the new key on the first write.

### Browser mode

Named MongoDB connections are stored via the same server-side API in both Electron and browser (web app) mode. The encryption key derivation is the same; however, in browser mode the key is derived from the server's hostname, not the user's OS keychain.

---

## Security Best Practices

| Recommendation | Why |
|---|---|
| Use the **desktop (Electron) build** for real credentials | Browser mode stores secrets in plaintext localStorage |
| Mark all tokens and passwords as **secret** | Encrypts them on disk via the OS keychain |
| Enable **Encrypt remote data** when syncing to shared storage | Protects your workspace if the remote store is compromised |
| Store a **passphrase backup** in a password manager | Remote encrypted data is unrecoverable without the passphrase |
| Enable **SSL verification** when testing production APIs | Protects against MITM attacks on real traffic |
| Keep secret values in **environment variables** rather than hardcoded in requests | Prevents accidental exposure in shared collections or exports |
| Rotate secrets stored in environments after sharing a collection export | Exports may include environment values depending on export options |
