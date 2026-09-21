# Desktop UX Refactor Spec

**Status:** Approved for implementation planning
**Date:** 2026-09-21
**Scope:** OpenKin Desktop and shared Web console UX, with mobile-responsive behavior where the same React console is used remotely.
**Primary references:** `PRINCIPLE.md`, `SYSTEM_DESIGN.md`, `AGENTS.md`, `kin-desktop-ui-redesign/project/Kin Main Window.dc.html`

## Assumptions

1. The immediate goal is not to add product surface area. It is to make the existing Desktop console coherent enough for daily use.
2. The design handoff in `kin-desktop-ui-redesign/` is a real reference direction. Based on maintainer feedback, prefer the denser `1a Native Pro` feel while preserving the inspector pattern where it helps task detail workflows.
3. Settings and integration flows are the most urgent UX debt because they currently mix passive status, credentials, provider setup, routing, Relay, notifications, price tables, and advanced JSON in one scroll.
4. The same React codebase must keep working for Electron Desktop, browser console, and phone-width remote use. Terminal remains Desktop-only.
5. This spec is a gate. Do not begin the broad implementation until this document's direction and build order are approved.

## Capability Map

| Module id                 | Responsibility                                                                                                                      | Depends on                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ux-system-foundation      | Design tokens, layout primitives, buttons, forms, cards, focus rings, empty/loading/error/disconnected patterns                     | -                                                                            |
| desktop-shell-ia          | App shell, sidebar, top chrome, command palette, session grouping, footer navigation                                                | ux-system-foundation                                                         |
| task-workbench            | New chat, task detail, running/completed cards, transcript, inspector, composer controls                                            | ux-system-foundation, desktop-shell-ia                                       |
| needs-you-inbox           | Approvals, questions, tray popover, notification entry points, keyboard approval flow                                               | ux-system-foundation, desktop-shell-ia, task-workbench                       |
| settings-integrations     | Settings information architecture and guided flows for Providers, Local Agents, Routing, Remote Relay, Notifications, Advanced JSON | ux-system-foundation, desktop-shell-ia                                       |
| mobile-responsive-console | Phone-width layouts for New Chat, Inbox, Task Detail, Settings, Artifacts, Agents, Routines                                         | ux-system-foundation, task-workbench, needs-you-inbox, settings-integrations |
| verification-harness      | Screenshot matrix, console/network checks, keyboard/a11y checklist, visual regression fixtures or scripts                           | all UI modules                                                               |

Build order: `ux-system-foundation` -> `desktop-shell-ia` -> `task-workbench` -> `needs-you-inbox` -> `settings-integrations` -> `mobile-responsive-console` -> `verification-harness`.

## Objective

Make Kin Desktop feel like one first-party agent console rather than a collection of feature panels.

Success means a user can:

1. Start work from one obvious entry point.
2. See running work, pending decisions, costs, and artifacts without switching mental models.
3. Resolve approval/question interruptions quickly on Desktop, tray, or phone.
4. Configure providers, local agents, routing, notifications, and Relay through guided, prerequisite-aware flows.
5. Understand when Kin is disconnected, stale, or waiting without seeing false or noisy error states.

## Product Direction

Use the design handoff's denser `1a Native Pro` direction as the target density, while keeping an inspector affordance for task detail workflows:

- dark-first native macOS visual language;
- 248 px material sidebar;
- conversation-centered main surface;
- task cards embedded in the conversation, with blue for running, orange for approval, green for completion, red for failure;
- right inspector for selected task details on desktop, full-screen inspector on mobile;
- compact table/list pages only where scanning is the primary job;
- restrained light mode derived from the same semantic tokens.

The prototype is a visual grammar, not an instruction to delete shipped features. Current capabilities such as Projects, Artifacts, Routines, Local Agent sessions, workspace panels, and routing must be folded into the grammar rather than copied out of the mock as a smaller product.

## Current Evidence

Static code audit:

- `ui/src/pages/SettingsPage.tsx` is 2035 lines and mixes at least nine concerns: provider registry, local agents, theme, Cloudflare Relay, connection QR/token, notifications, price table, limit policy, routing, and agent limits.
- `ui/src/components/layout/Sidebar.tsx` is 1298 lines and owns session grouping, external session import, project archive/pin/sort, mobile drawer, and footer navigation.
- `ui/src/pages/NewChatPage.tsx` is 522 lines and exposes host agent, model, dispatch mode, routine mode, cwd, branch, project one-pager status, and composer state in one bottom control row.
- `ui/src/components/chat/DispatchSelector.tsx` contains user-visible English literals (`Dispatch`, `Auto`, `Manual`, `Show preview`, `Hide preview`, `No models listed for this provider`) outside i18n.
- Some class/token references appear incomplete or inconsistent, for example `bg-kin-surface` and `--kin-warning`, while `tailwind.config.js` defines `kin.panel`, `kin.bg`, `kin.elevated`, status colors, and legacy `surface.*` aliases.

Runtime evidence from local daemon at `127.0.0.1:7777`:

- Health endpoint returned OK.
- Screenshots captured with an isolated Chrome profile:
  - `/tmp/kin-ux-audit-shots/settings.png`
  - `/tmp/kin-ux-audit-shots/new.png`
  - `/tmp/kin-ux-audit-shots/settings-mobile.png`
- The top reconnecting banner was visible in screenshots, even though the daemon health endpoint was OK. This may be a real WebSocket reconnect issue or a timing artifact, but the UX currently makes the whole app feel degraded.
- The mobile Settings screenshot shows horizontal clipping: the `Add Provider` button is partially offscreen in the first settings card.
- Settings shows one long page with multiple save buttons and several primary actions. Users must infer which save applies to which section.
- Sidebar is dense and powerful, but the relationship between `Project`/`Agent` grouping, imported sessions, Kin tasks, and current draft is not self-evident.

Sensitive details observed from settings were intentionally omitted from this document. Relay/account URLs, room keys, tokens, and account identifiers must not be included in specs, tests, screenshots, or logs.

## Problem Inventory

### P0: Flow and safety issues

1. Settings is a junk drawer. High-risk external integrations appear beside low-risk preferences and raw JSON editors.
2. Multi-step Relay setup exposes later-step actions alongside earlier prerequisites. The user can see refresh, deploy, bind, manual URL, pairing, connection QR, and token controls in one scroll.
3. Passive Settings load still performs several reads and status refreshes. The rule is that passive views must not read secure-store secrets or call third-party APIs implicitly.
4. Reconnection UI is global and visually dominant, but not specific enough to tell whether HTTP works, WebSocket is reconnecting, Relay is degraded, or background local-agent import failed.
5. Some secrets are one click away in the same page as ordinary settings. Token reveal/copy should be isolated in a security/connection surface with explicit intent.

### P1: Information architecture issues

1. Stable product entrances from `PRINCIPLE.md` are not reflected clearly. The current nav has New Chat, Inbox, project/session tree, Artifacts, Routines, Agents, Settings, while Ask/Plan/Do/Read/Review/Routine are implicit.
2. `Agents` now includes usage, install/auth status, limits, cache, cost, smoke tests, and setup actions. It is closer to an operations console than a daily navigation item.
3. `Tasks` overlaps with sidebar sessions and task detail. It should remain a secondary scanning view, not a competing home.
4. Imported native agent sessions appear in the main sidebar, but their read-only/unlinked/external status is too subtle for a user deciding whether they can continue work.
5. Command palette and slash/mention affordances are not yet treated as first-class navigation, despite the prototype centering them.

### P1: Visual and component issues

1. Design tokens exist but are not enforced as a contract. Components still use a mix of semantic tokens, raw rgba values, legacy surface aliases, and undefined custom properties.
2. Buttons do not consistently express intent. Settings has many primary buttons; some sections have a primary save button even when the user's next action is refresh, connect, deploy, or test.
3. Cards are used for page sections, repeated items, and workflow steps without a clear hierarchy.
4. Mobile widths reveal overflow in Settings and likely other dense tables/forms.
5. Keyboard behavior exists in places, but discoverability is fragmented. Approval shortcuts have no persistent shared hint model.

### P2: Implementation maintainability issues

1. `SettingsPage.tsx` and `Sidebar.tsx` are too large to refactor safely in one pass.
2. Several workflows are implemented inline instead of as focused containers and presentational components.
3. Existing tests focus on API contracts and pure helpers more than visual/user-flow regressions.
4. There is no committed screenshot matrix or repeatable browser verification script for the shipped console.

## Target Information Architecture

### Daily shell

- Primary CTA: `New Chat` / Ask Kin.
- Needs-you entry: Inbox with approval/question count.
- Session library: grouped by Project or Agent, with explicit visual distinction among Kin tasks, native external sessions, unlinked read-only sessions, and drafts.
- Bottom utility nav:
  - Artifacts
  - Routines
  - Agents / Usage
  - Settings

### Workbench

- `NewChatPage` starts centered and sparse.
- Advanced dispatch controls collapse behind clear chips:
  - permission mode;
  - host/model;
  - dispatch profile;
  - routine mode;
  - cwd/branch.
- Each chip opens a focused popover with validation and preview. The default row must not wrap into an unreadable control strip at 390 px.
- Task detail uses the conversation plus cards as the main story. Inspector owns details, transcript metadata, usage, workspace/diff, and task controls.

### Settings

Split Settings into left-side or top tabs within the Settings page:

1. **General:** appearance, language when available, default agent, basic app behavior.
2. **Agents:** local agent detection, install/auth state, import policy.
3. **Providers:** provider registry, model list, secret write/update, provider health.
4. **Routing:** routing defaults and profiles, with preview.
5. **Remote:** connection QR, paired devices, Relay setup, trust model, manual URL.
6. **Notifications:** Bark/ntfy, base URL, test send.
7. **Advanced:** price table, limit policy, agent limits JSON, diagnostics.

Each tab must expose one primary next action at a time. Raw JSON editors belong only in Advanced or an explicit advanced disclosure.

## Key Workflow Requirements

### W1: Start a normal task

1. User opens New Chat.
2. Kin shows the current host agent and cwd in compact chips.
3. User types and sends.
4. If dispatch/profile is incomplete, the blocking reason is shown before submit.
5. The created task opens immediately with live card and transcript.

Acceptance:

- The default path needs no routing knowledge.
- Missing cwd, missing agent, and blocked dispatch have distinct messages.
- Composer controls remain readable at 390, 768, 1024, and 1440 px.

### W2: Resolve a pending approval

1. Pending approval appears in Inbox, task detail, sidebar badge, and tray when applicable.
2. The card shows action, target, agent, task context, and diff/command preview when available.
3. Keyboard shortcuts `A`/`D`, pointer controls, and touch controls are all available.
4. Decision updates the task and removes the pending state without manual refresh.

Acceptance:

- Approval is one tap on phone.
- Keyboard focus is visible and screen-reader names are meaningful.
- Deny/approve failures preserve the card and show a retryable error.

### W3: Configure a provider

1. User opens Settings -> Providers.
2. Existing providers are listed with active/disabled/health states.
3. Creating or editing a provider shows a focused form.
4. Secret field is write-only by default; reveal is an explicit action.
5. Model fetch/test is explicit and never runs on page open.

Acceptance:

- No secure-store secret read from passive page open.
- No third-party API call until Connect, Refresh, Fetch models, Deploy, Bind, or Test is clicked.
- All provider form text is i18n-backed.

### W4: Set up remote Relay

1. User opens Settings -> Remote.
2. Kin first shows current local/relay reachability and trust model.
3. If Cloudflare is not connected, the only primary action is Connect Cloudflare.
4. After connect, the only primary action is select/refresh account if needed.
5. After account is ready, the only primary action is deploy/update Worker.
6. If `workers.dev` is unreachable, Kin recommends binding a custom domain and guides zone selection.
7. Repeat deploy/update handles existing Durable Object migrations idempotently.

Acceptance:

- No multiple equally prominent Relay actions before prerequisites are satisfied.
- First-time and repeat update flows are both tested.
- The UI never claims the BYO Relay is end-to-end encrypted.

### W5: Import native local agent sessions

1. User opens Settings -> Agents.
2. Kin shows detection status and capabilities per local agent.
3. Import is explicit unless auto-import is enabled.
4. Imported sessions appear in sidebar with clear external/unlinked/read-only semantics.

Acceptance:

- Provider unavailable or unsupported states do not blank the session library.
- Auto-import policy is understandable and reversible.
- Sidebar grouping does not create duplicate-looking sessions.

## Design System Requirements

### Tokens

Use semantic tokens only in components:

```css
:root {
  --kin-bg: #1a1a1c;
  --kin-elevated: #232327;
  --kin-panel: #2c2c2e;
  --kin-sidebar: rgba(30, 30, 32, 0.84);
  --kin-text: #f5f5f7;
  --kin-secondary: #a1a1a6;
  --kin-muted: #6e6e73;
  --kin-blue: #0a84ff;
  --kin-orange: #ff9f0a;
  --kin-green: #30d158;
  --kin-red: #ff453a;
}
```

The actual implementation may keep current variable names, but every used token must be defined in `index.css` and represented in `tailwind.config.js` or a documented class.

### Component primitives

Create or consolidate reusable primitives before rewriting pages:

- `PageHeader`
- `SectionHeader`
- `SettingsLayout`
- `SettingsTab`
- `SettingsRow`
- `SegmentedControl`
- `StatusPill`
- `ActionButton`
- `IconButton`
- `FormField`
- `Disclosure`
- `Callout`
- `WorkflowStep`

Avoid putting cards inside cards. Settings tabs should be surfaces with rows, not a page full of nested decorative cards.

### Accessibility

- All icon-only buttons need accessible names.
- Menus/popovers need `aria-haspopup`, `aria-expanded`, focus return, Escape close, and outside-click behavior.
- Heading hierarchy must be stable.
- Text contrast must meet WCAG 2.1 AA.
- Status changes must use `role="status"` or an appropriate live region when they change without navigation.

## Commands

Build and verification commands for this initiative:

```bash
# UI typecheck and production build
cd ui && npm run build

# UI tests
cd ui && npm test

# API contract check if generated API changes
cd ui && npm run check:api

# Backend checks if API or settings behavior changes
go test ./internal/api/... ./internal/provider/... ./internal/remote/... ./internal/task/...

# Whole repository gate for substantial slices
make test

# Desktop rebuild after UI/daemon changes land
./scripts/desktop-rebuild.sh
```

## Project Structure

Expected locations:

```text
ui/src/components/ui/              reusable visual primitives
ui/src/components/settings/        Settings tabs and integration flows
ui/src/components/layout/          App shell, sidebar, navigation
ui/src/components/chat/            Composer and dispatch controls
ui/src/components/cards/           Task, approval, question, status cards
ui/src/pages/                      Route-level containers only
ui/src/i18n/locales/               English and Chinese strings
docs/plans/                        this spec and implementation plans
web/dist/                          regenerated only after UI source changes pass build
```

## Code Style

Prefer container/presentation separation and explicit states:

```tsx
export function ProvidersSettingsTab() {
  const providers = useProvidersSettings();

  if (providers.state === "loading") return <SettingsSkeleton />;
  if (providers.state === "error") {
    return <SettingsError message={providers.message} onRetry={providers.refresh} />;
  }

  return (
    <SettingsSection
      title={tr("settings.providers.title")}
      description={tr("settings.providers.description")}
      action={<ActionButton icon="plus">{tr("settings.providers.add")}</ActionButton>}
    >
      <ProviderList providers={providers.items} onEdit={providers.edit} />
    </SettingsSection>
  );
}
```

Do not keep large integration logic, form rendering, and page layout in one file.

## Testing Strategy

For each implementation slice:

- Add Vitest coverage for pure UI helpers and state reducers.
- Add component tests where logic is non-trivial and can run without browser-only APIs.
- Add API tests when passive Settings behavior, provider status, Relay deployment, or settings response shapes change.
- Capture screenshots at 390, 768, 1024, and 1440 px for the changed routes.
- Verify console has no app errors or warnings after the changed route loads.
- Manually verify keyboard tab order for menus, Settings tabs, composer controls, approvals, and dialogs.

Current runtime screenshot command used for this audit:

```bash
Chrome --headless --user-data-dir=/tmp/kin-ux-audit-chrome \
  --window-size=1440,900 --screenshot=/tmp/kin-ux-audit-shots/settings.png \
  http://127.0.0.1:7777/settings?token=<redacted>
```

Replace this with a committed script or Playwright-style harness during `verification-harness`.

## Boundaries

Always:

- Preserve all existing capabilities unless explicitly cut in a reviewed spec update.
- Keep English and Chinese i18n aligned.
- Keep token, room key, account id, provider API key, and local paths out of committed screenshots and docs unless redacted.
- Keep terminal Desktop-only.
- Run the relevant UI build/tests before committing UI changes.

Ask first:

- Removing a navigation item.
- Changing API response shapes.
- Moving or deleting stored settings keys.
- Adding dependencies.
- Changing Relay/OAuth scopes or Cloudflare deployment semantics.
- Committing visual screenshots as fixtures.

Never:

- Read secure-store secrets or call third-party APIs on passive page open.
- Hide failures behind generic "reconnecting" if a more precise degraded state is known.
- Replace the user-owned Relay trust model with a Kin-hosted cloud assumption.
- Introduce a generic workflow/DAG product to solve settings or task UX.
- Implement this refactor as one giant branch.

## Proposed Implementation Slices

These slices are accepted as the implementation direction. Detailed tasks are tracked in `tasks/plan.md` and `tasks/todo.md`.

1. **Foundation audit and token cleanup**
   - Define missing tokens, remove undefined token usage, add primitive components.
   - Verify `cd ui && npm run build` and visual smoke for unchanged routes.
2. **Settings IA skeleton**
   - Split Settings into tabs without changing backend behavior.
   - Move existing sections into focused components.
   - Preserve all current settings functionality.
3. **Provider and Local Agent settings**
   - Make provider and local-agent setup flows explicit, i18n-complete, and prerequisite-aware.
   - Remove passive model fetch or secret reads.
4. **Remote Relay guided flow**
   - Turn current Relay section into a stepper/wizard with one primary action.
   - Add first-time and repeat-deploy tests around current Cloudflare constraints.
5. **Workbench and shell alignment**
   - Align New Chat, task cards, sidebar, inspector, and command palette with the denser `1a` visual grammar.
   - Keep current data model and routes.
6. **Mobile responsive pass**
   - Fix Settings overflow and validate core routes at 390 px.
   - Ensure touch-sized controls and single-column task/approval cards.
7. **Verification harness**
   - Add repeatable screenshot and browser-console checks for key routes.
   - Document exact manual Desktop checks.

## Success Criteria

- Settings first viewport clearly shows what category the user is editing and no clipped controls at 390 px.
- Provider setup, Local Agent import, Routing, Relay, Notifications, and Advanced JSON are distinct surfaces.
- Relay setup exposes exactly one primary next action for each prerequisite state.
- New Chat default path is visually calm and has no overflowing control strip at 390 px.
- Inbox approvals remain one-tap on phone and keyboard-operable on Desktop.
- Sidebar distinguishes Kin tasks, external native sessions, drafts, unread terminal results, and archived projects without relying on tiny text alone.
- All changed user-visible strings are in `en.ts` and `zh.ts`.
- `cd ui && npm run build` passes.
- Screenshot matrix for changed routes has no obvious overlap, clipping, blank panels, or text overflow.
- No broad backend persistence or API migration is required for the UI-only slices.

## Decisions

1. Should `Agents` remain a top-level nav item, or should daily `Agents/Usage` split into `Agents` under Settings and `Usage` as a dashboard?  \[the latter]
2. Should Settings use left tabs like the design prototype, or top tabs to preserve more horizontal room on narrow desktop widths? \[the latter]
3. Is `1b First-party + inspector` the accepted visual direction, or should we bias toward the denser `1a Native Pro` variant? \[ idont  know what you are saying  maybe the denser]
4. For Relay, should the guided flow prefer custom domain by default in this environment, or only after a failed `workers.dev` probe? \[ only after failed workes.dev]
5. Should the screenshot harness be committed as a script in this repo, or remain manual until after the first visual refactor slice?  \[ dont know what you are talking about, whatever, you recommend]
