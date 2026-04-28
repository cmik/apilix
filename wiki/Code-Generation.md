# Code Generation

The **Code Generation** modal converts any request currently open in the Request Builder into a ready-to-run snippet in nine languages and formats. Copy the snippet directly into your project or CI pipeline — no manual translation required.

---

## Table of Contents

- [Code Generation](#code-generation)
  - [Table of Contents](#table-of-contents)
  - [Opening the Modal](#opening-the-modal)
  - [Language Selector](#language-selector)
  - [Supported Languages](#supported-languages)
  - [What Gets Included](#what-gets-included)
  - [Language Reference](#language-reference)
    - [cURL](#curl)
    - [Python (requests)](#python-requests)
    - [JavaScript (fetch)](#javascript-fetch)
    - [JavaScript (axios)](#javascript-axios)
    - [Go (net/http)](#go-nethttp)
    - [PHP (cURL)](#php-curl)
    - [Ruby (Net::HTTP)](#ruby-nethttp)
    - [C# (HttpClient)](#c-httpclient)
    - [HURL](#hurl)
  - [Auth Handling per Language](#auth-handling-per-language)
  - [Body Modes per Language](#body-modes-per-language)
  - [Copying the Snippet](#copying-the-snippet)
  - [Common Workflows](#common-workflows)
    - [Quickly test an endpoint from the terminal](#quickly-test-an-endpoint-from-the-terminal)
    - [Generate a baseline SDK call](#generate-a-baseline-sdk-call)
    - [Share a reproducible example](#share-a-reproducible-example)
    - [Generate a HURL test file](#generate-a-hurl-test-file)

---

## Opening the Modal

With a request open in the Request Builder, click the **`</>`** (Code) button in the toolbar. The Code Generation modal opens and immediately shows a snippet for the currently selected language.

![Code Generation modal](images/code-gen-modal.png)

The modal is **live** — it reads the current state of the request (URL, method, headers, body, auth) at the moment you open it. If you change the request and re-open the modal you will get an updated snippet.

---

## Language Selector

A dropdown at the top of the modal lists all available languages. Select one and the snippet in the preview area updates instantly.

```
Language  [ Python (requests) ▼ ]        [ Copy ]
```

The default selection is **Python (requests)**.

---

## Supported Languages

| ID | Label shown in dropdown | Library / tool |
|---|---|---|
| `curl` | cURL | `curl` CLI |
| `python` | Python (requests) | `requests` |
| `js-fetch` | JavaScript (fetch) | `fetch` (browser / Node 18+) |
| `js-axios` | JavaScript (axios) | `axios` |
| `go` | Go (net/http) | `net/http` |
| `php` | PHP (cURL) | `curl_*` PHP extension |
| `ruby` | Ruby (Net::HTTP) | `Net::HTTP` |
| `csharp` | C# (HttpClient) | `System.Net.Http.HttpClient` |
| `hurl` | HURL | [hurl](https://hurl.dev/) CLI |

---

## What Gets Included

Each snippet is generated from five aspects of the current request:

| Aspect | Included |
|---|---|
| **Method** | Always |
| **URL** | Always (raw URL string with all query params) |
| **Headers** | All enabled headers |
| **Body** | Raw / URL-encoded / form-data / GraphQL — detected from current body mode |
| **Auth** | Bearer, Basic, or API Key — added as a header before custom headers |

Disabled headers and disabled body fields are excluded from all generated snippets.

> **Variable resolution:** `{{variable}}` placeholders in the URL, headers, body, and auth fields are resolved against the active environment, collection variables, and globals before the snippet is generated. The emitted snippet contains the resolved values — not the placeholder tokens — so it runs immediately without modification.

---

## Language Reference

### cURL

```bash
curl -X POST "https://api.example.com/users" \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

- Uses `-X` for the method (always explicit, even for GET).
- Each header is a separate `-H` flag.
- Raw body uses `-d`. URL-encoded body uses multiple `--data-urlencode` entries. Form-data uses `-F`.

---

### Python (requests)

```python
import requests

url = "https://api.example.com/users"

headers = {
    "Authorization": "Bearer eyJ...",
    "Content-Type": "application/json",
}

payload = '{"name":"Alice"}'

response = requests.post(url, headers=headers, data=payload)

print(response.status_code)
print(response.text)
```

- HTTP method maps to `requests.<method>()` (lowercase).
- Raw body → `data=payload`.
- URL-encoded body → `data={"key": "value"}` dict.
- Form-data body → `files={"key": (None, "value")}`.

---

### JavaScript (fetch)

```js
const response = await fetch(
  "https://api.example.com/users",
  {
    method: "POST",
    headers: {
      "Authorization": "Bearer eyJ...",
      "Content-Type": "application/json",
    },
    body: "{\"name\":\"Alice\"}",
  }
);

const data = await response.json();
console.log(data);
```

- Uses `await` — place inside an async function or top-level module.
- Form-data body creates a `FormData` object and uses `form.append()` calls before the `fetch`.

---

### JavaScript (axios)

```js
import axios from 'axios';

const response = await axios.post(
  "https://api.example.com/users",
  "{\"name\":\"Alice\"}",
  {
    headers: {
      "Authorization": "Bearer eyJ...",
      "Content-Type": "application/json",
    },
  }
);

console.log(response.data);
```

- Body and config are separate arguments for methods that accept a body (`POST`, `PUT`, `PATCH`).
- For body-less methods (`GET`, `HEAD`, `DELETE`, `OPTIONS`), the config object is passed as the second argument directly.

---

### Go (net/http)

```go
package main

import (
    "fmt"
    "io"
    "net/http"
    "strings"
)

func main() {
    payload := strings.NewReader(`{"name":"Alice"}`)
    req, err := http.NewRequest("POST", "https://api.example.com/users", payload)
    if err != nil {
        panic(err)
    }
    req.Header.Set("Authorization", "Bearer eyJ...")
    req.Header.Set("Content-Type", "application/json")

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Println(string(body))
}
```

- Raw body uses `strings.NewReader`.
- URL-encoded and form-data bodies use `net/url.Values`.
- Required imports are added automatically based on the body mode.

---

### PHP (cURL)

```php
<?php
$curl = curl_init();

curl_setopt_array($curl, [
    CURLOPT_URL => "https://api.example.com/users",
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => "POST",
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer eyJ...",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => "{\"name\":\"Alice\"}",
]);

$response = curl_exec($curl);
curl_close($curl);

echo $response;
```

- Uses `curl_setopt_array` with `CURLOPT_POSTFIELDS`.
- Form-data body uses an associative array for `CURLOPT_POSTFIELDS`.

---

### Ruby (Net::HTTP)

```ruby
require 'uri'
require 'net/http'

uri = URI("https://api.example.com/users")
http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = uri.scheme == 'https'

request = Net::HTTP::Post.new(uri.request_uri)
request["Authorization"] = "Bearer eyJ..."
request["Content-Type"] = "application/json"
request.body = '{"name":"Alice"}'

response = http.request(request)
puts response.body
```

- The HTTP method maps to the `Net::HTTP::<Method>` class (e.g. `Post`, `Get`, `Put`).
- HTTPS is enabled automatically when the URL scheme is `https`.

---

### C# (HttpClient)

```csharp
using System.Net.Http;
using System.Text;

var client = new HttpClient();
var request = new HttpRequestMessage(HttpMethod.Post, "https://api.example.com/users");
request.Headers.TryAddWithoutValidation("Authorization", "Bearer eyJ...");
var content = new StringContent("{\"name\":\"Alice\"}", Encoding.UTF8, "application/json");
request.Content = content;

var response = await client.SendAsync(request);
var body = await response.Content.ReadAsStringAsync();
Console.WriteLine(body);
```

- Content headers (`Content-Type`, `Content-Length`, `Content-Encoding`) are attached to the `HttpContent` object, not the request headers collection.
- URL-encoded body uses `FormUrlEncodedContent`.
- Form-data body uses `MultipartFormDataContent`.

---

### HURL

```hurl
POST https://api.example.com/users
Authorization: Bearer eyJ...
Content-Type: application/json

{"name":"Alice"}

HTTP *
```

- One entry per request, generated by the same HURL utility used for HURL export.
- Headers follow the method/URL line with no separator.
- Body follows a blank line.
- `HTTP *` is a wildcard status assertion accepted by the `hurl` CLI.

---

## Auth Handling per Language

Auth settings are converted to headers and injected **before** custom headers in every language.

| Auth type | Header generated |
|---|---|
| **Bearer Token** | `Authorization: Bearer <token>` |
| **Basic Auth** | `Authorization: Basic <base64(user:pass)>` |
| **API Key** | `<custom-header-name>: <value>` |
| **No Auth / OAuth 2.0 / Digest** | No header added (OAuth tokens must be set manually) |

---

## Body Modes per Language

| Body mode | Python | JS fetch | JS axios | Go | PHP | Ruby | C# | cURL | HURL |
|---|---|---|---|---|---|---|---|---|---|
| Raw | `data=` | `body:` | data arg | `strings.NewReader` | `POSTFIELDS` | `.body=` | `StringContent` | `-d` | body block |
| URL-encoded | `data={}` | encoded string | encoded string | `url.Values` | encoded string | `set_form` | `FormUrlEncodedContent` | `-d` encoded | body block |
| Form-data | `files={}` | `FormData` | `FormData` | `url.Values` | assoc array | `set_form multipart` | `MultipartFormDataContent` | `-F` | body block |
| GraphQL | raw JSON | raw JSON | raw JSON | raw string | raw string | raw string | `StringContent` | `-d` | body block |
| No body | omitted | omitted | omitted | `nil` | omitted | omitted | omitted | omitted | omitted |

---

## Copying the Snippet

Click the **Copy** button in the top-right corner of the modal. The button changes to **Copied!** for 1.5 seconds to confirm the operation.

The entire code block is copied — you can paste it directly into a terminal, a source file, or a CI pipeline YAML.

---

## Common Workflows

### Quickly test an endpoint from the terminal

1. Build your request in Apilix (URL, headers, body, auth).
2. Open Code Generation → select **cURL**.
3. Click **Copy** → paste into your terminal → run.

### Generate a baseline SDK call

1. Design the request in Apilix and confirm it works.
2. Open Code Generation → select your target language.
3. Copy the snippet into your codebase as a starting point, then refactor variables and error handling.

### Share a reproducible example

1. Open Code Generation → **cURL**.
2. Copy the snippet and paste it into a bug report, Slack message, or documentation page.
3. Anyone with `curl` installed can reproduce the request exactly.

### Generate a HURL test file

1. Open Code Generation → **HURL**.
2. Copy the entry.
3. Paste it into a `.hurl` file alongside assertion lines:
   ```hurl
   POST https://api.example.com/users
   Content-Type: application/json

   {"name":"Alice"}

   HTTP 201
   [Asserts]
   jsonpath "$.id" exists
   ```
4. Run with `hurl my-tests.hurl`.
