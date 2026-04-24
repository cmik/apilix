# Apilix — Monorepo Refactoring Initiative

## Executive Summary

The Monorepo Initiative restructures the Apilix codebase from a single-package layout into a **npm workspaces monorepo** with four focused packages. The goal is to enable the CLI runner to ship as a standalone binary without bundling Electron, allow the server and core logic to be used independently, and eliminate the copy-pasted `resolveVariables()` duplication that currently exists between `src/core/request-engine.js` and `server/oauth.js`.

---

## Why This Is Needed

| Problem | Impact |
|---|---|
| `resolveVariables()` duplicated in `request-engine.js` and `oauth.js` | Divergent behaviour between request execution and OAuth token resolution |
| Core logic (`request-engine.js`, `script-runtime.js`) tightly coupled to server paths | Cannot be imported by CLI without starting a server process |
| `client/src/types.ts` lives inside the client package | Server and CLI cannot consume TypeScript types without `tsc` path hacks |
| CLI binary (`bin/apilix.js`) pulled into Electron bundle via pkg | Binary bloat; `pkg` fallback requires force on `axios` path |
| No clean boundary between Electron-specific and portable code | Harder to maintain; portable core leaks platform assumptions |

---

## Target Package Structure

```
packages/
  core/       @apilix/core     — request-engine, script-runtime, oauth, tls, shared types
  server/     @apilix/server   — Express app, routes, mock server, sync relay
  client/     @apilix/client   — React + Vite UI
  cli/        @apilix/cli      — Commander CLI runner (no Electron dependency)
electron/                      — Electron shell (unchanged architecture)
```

---

## Business Value

| Benefit | Concrete gain |
|---|---|
| Standalone CLI binary | `npm run cli:build:binaries` produces smaller, faster `pkg` output |
| Shared types | `@apilix/core/types` imported by server, client, and CLI without duplication |
| Single `resolveVariables` | One implementation; fix once, fixed everywhere |
| Independent package tests | `node --test packages/core/tests` without starting the full server |
| Clean Electron boundary | Easier desktop-only features without polluting portable core |

---

## Document Map

| Document | Purpose | Read if you are… |
|---|---|---|
| **MONOREPO_INITIATIVE.md** (this file) | Executive summary | Anyone starting |
| **MONOREPO_IMPLEMENTATION_PLAN.md** | 4-phase roadmap with tasks, risks, timeline | Tech leads, project managers |
| **MONOREPO_APILIX_GUIDE.md** | Step-by-step commands for the migration | Engineers executing the work |
| **.github/GITHUB_PROJECT_SETUP.md** | Issue templates, labels, project board setup | GitHub project admin |

---

## Timeline Overview

| Phase | Duration | Milestone |
|---|---|---|
| 1 — Planning & Prep | 2 weeks | Tool decision, branch strategy, environment verified |
| 2 — Infrastructure | 3 weeks | Four packages buildable; all tests green |
| 3 — Optimisation | 4 weeks | CLI binary smaller; CI parallel; no duplicate code |
| 4 — Stabilisation | 3 weeks | Docs complete; team trained; production deployed |

**Total: ~12 weeks**

---

## Success Metrics

- `pnpm install && pnpm build` exits `0` across all packages
- All existing Vitest + `node --test` suites pass without modification
- `npm run cli:build:binaries` produces binaries ≥10% smaller than before
- Zero occurrences of `resolveVariables` outside `packages/core/src/`
- `client/src/types.ts` removed; replaced by `@apilix/core/types` import

---

## Next Steps

1. Read **MONOREPO_IMPLEMENTATION_PLAN.md** — review Phase 1 tasks and approve scope
2. Read **MONOREPO_APILIX_GUIDE.md** — validate the proposed directory layout with the team
3. Follow **.github/GITHUB_PROJECT_SETUP.md** — create GitHub issues and project board
4. Begin Phase 1 execution on a dedicated `refactor/monorepo` branch
