// ─── Code Generation Utility ─────────────────────────────────────────────────
// Generates request snippets for multiple languages from a request definition.

export interface CodeGenParams {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; disabled?: boolean }>;
  bodyMode: string;
  bodyRaw: string;
  bodyFormData: Array<{ key: string; value: string; disabled?: boolean }>;
  bodyUrlEncoded: Array<{ key: string; value: string; disabled?: boolean }>;
  authType: string;
  authBearer: string;
  authBasicUser: string;
  authBasicPass: string;
  authApiKeyName: string;
  authApiKeyValue: string;
}

export interface Language {
  id: string;
  label: string;
  generate: (p: CodeGenParams) => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pyStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function jsStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function goStr(s: string): string {
  return '`' + s.replace(/`/g, '` + "`" + `') + '`';
}

function phpStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function rubyStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function csStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** Collect all effective request headers including auth, returning {key, value}[]. */
function effectiveHeaders(p: CodeGenParams): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];

  if (p.authType === 'bearer' && p.authBearer) {
    out.push({ key: 'Authorization', value: `Bearer ${p.authBearer}` });
  } else if (p.authType === 'basic' && (p.authBasicUser || p.authBasicPass)) {
    const encoded = btoa(`${p.authBasicUser}:${p.authBasicPass}`);
    out.push({ key: 'Authorization', value: `Basic ${encoded}` });
  } else if (p.authType === 'apikey' && p.authApiKeyName) {
    out.push({ key: p.authApiKeyName, value: p.authApiKeyValue });
  }

  for (const h of p.headers) {
    if (!h.disabled && h.key) out.push({ key: h.key, value: h.value });
  }

  return out;
}

// ─── Python requests ──────────────────────────────────────────────────────────

function genPython(p: CodeGenParams): string {
  const lines: string[] = ['import requests', ''];

  const headers = effectiveHeaders(p);

  lines.push(`url = ${pyStr(p.url)}`, '');

  if (headers.length) {
    lines.push('headers = {');
    for (const h of headers) {
      lines.push(`    ${pyStr(h.key)}: ${pyStr(h.value)},`);
    }
    lines.push('}', '');
  }

  const method = p.method.toLowerCase();
  const hasBody = p.bodyMode !== 'none';

  if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push(`payload = ${pyStr(p.bodyRaw)}`, '');
    lines.push(
      headers.length
        ? `response = requests.${method}(url, headers=headers, data=payload)`
        : `response = requests.${method}(url, data=payload)`,
    );
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    lines.push('data = {');
    for (const e of p.bodyUrlEncoded) {
      if (!e.disabled && e.key) lines.push(`    ${pyStr(e.key)}: ${pyStr(e.value)},`);
    }
    lines.push('}', '');
    lines.push(
      headers.length
        ? `response = requests.${method}(url, headers=headers, data=data)`
        : `response = requests.${method}(url, data=data)`,
    );
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('files = {');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) lines.push(`    ${pyStr(f.key)}: (None, ${pyStr(f.value)}),`);
    }
    lines.push('}', '');
    lines.push(
      headers.length
        ? `response = requests.${method}(url, headers=headers, files=files)`
        : `response = requests.${method}(url, files=files)`,
    );
  } else {
    lines.push(
      headers.length && hasBody
        ? `response = requests.${method}(url, headers=headers)`
        : headers.length
          ? `response = requests.${method}(url, headers=headers)`
          : `response = requests.${method}(url)`,
    );
  }

  lines.push('', 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}

// ─── JavaScript fetch ─────────────────────────────────────────────────────────

function genJsFetch(p: CodeGenParams): string {
  const lines: string[] = [];
  const headers = effectiveHeaders(p);

  lines.push('const response = await fetch(');
  lines.push(`  ${jsStr(p.url)},`);
  lines.push('  {');
  lines.push(`    method: ${jsStr(p.method)},`);

  if (headers.length) {
    lines.push('    headers: {');
    for (const h of headers) {
      lines.push(`      ${jsStr(h.key)}: ${jsStr(h.value)},`);
    }
    lines.push('    },');
  }

  if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push(`    body: ${jsStr(p.bodyRaw)},`);
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    const pairs = p.bodyUrlEncoded
      .filter(e => !e.disabled && e.key)
      .map(e => `${encodeURIComponent(e.key)}=${encodeURIComponent(e.value)}`)
      .join('&');
    lines.push(`    body: ${jsStr(pairs)},`);
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('    // body is constructed separately (see below)');
  }

  lines.push('  }');
  lines.push(');', '');

  if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.unshift('const form = new FormData();');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) {
        lines.splice(1, 0, `form.append(${jsStr(f.key)}, ${jsStr(f.value)});`);
      }
    }
    lines.splice(p.bodyFormData.filter(f => !f.disabled && f.key).length + 1, 0, '');
    // replace body placeholder
    const bodyIdx = lines.indexOf('    // body is constructed separately (see below)');
    if (bodyIdx !== -1) lines[bodyIdx] = '    body: form,';
  }

  lines.push('const data = await response.json();');
  lines.push('console.log(data);');
  return lines.join('\n');
}

// ─── JavaScript axios ─────────────────────────────────────────────────────────

function genJsAxios(p: CodeGenParams): string {
  const lines: string[] = ["import axios from 'axios';", ''];
  const headers = effectiveHeaders(p);
  const method = p.method.toLowerCase();

  const configParts: string[] = [];
  if (headers.length) {
    configParts.push('  headers: {');
    for (const h of headers) {
      configParts.push(`    ${jsStr(h.key)}: ${jsStr(h.value)},`);
    }
    configParts.push('  },');
  }

  const hasBody = p.bodyMode === 'raw' || p.bodyMode === 'urlencoded' || p.bodyMode === 'formdata';
  const bodylessMethods = ['get', 'head', 'delete', 'options'];
  const useDataArg = hasBody && !bodylessMethods.includes(method);

  let bodyExpr = 'null';
  if (p.bodyMode === 'raw' && p.bodyRaw) {
    bodyExpr = jsStr(p.bodyRaw);
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    const pairs = p.bodyUrlEncoded
      .filter(e => !e.disabled && e.key)
      .map(e => `${encodeURIComponent(e.key)}=${encodeURIComponent(e.value)}`)
      .join('&');
    bodyExpr = jsStr(pairs);
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('const form = new FormData();');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) lines.push(`form.append(${jsStr(f.key)}, ${jsStr(f.value)});`);
    }
    lines.push('');
    bodyExpr = 'form';
  }

  if (useDataArg) {
    lines.push(`const response = await axios.${method}(`);
    lines.push(`  ${jsStr(p.url)},`);
    lines.push(`  ${bodyExpr},`);
    if (configParts.length) {
      lines.push('  {');
      lines.push(...configParts);
      lines.push('  }');
    }
    lines.push(');');
  } else {
    if (configParts.length) {
      lines.push(`const response = await axios.${method}(`);
      lines.push(`  ${jsStr(p.url)},`);
      lines.push('  {');
      lines.push(...configParts);
      lines.push('  }');
      lines.push(');');
    } else {
      lines.push(`const response = await axios.${method}(${jsStr(p.url)});`);
    }
  }

  lines.push('', 'console.log(response.data);');
  return lines.join('\n');
}

// ─── Go net/http ──────────────────────────────────────────────────────────────

function genGo(p: CodeGenParams): string {
  const headers = effectiveHeaders(p);
  const hasBody = p.bodyMode === 'raw' || p.bodyMode === 'urlencoded' || p.bodyMode === 'formdata';
  const needStrings = p.bodyMode === 'raw' && p.bodyRaw;
  const needUrlPkg = p.bodyMode === 'urlencoded' || p.bodyMode === 'formdata';

  const imports = ['fmt', 'io', 'net/http'];
  if (needStrings) imports.splice(2, 0, 'strings');
  if (needUrlPkg) imports.splice(2, 0, 'net/url');

  const lines: string[] = [
    'package main',
    '',
    'import (',
    ...imports.map(i => `\t${JSON.stringify(i)}`),
    ')',
    '',
    'func main() {',
  ];

  if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push(`\tpayload := strings.NewReader(${goStr(p.bodyRaw)})`);
    lines.push(`\treq, err := http.NewRequest(${JSON.stringify(p.method)}, ${JSON.stringify(p.url)}, payload)`);
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    lines.push('\tform := url.Values{}');
    for (const e of p.bodyUrlEncoded) {
      if (!e.disabled && e.key) lines.push(`\tform.Set(${JSON.stringify(e.key)}, ${JSON.stringify(e.value)})`);
    }
    lines.push(`\treq, err := http.NewRequest(${JSON.stringify(p.method)}, ${JSON.stringify(p.url)}, strings.NewReader(form.Encode()))`);
    imports.splice(imports.indexOf('net/http'), 0);
    if (!imports.includes('strings')) imports.push('strings');
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('\tform := url.Values{}');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) lines.push(`\tform.Set(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)})`);
    }
    lines.push(`\treq, err := http.NewRequest(${JSON.stringify(p.method)}, ${JSON.stringify(p.url)}, strings.NewReader(form.Encode()))`);
    if (!imports.includes('strings')) imports.push('strings');
  } else {
    lines.push(`\treq, err := http.NewRequest(${JSON.stringify(p.method)}, ${JSON.stringify(p.url)}, nil)`);
  }

  lines.push(
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
  );

  for (const h of headers) {
    lines.push(`\treq.Header.Set(${JSON.stringify(h.key)}, ${JSON.stringify(h.value)})`);
  }
  if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    lines.push('\treq.Header.Set("Content-Type", "application/x-www-form-urlencoded")');
  }

  lines.push(
    '',
    '\tclient := &http.Client{}',
    '\tresp, err := client.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer resp.Body.Close()',
    '',
    '\tbody, _ := io.ReadAll(resp.Body)',
    '\tfmt.Println(string(body))',
    '}',
  );

  return lines.join('\n');
}

// ─── PHP cURL ─────────────────────────────────────────────────────────────────

function genPhp(p: CodeGenParams): string {
  const headers = effectiveHeaders(p);
  const lines: string[] = ['<?php', '$curl = curl_init();', '', 'curl_setopt_array($curl, ['];

  lines.push(`    CURLOPT_URL => ${phpStr(p.url)},`);
  lines.push('    CURLOPT_RETURNTRANSFER => true,');
  lines.push(`    CURLOPT_CUSTOMREQUEST => ${phpStr(p.method)},`);

  if (headers.length) {
    lines.push('    CURLOPT_HTTPHEADER => [');
    for (const h of headers) {
      lines.push(`        ${phpStr(`${h.key}: ${h.value}`)},`);
    }
    lines.push('    ],');
  }

  if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push(`    CURLOPT_POSTFIELDS => ${phpStr(p.bodyRaw)},`);
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    const pairs = p.bodyUrlEncoded
      .filter(e => !e.disabled && e.key)
      .map(e => `${encodeURIComponent(e.key)}=${encodeURIComponent(e.value)}`)
      .join('&');
    lines.push(`    CURLOPT_POSTFIELDS => ${phpStr(pairs)},`);
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('    CURLOPT_POSTFIELDS => [');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) lines.push(`        ${phpStr(f.key)} => ${phpStr(f.value)},`);
    }
    lines.push('    ],');
  }

  lines.push(
    ']);',
    '',
    '$response = curl_exec($curl);',
    'curl_close($curl);',
    '',
    'echo $response;',
  );

  return lines.join('\n');
}

// ─── Ruby Net::HTTP ───────────────────────────────────────────────────────────

function genRuby(p: CodeGenParams): string {
  const headers = effectiveHeaders(p);
  const lines: string[] = ["require 'uri'", "require 'net/http'", ''];

  lines.push(`uri = URI(${rubyStr(p.url)})`);
  lines.push('http = Net::HTTP.new(uri.host, uri.port)');
  lines.push("http.use_ssl = uri.scheme == 'https'", '');

  const methodClass = p.method.charAt(0).toUpperCase() + p.method.slice(1).toLowerCase();
  lines.push(`request = Net::HTTP::${methodClass}.new(uri.request_uri)`);

  for (const h of headers) {
    lines.push(`request[${rubyStr(h.key)}] = ${rubyStr(h.value)}`);
  }

  if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push(`request.body = ${rubyStr(p.bodyRaw)}`);
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    const pairs: string[] = [];
    for (const e of p.bodyUrlEncoded) {
      if (!e.disabled && e.key) pairs.push(`${encodeURIComponent(e.key)}=${encodeURIComponent(e.value)}`);
    }
    lines.push('request.content_type = \'application/x-www-form-urlencoded\'');
    lines.push(`request.body = ${rubyStr(pairs.join('&'))}`);
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('request.set_form(');
    lines.push('  [');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) lines.push(`    [${rubyStr(f.key)}, ${rubyStr(f.value)}],`);
    }
    lines.push("  ], 'multipart/form-data'");
    lines.push(')');
  }

  lines.push('', 'response = http.request(request)', 'puts response.body');
  return lines.join('\n');
}

// ─── C# HttpClient ────────────────────────────────────────────────────────────

function genCSharp(p: CodeGenParams): string {
  const headers = effectiveHeaders(p);
  const lines: string[] = [
    'using System.Net.Http;',
    'using System.Text;',
    '',
    'var client = new HttpClient();',
    `var request = new HttpRequestMessage(HttpMethod.${p.method.charAt(0).toUpperCase() + p.method.slice(1).toLowerCase()}, ${csStr(p.url)});`,
  ];

  // Separate content headers from request headers
  const contentHeaderKeys = new Set(['content-type', 'content-length', 'content-encoding']);
  const reqHeaders = headers.filter(h => !contentHeaderKeys.has(h.key.toLowerCase()));
  const contentTypeHeader = headers.find(h => h.key.toLowerCase() === 'content-type');

  for (const h of reqHeaders) {
    lines.push(`request.Headers.TryAddWithoutValidation(${csStr(h.key)}, ${csStr(h.value)});`);
  }

  if (p.bodyMode === 'raw' && p.bodyRaw) {
    const mimeType = contentTypeHeader?.value ?? 'application/json';
    lines.push(`var content = new StringContent(${csStr(p.bodyRaw)}, Encoding.UTF8, ${csStr(mimeType)});`);
    lines.push('request.Content = content;');
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length) {
    lines.push('var content = new FormUrlEncodedContent(new Dictionary<string, string>');
    lines.push('{');
    for (const e of p.bodyUrlEncoded) {
      if (!e.disabled && e.key) lines.push(`    { ${csStr(e.key)}, ${csStr(e.value)} },`);
    }
    lines.push('});');
    lines.push('request.Content = content;');
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length) {
    lines.push('var content = new MultipartFormDataContent();');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) {
        lines.push(`content.Add(new StringContent(${csStr(f.value)}), ${csStr(f.key)});`);
      }
    }
    lines.push('request.Content = content;');
  }

  lines.push(
    '',
    'var response = await client.SendAsync(request);',
    'var body = await response.Content.ReadAsStringAsync();',
    'Console.WriteLine(body);',
  );

  return lines.join('\n');
}

// ─── Language registry ────────────────────────────────────────────────────────

export const CODE_GEN_LANGUAGES: Language[] = [
  { id: 'python', label: 'Python (requests)', generate: genPython },
  { id: 'js-fetch', label: 'JavaScript (fetch)', generate: genJsFetch },
  { id: 'js-axios', label: 'JavaScript (axios)', generate: genJsAxios },
  { id: 'go', label: 'Go (net/http)', generate: genGo },
  { id: 'php', label: 'PHP (cURL)', generate: genPhp },
  { id: 'ruby', label: 'Ruby (Net::HTTP)', generate: genRuby },
  { id: 'csharp', label: 'C# (HttpClient)', generate: genCSharp },
];
