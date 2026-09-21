# Desktop UX Refactor Tasks

## Task 1: Fix UI Foundation Audit Issues

**Description:** Close the lowest-risk issues found by the UX audit before larger restructuring: define/normalize missing semantic token usage, move Dispatch selector visible strings into i18n, and fix the Settings first-card mobile overflow.

**Acceptance criteria:**
- [x] Dispatch selector renders all user-visible labels through i18n keys in English and Chinese.
- [x] Token/class references used by changed UI are defined by `index.css` and Tailwind config or replaced with existing semantic tokens.
- [x] Settings first viewport at 390 px no longer clips the Add Provider action.

**Verification:**
- [x] Tests pass: `cd ui && npm test -- DispatchSelector`
- [x] Build succeeds: `cd ui && npm run build`
- [x] Manual/browser check: Settings at 390 px and desktop has no clipped Add Provider button.

**Dependencies:** None

**Files likely touched:**
- `ui/src/components/chat/DispatchSelector.tsx`
- `ui/src/components/chat/DispatchSelector.test.ts`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/index.css`
- `ui/tailwind.config.js`

**Estimated scope:** Medium: 3-5 files

## Task 2: Introduce Reusable Settings Layout Primitives

**Description:** Add focused Settings primitives for sections, rows, tabs, status pills, callouts, and actions without changing current settings behavior.

**Acceptance criteria:**
- [x] New primitives support accessible headings, descriptions, actions, loading, empty, and error states.
- [x] At least one low-risk Settings section uses the primitives as a migration example.
- [x] No provider, Relay, routing, notification, or advanced settings behavior changes.

**Verification:**
- [x] Tests pass: `cd ui && npm test`
- [x] Build succeeds: `cd ui && npm run build`
- [ ] Manual/browser check: migrated Settings section works at 390, 768, 1024, and 1440 px. Unauthenticated harness run passed; authenticated visual pass still needs `KIN_UX_BASE_URL` with a local token.

**Dependencies:** Task 1

**Files likely touched:**
- `ui/src/components/settings/`
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`

**Estimated scope:** Medium: 3-5 files

## Checkpoint: Foundation

- [x] `cd ui && npm test` passes.
- [x] `cd ui && npm run build` passes.
- [ ] Changed routes have no obvious overlap, clipping, blank panels, or text overflow.
- [ ] Human review before broad Settings extraction.

## Task 3: Split Settings Into Top-Level Tabs

**Description:** Convert Settings from one long scroll into top tabs that preserve all existing controls while separating Providers, Local Agents, Routing, Remote, Notifications, and Advanced.

**Acceptance criteria:**
- [x] Each category is reachable via keyboard-operable tabs.
- [x] Existing setting values, save actions, and error states still work.
- [x] Mobile and narrow desktop use a non-clipping horizontal or wrapped tab layout.

**Verification:**
- [x] Tests pass: `cd ui && npm test`
- [x] Build succeeds: `cd ui && npm run build`
- [ ] Manual/browser check: navigate all tabs at 390 and 1440 px. Requires authenticated local browser URL.

**Dependencies:** Task 2

**Files likely touched:**
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/components/settings/`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`

**Estimated scope:** Medium

## Task 4: Move Providers and Local Agents Into Focused Components

**Description:** Extract provider and local-agent setup flows from `SettingsPage.tsx`, preserving explicit user actions and avoiding passive secret or third-party reads.

**Acceptance criteria:**
- [x] Provider create/edit/list flows remain functional and i18n-backed.
- [x] Local agent detection/import states remain explicit and reversible.
- [x] No model fetch, secret read, or external API call occurs on passive Settings open.

**Verification:**
- [x] Tests pass: `cd ui && npm test`
- [x] Build succeeds: `cd ui && npm run build`
- [ ] Manual/browser check: provider edit and local agent import entry points render and behave as before. Requires authenticated local browser URL.

**Dependencies:** Task 3

**Files likely touched:**
- `ui/src/components/settings/`
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/api/client.ts`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`

**Estimated scope:** Medium

## Task 5: Convert Remote Relay Into A Guided Flow

**Description:** Replace the dense Relay settings block with a prerequisite-aware flow that exposes one primary next action and only recommends custom domains after a failed `workers.dev` probe or user preference.

**Acceptance criteria:**
- [x] Each Relay prerequisite state has exactly one primary action.
- [x] Repeat deploy/update behavior remains idempotent.
- [x] The UI never implies Kin-hosted cloud or end-to-end encryption for BYO Relay.

**Verification:**
- [x] Tests pass: `cd ui && npm test`
- [x] Backend checks pass if touched: not applicable; backend was not touched.
- [x] Build succeeds: `cd ui && npm run build`
- [ ] Manual/browser check: disconnected, connected, deployed, and bind-domain states render clearly.

**Dependencies:** Task 3

**Files likely touched:**
- `ui/src/components/settings/`
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/api/client.ts`
- `internal/remote/`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`

**Estimated scope:** Medium

## Task 6: Align Sidebar And Session IA

**Description:** Clarify Kin tasks, external native sessions, drafts, archived projects, and unread terminal states in the sidebar without removing capabilities.

**Acceptance criteria:**
- [x] External/unlinked/read-only sessions are visually distinct without relying on tiny secondary text alone.
- [ ] Project/session grouping remains keyboard-operable and does not lose archive/pin/sort behavior.
- [ ] Top-level navigation prepares for future split of daily Agents from usage/operations surfaces.

**Verification:**
- [x] Tests pass: `cd ui && npm test`
- [x] Build succeeds: `cd ui && npm run build`
- [ ] Manual/browser check: sidebar states render at 390, 768, and 1440 px.

**Dependencies:** Task 2

**Files likely touched:**
- `ui/src/components/layout/Sidebar.tsx`
- `ui/src/lib/projectSidebar.ts`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`

**Estimated scope:** Medium

## Task 7: Align New Chat Workbench Controls And Task Cards

**Description:** Calm the New Chat first screen and task detail flow using the accepted dense desktop direction, with controls grouped by workflow instead of one overloaded control row.

**Acceptance criteria:**
- [ ] Start-work path has one obvious primary entry point.
- [ ] Host agent, model, dispatch, routine, cwd, branch, and project summary controls remain available without overflowing at 390 px.
- [ ] Task status cards use consistent running, approval, completed, and failed semantics.

**Verification:**
- [ ] Tests pass: `cd ui && npm test`
- [ ] Build succeeds: `cd ui && npm run build`
- [ ] Manual/browser check: New Chat and Task Detail at 390 and 1440 px.

**Dependencies:** Task 2

**Files likely touched:**
- `ui/src/pages/NewChatPage.tsx`
- `ui/src/pages/TaskDetailPage.tsx`
- `ui/src/components/chat/`
- `ui/src/components/cards/`
- `ui/src/i18n/locales/en.ts`
- `ui/src/i18n/locales/zh.ts`

**Estimated scope:** Medium

## Task 8: Add Screenshot And Browser-Console Verification Harness

**Description:** Commit a lightweight repeatable harness for key route screenshots and console checks so later UX slices can be verified consistently.

**Acceptance criteria:**
- [x] Harness covers Settings and New Chat at 390, 768, 1024, and 1440 px.
- [x] Secrets, room keys, tokens, and account identifiers are never committed in screenshots or logs.
- [x] Documentation explains when to run the harness and how to inspect failures.

**Verification:**
- [x] Harness command runs locally against `127.0.0.1:7777`.
- [x] `cd ui && npm run build` passes.
- [x] Generated screenshots/logs are ignored unless explicitly approved as fixtures.

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/`
- `.gitignore`
- `docs/plans/2026-09-21-desktop-ux-refactor.md`

**Estimated scope:** Small
