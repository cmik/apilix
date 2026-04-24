# GitHub Project Setup — Apilix Monorepo Refactoring

This guide provides the exact labels, milestones, issue templates, and project board configuration needed to track the Apilix monorepo refactoring initiative.

---

## 1. Labels

Create these labels in **GitHub → Settings → Labels**.

### Epic labels
| Label | Color | Description |
|---|---|---|
| `epic:foundation` | `#0075ca` | Monorepo tooling and workspace scaffolding |
| `epic:core-extraction` | `#e4e669` | Move request-engine, script-runtime, oauth, tls-utils |
| `epic:server-migration` | `#d73a4a` | Restructure server package |
| `epic:client-migration` | `#0e8a16` | Restructure client package |
| `epic:cli-refactor` | `#5319e7` | Refactor CLI into standalone package |
| `epic:stabilisation` | `#b60205` | Docs, training, production deployment |

### Priority labels
| Label | Color |
|---|---|
| `priority:critical` | `#b60205` |
| `priority:high` | `#d93f0b` |
| `priority:medium` | `#e4e669` |
| `priority:low` | `#0e8a16` |

### Type labels
| Label | Color |
|---|---|
| `type:task` | `#1d76db` |
| `type:bug` | `#d73a4a` |
| `type:docs` | `#0075ca` |
| `type:test` | `#006b75` |

### Effort labels
| Label | Meaning |
|---|---|
| `effort:S` | < 2 hours |
| `effort:M` | 2–8 hours |
| `effort:L` | 1–3 days |
| `effort:XL` | > 3 days |

### Status labels
| Label |
|---|
| `status:blocked` |
| `status:in-review` |
| `status:needs-rebase` |

---

## 2. Milestones

| Milestone | Due | Description |
|---|---|---|
| Phase 1 — Planning | Week 2 | Tool decision, branch setup, CI green |
| Phase 2 — Infrastructure | Week 5 | All packages buildable, all tests pass |
| Phase 3 — Optimisation | Week 9 | CLI binary smaller, CI parallel |
| Phase 4 — Stabilisation | Week 12 | Docs, training, production release |

---

## 3. Issue Templates

### Template 1: Foundation Task

```markdown
---
name: Foundation Task
about: Workspace scaffolding, tooling, and root configuration
title: "[Foundation] "
labels: epic:foundation, type:task
---

## What
Brief description of what infrastructure component needs to exist.

## Why
Why this is needed for the monorepo foundation.

## Acceptance Criteria
- [ ] 
- [ ] 
- [ ] 

## Files Affected
<!-- List specific files or directories -->

## Blocked by
<!-- Reference blocking issues with #number, or write "Nothing" -->

---

### Example

**Title:** [Foundation] Add `workspaces` field to root `package.json`

**Acceptance Criteria:**
- [ ] Root `package.json` has `"workspaces": ["packages/*"]`
- [ ] `npm install` from repo root symlinks all four packages under `node_modules/@apilix/`
- [ ] `npm ls --workspaces --depth=0` lists all four packages with correct versions
```

---

### Template 2: Core Extraction Task

```markdown
---
name: Core Extraction
about: Moving a file from its current location into packages/core/
title: "[Core] "
labels: epic:core-extraction, type:task
---

## File to Move
**From:** 
**To:** `packages/core/src/`

## Import Changes Required
List every file that imports the source file and needs updating.

| File | Old import | New import |
|---|---|---|
| | | |

## Acceptance Criteria
- [ ] File moved with `git mv` (history preserved)
- [ ] All callers updated to import from `@apilix/core`
- [ ] `node --test packages/core/tests/` passes
- [ ] No references to old path remain (`grep -r "old/path" .`)

## Notes
<!-- Circular dependency risks, edge cases, etc. -->
```

---

### Template 3: Duplicate Code Consolidation

```markdown
---
name: Duplicate Consolidation
about: Remove a duplicated function and replace with a single shared implementation
title: "[Dedup] "
labels: epic:core-extraction, type:task
---

## Duplicate
**Function name:** 
**Locations:**
1. 
2. 

## Differences Between Copies
<!-- Describe any behavioural differences between the two copies -->

## Proposed Canonical Location
`packages/core/src/`

## Acceptance Criteria
- [ ] Single implementation exists in `packages/core/src/`
- [ ] Both original locations import from the canonical location
- [ ] `grep -r "function <name>" packages/` returns exactly one result
- [ ] All existing tests pass unchanged

---

### Example

**Title:** [Dedup] Consolidate `resolveVariables` from request-engine and oauth

**Locations:**
1. `src/core/request-engine.js` line ~45
2. `server/oauth.js` line ~22

**Proposed Canonical Location:** `packages/core/src/variable-resolver.js`
```

---

### Template 4: Test Coverage Task

```markdown
---
name: Test Coverage
about: Add or update tests after a file is moved
title: "[Test] "
labels: type:test
---

## Package
`@apilix/`

## What to Test
<!-- Describe the functions or behaviours to cover -->

## Test File
`packages/<name>/tests/<file>.test.js`

## Test Runner
- [ ] `node --test` (server/core)
- [ ] Vitest (client)

## Cases to Cover
- [ ] 
- [ ] 
- [ ] 

## Acceptance Criteria
- [ ] Test file created at correct path
- [ ] All cases pass
- [ ] Coverage for the moved function is ≥ 80%
```

---

### Template 5: Documentation Task

```markdown
---
name: Documentation
about: Update or create documentation for the monorepo
title: "[Docs] "
labels: epic:stabilisation, type:docs
---

## Document
<!-- File path and what it documents -->

## Audience
- [ ] Engineers
- [ ] DevOps
- [ ] New contributors

## Sections Required
- [ ] 
- [ ] 

## Acceptance Criteria
- [ ] Document is accurate and tested
- [ ] Linked from `README.md`
- [ ] Reviewed by at least one other engineer
```

---

## 4. Project Board

Create a GitHub Project (beta / Projects v2) with the following views:

### Board view columns

| Column | Auto-add rule |
|---|---|
| **Backlog** | All new issues |
| **This Sprint** | Issues with current milestone |
| **In Progress** | Issues with `status:in-progress` label or open PR |
| **In Review** | PR opened and review requested |
| **Done** | Issue closed |
| **Blocked** | Issues with `status:blocked` label |

### Table view fields

Add custom fields:
- **Effort** (single select: S / M / L / XL)
- **Phase** (single select: 1 / 2 / 3 / 4)
- **Package** (single select: core / server / client / cli / root)

### Roadmap view

Group by **Phase** field. This gives a timeline of what ships in each phase.

---

## 5. Automation Rules

In **Project Settings → Workflows**, enable:

| Trigger | Action |
|---|---|
| Issue opened | Set status → Backlog |
| Pull request opened | Set status → In Review |
| Pull request merged | Set status → Done |
| Issue closed | Set status → Done |

---

## 6. Sample Workflow: From Issue to Merge

```
1. Create issue using a template above
2. Assign to engineer, add milestone + effort label
3. Engineer creates branch: feat/core-123-extract-oauth
4. Engineer opens PR with "Closes #123" in the description
5. PR auto-moves issue to "In Review"
6. Reviewer approves; merge
7. Issue auto-closes and moves to "Done"
```

---

## 7. Quick-Start Checklist

```
- [ ] Create all labels (section 1)
- [ ] Create 4 milestones (section 2)
- [ ] Add issue templates to .github/ISSUE_TEMPLATE/ (section 3)
- [ ] Create GitHub Project with board + table + roadmap views (section 4)
- [ ] Enable automation rules (section 5)
- [ ] Create Phase 1 issues from MONOREPO_IMPLEMENTATION_PLAN.md tasks 1.1–1.7
- [ ] Assign Phase 1 issues to engineers
- [ ] Schedule Phase 1 kickoff meeting
```
