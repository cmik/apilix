# API Documentation Export

Apilix can turn a collection (or a single folder) into shareable API documentation. Three formats are available:

| Format | Output | Typical use |
|---|---|---|
| **HTML** | One self-contained `.html` file | Share with teammates, host as a static page |
| **Markdown** | One `.md` file | Commit next to code, paste into a wiki or README |
| **OpenAPI** | `.json` or `.yaml` (OpenAPI 3.0.3, optional 3.1) | Feed API gateways, SDK generators, Swagger UI, Redoc |

The HTML output is **static**: no "Try it" button, no scripts, and no CDN assets (the only network requests are images that your descriptions reference, see below). A restrictive Content-Security-Policy is embedded in the page, and the output is deterministic (no timestamps), so it diffs cleanly in version control.

## Table of Contents

- [Exporting from the app](#exporting-from-the-app)
- [Options](#options)
- [What is documented](#what-is-documented)
- [Security: credentials and secrets](#security-credentials-and-secrets)
- [Saved examples](#saved-examples)
- [OpenAPI mapping](#openapi-mapping)
- [CLI](#cli)
- [Limitations](#limitations)

---

## Exporting from the app

- Right-click a **collection** in the sidebar and choose **Export documentation…**
- Right-click a **folder** and choose **Export documentation…** to document only that folder.
- Or open **Export**, pick the **Docs** format, select exactly one collection and click **Configure…**.

The dialog shows a live preview (HTML is rendered in a sandboxed frame with scripts disabled). Click **Save…** to write the file; on desktop this opens the native Save dialog, in the browser it triggers a download.

## Options

| Option | Default | Description |
|---|---|---|
| Format | HTML | HTML, Markdown or OpenAPI |
| OpenAPI serialization | YAML (app) / JSON (CLI) | JSON or YAML |
| OpenAPI version | 3.0.3 | Tick "Use OpenAPI 3.1" for 3.1.0 |
| Theme (HTML) | Dark | Dark, Light or Auto (follows the OS). The page also has a Light / Dark toggle that works without JavaScript |
| Variables | Keep `{{var}}` | **Keep** leaves `{{variable}}` verbatim. **Resolve** substitutes non-secret values from the active environment (and collection variables) |
| Include saved examples | On | Render Postman saved example responses |
| Code snippets (HTML/Markdown) | None | cURL, Python, JavaScript (fetch/axios), Go, PHP, Ruby, C#, HURL |
| Include credentials | Off | See [Security](#security-credentials-and-secrets) |

## What is documented

For each HTTP request: name, method, URL, description (a safe subset of Markdown is rendered in HTML), path variables, query parameters, headers, body (raw, URL-encoded, form-data, file, GraphQL), effective authentication (including auth inherited from folders or the collection), saved examples and optional code snippets. Disabled headers, parameters and fields are omitted.

Folders become sections (HTML/Markdown) or tags (OpenAPI). Non-HTTP requests (MongoDB, SQL and other database requests) are skipped and reported as warnings. Pre-request and test scripts are never included.

## Security: credentials and secrets

Redaction is **deny-by-default**:

- Bearer tokens, basic-auth usernames and passwords, API key values and OAuth 2.0 client secrets or tokens are replaced with `<redacted>`.
- Headers such as `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` (and any header whose name looks like a credential) are redacted.
- Query parameters, form fields and JSON body keys with credential-like names (`token`, `secret`, `password`, `api_key`, `signature`, ...) are redacted. The same applies to saved example headers and bodies.
- `user:password@` in URLs is stripped.
- `{{variable}}` references are always preserved, so docs still show where a value comes from.
- Secret environment variables (marked as secret) are **never** substituted, even in Resolve mode. Dynamic variables such as `{{$guid}}` are left as-is so output stays deterministic.
- In the app, a final masking pass removes any known secret value (active environment and globals) from the finished file.

**Include credentials** is an explicit opt-in that keeps literal credential values in the output. A warning is shown in the dialog. Secret environment values remain masked in the app.

### Redaction is name-based and best-effort

Redaction decides by **name**, never by the shape of a value. It cannot recognise a secret that sits under a harmless name. Review the output before publishing.

Covered (when Include credentials is off):

- Sensitive names: anything containing `token`, `secret`, `password`, `passwd`, `pwd`, `api key`, `signature`, `credential`, `private key`, `access key`, `session`, `cookie`, `bearer`, `jwt`, `csrf`, `xsrf`, `authoriz...`, `authentic...` or `oauth`, plus the whole words `pass`, `pw`, `auth`, `sig`, `key`, `code` and `pin` (also inside `snake_case` and `camelCase` names). Names like `passenger`, `bypass`, `compass` and `authors` are not treated as sensitive.
- JSON bodies (raw, GraphQL variables and saved examples), including bodies with unquoted `{{variables}}` and bodies that do not parse (regex fallback). Everything beneath a sensitive key is redacted: scalars, array items and nested objects.
- `application/x-www-form-urlencoded` style raw bodies (`key=value&...`) and XML/SOAP elements or attributes with sensitive names (for example `<password>`, `<wsse:Password>`).
- Query and fragment parameters in every URL: request URLs, OAuth 2.0 token/authorization URLs, saved example `originalRequest` URLs, header values such as `Location`, `Content-Location`, `Link` and `Referer`, and OpenAPI server and flow URLs.
- `user:password@` userinfo, including passwords containing `/` or `@` and the scheme-less `user:pass@host` form.
- Variables listed as secret in the active environment (also in the Variables table), and, in the app, every known secret value in its raw, HTML-escaped, JSON/YAML-escaped, markdown-escaped and URL-encoded forms.

Not covered:

- A secret under a harmless name (`X-Custom: s3cr3t`, `{"note": "my password is ..."}`), or secrets in free text such as descriptions, names, GraphQL queries or non-JSON/XML/urlencoded bodies.
- Secrets embedded in URL **paths** (`/reset/<token>`).
- Secrets inside multipart/form-data file contents, binary bodies, or values nested in a string-encoded JSON string.
- Include credentials = on disables all of the above except the in-app known-secret mask.

## Saved examples

Apilix preserves Postman `item.response[]` (saved examples) on import, duplication and export, and renders each example (status, headers, body and original request) in HTML and Markdown, and as response `examples` in OpenAPI. Apilix does not yet have a UI for creating examples; import a Postman collection that contains them.

## OpenAPI mapping

- Requests are grouped by host into `servers`; `{{baseUrl}}` becomes a templated server `{baseUrl}` with a default taken from the collection variable when available.
- `:id` and `{{var}}` path segments become `{id}` / `{var}` path parameters.
- Each operation gets a unique `operationId` derived from the request name; folders become `tags`.
- Auth maps to `components.securitySchemes` (bearer, basic, API key, OAuth 2.0 authorization code / client credentials, digest). Collection-level auth becomes the global `security`; request or folder overrides become operation-level `security`; "No auth" becomes `security: []`.
- Request bodies map to `requestBody` by mode, with a schema inferred from JSON samples.
- Responses come from saved examples; otherwise a `default` response is emitted.
- Skipped items (unsupported methods, duplicate method + path, unsupported auth types) are returned as warnings.

The output can be re-imported with **Import → OpenAPI**.

## CLI

```bash
# HTML to stdout
apilix docs ./collection.json > docs.html

# Markdown with cURL snippets
apilix docs ./collection.json --format md --snippets curl --out API.md

# OpenAPI YAML for one folder
apilix docs ./collection.json --format openapi --openapi-format yaml --folder "Users" --out openapi.yaml

# Resolve non-secret environment values
apilix docs ./collection.json -e ./prod.env.json --resolve-variables --out docs.html
```

| Flag | Description |
|---|---|
| `--format <html\|md\|openapi>` | Output format (default `html`) |
| `--openapi-format <json\|yaml>` | OpenAPI serialization (default `json`) |
| `--openapi-version <3.0.3\|3.1.0>` | OpenAPI version (default `3.0.3`) |
| `--folder <id\|name\|A/B>` | Document only one folder |
| `-e, --environment <file>` | Environment file (used with `--resolve-variables`) |
| `--resolve-variables` | Substitute non-secret environment values |
| `--include-credentials` | Keep literal credentials |
| `--snippets <list>` | Comma-separated snippet languages (the CLI supports `curl`) |
| `--theme <dark\|light\|auto>` | HTML theme |
| `--no-examples` | Omit saved examples |
| `--out <file>` | Write to a file instead of stdout. Refused (exit 2) if it resolves to the collection or environment file |

Warnings are printed to stderr. Exit code `0` on success, `2` for usage or input errors.

## Limitations

- Static output only: no interactive "Try it" console.
- Examples can be imported but not authored in the UI.
- Only the cURL snippet language is available from the CLI.
- Credential detection is name-based and JSON-aware, not a general secret scanner.

## HTML in descriptions

Descriptions (collection, folder, request, parameter) may contain Markdown and a safe subset of HTML in the HTML export:

- Inline: `b`, `strong`, `i`, `em`, `u`, `s`, `del`, `ins`, `code`, `kbd`, `mark`, `small`, `sub`, `sup`, `br`, `a`, `img`
- Block: `p`, `ul`, `ol`, `li`, `table` (`thead`/`tbody`/`tr`/`th`/`td`), `blockquote`, `pre`, `h1`-`h6`, `hr`, `details`, `summary`, `div`
- Attributes are dropped, except `href` on links (`http(s):`, `mailto:` or `#`), `colspan`/`rowspan` on cells, and `src`, `alt`, `title`, `width`, `height` on images.
- Images (`<img>` or `![alt](url)`) load only from `http(s):` URLs or `data:image/png|jpeg|gif|webp;base64,` URIs. This is the one thing in the file that can reach the network when it is opened, so a collection from an untrusted source can make the viewer's browser fetch an image URL.
- Anything else (`script`, `style`, `iframe`, `form`, ...) is shown as visible text. The Markdown export still escapes raw HTML.

