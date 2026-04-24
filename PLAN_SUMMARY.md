# Apilix Monorepo — Plan Summary (Quick Reference)

## What We're Doing

Converting Apilix from a single-package layout to an **npm workspaces monorepo** with four packages.

| Package | Contents |
|---|---|
| `@apilix/core` | `request-engine.js`, `script-runtime.js`, `oauth.js`, `tls-utils.js`, shared TypeScript types |
| `@apilix/server` | Express app, routes, mock server, sync engine |
| `@apilix/client` | React + Vite UI |
| `@apilix/cli` | Commander CLI runner (standalone binary) |

---

## Why

- `resolveVariables()` is duplicated in `request-engine.js` and `oauth.js` → single source of truth needed
- CLI binary must not carry Electron dependencies → `@apilix/core` as a pure Node package enables this
- `client/src/types.ts` can't be imported by server/CLI without hacks → move to `@apilix/core/types`

---

## Document Map

| Read this | For |
|---|---|
| [MONOREPO_INITIATIVE.md](MONOREPO_INITIATIVE.md) | Executive overview, success metrics |
| [MONOREPO_IMPLEMENTATION_PLAN.md](MONOREPO_IMPLEMENTATION_PLAN.md) | Phases, tasks, risks, rollback |
| [MONOREPO_APILIX_GUIDE.md](MONOREPO_APILIX_GUIDE.md) | Exact commands to execute |
| [.github/GITHUB_PROJECT_SETUP.md](.github/GITHUB_PROJECT_SETUP.md) | GitHub labels, milestones, issue templates |
| [IMPLEMENTATION_DELIVERABLES.md](IMPLEMENTATION_DELIVERABLES.md) | Document inventory and role guide |

---

## Timeline

```
Week 1–2   Phase 1 — Planning     Branch setup, tool decision, issue creation
Week 3–5   Phase 2 — Migration    Move files, update imports, tests green
Week 6–9   Phase 3 — Optimise     CLI smaller, CI parallel, cleanup
Week 10–12 Phase 4 — Stabilise    Docs, training, production release
```

---

## GitHub Setup (One-Time)

1. Create labels from [.github/GITHUB_PROJECT_SETUP.md §1](.github/GITHUB_PROJECT_SETUP.md)
2. Create 4 milestones (Phase 1–4)
3. Add issue templates from §3 to `.github/ISSUE_TEMPLATE/`
4. Create Projects v2 board with board / table / roadmap views
5. Enable the 4 automation rules from §5
6. Create Phase 1 issues from [MONOREPO_IMPLEMENTATION_PLAN.md tasks 1.1–1.7](MONOREPO_IMPLEMENTATION_PLAN.md)

---

## Engineer Quick Start

```bash
# 1. Create branch
git checkout -b refactor/monorepo

# 2. Follow Step-by-step guide
# → MONOREPO_APILIX_GUIDE.md

# 3. Verify everything still works
npm install
node --test packages/core/tests/
node --test packages/server/tests/
npm run test --workspace=packages/client
npm run electron:dev
```

---

## Success Metrics

| Metric | Target |
|---|---|
| `npm install && npm start` | Exits 0 |
| All tests | 100% pass (no regressions) |
| CLI binary size | ≥10% smaller than current |
| `resolveVariables` copies | Exactly 1 (in `packages/core/src/variable-resolver.js`) |
| `client/src/types.ts` | Deleted; replaced by `@apilix/core/types` |

---

## Contacts

| Area | Owner |
|---|---|
| Architecture decisions | Tech Lead |
| Phase execution | Assigned engineer per issue |
| GitHub project board | PM / project admin |
| Electron + build pipeline | DevOps |
