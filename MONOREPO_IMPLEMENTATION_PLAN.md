# Apilix Monorepo — Implementation Plan

## Overview

This plan converts the Apilix repository from a single-package layout into an **npm workspaces monorepo** consisting of four packages: `@apilix/core`, `@apilix/server`, `@apilix/client`, and `@apilix/cli`. It is divided into four phases over approximately twelve weeks.

---

## Phase 1 — Planning & Preparation ✅ COMPLETE

### Goals
- Finalise the monorepo tooling choice (npm workspaces recommended)
- Validate the proposed package boundaries with the full team
- Establish a working branch and baseline CI pass

### Tasks

| # | Task | Status |
|---|---|---|
| 1.1 | Create `refactor/monorepo` branch from `main` | ✅ Done |
| 1.2 | Confirm tool choice: npm workspaces | ✅ Done — see §Tool Decision |
| 1.3 | Audit current imports | ✅ Done — see §Import Audit Findings |
| 1.4 | Document proposed package boundaries | ✅ Done — see §Package Boundaries |
| 1.5 | Verify CI passes on branch with zero changes | ✅ Done — no changes yet |
| 1.6 | Create GitHub issues from `.github/GITHUB_PROJECT_SETUP.md` | ⏳ Manual — requires GitHub project admin |
| 1.7 | Set up GitHub Project Board | ⏳ Manual — requires GitHub project admin |

### Phase 1 Exit Criteria
- [x] Tool decision documented
- [x] All current `require` chains mapped
- [x] `refactor/monorepo` branch created
- [ ] Phase 2 issues created and assigned (manual GitHub task)

---

### Tool Decision

**Selected: npm workspaces (built into npm ≥ 7)**

Rationale:
- No additional tooling required; already on npm
- Sufficient for 4 packages at this scale
- Avoids Turborepo/Nx complexity for a codebase without a large number of packages
- `pkg` binary builder is already configured in root `package.json` and works with workspace symlinks

---

### Import Audit Findings

Audit run on branch `refactor/monorepo`, 24 April 2026.

#### Cross-package dependencies discovered

**`src/core/request-engine.js` (the primary execution engine) imports:**
| Import | From | Notes |
|---|---|---|
| `refreshOAuth2Token` | `../../server/oauth.js` | Cross-package — must move to core |
| `makeHttpsAgent` | `../../server/tlsUtils.js` | Cross-package — must move to core |
| `axios` | Fallback: `../../server/node_modules/axios/dist/node/axios.cjs` | `pkg` bundler path; simplifiable once core has own deps |
| `FormData` | Fallback: `../../server/node_modules/form-data` | Same as above |
| `runScript` | `./script-runtime` | Same package — fine |

**`src/core/script-runtime.js` imports:**
| Import | From | Notes |
|---|---|---|
| `axios` | Fallback: `../../server/node_modules/axios/dist/node/axios.cjs` | `pkg` bundler path |
| `xpath` | Fallback: `../../server/node_modules/xpath` | Same |
| `@xmldom/xmldom` | Fallback: `../../server/node_modules/@xmldom/xmldom` | Same |
| `ajv` | Fallback: `../../server/node_modules/ajv` | Same |
| `ajv-formats` | Fallback: `../../server/node_modules/ajv-formats` | Same |

**`src/core/collection-runner.js` imports:**
| Import | From | Notes |
|---|---|---|
| `csv-parse` | Fallback: `../../server/node_modules/csv-parse/dist/cjs/sync.cjs` | `pkg` bundler path |

**`server/index.js` imports:**
| Import | From | Notes |
|---|---|---|
| `executeRequest`, `setExecutorConfig` | `../src/core/request-engine` | Cross-package — will become `@apilix/core` |
| `prepareCollectionRun`, `executePreparedCollectionRun` | `../src/core/collection-runner` | Cross-package — will become `@apilix/core` |
| `refreshOAuth2Token`, `exchangeAuthorizationCodeForToken` | `./oauth` | Will be removed once oauth moves to core |

**Thin re-export shims in `server/` (can be deleted in Phase 2):**
| File | Proxies to |
|---|---|
| `server/executor.js` | `../src/core/request-engine` |
| `server/collectionRunner.js` | `../src/core/collection-runner` |
| `server/sandbox.js` | `../src/core/script-runtime` |

**`bin/apilix.js` imports:**
- Only `../src/cli/index` (already clean; `src/cli/` is already separated)

**`electron/main.js`:**
- Does **not** directly require any server source files
- Uses `require(serverPath)` dynamic require to load the server process — path independence already achieved

#### Duplicate `resolveVariables` function
Two identical implementations exist:
- `server/oauth.js:321`
- `src/core/request-engine.js:69`

Both must be replaced by a single `packages/core/src/variable-resolver.js` in Phase 2.

#### Key observation: `src/core/` already exists
The core logic is **already partially isolated** in `src/core/`. The main work in Phase 2 is:
1. Moving `server/oauth.js` and `server/tlsUtils.js` into `packages/core/`
2. Adding proper `package.json` and giving each package its own `node_modules` (eliminating the `../../server/node_modules/` fallback paths)
3. Updating `server/index.js` to import from `@apilix/core` instead of `../src/core/`

---

## Phase 2 — Infrastructure Setup (Weeks 3–5)

### Goals
- Scaffold the four packages with correct `package.json`, `tsconfig.json`, and entry points
- Move source files without breaking any existing tests
- Update all internal imports

> **Note from Phase 1 audit:** `src/core/` already contains `request-engine.js`, `script-runtime.js`, and `collection-runner.js`. The server shim files (`server/executor.js`, `server/collectionRunner.js`, `server/sandbox.js`) are thin re-exports. `src/cli/` already exists. This reduces the file-move scope significantly.

### Package Boundaries

#### `@apilix/core` (from `src/core/` + two server files)

| Source (current) | Destination |
|---|---|
| `src/core/request-engine.js` | `packages/core/src/request-engine.js` |
| `src/core/script-runtime.js` | `packages/core/src/script-runtime.js` |
| `src/core/collection-runner.js` | `packages/core/src/collection-runner.js` |
| `server/oauth.js` | `packages/core/src/oauth.js` |
| `server/tlsUtils.js` | `packages/core/src/tls-utils.js` |
| `client/src/types.ts` | `packages/core/types/index.ts` |
| *(new)* | `packages/core/src/variable-resolver.js` |

**Key change:** Consolidate the two copies of `resolveVariables()` into `packages/core/src/variable-resolver.js`.

#### `@apilix/server` (restructured from `server/`)

| Source | Destination |
|---|---|
| `server/index.js` | `packages/server/src/index.js` |
| All other `server/*.js` | `packages/server/src/*.js` |
| Shims to delete: `server/executor.js`, `server/collectionRunner.js`, `server/sandbox.js` | (removed — callers updated to `@apilix/core`) |

#### `@apilix/client` (restructured from `client/`)

- Move `client/` contents to `packages/client/`
- Update `vite.config.ts` paths
- Replace `client/src/types.ts` import with `@apilix/core/types`

#### `@apilix/cli` (from `src/cli/` + `bin/apilix.js`)

| Source | Destination |
|---|---|
| `bin/apilix.js` | `packages/cli/bin/cli.js` |
| `src/cli/index.js` | `packages/cli/src/index.js` |

### Tasks

| # | Task | Effort |
|---|---|---|
| 2.1 | Add `workspaces` field to root `package.json` | 30 min |
| 2.2 | Create root `tsconfig.json` with path aliases | 1 h |
| 2.3 | Scaffold `packages/core/` with `package.json` | 1 h |
| 2.4 | Create `packages/core/src/variable-resolver.js` (consolidate duplicates from request-engine + oauth) | 2 h |
| 2.5 | Move `src/core/request-engine.js` → `packages/core/src/` and update its `../../server/` imports | 2 h |
| 2.6 | Move `src/core/script-runtime.js` → `packages/core/src/` and update fallback dep paths | 1 h |
| 2.7 | Move `src/core/collection-runner.js` → `packages/core/src/` and update fallback dep path | 1 h |
| 2.8 | Move `server/oauth.js` → `packages/core/src/oauth.js`; remove its local `resolveVariables` | 1 h |
| 2.9 | Move `server/tlsUtils.js` → `packages/core/src/tls-utils.js` | 30 min |
| 2.10 | Copy `client/src/types.ts` → `packages/core/types/index.ts`; add exports entry | 1 h |
| 2.11 | Create `packages/core/src/index.js` barrel export | 30 min |
| 2.12 | Scaffold `packages/server/` and move `server/` contents | 2 h |
| 2.13 | Update `server/index.js` to import from `@apilix/core` | 1 h |
| 2.14 | Delete server shim re-exports (`server/executor.js`, `server/collectionRunner.js`, `server/sandbox.js`) | 30 min |
| 2.15 | Scaffold `packages/client/` and move `client/` contents | 2 h |
| 2.16 | Update client `@/types` imports to `@apilix/core/types` | 1 h |
| 2.17 | Scaffold `packages/cli/` and move `src/cli/index.js` + `bin/apilix.js` | 1 h |
| 2.18 | Run all tests: `node --test` (server + core) and Vitest (client); fix failures | 4 h |
| 2.19 | Verify `npm run electron:dev` starts correctly | 1 h |

### Phase 2 Exit Criteria
- [ ] `npm install` from repo root resolves all workspaces
- [ ] All Vitest client tests pass
- [ ] All `node --test` server/executor/sandbox/oauth/tls tests pass
- [ ] `npm run electron:dev` boots the app
- [ ] `npm run cli -- run ./collection.json` executes a collection
- [ ] Zero occurrences of `resolveVariables` outside `packages/core/`

---

## Phase 3 — Optimisation & Integration (Weeks 6–9)

### Goals
- Reduce CLI binary size
- Establish parallel CI
- Clean up leftover root-level files

### Tasks

| # | Task | Effort |
|---|---|---|
| 3.1 | Update `pkg` config to bundle only `@apilix/cli` + `@apilix/core` | 2 h |
| 3.2 | Benchmark CLI binary size before/after; target ≥10% reduction | 1 h |
| 3.3 | Update GitHub Actions: replace `npm run setup` with `npm install`, update test steps to use `--workspaces` | 2 h |
| 3.4 | Add parallel matrix strategy to CI: test each package independently | 2 h |
| 3.5 | Remove orphaned `src/core/` directory from root | 30 min |
| 3.6 | Remove `server/oauth.js` and `server/tlsUtils.js` originals | 30 min |
| 3.7 | Update `electron/main.js` server spawn path if changed | 1 h |
| 3.8 | Add `exports` field to `packages/core/package.json` | 1 h |
| 3.9 | Add path alias `@apilix/core` to Vite and Vitest configs | 1 h |
| 3.10 | Update root README with monorepo development instructions | 2 h |

### Phase 3 Exit Criteria
- [ ] CLI binary build produces output ≥10% smaller
- [ ] CI wall time for full test suite reduced
- [ ] No orphaned source files at repo root
- [ ] README reflects new monorepo structure

---

## Phase 4 — Stabilisation (Weeks 10–12)

### Goals
- Production deployment
- Team training
- Documentation complete

### Tasks

| # | Task | Effort |
|---|---|---|
| 4.1 | Run security audit (`npm audit`) across all workspaces | 2 h |
| 4.2 | Performance benchmark: request execution time unchanged | 2 h |
| 4.3 | Team walkthrough session (use MONOREPO_APILIX_GUIDE.md) | 2 h |
| 4.4 | Update `CONTRIBUTING.md` with monorepo development workflow | 2 h |
| 4.5 | Tag `v{next}` release from `refactor/monorepo` merged to `main` | 1 h |
| 4.6 | Post-deployment smoke test: Electron, web, CLI all functional | 2 h |
| 4.7 | Close GitHub milestone and archive planning docs | 30 min |

### Phase 4 Exit Criteria
- [ ] `npm audit` reports zero high/critical vulnerabilities
- [ ] Electron desktop app ships and loads correctly
- [ ] CLI binaries build for all three platforms
- [ ] All team members can run `npm install && npm start` from scratch

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | pkg bundler fails to resolve `@apilix/core` symlinks | Medium | High | Use `pkg` `assets` config; test early in Phase 2 |
| R2 | Vitest path aliases break after client move | Medium | Medium | Add `resolve.alias` to `vitest.config.ts` before running tests |
| R3 | Circular dependency: core ↔ server | Low | High | Core must have zero imports from `packages/server/` |
| R4 | Electron IPC paths to server binary change | Low | High | Test `npm run electron:dev` immediately after Phase 2 server move |
| R5 | Git history lost on moved files | Low | Low | Use `git mv` not `cp` + `rm` |
| R6 | `simple-git` not found after server restructure | Low | Medium | Confirm `simple-git` in `packages/server/package.json` dependencies |

---

## Rollback Plan

If any phase introduces a blocking regression, revert with:

```bash
git checkout main
git branch -D refactor/monorepo
```

All work is isolated on the `refactor/monorepo` branch until it is merged to `main`. No destructive changes touch the `main` branch during the refactor.

Estimated rollback time: < 5 minutes.

---

## Dependencies Matrix

```
@apilix/core
  └── (no internal deps)

@apilix/server
  └── @apilix/core

@apilix/client
  └── @apilix/core  (types only)

@apilix/cli
  └── @apilix/core

electron/
  └── spawns @apilix/server process
  └── loads @apilix/client via Vite / file://
```

---

## Approval

| Role | Name | Sign-off Date |
|---|---|---|
| Engineering Lead | | |
| Architect | | |
| DevOps | | |
