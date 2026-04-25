# Contributing to Apilix

Thank you for your interest in contributing! This document covers the repository layout, how to get a development environment running, and the conventions used across the codebase.

---

## Repository structure

Apilix is an **npm workspaces monorepo**.

```
apilix/
├── packages/
│   ├── core/          @apilix/core  — execution engine, sandbox, OAuth, TLS utils
│   └── cli/           @apilix/cli   — headless CLI runner (shipped as a binary)
├── client/            React + Vite frontend  (workspace: apilix-client)
├── server/            Express API server     (workspace: apilix-server)
├── electron/          Electron desktop wrapper
├── bin/               Entry-point shim for the CLI (apilix.js)
└── package.json       Root workspace manifest, pkg bundler config
```

`packages/core` is the shared library consumed by both `server/` and the CLI. All HTTP execution logic, scripting, OAuth, and TLS configuration live there.

The root `workspaces` field covers `packages/*`, `client`, and `server`, so a single `npm install` from the repo root links all four workspace packages and hoists shared dependencies.

---

## Prerequisites

| Tool | Minimum version |
|------|-----------------|
| Node.js | 20.19.0 |
| npm | 9 |

---

## Getting started

```bash
# Clone the repo
git clone https://github.com/cmik/apilix.git
cd apilix

# Install all workspaces in one step
npm install

# Start in web mode (server + Vite dev server)
npm start

# Or start the Electron desktop app
npm run electron:dev
```

---

## Running tests

```bash
# Workspace package tests (packages/core, packages/cli)
npm run test --workspaces --if-present

# Server tests (Node built-in test runner)
npm run test:server

# Client tests (Vitest)
npm run test:client
```

All three suites are run in parallel in CI via the GitHub Actions test matrix.

### Writing tests

**Server (`server/*.test.js`):**
- Uses Node.js built-in `node:test` and `node:assert/strict` — no external framework.
- Co-locate test files next to the module under test.
- Use the `withServer(handler, fn)` helper (from `executor.test.js`) for tests that need a real HTTP response.

**Client (`client/src/**/*.test.ts`):**
- Uses Vitest 2.x.
- Co-locate test files next to the module under test.
- Mock `../store` imports that reference browser globals: `vi.mock('../store', () => ({ generateId: () => ... }))`.

---

## Code style

- **TypeScript** for all client code; **CommonJS JavaScript** for server and packages.
- Tailwind CSS for UI — dark theme by default (`bg-slate-*`, `text-slate-*`, orange accent `text-orange-400`).
- No external icon library — inline SVGs only (`w-4 h-4`, `stroke="currentColor"`).
- Do not hardcode hex colours; use the Tailwind palette defined in `client/src/index.css`.

---

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Stable, tagged releases |
| `feat/*` | New feature work |
| `fix/*` | Bug fixes |

---

## Pull requests

1. Branch from `main` (or the active refactor branch if working on monorepo tasks).
2. Keep PRs focused — one logical change per PR.
3. All CI checks (lint, test matrix, smoke test) must pass before merging.
4. Add or update tests for any changed server/client utility logic.

---

## Security

Run `npm audit` before opening a PR. Address any high or critical advisories. Moderate advisories in indirect dependencies may be noted rather than blocked if no upstream fix is available.

---

## Commit messages

Follow conventional commits:

```
feat: short description of the feature
fix: short description of the bug fix
chore: dependency updates, CI changes, refactoring
docs: documentation-only changes
test: adding or updating tests
```

---

## Adding a new dependency

- **`packages/core`** — declare in `packages/core/package.json`. These become peer-deps of the CLI and are bundled into the binary via `pkg`.
- **`client/`** — declare in `client/package.json`.
- **`server/`** — declare in `server/package.json`.
- **Root** — only for dev tooling shared across all packages.

Do not add the same dependency in multiple places; prefer pulling shared runtime deps into `packages/core`.

---

## Adding a new export to @apilix/core

1. Create `packages/core/src/<module>.js` with your implementation.
2. Add a subpath entry in `packages/core/package.json` under `"exports"`:

   ```json
   "./my-module": {
     "require": "./src/my-module.js",
     "default": "./src/my-module.js"
   }
   ```

3. Add corresponding TypeScript declarations to `packages/core/types/index.ts`.
4. Re-export from the barrel (`packages/core/src/index.js`) if the symbol should be available via the root import.
5. Add path aliases for the new subpath in:
   - `tsconfig.json` (root IDE/type-checking)
   - `client/tsconfig.json` (if client needs it)
   - `client/vitest.config.ts` (test resolution)
   - `client/vite.config.ts` (if client needs it at build time)
