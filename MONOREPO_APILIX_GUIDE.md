# Apilix Monorepo — Step-by-Step Migration Guide

This guide provides exact commands and file contents for converting the Apilix repository to an npm workspaces monorepo. Execute steps in order on the `refactor/monorepo` branch.

---

## Step 0 — Prerequisites

```bash
# Confirm Node.js ≥ 20.19 and npm ≥ 9
node --version   # expected: v20.x or higher
npm --version    # expected: 9.x or higher

# Create working branch
git checkout -b refactor/monorepo
```

---

## Step 1 — Root `package.json`

Replace the `workspaces` field in the root `package.json` (add it if missing):

```json
{
  "name": "apilix-monorepo",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "start": "npm run start --workspace=packages/server & npm run dev --workspace=packages/client",
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspace=packages/core && npm run test --workspace=packages/server && npm run test --workspace=packages/client",
    "electron:dev": "electron electron/main.js",
    "cli": "node packages/cli/bin/cli.js",
    "cli:build:binaries": "npm run build:binaries --workspace=packages/cli",
    "setup": "npm install"
  }
}
```

---

## Step 2 — Root `tsconfig.json`

Create `/tsconfig.json` at repo root:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "paths": {
      "@apilix/core": ["./packages/core/src/index.ts"],
      "@apilix/core/*": ["./packages/core/src/*"]
    }
  }
}
```

---

## Step 3 — Scaffold `packages/core/`

```bash
mkdir -p packages/core/src packages/core/types
```

**`packages/core/package.json`:**

```json
{
  "name": "@apilix/core",
  "version": "1.0.0",
  "description": "Apilix request engine, script runtime, OAuth, and shared types",
  "main": "src/index.js",
  "types": "types/index.ts",
  "exports": {
    ".": "./src/index.js",
    "./types": "./types/index.ts"
  },
  "dependencies": {
    "axios": "*",
    "form-data": "*"
  }
}
```

**`packages/core/src/index.js`** (barrel):

```js
module.exports = {
  ...require('./request-engine'),
  ...require('./script-runtime'),
  ...require('./oauth'),
  ...require('./tls-utils'),
  ...require('./variable-resolver'),
};
```

---

## Step 4 — Move Core Files

```bash
# Move request engine
git mv src/core/request-engine.js packages/core/src/request-engine.js

# Move script runtime
git mv src/core/script-runtime.js packages/core/src/script-runtime.js

# Move OAuth
git mv server/oauth.js packages/core/src/oauth.js

# Move TLS utils
git mv server/tlsUtils.js packages/core/src/tls-utils.js

# Copy types (keep original for now — remove in Step 8)
cp client/src/types.ts packages/core/types/index.ts
```

---

## Step 5 — Consolidate `resolveVariables`

Create `packages/core/src/variable-resolver.js`:

```js
/**
 * Resolve {{variable}} placeholders in a string using the provided variable map.
 * @param {string} str
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function resolveVariables(str, vars) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmed = key.trim();
    return Object.prototype.hasOwnProperty.call(vars, trimmed)
      ? vars[trimmed]
      : match;
  });
}

module.exports = { resolveVariables };
```

Then update the imports in the two files that previously defined their own copy:

**`packages/core/src/request-engine.js`** — replace the inline `resolveVariables` function with:
```js
const { resolveVariables } = require('./variable-resolver');
```

**`packages/core/src/oauth.js`** — same replacement:
```js
const { resolveVariables } = require('./variable-resolver');
```

---

## Step 6 — Scaffold `packages/server/`

```bash
mkdir -p packages/server/src
```

**`packages/server/package.json`:**

```json
{
  "name": "@apilix/server",
  "version": "1.0.0",
  "description": "Apilix Express API server",
  "main": "src/index.js",
  "dependencies": {
    "@apilix/core": "*",
    "express": "*",
    "cors": "*",
    "simple-git": "*",
    "@aws-sdk/client-s3": "*"
  },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test tests/"
  }
}
```

```bash
# Move all server source files
git mv server/*.js packages/server/src/
```

Update imports in `packages/server/src/index.js`:

```bash
# Replace old relative core imports with package imports
sed -i "s|require('../src/core/request-engine')|require('@apilix/core')|g" packages/server/src/index.js
sed -i "s|require('./oauth')|require('@apilix/core')|g" packages/server/src/index.js
sed -i "s|require('./tlsUtils')|require('@apilix/core')|g" packages/server/src/index.js
```

---

## Step 7 — Scaffold `packages/client/`

```bash
mkdir -p packages/client
```

**`packages/client/package.json`:**

```json
{
  "name": "@apilix/client",
  "version": "1.0.0",
  "description": "Apilix React UI",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@apilix/core": "*",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "vite": "*",
    "vitest": "^2.0.0",
    "@vitejs/plugin-react": "*",
    "typescript": "^5.0.0"
  }
}
```

```bash
# Move client source
git mv client/* packages/client/
```

Update `packages/client/vite.config.ts` to add the alias:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@apilix/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
});
```

Update `packages/client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@apilix/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

---

## Step 8 — Remove Duplicate `types.ts`

Once `packages/core/types/index.ts` exists and all client imports have been updated:

```bash
git rm client/src/types.ts
```

Update all `import ... from '@/types'` or `from '../types'` in the client source:

```bash
find packages/client/src -name '*.ts' -o -name '*.tsx' | \
  xargs sed -i "s|from '.*\/types'|from '@apilix/core/types'|g"
```

---

## Step 9 — Scaffold `packages/cli/`

```bash
mkdir -p packages/cli/bin packages/cli/src
```

**`packages/cli/package.json`:**

```json
{
  "name": "@apilix/cli",
  "version": "1.0.0",
  "description": "Apilix CLI collection runner",
  "bin": {
    "apilix": "./bin/cli.js"
  },
  "scripts": {
    "build:binaries": "pkg . --targets node20-macos-x64,node20-linux-x64,node20-win-x64 --out-path ../../dist/cli"
  },
  "dependencies": {
    "@apilix/core": "*",
    "commander": "*"
  },
  "pkg": {
    "assets": ["../../node_modules/axios/dist/node/axios.cjs"]
  }
}
```

```bash
# Move CLI entry
git mv bin/apilix.js packages/cli/bin/cli.js
```

---

## Step 10 — Install and Verify

```bash
# Install all workspaces from repo root
npm install

# Verify workspace links
npm ls --workspaces --depth=0

# Run tests
node --test packages/core/tests/
node --test packages/server/tests/
npm run test --workspace=packages/client

# Verify Electron starts
npm run electron:dev

# Verify CLI runs
node packages/cli/bin/cli.js run ./test-fixtures/sample-collection.json

# Verify no stray resolveVariables copies
grep -r "function resolveVariables" packages/ --include="*.js"
# Expected: only packages/core/src/variable-resolver.js
```

---

## Verification Checklist

- [ ] `npm install` exits 0 from repo root
- [ ] `node --test packages/core/tests/` — all pass
- [ ] `node --test packages/server/tests/` — all pass
- [ ] `npm run test --workspace=packages/client` — all pass
- [ ] `npm run electron:dev` — app loads in Electron
- [ ] `node packages/cli/bin/cli.js run ...` — collection executes
- [ ] `grep -r "function resolveVariables" packages/` — single result only
- [ ] `client/src/types.ts` no longer exists

---

## Troubleshooting

### `Cannot find module '@apilix/core'`
Run `npm install` from the repo root. If using pnpm, run `pnpm install`. The workspace symlink must exist in `node_modules/@apilix/core`.

### Vitest cannot resolve `@apilix/core/types`
Add the alias to `packages/client/vitest.config.ts` (see Step 7).

### pkg binary fails with `Cannot find module 'axios'`
Add `"assets": ["path/to/axios.cjs"]` in the `pkg` config inside `packages/cli/package.json`.

### Electron white screen after restructure
Confirm the Vite dev server port and the server spawn path in `electron/main.js` are unchanged. The server is forked as a child process — ensure the entry point path resolves to `packages/server/src/index.js`.
