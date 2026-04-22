# Settings and Configuration

The **Settings** modal provides global configuration for Apilix. Changes take effect immediately and are persisted at the app level across workspaces.

Open it by clicking the gear icon (⚙️) in the bottom-left corner of the Activity Bar, or via the keyboard shortcut **⌘,** / **Ctrl+,**.

---

## Table of Contents

- [Settings and Configuration](#settings-and-configuration)
  - [Table of Contents](#table-of-contents)
  - [Appearance](#appearance)
  - [Requests](#requests)
  - [Proxy](#proxy)
  - [CORS](#cors)
  - [About](#about)
  - [Settings Reference](#settings-reference)

---

## Appearance

![Settings — Appearance tab](images/settings-appearance.png)

**Theme**

Choose how Apilix renders its UI:

| Option | Behaviour |
|---|---|
| 🌙 **Dark** | Dark slate theme (default) |
| ☀️ **Light** | Light theme |
| 🖥 **System** | Follows your OS light/dark preference |

---

## Requests

![Settings — Requests tab](images/settings-requests.png)

Controls applied to every request Apilix sends through its local proxy server.

| Setting | Default | Description |
|---|---|---|
| **Request timeout (ms)** | `30000` | Maximum time (milliseconds) to wait for a response. Set to `0` to disable the timeout entirely and wait indefinitely. |
| **Follow redirects** | On | When enabled, Apilix automatically follows HTTP 3xx redirects. Disable to inspect the raw redirect response. |
| **SSL certificate verification** | Off | When enabled, the server validates the SSL certificate of the target host. Disable for self-signed certificates in development environments. |
| **Mask secret variable values in console, logs, and history** | On | Redacts known secret values (from enabled secret rows in the active environment) in Console and Request History UI surfaces. |

---

## Proxy

![Settings — Proxy tab](images/settings-proxy.png)

Route all outgoing requests through an HTTP/HTTPS proxy (e.g. a corporate proxy, Burp Suite, or Charles Proxy).

| Setting | Description |
|---|---|
| **Enable proxy** | Master toggle. When off, all proxy fields are greyed out and ignored. |
| **HTTP Proxy URL** | Proxy URL for `http://` requests. Example: `http://proxy.example.com:8080` |
| **HTTPS Proxy URL** | Proxy URL for `https://` requests. Can be the same as the HTTP proxy. Example: `http://proxy.example.com:8080` |
| **No proxy** | Comma-separated list of hostnames or domains that bypass the proxy. Example: `localhost, 127.0.0.1, .internal.example.com` |

> **Tip:** To intercept traffic with a local proxy tool like Burp Suite, set both proxy URLs to `http://127.0.0.1:8080` and disable SSL verification in the **Requests** tab.

---

## CORS

![Settings — CORS tab](images/settings-cors.png)

The Apilix local server enforces a `localhost`-only CORS policy by default. Use this tab to whitelist additional origins that need to reach the Apilix API server directly.

| Setting | Description |
|---|---|
| **Allowed origins** | Comma-separated list of origins to add to the CORS allow-list. The built-in localhost rule always applies regardless of what is entered here. |

**Example:**
```
https://app.example.com, http://custom.host:5000
```

This is useful when you run Apilix in web mode (e.g. `http://localhost:3001`) and want to allow a separate front-end origin to make requests to the Apilix API server on port `3000`.

---

## About

![Settings — About tab](images/settings-about.png)

Displays the current application version and provides links to the project repository.

**Update check**

Click **Check for update** to query the [GitHub Releases API](https://api.github.com/repos/cmik/apilix/releases/latest) for the latest published release:

| Status | Indicator |
|---|---|
| Checking | Spinning arrow |
| Up to date | Green checkmark — "Up to date" |
| Update available | Amber warning — "vX.Y.Z available" (links to the releases page) |
| Error | Red text — "Could not reach GitHub" + Retry link |

**Links**

- **GitHub** — opens `https://github.com/cmik/apilix` in a new tab.

---

## Settings Reference

| Key | Type | Default | Where used |
|---|---|---|---|
| `theme` | `'dark' \| 'light' \| 'system'` | `'dark'` | Appearance tab |
| `requestTimeout` | `number` (ms) | `30000` | Requests tab; applied by the executor for every request |
| `followRedirects` | `boolean` | `true` | Requests tab; executor redirect behaviour |
| `sslVerification` | `boolean` | `false` | Requests tab; executor TLS check |
| `maskSecrets` | `boolean` | `true` | Requests tab; redacts known secret values in Console and Request History |
| `proxyEnabled` | `boolean` | `false` | Proxy tab; whether proxy settings are applied |
| `httpProxy` | `string` | `''` | Proxy tab; proxy URL for HTTP targets |
| `httpsProxy` | `string` | `''` | Proxy tab; proxy URL for HTTPS targets |
| `noProxy` | `string` | `''` | Proxy tab; bypass list |
| `corsAllowedOrigins` | `string` | `''` | CORS tab; extra allowed origins for the local server |

All settings are stored in the active workspace and persist across sessions.
