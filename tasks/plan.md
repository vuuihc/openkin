# Implementation Plan: Desktop UX Refactor

## Overview

Implement the approved Desktop UX refactor in small, reversible slices. The first delivery focuses on low-risk UI foundation issues found during the audit: token consistency, i18n completeness for dispatch controls, and the narrow-width Settings header overflow. Larger information architecture changes stay behind later tasks.

## Architecture Decisions

- Use the denser `1a Native Pro` direction as the bias for future visual choices while preserving the first-party inspector model where it already fits the product.
- Keep `Agents` visible for now; later split daily agent operations from usage/operations surfaces only after the Settings and shell IA slices make that migration obvious.
- Use top Settings tabs for narrow desktop and mobile constraints.
- For Relay, keep custom domains as a recommendation only after a failed `workers.dev` reachability probe or explicit user preference.
- Add a committed screenshot/browser verification harness after the first visual refactor slice, not before foundation cleanup.

## Task List

### Phase 1: Foundation

- [x] Task 1: Fix UI foundation audit issues
- [ ] Task 2: Introduce reusable Settings layout primitives

### Checkpoint: Foundation

- [ ] `cd ui && npm test` passes
- [ ] `cd ui && npm run build` passes
- [ ] Settings and New Chat screenshots at desktop and 390 px have no obvious clipping

### Phase 2: Settings IA

- [ ] Task 3: Split Settings into top-level tabs without backend behavior changes
- [ ] Task 4: Move Providers and Local Agents into focused settings components
- [ ] Task 5: Convert Remote Relay into a prerequisite-aware guided flow

### Checkpoint: Settings

- [ ] Passive Settings load does not read secrets or call third-party APIs
- [ ] Each Settings tab has one clear primary next action
- [ ] English and Chinese locale files are complete for changed UI

### Phase 3: Shell and Workbench

- [ ] Task 6: Align sidebar/session IA with the accepted dense desktop direction
- [ ] Task 7: Align New Chat workbench controls and task cards
- [ ] Task 8: Add screenshot and browser-console verification harness

### Checkpoint: Complete

- [ ] All accepted spec success criteria are covered by code, tests, or explicit follow-up tasks
- [ ] Full relevant verification has passed
- [ ] Feature completion gate can run for the coherent release slice

## Risks and Mitigations

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Settings refactor breaks provider or Relay behavior | High | Preserve existing APIs and state keys; move UI first, then change workflow behavior with tests. |
| Large component extraction creates review noise | Medium | Extract one tab/component per task and keep formatting churn out of unrelated files. |
| Mobile fixes regress dense desktop layout | Medium | Verify 390, 768, 1024, and 1440 px for changed routes. |
| Passive Settings calls reappear during extraction | High | Add tests around explicit-action-only fetches before changing provider/Relay behavior. |

## Open Questions

- None blocking Task 1.
