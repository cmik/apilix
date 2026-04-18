# Authentication

Apilix supports multiple authentication schemes that can be configured at the request, folder, or collection level. Setting auth on a collection and using **Inherit** on individual requests means you only update credentials in one place.

---

## Table of Contents

- [Authentication](#authentication)
  - [Table of Contents](#table-of-contents)
  - [Configuring Auth](#configuring-auth)
  - [No Auth](#no-auth)
  - [Inherit Auth from Parent](#inherit-auth-from-parent)
  - [Bearer Token](#bearer-token)
  - [Basic Auth](#basic-auth)
  - [API Key](#api-key)
  - [OAuth 2.0](#oauth-20)
    - [Grant Types](#grant-types)
    - [Authorization Code with PKCE](#authorization-code-with-pkce)
    - [Client Credentials](#client-credentials)
    - [Refresh Token](#refresh-token)
    - [Preset Providers](#preset-providers)
      - [Setting up a Google OAuth app](#setting-up-a-google-oauth-app)
      - [Setting up a GitHub OAuth app](#setting-up-a-github-oauth-app)
      - [Setting up an Azure AD app](#setting-up-an-azure-ad-app)
    - [Token Status \& Auto-Refresh](#token-status--auto-refresh)
    - [Field Reference](#field-reference)
  - [Auth Inheritance \& Overrides](#auth-inheritance--overrides)
  - [Using Variables in Auth Fields](#using-variables-in-auth-fields)
  - [See Also](#see-also)

---

## Configuring Auth

Open the **Auth** tab in the Request Builder to configure authentication for the current request.

![Auth tab in request builder](images/auth-tab-overview.png)

The auth type selector at the top of the tab lets you choose from:

| Type | Description |
|---|---|
| **No Auth** | Send the request with no auth headers |
| **Inherit auth from parent** | Use the auth configured on the parent folder or collection |
| **Bearer Token** | `Authorization: Bearer <token>` |
| **Basic Auth** | `Authorization: Basic <base64(username:password)>` |
| **API Key** | A custom header with a key name and value you define |
| **OAuth 2.0** | Full OAuth 2.0 flows with automatic token management |

Auth can be set at three levels:
- **Request** — overrides everything above it
- **Folder** — applies to all requests in the folder that use `Inherit`
- **Collection** — applies to all requests and folders that use `Inherit`

---

## No Auth

Select **No Auth** to send the request without any authentication headers. Use this for public endpoints or when you handle auth manually via a pre-request script or custom header.

---

## Inherit Auth from Parent

Select **Inherit auth from parent** to delegate auth to the nearest ancestor (folder or collection) that has a non-inherit auth type configured.

The resolution chain walks up:
```
Request (Inherit) → Folder (Inherit) → Collection (Bearer Token) ✓
```

If no ancestor has a concrete auth type configured, no auth headers are injected.

**Recommended pattern:** Set the auth type once on the collection and leave all requests as **Inherit**. When credentials change (e.g. a new token), update only the collection-level auth.

---

## Bearer Token

Injects the header:
```
Authorization: Bearer <token>
```

![Bearer token configuration](images/auth-bearer.png)

| Field | Description |
|---|---|
| **Token** | The raw token value. Supports `{{variable}}` placeholders. |

**Example with a variable:**
```
Token: {{accessToken}}
```

Set `accessToken` in your active environment, or use a pre-request script to populate it dynamically (see [Pattern: Capture a token after login](Variables-and-Environments#pattern-2-capture-a-token-after-login)).

---

## Basic Auth

Injects the header:
```
Authorization: Basic <base64(username:password)>
```

The encoding is handled automatically — enter the plain username and password.

![Basic auth configuration](images/auth-basic.png)

| Field | Description |
|---|---|
| **Username** | The account username. Supports `{{variable}}`. |
| **Password** | The account password. Supports `{{variable}}`. |

> **Security note:** Store credentials in environment variables (e.g. `{{basicUser}}`, `{{basicPass}}`) rather than hardcoding them in the request. This also makes switching between environments seamless.

---

## API Key

Sends a custom header with a key name and value you define.

![API Key configuration](images/auth-apikey.png)

| Field | Description |
|---|---|
| **Key** | The header name (e.g. `X-API-Key`, `x-auth-token`). |
| **Value** | The key value. Supports `{{variable}}`. |

**Example:**
```
Key:   X-API-Key
Value: {{apiKey}}
```

This produces the header:
```
X-API-Key: sk-live-abc123...
```

---

## OAuth 2.0

Apilix implements a full OAuth 2.0 client with three grant types, automatic token refresh, PKCE support, and preset configurations for popular providers.

![OAuth 2.0 configuration panel](images/auth-oauth2-panel.png)

### Grant Types

| Grant Type | When to use |
|---|---|
| **Authorization Code (PKCE)** | User-facing applications where the user grants access via a browser login. PKCE is always enabled. |
| **Client Credentials** | Machine-to-machine (M2M) flows where the application authenticates itself, without user involvement. |
| **Refresh Token** | Exchange an existing refresh token for a new access token (manual re-auth). |

---

### Authorization Code with PKCE

This is the most secure and common flow for applications where the end-user authorises access.

**How it works:**

1. Apilix generates a random **PKCE verifier** and its SHA-256 **code challenge**.
2. Apilix opens a browser window pointing to the **Authorization URL** with `response_type=code`, `code_challenge`, and `state` parameters.
3. The user logs in and grants access. The provider redirects to the **Redirect URL** with a `code` query parameter.
4. Apilix detects the redirect, extracts the `code`, and exchanges it for tokens via the **Token URL**, sending the `code_verifier` for PKCE validation.
5. The access token (and refresh token if provided) are stored and displayed in the **Token Status** panel.
6. On subsequent requests, the access token is injected automatically as `Authorization: Bearer <token>`.

![Authorization Code flow — browser window](images/auth-oauth2-authcode-browser.png)

**Step-by-step setup:**

1. In the Auth tab, select **OAuth 2.0**.
2. Choose a **Preset Provider** (e.g. Google) or select **Custom** and fill in URLs manually.
3. Set **Grant Type** to **Authorization Code (PKCE)**.
4. Enter **Client ID** (and optionally **Client Secret** for confidential clients).
5. Set the **Redirect URL** — defaults to `http://localhost:3000/oauth/callback` in the desktop app.
6. Add any required **Scopes** (space-separated, e.g. `openid profile email`).
7. Click **Get New Access Token** — a browser window opens for the user to authorise.
8. After authorisation, Apilix exchanges the code and displays the token status.

> **In Electron:** Apilix launches Chrome directly. In web mode, start Chrome manually with `--remote-debugging-port=9222` and connect first.

---

### Client Credentials

Used for server-to-server APIs where no user interaction is involved. The application authenticates with its own credentials.

**How it works:**

1. Apilix sends a `POST` request to the **Token URL** with `grant_type=client_credentials`, `client_id`, `client_secret`, and `scope`.
2. The provider returns an access token.
3. The token is used automatically for all requests in this collection/request.

**Step-by-step setup:**

1. Select **OAuth 2.0** → **Client Credentials**.
2. Enter **Token URL**, **Client ID**, and **Client Secret**.
3. Add scopes if required by the API.
4. Click **Get New Access Token** — the token is fetched immediately (no browser window needed).

---

### Refresh Token

Use this grant type when you already have a refresh token (e.g. from a previous Authorization Code flow) and want to exchange it for a new access token without going through the browser flow again.

**Step-by-step setup:**

1. Select **OAuth 2.0** → **Refresh Token**.
2. Enter **Token URL**, **Client ID**, **Client Secret**, and the existing **Refresh Token** value.
3. Click **Get New Access Token** — the server exchanges the refresh token for a new access token.

---

### Preset Providers

Selecting a preset fills in the Authorization URL, Token URL, and default scopes automatically.

| Preset | Authorization URL | Token URL | Default Scopes |
|---|---|---|---|
| **Google** | `https://accounts.google.com/o/oauth2/v2/auth` | `https://oauth2.googleapis.com/token` | `openid profile email` |
| **GitHub** | `https://github.com/login/oauth/authorize` | `https://github.com/login/oauth/access_token` | `repo workflow read:user` |
| **Azure AD** | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` | `https://login.microsoftonline.com/common/oauth2/v2.0/token` | `openid profile email` |
| **Custom** | — | — | — |

After selecting a preset, a link to the provider's official OAuth documentation is shown. You still need to provide your own **Client ID** and **Client Secret** from the provider's developer console.

#### Setting up a Google OAuth app

1. Go to [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth 2.0 Client ID**.
3. Choose **Web application**.
4. Add `http://localhost:3000/oauth/callback` to **Authorised redirect URIs**.
5. Copy the **Client ID** and **Client Secret** into Apilix.

#### Setting up a GitHub OAuth app

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set **Authorization callback URL** to `http://localhost:3000/oauth/callback`.
3. Copy the **Client ID** and generate a **Client Secret**.

#### Setting up an Azure AD app

1. Go to [Azure Portal](https://portal.azure.com) → **Azure Active Directory → App registrations → New registration**.
2. Set the redirect URI to `http://localhost:3000/oauth/callback` (platform: Web).
3. Copy the **Application (client) ID** and create a **Client Secret** under **Certificates & secrets**.

---

### Token Status & Auto-Refresh

The **Token Status** panel at the bottom of the OAuth configuration shows:

| Indicator | Description |
|---|---|
| ✅ Token active | Token is valid with time remaining shown (e.g. `expires in 47m 12s`) |
| ⚠ Token expiring soon | Token expires in less than 60 seconds — will be refreshed automatically |
| ❌ Token expired | Token has expired — click **Refresh Token Now** or **Get New Access Token** |
| — No token | No token has been obtained yet |

![OAuth token status panel](images/auth-oauth2-token-status.png)

**Automatic refresh:** Before each request, the server checks the token's `expiresAt` timestamp. If the token is expired or will expire within **60 seconds**, it is refreshed automatically using the stored refresh token (Authorization Code flow) or by re-requesting a token (Client Credentials flow). The request proceeds with the fresh token — no manual action required.

**Manual refresh:** Click **Refresh Token Now** to force a token refresh regardless of expiration.

---

### Field Reference

Full reference of all OAuth 2.0 configuration fields:

| Field | Required | Applies to | Description |
|---|---|---|---|
| **Grant Type** | ✅ | All | `Authorization Code`, `Client Credentials`, or `Refresh Token` |
| **Preset Provider** | — | All | Pre-fills URLs and scopes for Google, GitHub, Azure AD |
| **Client ID** | ✅ | All | Application client ID from the provider |
| **Client Secret** | ✅* | CC, RT | Client secret. Optional for public Authorization Code clients. |
| **Authorization URL** | ✅ | AC | Provider's authorise endpoint (e.g. `/oauth/authorize`) |
| **Token URL** | ✅ | All | Provider's token endpoint (e.g. `/oauth/token`) |
| **Scopes** | — | All | Space-separated list of requested scopes (e.g. `openid profile`) |
| **Redirect URL** | ✅ | AC | Callback URL registered with the provider. Default: `http://localhost:3000/oauth/callback` |
| **Refresh Token** | ✅ | RT | Existing refresh token to exchange |
| **Custom Headers** | — | All | Extra headers to send to the token endpoint (e.g. `x-tenant-id`) |

> Grant type abbreviations: **AC** = Authorization Code, **CC** = Client Credentials, **RT** = Refresh Token.

> All text fields support `{{variable}}` substitution — store secrets in environment variables, not hardcoded.

---

## Auth Inheritance & Overrides

Auth is evaluated at send time using this resolution order:

```
1. Request-level auth (if not "Inherit")
2. Nearest parent folder with a concrete auth type (if not "Inherit")
3. Collection-level auth
4. No auth
```

**Practical example:**

```
My API Collection  [Bearer Token: {{accessToken}}]
├── Public              [No Auth]          ← overrides collection
│   └── GET /health
├── Users               [Inherit]          ← uses collection Bearer
│   ├── GET /users
│   └── POST /users
└── Admin               [Basic Auth]       ← overrides collection
    └── DELETE /users/:id
```

In this structure:
- `GET /health` sends no auth headers.
- `GET /users` and `POST /users` inherit the Bearer token from the collection.
- `DELETE /users/:id` sends Basic auth, overriding the collection's Bearer token.

---

## Using Variables in Auth Fields

All auth fields support `{{variable}}` substitution and provide live autocomplete as you type. This is the recommended way to manage credentials:

**Environment variables for auth:**

| Variable | Value in "Production" env | Value in "Staging" env |
|---|---|---|
| `accessToken` | `eyJ...prod...` | `eyJ...staging...` |
| `apiKey` | `live_key_xyz` | `test_key_abc` |
| `basicUser` | `produser` | `staginguser` |
| `basicPass` | `prodpass` | `stagingpass` |

Setting the Bearer Token field to `{{accessToken}}` and switching environments automatically changes the token used — without editing the request itself.

**Setting auth tokens from scripts:**

```js
// Pre-request script: obtain a fresh token if missing
if (!apx.environment.get('accessToken')) {
  apx.sendRequest({
    url: apx.environment.get('tokenUrl'),
    method: 'POST',
    header: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      mode: 'urlencoded',
      urlencoded: [
        { key: 'grant_type', value: 'client_credentials' },
        { key: 'client_id', value: apx.environment.get('clientId') },
        { key: 'client_secret', value: apx.environment.get('clientSecret') },
      ]
    }
  }, (err, res) => {
    apx.environment.set('accessToken', res.json().access_token);
  });
}
```

---

## See Also

- [Variables & Environments](Variables-and-Environments) — store credentials securely in environment variables
- [Scripting](Scripting) — `apx.sendRequest()` for scripted auth flows
- [Collections & Requests](Collections-and-Requests) — collection-level auth settings
- [Import & Export](Import-and-Export) — OAuth config is preserved in Postman v2.1 exports
