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
- [HTML in descriptions](#html-in-descriptions)

---

## Exporting from the app

- Right-click a **collection** in the sidebar and choose **Export documentation…**
- Right-click a **folder** and choose **Export documentation…** to document only that folder.
- Or open **Export**, pick the **Docs** format, select exactly one collection and click **Configure…** (the app shows "Select exactly one collection to export documentation." otherwise).

When you start from a folder, only that folder (and its sub-folders) is documented. The title becomes `Collection / Folder`, the folder description is appended to the collection description, and authentication inherited from the collection or parent folders is still shown. Requests outside the folder are left out.

The dialog (**Export documentation**) shows a live preview that updates as you change options. HTML is rendered in a sandboxed frame with scripts disabled; Markdown and OpenAPI are shown as text (truncated after 30,000 characters in the preview only, the saved file is complete). Warnings, such as skipped requests, are listed under the preview.

Click **Save…** to write the file. On desktop this opens the native Save dialog. In the browser it uses the file picker when the browser supports one, and otherwise triggers a download. Suggested file names are `<name>.docs.html`, `<name>.docs.md`, `<name>.openapi.yaml` and `<name>.openapi.json` (`<name>` is the collection name, or `collection-folder` for a folder export).

## Options

| Option | Default | Description |
|---|---|---|
| Format | HTML | HTML, Markdown or OpenAPI |
| OpenAPI serialization (OpenAPI only) | YAML (app) / JSON (CLI) | **YAML** or **JSON** |
| OpenAPI version (OpenAPI only) | 3.0.3 | Tick "Use OpenAPI 3.1 (default 3.0.3)" for 3.1.0 |
| Render images (HTML only) | On | Loads images from descriptions. Turn it off to render every image as a text link and block image loading (see [Content-Security-Policy and the image trade-off](#content-security-policy-and-the-image-trade-off)). Remote images are fetched when the file is opened |
| Theme (HTML only) | Dark | Dark, Light or Auto (follows the OS). The page also has a Light / Dark toggle that works without JavaScript |
| Variables | Keep `{{var}}` | **Keep** leaves `{{variable}}` verbatim. **Resolve** substitutes non-secret values from the active environment and from collection variables (environment values win) |
| Include saved examples | On | Render saved example responses |
| Code snippets (HTML/Markdown only) | None | Tick any of: cURL, Python (requests), JavaScript (fetch), JavaScript (axios), Go (net/http), PHP (cURL), Ruby (Net::HTTP), C# (HttpClient), HURL |
| Include credentials | Off | See [Security](#security-credentials-and-secrets) |

In **Resolve** mode, variables are substituted only when they are defined, are not marked as secret in the active environment, and do not have a credential-like name. Everything else (including dynamic variables such as `{{$guid}}`) stays as `{{variable}}`. Global variables are not used for substitution. Saved example bodies are never variable-substituted.

## What is documented

For each HTTP request: name, method, URL, description (a safe subset of Markdown is rendered in HTML), path variables, query parameters, headers, body (raw, URL-encoded, form-data, file, GraphQL), effective authentication (including auth inherited from folders or the collection), saved examples and optional code snippets. Disabled headers, parameters and fields are omitted.

Folders become sections (HTML/Markdown) or tags (OpenAPI). Enabled collection variables are listed in a Variables table (HTML/Markdown) and drive the server defaults in OpenAPI. Non-HTTP requests (MongoDB, SQL and other database requests) are skipped and reported as warnings. Pre-request and test scripts are never included.

## Security: credentials and secrets

Redaction is **deny-by-default**:

- Bearer tokens, basic-auth usernames and passwords, API key values and OAuth 2.0 client IDs, client secrets and access tokens are replaced with `<redacted>`.
- A credential value that consists only of `{{variable}}` references (optionally behind a `Bearer`, `Basic`, `Token` or `Digest` word) is kept, since it contains no literal secret.
- Headers such as `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` (and any header whose name looks like a credential) are redacted.
- Query parameters, form fields and JSON body keys with credential-like names (`token`, `secret`, `password`, `api_key`, `signature`, ...) are redacted. The same applies to saved example headers and bodies.
- `user:password@` in URLs is stripped, including the protocol-relative `//user:password@host` form.
- A literal `Bearer <value>` or `Basic <value>` in a free-text header value (for example a custom header, or a saved example header) is replaced by `Bearer <redacted>` / `Basic <redacted>`. `Bearer {{token}}` is kept.
- `{{variable}}` references are always preserved, so docs still show where a value comes from.
- Secret environment variables (marked as secret) are **never** substituted, even in Resolve mode. Dynamic variables such as `{{$guid}}` are left as-is so output stays deterministic.
- In the app, a final masking pass removes any known secret value (active environment and globals) from the finished file.

**Include credentials** is an explicit opt-in that keeps literal credential values in the output. A warning is shown in the dialog. Secret environment values remain masked in the app.

### Redaction is name-based and best-effort

Redaction decides by **name**, never by the shape of a value. It cannot recognise a secret that sits under a harmless name. Review the output before publishing.

Covered (when Include credentials is off):

- Sensitive names (percent-encoded and `+`-encoded query, header and form keys are decoded before the check, so `api%5Fkey` is treated like `api_key`; a malformed sequence such as `api%2Dkey%E0` or `%74oken%ZZ` does not hide the name. A double-encoded name such as `%2574oken` is decoded only once and is therefore not recognised): anything containing `token`, `secret`, `password`, `passwd`, `pwd`, `api key`, `signature`, `credential`, `private key`, `access key`, `session`, `cookie`, `bearer`, `jwt`, `csrf`, `xsrf`, `authoriz...`, `authentic...` or `oauth`, plus the whole words `pass`, `pw`, `auth`, `sig`, `key`, `code` and `pin` (also inside `snake_case` and `camelCase` names). Names like `passenger`, `bypass`, `compass` and `authors` are not treated as sensitive.
- JSON bodies (raw, GraphQL variables and saved examples), including bodies with unquoted `{{variables}}` and bodies that do not parse (regex fallback). Everything beneath a sensitive key is redacted: scalars, array items and nested objects.
- Single-line `application/x-www-form-urlencoded` style raw bodies (`key=value&...`) and XML/SOAP elements or attributes with sensitive names (for example `<password>`, `<wsse:Password>`). The text of a sensitive element is redacted whatever its mix of text, CDATA sections and comments (`<password>a<![CDATA[b]]></password>`).
- Query and fragment parameters in every URL: request URLs, OAuth 2.0 token/authorization URLs, saved example `originalRequest` URLs, header values such as `Location`, `Content-Location`, `Link` and `Referer`, and OpenAPI server and flow URLs.
- `user:password@` userinfo, including passwords containing `/` or `@` and the scheme-less `user:pass@host` form.
- Variables listed as secret in the active environment (also in the Variables table). In the app, every known secret value (secret rows of the active environment and secret globals) is additionally masked in its raw, HTML-escaped, JSON/YAML-escaped, markdown-escaped, URL-encoded and shell-quoted forms. The CLI has no such final pass: it only withholds the secret rows of the environment file you pass.

Not covered:

- A secret under a harmless name (`X-Custom: s3cr3t`, `{"note": "my password is ..."}`), or secrets in free text such as descriptions, names, GraphQL queries or non-JSON/XML/urlencoded bodies.
- Secrets embedded in URL **paths** (`/reset/<token>`).
- Secrets inside multipart/form-data file contents, binary bodies, or values nested in a string-encoded JSON string.
- Include credentials = on disables all of the above except the in-app known-secret mask.

## Saved examples

A saved example is a stored response attached to a request (Postman's `item.response[]`). Examples come from two places:

- **Import.** Examples in an imported Postman collection are kept on the request and are written back when you export the collection as Postman JSON.
- **Save response as example.** After sending a request that belongs to a collection, click the bookmark icon in the response toolbar (tooltip **Save response as example**). The example is named after the response (for example `200 OK`) and stores the status, headers, body and a copy of the request. The button is not shown for error responses or for requests that are not stored in a collection, and it is disabled when the response is already a saved example, is binary, or has a body over 1 MB.

In the collection tree, a request with examples shows a **▸ N** toggle. Expand it to list the examples. Click one to view it in the response panel, use the pencil icon to rename it, or the **×** icon to delete it (after a **Delete example?** confirmation).

Examples are rendered (name, status, original request, headers and body) in HTML and Markdown, and become response `examples` in OpenAPI. In the docs, the original request is reduced to its method, its URL without the query string, and its raw body. Disabled example headers are omitted.

> **Privacy:** a saved example stores the response exactly as received, together with the request that produced it. It is redacted by name when you export documentation, but it is included unredacted in Postman JSON exports, snapshots and workspace sync. Do not save responses that contain secrets you would not share.

## OpenAPI mapping

- `info.title` is the collection name (`Collection / Folder` for a folder export), `info.version` is always `1.0.0`, and the description comes from the collection description.
- Requests are grouped by host into `servers`; `{{baseUrl}}` becomes a templated server `{baseUrl}` with a default taken from the collection variable when available (empty when that variable is redacted). When several hosts are used, each operation lists its own server.
- `:id` and `{{var}}` path segments become `{id}` / `{var}` path parameters.
- Query parameters and headers become `parameters`. `Content-Type`, `Accept` and `Authorization` headers are not emitted as parameters. Redacted values are not used as `example`.
- Each operation gets a unique `operationId` derived from the request name. Folders become `tags` (nested folders are joined as `A / B`); folder descriptions become tag descriptions.
- Auth maps to `components.securitySchemes` (bearer, basic, API key, OAuth 2.0 authorization code / client credentials, digest). Collection-level auth becomes the global `security`; request or folder overrides become operation-level `security`; "No auth" becomes `security: []` when a collection-level auth exists.
- Request bodies map to `requestBody` by mode, with a schema inferred from JSON samples.
- Responses come from saved examples, grouped by status code (`default` when the code is missing or invalid), with the example body under `content[mime].examples`. Without examples a `default` response is emitted.
- Skipped items are returned as warnings: unsupported methods, duplicate method + path, non-HTTP requests, unsupported auth types, and OAuth 2.0 requests that use the `refresh_token` grant, which has no OpenAPI flow and is omitted. When a request has its own auth that cannot be expressed (the `refresh_token` grant or an unsupported type) and the collection has auth, the operation gets `security: []` and a warning, so it does not wrongly inherit the collection-level scheme.

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
| `--format <html\|md\|openapi>` | Output format (default `html`; `markdown` is accepted as a synonym of `md`) |
| `--openapi-format <json\|yaml>` | OpenAPI serialization (default `json`) |
| `--openapi-version <3.0.3\|3.1.0>` | OpenAPI version (default `3.0.3`) |
| `--folder <id\|name\|A/B>` | Document only one folder, matched by id, name or `Parent/Child` name path |
| `-e, --environment <file>` | Environment JSON file. Required with `--resolve-variables`; secret rows are never substituted |
| `--resolve-variables` | Substitute non-secret environment values instead of keeping `{{var}}` |
| `--include-credentials` | Keep literal credentials |
| `--snippets <list>` | Comma-separated snippet languages (the CLI supports `curl`) |
| `--theme <dark\|light\|auto>` | HTML theme (default `dark`) |
| `--no-examples` | Omit saved examples |
| `--no-images` | HTML only: do not render images; they become text links and the CSP is `img-src 'none'` (default: images are rendered) |
| `--out <file>` | Write to a file instead of stdout (missing parent folders are created) |

`--out` is refused if it points to the collection file or to the environment file, including through a symlink, so a mistyped path cannot overwrite your input.

Warnings are printed to stderr as `Warning: ...`; with `--out`, a `Documentation written to <path>` line is printed there too. Exit code `0` on success, `2` for usage or input errors (unknown format, theme, OpenAPI version or snippet language, `--resolve-variables` without `--environment`, unreadable or invalid JSON files, folder not found, refused `--out`).

## Limitations

- Static output only: no interactive "Try it" console.
- Binary responses and responses over 1 MB cannot be saved as examples.
- Only the cURL snippet language is available from the CLI. Its snippets are generated from the already redacted model, so they never contain more than the document itself.
- OpenAPI output has no representation for the OAuth 2.0 `refresh_token` grant or for auth types other than bearer, basic, API key, OAuth 2.0 and digest; these are reported as warnings, and a request-level occurrence under a collection-level auth is emitted with `security: []`.
- Credential detection is name-based and JSON-aware, not a general secret scanner.

## HTML in descriptions

Descriptions (collection, folder, request, parameter) may contain a small subset of Markdown (headings, bullet and numbered lists, fenced code blocks, inline code, bold, italic, links and images) and a safe subset of HTML in the HTML export:

- Inline: `b`, `strong`, `i`, `em`, `u`, `s`, `del`, `ins`, `code`, `kbd`, `mark`, `small`, `sub`, `sup`, `br`, `a`, `img`
- Block: `p`, `ul`, `ol`, `li`, `table` (`thead`/`tbody`/`tfoot`/`caption`/`tr`/`th`/`td`), `blockquote`, `pre`, `h1`-`h6`, `hr`, `details`, `summary`, `div`
- Attributes are dropped, except `href` on links (`http(s):`, `mailto:` or `#`; links are emitted with `rel="noopener noreferrer nofollow"`), `colspan`/`rowspan` on cells, and `src`, `alt`, `title`, `width`, `height` on images. An `<img>` without a safe `src` is shown as text.
- A single HTML tag is read up to 64 KB (65 536 characters), so long `data:` image URIs and long links are rendered. A tag that is not closed within that limit is shown as text. Markdown links and images accept a label of up to 500 characters and a URL of up to 2000 characters without spaces or `(`; longer ones are shown as text.
- Images (`<img>` or `![alt](url)`) load only from `http(s):` URLs or `data:image/png|jpeg|gif|webp;base64,` URIs, and only when image rendering is on (the default). With **Render images** off (`--no-images`, option `renderImages: false`) no `<img>` tag is emitted: an image with an `http(s):` source becomes a link (`<a href=...>alt text or URL</a>`, same checks and `rel` as other links), a `data:` image becomes its alt text (a `data:` URI is not a valid link target), and an image with an unsafe source is shown as text as before.
- Anything else (`script`, `style`, `iframe`, `form`, ...) is shown as visible text.

### Content-Security-Policy and the image trade-off

Every HTML file embeds this policy: `default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; base-uri 'none'; form-action 'none'`. Scripts, fonts, frames, forms and network calls are blocked; only inline styles and images are allowed. The file itself contains no script. With **Render images** off the policy is `... img-src 'none' ...`, so nothing can be loaded even if markup slipped through.

Images are the one thing that can reach the network when the file is opened. A collection from an untrusted source can therefore make the viewer's browser request an image URL, which tells the host that the document was opened (and from which IP address). Review image references in descriptions before publishing or opening documentation generated from a collection you do not trust. The preview in the app renders in a sandboxed frame with scripts disabled, but images can still load there when **Render images** is on (the preview follows the checkbox).

The Markdown export escapes raw HTML in descriptions, but it does not strip Markdown image syntax (`![alt](url)`), so a Markdown viewer that renders images can load them. An `<img>` tag with an `http(s):` or `data:image/...` source is converted to Markdown image syntax (`![alt](url)`, width and other attributes dropped); other raw HTML stays escaped. The OpenAPI export copies descriptions as they are (JSON and YAML), without sanitising them, so both `![alt](url)` and `<img>` stay in the `description` fields. OpenAPI viewers (Swagger UI, Redoc and similar) render those descriptions as Markdown themselves, so they display the images: that is a property of the viewer, not of Apilix.

The **Render images** option (`renderImages`) applies to the HTML export only. The Markdown and OpenAPI exports always keep images in the description text, whatever its value.

