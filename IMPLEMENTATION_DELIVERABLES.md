# Implementation Deliverables — Apilix Monorepo Refactoring

## Overview

This document lists all planning artefacts created for the monorepo refactoring initiative, explains how they connect, and tells each stakeholder where to start reading.

---

## Document Inventory

| File | Lines | Purpose |
|---|---|---|
| [MONOREPO_INITIATIVE.md](../MONOREPO_INITIATIVE.md) | ~80 | Executive summary: why, what, timeline, success metrics |
| [MONOREPO_IMPLEMENTATION_PLAN.md](../MONOREPO_IMPLEMENTATION_PLAN.md) | ~220 | 4-phase roadmap with tasks, risks, rollback plan |
| [MONOREPO_APILIX_GUIDE.md](../MONOREPO_APILIX_GUIDE.md) | ~350 | Step-by-step commands for the actual migration |
| [.github/GITHUB_PROJECT_SETUP.md](GITHUB_PROJECT_SETUP.md) | ~250 | GitHub labels, milestones, issue templates, board config |

---

## Role-Based Reading Guide

| Role | Start here | Then read |
|---|---|---|
| Executive / PM | MONOREPO_INITIATIVE.md | MONOREPO_IMPLEMENTATION_PLAN.md (phases only) |
| Tech Lead / Architect | MONOREPO_IMPLEMENTATION_PLAN.md | MONOREPO_APILIX_GUIDE.md |
| Engineer executing the work | MONOREPO_APILIX_GUIDE.md | MONOREPO_IMPLEMENTATION_PLAN.md (task details) |
| GitHub project admin | .github/GITHUB_PROJECT_SETUP.md | MONOREPO_IMPLEMENTATION_PLAN.md (phase tasks) |
| New team member | MONOREPO_INITIATIVE.md | All others in order |

---

## Document Relationships

```
MONOREPO_INITIATIVE.md
│  "What are we doing and why?"
│
├── MONOREPO_IMPLEMENTATION_PLAN.md
│     "What phases, tasks, and risks?"
│     │
│     └── MONOREPO_APILIX_GUIDE.md
│           "Exactly which commands do I run?"
│
└── .github/GITHUB_PROJECT_SETUP.md
      "How do we track this in GitHub?"
```

---

## Key Decisions Documented

| Decision | Where |
|---|---|
| Four packages: core / server / client / cli | MONOREPO_INITIATIVE.md §Target Package Structure |
| Consolidate duplicate `resolveVariables` | MONOREPO_IMPLEMENTATION_PLAN.md §Phase 2, task 2.8 |
| npm workspaces (not pnpm or Turborepo) | MONOREPO_IMPLEMENTATION_PLAN.md §Phase 1, task 1.2 |
| CLI binary uses `pkg` with `@apilix/core` asset | MONOREPO_APILIX_GUIDE.md §Step 9 |
| Types moved to `@apilix/core/types` | MONOREPO_APILIX_GUIDE.md §Step 8 |
| All work on `refactor/monorepo` branch | MONOREPO_IMPLEMENTATION_PLAN.md §Rollback Plan |

---

## Phase Completion Checklist

### Phase 1 — Planning (Weeks 1–2)
- [ ] Tool decision documented
- [ ] `refactor/monorepo` branch created
- [ ] All current `require` chains mapped
- [ ] GitHub issues + project board set up
- [ ] Phase 2 issues assigned

### Phase 2 — Infrastructure (Weeks 3–5)
- [ ] Four packages scaffolded
- [ ] All files moved with `git mv`
- [ ] All imports updated
- [ ] `resolveVariables` consolidated
- [ ] All tests green
- [ ] Electron and CLI both functional

### Phase 3 — Optimisation (Weeks 6–9)
- [ ] CLI binary ≥10% smaller
- [ ] CI parallel builds configured
- [ ] Orphaned root directories removed
- [ ] README updated

### Phase 4 — Stabilisation (Weeks 10–12)
- [ ] `npm audit` clean
- [ ] Team walkthrough complete
- [ ] `CONTRIBUTING.md` updated
- [ ] Production release tagged

---

## Document Maintenance

| Document | Update trigger |
|---|---|
| MONOREPO_IMPLEMENTATION_PLAN.md | After each phase completes; mark tasks done |
| MONOREPO_APILIX_GUIDE.md | If directory structure or commands change |
| .github/GITHUB_PROJECT_SETUP.md | If new issue types or board columns are needed |
| This file | If new planning artefacts are added |
