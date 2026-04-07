import { useState } from 'react';

export interface Snippet {
  id: string;
  name: string;
  description: string;
  code: string;
}

interface SnippetCategory {
  label: string;
  snippets: Snippet[];
}

const PRE_REQUEST_CATEGORIES: SnippetCategory[] = [
  {
    label: 'Variables & Environment',
    snippets: [
      {
        id: 'timestamp',
        name: 'Inject Timestamp',
        description: 'Set current Unix timestamp as environment variable',
        code: `// Inject current Unix timestamp (ms)
apx.environment.set('timestamp', Date.now().toString());`,
      },
      {
        id: 'uuid',
        name: 'Generate UUID',
        description: 'Generate a random UUID v4 and store it',
        code: `// Generate a random UUID v4
const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
apx.environment.set('uuid', uuid);`,
      },
      {
        id: 'random-int',
        name: 'Random Integer',
        description: 'Generate a random integer in a range',
        code: `// Random integer between min (inclusive) and max (exclusive)
const min = 1;
const max = 1000;
const rand = Math.floor(Math.random() * (max - min)) + min;
apx.environment.set('randomInt', rand.toString());`,
      },
      {
        id: 'iso-date',
        name: 'ISO Date String',
        description: 'Set current UTC date-time as ISO 8601 string',
        code: `// Set current UTC date-time in ISO 8601 format
apx.environment.set('isoDate', new Date().toISOString());`,
      },
    ],
  },
  {
    label: 'Hashing & Encoding',
    snippets: [
      {
        id: 'base64-encode',
        name: 'Base64 Encode',
        description: 'Base64-encode a value and store it',
        code: `// Base64-encode a value
const value = apx.environment.get('myValue') ?? 'hello';
const encoded = btoa(unescape(encodeURIComponent(value)));
apx.environment.set('base64Value', encoded);`,
      },
      {
        id: 'base64-decode',
        name: 'Base64 Decode',
        description: 'Decode a Base64 environment variable',
        code: `// Base64-decode an environment variable
const encoded = apx.environment.get('base64Value') ?? '';
try {
  const decoded = decodeURIComponent(escape(atob(encoded)));
  apx.environment.set('decodedValue', decoded);
} catch (e) {
  console.error('Base64 decode failed:', e.message);
}`,
      },
      {
        id: 'hmac-sha256',
        name: 'HMAC-SHA256 Signature',
        description: 'Sign a message with HMAC-SHA256 using the Web Crypto API',
        code: `// HMAC-SHA256 signature using the Web Crypto API
const secret = apx.environment.get('hmacSecret') ?? 'my-secret';
const message = apx.environment.get('timestamp') ?? Date.now().toString();

const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
apx.environment.set('hmacSignature', hex);`,
      },
      {
        id: 'md5-hash',
        name: 'MD5 Hash (simple)',
        description: 'Compute a simple MD5 hash (pure JS, no external lib)',
        code: `// Simple MD5 implementation (pure JS)
function md5(str) {
  function safeAdd(x, y) { const lsw=(x&0xFFFF)+(y&0xFFFF); return (((x>>16)+(y>>16)+(lsw>>16))<<16)|(lsw&0xFFFF); }
  function bitRotateLeft(num, cnt) { return (num<<cnt)|(num>>>(32-cnt)); }
  function md5cmn(q,a,b,x,s,t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b); }
  function md5ff(a,b,c,d,x,s,t) { return md5cmn((b&c)|((~b)&d),a,b,x,s,t); }
  function md5gg(a,b,c,d,x,s,t) { return md5cmn((b&d)|(c&(~d)),a,b,x,s,t); }
  function md5hh(a,b,c,d,x,s,t) { return md5cmn(b^c^d,a,b,x,s,t); }
  function md5ii(a,b,c,d,x,s,t) { return md5cmn(c^(b|(~d)),a,b,x,s,t); }
  const utf8 = unescape(encodeURIComponent(str));
  const bytes = Array.from(utf8).map(c => c.charCodeAt(0));
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLen = (utf8.length * 8);
  bytes.push(bitLen & 0xff, (bitLen>>8)&0xff, (bitLen>>16)&0xff, (bitLen>>24)&0xff, 0,0,0,0);
  let [a,b,c,d] = [0x67452301,-0x10325477,-0x67452302,0x10325476];
  for (let i=0;i<bytes.length;i+=64) {
    const w=[];for(let j=0;j<16;j++)w[j]=bytes[i+j*4]|(bytes[i+j*4+1]<<8)|(bytes[i+j*4+2]<<16)|(bytes[i+j*4+3]<<24);
    let [aa,bb,cc,dd]=[a,b,c,d];
    [a,b,c,d]=[md5ff(a,b,c,d,w[0],7,-680876936),md5ff(d,a,b,c,w[1],12,-389564586),md5ff(c,d,a,b,w[2],17,606105819),md5ff(b,c,d,a,w[3],22,-1044525330),md5ff(a,b,c,d,w[4],7,-176418897),md5ff(d,a,b,c,w[5],12,1200080426),md5ff(c,d,a,b,w[6],17,-1473231341),md5ff(b,c,d,a,w[7],22,-45705983),md5ff(a,b,c,d,w[8],7,1770031416),md5ff(d,a,b,c,w[9],12,-1958414417),md5ff(c,d,a,b,w[10],17,-42063),md5ff(b,c,d,a,w[11],22,-1990404162),md5ff(a,b,c,d,w[12],7,1804603682),md5ff(d,a,b,c,w[13],12,-40341101),md5ff(c,d,a,b,w[14],17,-1502002290),md5ff(b,c,d,a,w[15],22,1236535329)];
    [a,b,c,d]=[md5gg(a,b,c,d,w[1],5,-165796510),md5gg(d,a,b,c,w[6],9,-1069501632),md5gg(c,d,a,b,w[11],14,643717713),md5gg(b,c,d,a,w[0],20,-373897302),md5gg(a,b,c,d,w[5],5,-701558691),md5gg(d,a,b,c,w[10],9,38016083),md5gg(c,d,a,b,w[15],14,-660478335),md5gg(b,c,d,a,w[4],20,-405537848),md5gg(a,b,c,d,w[9],5,568446438),md5gg(d,a,b,c,w[14],9,-1019803690),md5gg(c,d,a,b,w[3],14,-187363961),md5gg(b,c,d,a,w[8],20,1163531501),md5gg(a,b,c,d,w[13],5,-1444681467),md5gg(d,a,b,c,w[2],9,-51403784),md5gg(c,d,a,b,w[7],14,1735328473),md5gg(b,c,d,a,w[12],20,-1926607734)];
    [a,b,c,d]=[md5hh(a,b,c,d,w[5],4,-378558),md5hh(d,a,b,c,w[8],11,-2022574463),md5hh(c,d,a,b,w[11],16,1839030562),md5hh(b,c,d,a,w[14],23,-35309556),md5hh(a,b,c,d,w[1],4,-1530992060),md5hh(d,a,b,c,w[4],11,1272893353),md5hh(c,d,a,b,w[7],16,-155497632),md5hh(b,c,d,a,w[10],23,-1094730640),md5hh(a,b,c,d,w[13],4,681279174),md5hh(d,a,b,c,w[0],11,-358537222),md5hh(c,d,a,b,w[3],16,-722521979),md5hh(b,c,d,a,w[6],23,76029189),md5hh(a,b,c,d,w[9],4,-640364487),md5hh(d,a,b,c,w[12],11,-421815835),md5hh(c,d,a,b,w[15],16,530742520),md5hh(b,c,d,a,w[2],23,-995338651)];
    [a,b,c,d]=[md5ii(a,b,c,d,w[0],6,-198630844),md5ii(d,a,b,c,w[7],10,1126891415),md5ii(c,d,a,b,w[14],15,-1416354905),md5ii(b,c,d,a,w[5],21,-57434055),md5ii(a,b,c,d,w[12],6,1700485571),md5ii(d,a,b,c,w[3],10,-1894986606),md5ii(c,d,a,b,w[10],15,-1051523),md5ii(b,c,d,a,w[1],21,-2054922799),md5ii(a,b,c,d,w[8],6,1873313359),md5ii(d,a,b,c,w[15],10,-30611744),md5ii(c,d,a,b,w[6],15,-1560198380),md5ii(b,c,d,a,w[13],21,1309151649),md5ii(a,b,c,d,w[4],6,-145523070),md5ii(d,a,b,c,w[11],10,-1120210379),md5ii(c,d,a,b,w[2],15,718787259),md5ii(b,c,d,a,w[9],21,-343485551)];
    [a,b,c,d]=[safeAdd(a,aa),safeAdd(b,bb),safeAdd(c,cc),safeAdd(d,dd)];
  }
  return [a,b,c,d].map(n=>[n&0xff,(n>>8)&0xff,(n>>16)&0xff,(n>>24)&0xff]).flat().map(b=>b.toString(16).padStart(2,'0')).join('');
}

const hash = md5(apx.environment.get('myValue') ?? 'hello');
apx.environment.set('md5Hash', hash);`,
      },
    ],
  },
  {
    label: 'Authentication',
    snippets: [
      {
        id: 'jwt-hs256',
        name: 'Generate JWT (HS256)',
        description: 'Create a signed JWT using HMAC-SHA256',
        code: `// Generate a signed JWT (HS256) using Web Crypto API
const secret = apx.environment.get('jwtSecret') ?? 'my-secret';
const payload = {
  sub: apx.environment.get('userId') ?? '1234567890',
  name: 'John Doe',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
};

function base64url(data) {
  return btoa(JSON.stringify(data))
    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
}

const header = base64url({ alg: 'HS256', typ: 'JWT' });
const body = base64url(payload);
const signingInput = \`\${header}.\${body}\`;

const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');

apx.environment.set('jwt', \`\${signingInput}.\${sigB64}\`);`,
      },
      {
        id: 'bearer-from-env',
        name: 'Set Bearer from Env',
        description: 'Read a token from env and set the Authorization header',
        code: `// Set Authorization header from environment token
const token = apx.environment.get('accessToken');
if (!token) {
  throw new Error('accessToken environment variable is not set');
}
apx.request.headers.upsert({ key: 'Authorization', value: \`Bearer \${token}\` });`,
      },
      {
        id: 'basic-auth-header',
        name: 'Basic Auth Header',
        description: 'Build and set a Basic Authorization header',
        code: `// Build Basic Authorization header from credentials
const username = apx.environment.get('username') ?? '';
const password = apx.environment.get('password') ?? '';
const credentials = btoa(\`\${username}:\${password}\`);
apx.request.headers.upsert({ key: 'Authorization', value: \`Basic \${credentials}\` });`,
      },
      {
        id: 'api-key-header',
        name: 'API Key Header',
        description: 'Set a custom API key header from environment',
        code: `// Set custom API key header from environment
const apiKey = apx.environment.get('apiKey');
if (!apiKey) {
  throw new Error('apiKey environment variable is not set');
}
apx.request.headers.upsert({ key: 'X-API-Key', value: apiKey });`,
      },
    ],
  },
  {
    label: 'Apilix Functions',
    snippets: [
      {
        id: 'pm-get-env',
        name: 'Get environment variable',
        description: 'Read an environment variable with a fallback',
        code: `const value = apx.environment.get('myVar') ?? 'default';`,
      },
      {
        id: 'pm-set-env',
        name: 'Set environment variable',
        description: 'Write a value to the current environment',
        code: `apx.environment.set('myVar', 'myValue');`,
      },
      {
        id: 'pm-unset-env',
        name: 'Unset environment variable',
        description: 'Remove a variable from the current environment',
        code: `apx.environment.unset('myVar');`,
      },
      {
        id: 'pm-get-global',
        name: 'Get / set global variable',
        description: 'Read and write apx.globals',
        code: `// Read global
const g = apx.globals.get('myGlobal') ?? '';

// Write global
apx.globals.set('myGlobal', 'value');`,
      },
      {
        id: 'pm-get-collection-var',
        name: 'Get / set collection variable',
        description: 'Read and write apx.collection',
        code: `// Read collection variable
const v = apx.collection.get('myVar') ?? '';

// Write collection variable
apx.collection.set('myVar', 'value');`,
      },
      {
        id: 'pm-send-request',
        name: 'apx.sendRequest()',
        description: 'Make an additional HTTP call from a script',
        code: `// Make an extra HTTP request
apx.sendRequest(
  {
    url: 'https://api.example.com/token',
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    body: {
      mode: 'raw',
      raw: JSON.stringify({ grant_type: 'client_credentials' }),
    },
  },
  (err, response) => {
    if (err) {
      console.error('Token request failed:', err);
      return;
    }

    apx.environment.set('accessToken', response.json().access_token);
  }
);`,
      },
      {
        id: 'pm-add-header',
        name: 'Add / upsert request header',
        description: 'Dynamically add or overwrite a header before sending',
        code: `apx.request.headers.upsert({ key: 'X-Correlation-Id', value: apx.environment.get('uuid') ?? '' });`,
      },
      {
        id: 'pm-log',
        name: 'Console log',
        description: 'Log a value to the Apilix console for debugging',
        code: `console.log('Debug value:', apx.environment.get('myVar'));`,
      },
    ],
  },
];

const TEST_CATEGORIES: SnippetCategory[] = [
  {
    label: 'Status Code',
    snippets: [
      {
        id: 'status-200',
        name: 'Status is 200',
        description: 'Assert the response status is 200 OK',
        code: `pm.test("Status is 200 OK", () => {
  pm.response.to.have.status(200);
});`,
      },
      {
        id: 'status-2xx',
        name: 'Status is 2xx',
        description: 'Assert the response is a success (2xx)',
        code: `pm.test("Status is 2xx", () => {
  pm.expect(pm.response.code).to.be.within(200, 299);
});`,
      },
      {
        id: 'status-created',
        name: 'Status is 201 Created',
        description: 'Assert the response status is 201',
        code: `pm.test("Status is 201 Created", () => {
  pm.response.to.have.status(201);
});`,
      },
    ],
  },
  {
    label: 'Response Time',
    snippets: [
      {
        id: 'response-time-500',
        name: 'Response time < 500ms',
        description: 'Assert the response was received within 500ms',
        code: `pm.test("Response time is less than 500ms", () => {
  pm.expect(pm.response.responseTime).to.be.below(500);
});`,
      },
      {
        id: 'response-time-1s',
        name: 'Response time < 1s',
        description: 'Assert the response was received within 1 second',
        code: `pm.test("Response time is less than 1s", () => {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});`,
      },
    ],
  },
  {
    label: 'JSON Body',
    snippets: [
      {
        id: 'json-body',
        name: 'Response is JSON',
        description: 'Assert the response body is valid JSON',
        code: `pm.test("Response body is JSON", () => {
  pm.response.to.be.json;
  pm.response.json(); // throws if not valid JSON
});`,
      },
      {
        id: 'json-property-exists',
        name: 'Property exists',
        description: 'Assert a top-level property exists in the JSON response',
        code: `pm.test("Response has 'id' property", () => {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
});`,
      },
      {
        id: 'json-property-value',
        name: 'Property equals value',
        description: 'Assert a property has an expected value',
        code: `pm.test("Response 'status' is 'active'", () => {
  const json = pm.response.json();
  pm.expect(json.status).to.equal('active');
});`,
      },
      {
        id: 'json-array-not-empty',
        name: 'Array is not empty',
        description: 'Assert the response body is a non-empty array',
        code: `pm.test("Response is a non-empty array", () => {
  const json = pm.response.json();
  pm.expect(json).to.be.an('array').that.is.not.empty;
});`,
      },
      {
        id: 'store-json-value',
        name: 'Store value from response',
        description: 'Extract a value from the JSON body and save it as an env variable',
        code: `// Parse the response and store a value for the next request
const json = pm.response.json();
pm.environment.set('capturedId', json.id?.toString() ?? '');`,
      },
    ],
  },
  {
    label: 'Apilix apx.* functions',
    snippets: [
      {
        id: 'test-pm-get-env',
        name: 'Get environment variable',
        description: 'Read an environment variable inside a test',
        code: `const value = apx.environment.get('myVar') ?? 'default';`,
      },
      {
        id: 'test-pm-set-env',
        name: 'Set env variable from response',
        description: 'Extract a JSON value and store it for the next request',
        code: `const json = apx.response.json();
apx.environment.set('capturedToken', json.token ?? '');`,
      },
      {
        id: 'test-pm-unset-env',
        name: 'Unset environment variable',
        description: 'Clean up a variable after the test run',
        code: `apx.environment.unset('temporaryVar');`,
      },
      {
        id: 'test-pm-response-json',
        name: 'Parse response JSON',
        description: 'Parse the response body and access properties',
        code: `const json = apx.response.json();
console.log('id:', json.id);
console.log('status:', json.status);`,
      },
      {
        id: 'test-pm-response-text',
        name: 'Get response text',
        description: 'Access the raw response body as a string',
        code: `const text = apx.response.text();
console.log('body:', text);`,
      },
      {
        id: 'test-pm-skip-request',
        name: 'Skip this request (runner)',
        description: 'Conditionally skip the request in a collection run',
        code: `// Skip this request in the runner if condition is not met
if (!apx.environment.get('runThis')) {
  apx.execution.skipRequest();
}`,
      },
      {
        id: 'test-pm-next-request',
        name: 'Set next request (runner)',
        description: 'Jump to a named request in the collection runner',
        code: `// Jump to a specific request by name in the runner
apx.execution.setNextRequest('Login');`,
      },
    ],
  },
  {
    label: 'Headers',
    snippets: [
      {
        id: 'header-content-type',
        name: 'Content-Type is JSON',
        description: 'Assert the Content-Type header contains application/json',
        code: `pm.test("Content-Type is application/json", () => {
  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');
});`,
      },
      {
        id: 'header-exists',
        name: 'Header exists',
        description: 'Assert a specific response header is present',
        code: `pm.test("X-Request-Id header is present", () => {
  pm.expect(pm.response.headers.has('X-Request-Id')).to.be.true;
});`,
      },
      {
        id: 'store-header',
        name: 'Store header value',
        description: 'Save a response header value as an environment variable',
        code: `// Store a response header for use in subsequent requests
const value = pm.response.headers.get('X-Request-Id');
if (value) {
  pm.environment.set('capturedRequestId', value);
}`,
      },
    ],
  },
];

interface ScriptSnippetsLibraryProps {
  target: 'prerequest' | 'test';
  onInsert: (code: string) => void;
}

export default function ScriptSnippetsLibrary({ target, onInsert }: ScriptSnippetsLibraryProps) {
  const [open, setOpen] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [previewSnippet, setPreviewSnippet] = useState<string | null>(null);

  const categories = [...(target === 'prerequest' ? PRE_REQUEST_CATEGORIES : TEST_CATEGORIES)]
    .sort((a, b) => a.label.localeCompare(b.label));

  function toggleCategory(label: string) {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function handleInsert(snippet: Snippet) {
    onInsert(snippet.code);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Open snippet library"
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
          open
            ? 'bg-orange-600 text-white'
            : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-slate-100'
        }`}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.396 0 2.703.387 3.8 1.052A7.97 7.97 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
        </svg>
        Snippets
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-80 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl flex flex-col"
          style={{ maxHeight: '480px' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
            <span className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
              {target === 'prerequest' ? 'Pre-request Snippets' : 'Test Snippets'}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-slate-500 hover:text-slate-200 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>

          {/* Category list */}
          <div className="overflow-y-auto flex-1 divide-y divide-slate-700">
            {categories.map(cat => (
              <div key={cat.label}>
                <button
                  type="button"
                  onClick={() => toggleCategory(cat.label)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  <span>{cat.label}</span>
                  <svg
                    className={`w-3.5 h-3.5 text-slate-500 transition-transform ${expandedCategories.has(cat.label) ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>

                {expandedCategories.has(cat.label) && (
                  <div className="bg-slate-850">
                    {cat.snippets.map(snippet => (
                      <div key={snippet.id}>
                        <div
                          className="flex items-start justify-between gap-2 px-3 py-2 hover:bg-slate-700 transition-colors group"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-slate-200 font-medium truncate">{snippet.name}</p>
                            <p className="text-xs text-slate-500 truncate">{snippet.description}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {/* Preview toggle */}
                            <button
                              type="button"
                              onClick={() => setPreviewSnippet(prev => prev === snippet.id ? null : snippet.id)}
                              className={`p-1 transition-colors opacity-0 group-hover:opacity-100 ${previewSnippet === snippet.id ? 'text-orange-400' : 'text-slate-500 hover:text-slate-300'}`}
                              title="Preview code"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                                <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                                <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleInsert(snippet)}
                              className="px-2 py-0.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
                            >
                              Insert
                            </button>
                          </div>
                        </div>

                        {/* Inline code preview */}
                        {previewSnippet === snippet.id && (
                          <div className="mx-3 mb-2 rounded bg-slate-900 border border-slate-600 p-2">
                            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed" style={{ maxHeight: '180px', overflow: 'auto' }}>
                              {snippet.code}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="px-3 py-2 border-t border-slate-700 text-xs text-slate-500">
            Click <span className="text-orange-400 font-medium">Insert</span> to append at cursor
          </div>
        </div>
      )}
    </div>
  );
}
