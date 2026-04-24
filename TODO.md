# Apilix — Todo / Tech Debt

## Monorepo & Package Hygiene

- [x] Extract shared logic into `packages/core` (`@apilix/core`)
- [x] Extract CLI runner into `packages/cli` (`@apilix/cli`)
- [x] Move canonical TypeScript types to `packages/core/types/index.ts`
- [x] Delete stale `client/src/types/oauth.ts`; redirect all importers to `from '../types'`
- [x] Unify `resolveVariables` — single canonical export from `@apilix/core`; client delegates to it
- [x] Fix `packages/core/src/index.js` barrel: remove `resolveVariablesCore` duplicate, clean naming
- [x] Add `./types` subpath to `packages/core` exports map (`./types/index.ts`)
- [ ] Publish `@apilix/core` to npm registry (bump version, run `npm publish`)
- [ ] Publish `@apilix/cli` to npm registry

## Testing

### [x] Add StatusBar component render tests

**Context:** The startup version-check feature added conditional rendering to `StatusBar` (update badge). Tests were deferred because the Vitest setup does not currently support JSX rendering.

**What's needed:**
1. Install `@testing-library/react` and `jsdom` as dev dependencies in `client/`.
2. Update `client/vitest.config.ts`:
   - Set `environment: 'jsdom'`
   - Extend `include` glob to `src/**/*.test.{ts,tsx}`
3. Create `client/src/components/StatusBar.test.tsx` with:
   - **No update props** → update link absent
   - **`updateAvailable=true, latestVersion="1.2.3"`** → link rendered with correct `href` and text
   - **`updateAvailable=false, latestVersion="1.2.3"`** → link absent even when version is provided

### [ ] Add Vitest coverage thresholds

Add `coverage.thresholds` to `client/vitest.config.ts` to enforce minimum coverage on utility modules.

## TypeScript / Build

- [x] `client/tsconfig.json`: add `"@apilix/core/types": ["../packages/core/types/index.ts"]` to `paths` so IDE go-to-definition resolves the `/types` subpath in editors that don't read `exports` maps
- [x] `packages/core/tsconfig.json`: add `"types/**/*"` to `include` so `tsc --noEmit` on the core package type-checks the `.ts` declaration files in `types/`
- [x] **Align exports map conditions**: add explicit `"require"` / `"default"` conditions for dual-mode consumers:
  ```json
  ".": { "require": "./src/index.js", "default": "./src/index.js" }
  ```
- [x] Root `tsconfig.json` created with `paths` for all `@apilix/core` subpaths (enables IDE go-to-definition from anywhere in the monorepo)

## Sync & Storage

- [ ] Team-adapter JWT refresh: implement silent token refresh before expiry (currently throws `401` and forces re-login)
- [ ] Git adapter: surface `stderr` from `simple-git` merge failures in the conflict UI
- [ ] Persist mock traffic log across restarts (currently in-memory only, cleared on server stop)

## Electron

- [ ] Wire `ipcMain.handle('open-devtools')` + renderer call for in-app DevTools toggle (currently only available via keyboard shortcut)
