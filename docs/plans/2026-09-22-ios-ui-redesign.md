# iOS UI Redesign Spec

**Status:** Implementation in progress
**Date:** 2026-09-22
**Scope:** Native iOS SwiftUI companion app under `ios/`
**Primary references:** `ios/README.md`, `docs/plans/2026-09-17-ios-console-parity.md`, `docs/plans/2026-09-21-desktop-ux-refactor.md`, `kin-desktop-ui-redesign/README.md`

## Skill Stack

This redesign should use the installed agent-skills workflow already adopted by
the project:

- `spec-driven-development`: gate the redesign through a written spec before
  SwiftUI implementation.
- `frontend-ui-engineering`: apply production UI quality, accessibility,
  loading/error/empty states, and responsive layout discipline.
- `prototype` when visual direction needs comparison before implementation.
- `source-driven-development` during implementation when checking Apple Human
  Interface Guidelines or SwiftUI APIs.

No dedicated local skill named `UI Redesign`, `Andy`, or `addyosmani` was found
in this checkout. The available installed skill closest to that intent is
`frontend-ui-engineering`.

## Current iOS Feature Inventory

The iOS app is already a native remote console for one Desktop Kin daemon. It
does not run agents locally.

### Connection and Session

- Pair with a daemon by scanning a QR code.
- Enter server URL and token manually.
- Store profile metadata in `UserDefaults`.
- Store credentials in iOS Keychain.
- Support LAN HTTP, HTTPS tunnel, Tailscale/Funnel-style URLs, and Relay query
  parameters.
- Maintain explicit connection states: unconfigured, connecting, connected,
  reconnecting, offline, unauthorized, incompatible.
- Reconcile on app foreground and WebSocket reconnect.
- Manage multiple saved daemon profiles.

### Control

- Default tab for urgent work.
- Shows pending approvals.
- Shows pending user questions.
- Shows active tasks.
- Shows empty, loading, offline, unauthorized, and incompatible states.
- Starts a new task from the primary action.

### Tasks

- Search task history.
- Split task list into active and completed sections.
- Open task detail.
- Show task prompt, cwd, status, agent, model, and elapsed time.

### Task Detail

- Show status, agent/model, cwd, elapsed time, cost, and quota retry state.
- Render task event timeline.
- Collapse reasoning and tool-call rows.
- Send guidance to a running task.
- Cancel a running task.
- Retry failed/terminal tasks.
- Continue after limit waits.
- Fork a task.
- Delete a task when paired with management permissions.
- Open workspace changes for completed work.

### Approvals and Questions

- Approve or deny pending tool approvals.
- Answer single-select, multi-select, and free-text questions.
- Disable controls while requests are in flight.
- Surface decision/answer errors.

### New Task

- Choose agent from daemon-reported agents.
- Choose optional model when advertised.
- Choose recent Desktop cwd or enter one manually.
- Enter prompt.
- Choose permission mode: default, accept edits, unrestricted.
- Confirm unrestricted mode before submit.
- Create a daemon task from the phone.

### Projects

- List active projects.
- Create a project when paired with management credentials.
- View project mode, status, session counts, running/waiting counts.
- View and edit project One-Pager when authorized.
- View recent project tasks and open task detail.

### Artifacts

- List saved artifacts.
- Read artifact content.
- Archive artifacts when authorized.

### Routines

- List routines.
- Create recurring work.
- Enable/disable routines.
- Run a routine now.
- Delete routines.

### Operations

- View local agent access/auth status.
- View usage limits.
- View provider registry.
- Edit provider name, kind, base URL, model, and API key when authorized.
- Activate a provider for new tasks.
- View registered workers.

## Capability Ownership Model

The redesign must make it clear which state belongs to the phone and which
state belongs to the selected Desktop daemon. iOS is a remote control surface,
not a second Kin runtime.

### Local iOS-only Capabilities

These capabilities can work without contacting a daemon after the data is
already present on the phone:

- Saved daemon profile list and active profile selection.
- Non-sensitive connection metadata display: hostname, transport, last selected
  profile, last-accessed ordering.
- Keychain credential storage and deletion.
- QR scanner and manual pairing form state.
- UI preferences introduced by the iOS app, such as local display density or
  notification preferences, if added later.
- Cached read-only snapshots used only for launch continuity, if added later.

Local state must be visually marked as "on this iPhone" when it could be
confused with daemon state.

### Remote Desktop Projection

These views are projections of the currently selected Desktop daemon:

- Tasks and task detail.
- Events/transcript.
- Approvals and user questions.
- Projects and One-Pagers.
- Artifacts.
- Routines.
- Agents, provider registry, usage limits, workers, and daemon version.

Remote projection state must always be scoped to the active daemon profile. A
screen showing daemon data must show the active Desktop identity in either the
navigation subtitle, a connection chip, or the top status banner.

### Remote Desktop Mutations

These actions execute on the currently selected Desktop daemon and must not look
like local phone-only changes:

- Create task.
- Send guidance, cancel, retry, continue, fork, or delete task.
- Approve/deny tool requests.
- Answer user questions.
- Create/edit project or One-Pager.
- Archive artifacts.
- Create/toggle/run/delete routines.
- Edit or activate providers.

Mutation controls should use daemon-scoped copy such as "Run on MacBook Pro" or
a visible active-profile chip near the action when ambiguity is possible. If the
selected daemon changes while a sheet is open, the sheet must either rebind
explicitly to the new daemon after confirmation or close with a stale-context
notice.

### Reconciliation and Sync

"Sync" in the iOS app means reconciliation with the active Desktop daemon, not
multi-master replication.

- HTTP snapshots are authoritative after app launch, foreground, reconnect, and
  profile switch.
- WebSocket events are live invalidations/updates for the active daemon only.
- There is no cross-daemon merge of tasks, projects, artifacts, routines, or
  provider settings.
- Offline writes are not queued in the first redesign.
- If the active daemon is offline, iOS may show the last known metadata only if
  it is clearly labeled as stale/read-only.

## Multi-Desktop Model

The existing app already stores multiple `ServerProfile` records and activates
one profile at a time. The redesign should make this a first-class concept.

### Product Rule

At any moment, the app has exactly one active Desktop daemon. All remote data
and write actions belong to that active daemon.

### UX Requirements

- Show an active Desktop switcher in Today and Settings. The compact form can be
  a hostname/device pill.
- Profile switch must stop the old WebSocket, clear visible daemon-scoped state,
  load the new profile credential, fetch fresh snapshots, then start the new
  WebSocket.
- Lists must not blend data from multiple desktops. A task from "Work Mac" and
  a task from "Home Mac" should never appear in one combined list unless a
  future cross-device aggregator is explicitly designed.
- Pending approvals/questions must be scoped by daemon. If another saved
  Desktop has pending work, show it as a profile-level badge or switcher row,
  not as actionable cards inside the current daemon's Today view.
- Mutating a remote item requires that the item still belongs to the active
  daemon. Stale detail screens opened before a profile switch should disable
  actions and offer to return to the relevant profile.
- Deleting a profile removes only the iPhone's saved profile and Keychain
  credential. It must not revoke device credentials on the daemon unless a
  separate explicit remote revoke action exists.

### Future Non-Goal

A cross-Desktop dashboard may be useful later, but it is out of scope for this
redesign. Building it correctly requires daemon identity in every cached object,
cross-profile notification semantics, and conflict-free routing for mutations.

## Current UX Problems

1. The app exposes many daemon capabilities, but the information architecture
   still feels like a set of plain admin lists.
2. The first tab mixes inbox, status, active work, and new-task entry without a
   strong mobile hierarchy.
3. Task detail is functional but transcript, metadata, approvals, guidance, and
   workspace changes compete for the same vertical space.
4. Settings is doing too much: connection, devices, console links, daemon
   status, workers, about, providers, agents, usage, and routines are scattered.
5. Several user-visible strings are hardcoded English instead of
   `Localizable.xcstrings`.
6. The iOS app does not yet share a coherent design grammar with the Desktop
   redesign: task cards, status colors, inspector-like detail panels, and
   "needs you" urgency are not consistently expressed.
7. There is no physical-device visual regression checklist for narrow iPhones,
   Dynamic Type, dark/light mode, or one-handed usage.
8. The current UI does not consistently distinguish local iPhone profile state
   from active-daemon data and active-daemon mutations.
9. Multi-Desktop profile switching exists technically, but the current UI does
   not make daemon scope visible enough before remote actions.

## Assumptions

1. The iOS app should remain native SwiftUI, not a WebView wrapper around the
   React console.
2. Desktop Kin remains the source of truth for tasks, events, approvals,
   questions, projects, artifacts, routines, providers, workers, and usage.
3. The redesign should not add backend APIs in the first pass.
4. The visual language should adapt the Desktop redesign's "Native Pro" density
   to iPhone, not copy the desktop sidebar/inspector literally.
5. Phone usage is interruption-driven: approve, answer, check status, send a
   short instruction, read an artifact, or start a simple task.
6. Provider and routine administration remain available, but should not dominate
   the daily mobile surface.
7. Multi-Desktop support means one active daemon at a time, not merged
   cross-daemon state.

## Target Product Shape

### Primary Navigation

Keep a bottom `TabView`, but revise the mental model:

- **Today:** connection status, urgent approvals/questions, active work, and a
  compact "start task" entry for the active Desktop.
- **Work:** searchable task history, running/completed filters, and task detail.
- **Projects:** project One-Pagers, project pulse, and project tasks.
- **Library:** artifacts and saved outputs.
- **Settings:** connection, devices, operations, providers, routines, and about.

Routines, Providers, Agents/Usage, and Workers should remain reachable from
Settings or Operations rather than competing with the daily tabs unless usage
data shows they are top-level mobile workflows.

### Today Screen

The first screen should answer:

1. Is my daemon reachable?
2. Does Kin need me?
3. What is currently running?
4. What is the safest next action?

Required structure:

- Compact active-Desktop banner pinned near the top, including connection state
  and a switcher affordance when multiple profiles exist.
- "Needs You" section first, merging approvals and questions.
- Running work cards next, with visible agent, cwd/project, elapsed time, and
  latest meaningful event.
- Quiet empty state when nothing needs attention.
- Primary floating or toolbar action for new task.
- If non-active saved Desktops have stale/pending summaries in a future cache,
  show them only as switcher badges, not inline actions.

### Task Detail

Task detail should become the mobile equivalent of the desktop workbench:

- Sticky task summary with status, agent/model, cwd/project, elapsed/cost.
- Transcript as the main scroll surface.
- Tool calls and reasoning collapsed by default.
- Inline approval/question cards in context when relevant.
- Bottom composer for guidance while running.
- Terminal task action tray for retry, fork, changes, delete.
- Workspace changes and file diff presented as drill-down sheets.

### New Task

New task should optimize the default path:

- Prompt is first and visually dominant.
- Agent/model, cwd, permission, and workspace mode are compact chips.
- Cwd manual entry remains advanced.
- Unrestricted permission uses a clear destructive confirmation.
- Submit remains one obvious primary action.

### Projects and Library

Projects and Artifacts should be read-first on iPhone:

- Project rows show name, mode, soft progress, and live counts.
- Project detail prioritizes One-Pager reading and "continue focus".
- Artifact list supports scan-friendly metadata and search later.
- Artifact detail uses a readable document view, not plain unstyled text.

### Settings and Operations

Settings should be reorganized into grouped destinations:

- Connection: active profile, pairing, reconnect, disconnect, devices.
- Remote: Relay/workers and transport status.
- Agents: local agent auth/status and usage limits.
- Providers: provider registry and explicit secret writes.
- Routines: recurring work configuration.
- About: app and daemon versions.

Passive Settings load must not read secrets or call third-party provider APIs.
Secret changes, provider tests, relay refreshes, and deploy actions must remain
explicit user actions.

### Profile Switcher

The profile switcher is the boundary between iOS-local control and remote
daemon scope:

- Shows saved profiles with display name, origin, transport, credential scope,
  last accessed time, and current connection state when known.
- Selecting a profile changes the active daemon before showing remote data.
- Adding a profile opens the QR/manual pairing flow.
- Removing a profile is labeled as removing it from this iPhone.
- Management-only affordances should show why they are disabled when the active
  profile has a device credential instead of a master credential.

## Visual Direction

- Use Apple-native SwiftUI surfaces: `NavigationStack`, `List`, `Form`, sheets,
  toolbars, materials, semantic colors, and system symbols.
- Keep the feel quiet, dense, and work-focused. Avoid marketing-style hero
  sections, decorative gradients, and oversized cards.
- Adopt Desktop redesign semantics:
  - blue: running/current work;
  - orange: approval or user action required;
  - green: completed/safe;
  - red: failed/destructive;
  - gray: quiet/archived/disconnected detail.
- Use cards only for repeated work items, approvals/questions, and focused
  action surfaces.
- Avoid nested cards.
- Support dark and light mode without raw one-off colors.
- Respect Dynamic Type and one-handed operation on 390 px wide devices.

## Implementation Plan

Implementation should be sliced, not done as a big-bang rewrite.

1. **Design foundation**
   - Create shared iOS view primitives for screen section headers, status chips,
     task cards, metadata rows, empty states, and action bars.
   - Move hardcoded repeated display logic into small helpers.
   - Add localization keys for all visible text touched in the slice.

2. **Today screen**
   - Redesign `ControlView` around connection, Needs You, running work, and
     primary new-task action.
   - Merge approvals/questions into a single urgency section while preserving
     their existing cards and API calls.
   - Add an active-Desktop identity chip and profile switcher entry point.

3. **Task workbench**
   - Redesign `TaskDetailView` header, transcript rows, collapsible tool rows,
     guidance composer, and terminal action tray.
   - Keep existing polling/reconciliation behavior.

4. **New task**
   - Replace the form-heavy layout with prompt-first composition and compact
     configuration chips.
   - Preserve current agent/model/cwd/permission behavior.

5. **Projects and Library**
   - Improve project and artifact list/detail readability.
   - Keep write actions gated by `canManageDaemon`.

6. **Settings and Operations**
   - Split Settings into navigation destinations for Connection, Remote,
     Agents, Providers, Routines, and About.
   - Keep secret and third-party API actions explicit.
   - Make multi-Desktop profile management explicit and separated from daemon
     operations.

7. **Verification**
   - Simulator unit tests for formatting/projection helpers.
   - Simulator build and tests.
   - Generic iOS device build with signing disabled.
   - Manual real-device pass for QR pairing, Relay pairing, approval, question,
     task creation, guidance, task detail, workspace changes, provider edit, and
     Dynamic Type.

## Commands

```bash
xcodebuild -project ios/Kin.xcodeproj -scheme Kin \
  -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' test

xcodebuild -project ios/Kin.xcodeproj -scheme Kin \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO build
```

When adding/removing Swift files:

```bash
cd ios
xcodegen generate
```

## Boundaries

- Always: keep iOS native SwiftUI; preserve daemon API contracts; use Keychain
  for credentials; update English and Chinese localization together; preserve
  accessibility labels for icon-only actions; scope every remote read/write to
  the active daemon profile.
- Ask first: adding dependencies, changing backend API shapes, changing pairing
  security model, adding persistent caches, changing top-level tab count after
  this spec is approved, adding cross-daemon aggregation.
- Never: store tokens in `UserDefaults`, log credentials, call provider APIs or
  read secrets on passive Settings load, remove existing task/approval/question
  capabilities during visual cleanup, mix data from different daemon profiles
  in one actionable list.

## Success Criteria

- A fresh user can pair, understand connection state, and start a task from
  iPhone without reading documentation.
- The active Desktop daemon is visible before every ambiguous remote action.
- Switching Desktop profiles clears stale daemon-scoped state and reconciles
  from the new daemon before actions are enabled.
- A returning user can resolve approvals/questions in one or two taps.
- A running task is understandable from the Today screen and deeper task detail.
- Existing capabilities remain available after the redesign.
- All touched UI strings use `Localizable.xcstrings` in English and Chinese.
- The simulator test suite and generic iOS build pass.
- A real-device checklist covers QR pairing, Relay, task creation, approval,
  question answer, guidance, retry/fork, artifact reading, and Dynamic Type.

## Implementation Log

### 2026-09-22 Slice 1: Today and Active Desktop Scope

- Renamed the first tab to Today while preserving the existing `control` route.
- Reworked the connected Control screen into a mobile dashboard with active
  Desktop scope, summary counters, Needs You, Running Work, loading, error, and
  empty states.
- Added an active Desktop switcher in Today and clarified Settings profile rows
  as profiles saved on this iPhone.
- Made profile switch clear daemon-scoped task, approval, and question snapshots
  immediately before reconciling from the selected daemon.
- Added `ServerProfile` presentation helpers and regression tests for transport
  classification, display-name fallback, and profile-switch snapshot clearing.
- Verified with:
  `xcodebuild -project ios/Kin.xcodeproj -scheme Kin -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' test`

### 2026-09-22 Slice 2: Task Workbench Scope

- Reworked Work task history rows and task detail into active Desktop-scoped
  surfaces with clearer task summaries, stale profile protection, and richer
  terminal actions.
- Kept task polling and fork/delete/retry/guidance behavior scoped to the active
  daemon client.
- Added task presentation tests for search, status semantics, elapsed/cost
  formatting, and stale profile detection.
- Verified with:
  `xcodebuild -project ios/Kin.xcodeproj -scheme Kin -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' test`

### 2026-09-22 Slice 3: New Task Composer

- Replaced the form-heavy New Task sheet with a prompt-first composer, active
  Desktop target card, compact configuration chips, and bottom primary action.
- Removed stored-credential fallback from `NewTaskViewModel`; the composer now
  uses only the `AppSession`-scoped API client and disables submit if the active
  Desktop changes while the sheet is open.
- Preserved agent/model/cwd/permission behavior, including the destructive
  unrestricted confirmation, and surfaced workspace mode as a read-only default
  chip.
- Added regression tests for profile-scoped submit eligibility, client
  requirement, profile-switch option clearing, in-flight submit invalidation,
  and trimmed task draft payloads.
- Verified with:
  `xcodebuild -project ios/Kin.xcodeproj -scheme Kin -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' test`
  `xcodebuild -project ios/Kin.xcodeproj -scheme Kin -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`

## Open Questions

1. Should `Routines` stay inside Settings/Operations, or become a top-level tab
   for the first redesign release?
2. Should iOS include a Desktop-style "Inbox" tab, or is "Today" with a Needs
   You section enough?
3. Should provider editing remain in iOS, or should iOS show provider status
   only unless paired with the master credential?
4. Should we prototype 2-3 Today/Task Detail visual directions before writing
   production SwiftUI?
5. Should the first redesign show badges for non-active Desktops based only on
   last-known cached state, or avoid any non-active daemon summary until a
   dedicated cross-Desktop design exists?
