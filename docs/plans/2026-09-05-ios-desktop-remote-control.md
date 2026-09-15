# iOS Desktop Remote Control - Implementation Plan

**Status:** Ready for implementation
**Date:** 2026-09-05
**Audience:** Maintainers implementing the first native iOS companion
**Related:** [PRINCIPLE.zh.md](../../PRINCIPLE.zh.md) sections 5.4, 6.6-6.8, 13; [SYSTEM_DESIGN.zh.md](../../SYSTEM_DESIGN.zh.md) sections 5-6; [MVP_TECH_SPEC.md](../MVP_TECH_SPEC.md) sections 6-10; [REMOTE_ACCESS.md](../REMOTE_ACCESS.md)

## 1. Goal

Build a native iOS companion that remotely controls agent work running on the
user's Desktop Kin daemon.

The first useful loop is:

1. Start Kin on the Mac and expose it over LAN or an existing private/public
   remote-access rung.
2. Pair the iPhone by scanning the daemon's existing connection QR code.
3. Start a task against a recent directory on the Mac.
4. Watch task state and the useful parts of the transcript update live.
5. Approve or deny tool requests and answer agent questions from the phone.
6. Send guidance, cancel work, and inspect the resulting workspace changes.

This is remote **agent control**, not generic remote desktop control.

## 2. Product boundary

### In scope

- One iPhone connects directly to one user-owned Kin daemon.
- The Desktop daemon remains authoritative for tasks, events, approvals,
  questions, workspaces, agents, and projects.
- The iOS app is a native control surface built with SwiftUI.
- HTTP provides snapshots and commands. WebSocket provides invalidation/live
  updates. A reconnect always reconciles from HTTP.
- The app supports LAN, Tailscale/Headscale, Funnel, and user-provided HTTPS
  tunnel URLs without embedding a networking vendor SDK.
- English and Chinese UI ship together.

### Explicitly out of scope

- Screen sharing, mouse/keyboard control, VNC, or Apple Remote Desktop.
- Remote PTY. `/api/terminal/*` remains loopback-only by design.
- Running an agent or model locally on iPhone.
- Peer-to-peer or multi-master database synchronization.
- Editing Desktop files directly from iOS.
- Provider/API-key administration from iOS.
- Offline task creation, offline approvals, or queued offline writes.
- A Kin account, Kin-operated relay, or mandatory cloud.
- iPad-specific multi-column optimization in the first slice.
- App Store/TestFlight delivery for the first local experience build.

## 3. Locked architecture decisions

### 3.1 One authoritative daemon

```text
iPhone native app
  |  HTTPS/WSS or private LAN HTTP/WS
  |  REST snapshots + commands; WebSocket invalidations
  v
Kin daemon on Desktop
  |-- task engine and agent processes
  |-- approvals and user questions
  |-- SQLite event/task state
  |-- Git worktrees and workspace snapshots
  `-- existing Web console/Desktop shell
```

The iOS app does not maintain an independent Kin database. It may cache
read-only snapshots for fast launch, but server responses always win.

This deliberately avoids building the full Sync Layer described in
`PRINCIPLE.zh.md` section 6.6. The first client is a remote projection of one
daemon, not a second writable Kin replica.

### 3.2 WebSocket is not the source of truth

The current `/api/ws` stream has no durable global cursor. A slow subscriber
may be disconnected, and iOS suspends sockets in the background. Therefore:

- initial connection fetches HTTP snapshots;
- WebSocket messages update visible state optimistically;
- every socket reconnect and app foreground transition re-fetches tasks,
  pending approvals, and pending questions;
- an open task fetches `/events?since_seq=<last sequence>`;
- unknown message kinds and event types are ignored safely and retained as
  generic timeline entries where useful.

### 3.3 Experience authentication versus durable authentication

The first experience build uses the existing daemon bearer token:

- scan the existing `http(s)://host/?token=...` QR;
- extract the origin and token;
- persist the token in Keychain, never `UserDefaults`;
- remove the token from all displayed URLs;
- send it only in the `Authorization: Bearer` header, except the WebSocket
  handshake where the current server requires `?token=`.

This is acceptable only for a private LAN/tailnet development build. The token
currently grants access to the complete public API and is shared by every
client. Per-device credentials and revocation are required before a wider
release; see section 12.

### 3.4 Native implementation

- SwiftUI application lifecycle.
- iOS 17 minimum for a small compatibility surface.
- `URLSession` for REST and `URLSessionWebSocketTask` for live events.
- `Security` framework for Keychain storage.
- `Network` framework only for connectivity status; no vendor networking SDK.
- `AVFoundation` metadata scanner for pairing QR.
- No third-party dependencies in the first slice.
- No HTML/WebView reuse of the existing React console.

## 4. User experience

### 4.1 Information architecture

Use a three-tab `TabView`:

1. **Control** - the default screen: pending approvals/questions first, then
   active tasks.
2. **Tasks** - searchable task history and task detail.
3. **Settings** - connection, daemon version, transport/security status, and
   disconnect.

Starting work is a compose button in Control and Tasks, not a fourth tab.

### 4.2 Connection flow

When no daemon profile exists:

1. Show `Scan QR` as the primary action and manual server URL/token entry as a
   secondary path.
2. Parse the existing daemon QR payload.
3. Accept:
   - private/LAN `http://` URLs only when iOS local-network access is available;
   - any valid `https://` URL;
   - reject public, non-TLS HTTP URLs.
4. Call public `/api/health` and `/api/version`, then authenticated
   `/api/tasks?limit=1`.
5. Display the hostname and version before saving.
6. Store `{displayName, baseURL}` in app preferences and the token in Keychain.
7. Enter Control only after the authenticated probe succeeds.

Connection states are explicit: `unconfigured`, `connecting`, `connected`,
`reconnecting`, `unauthorized`, `incompatible`, and `offline`. An empty task
list must never be used as a connection signal.

### 4.3 Control screen

Order content by action urgency:

1. Pending approvals.
2. Pending user questions.
3. Tasks in `waiting_approval` or `waiting_input`.
4. Other queued/running tasks.
5. Recent terminal tasks.

Approval cards show task, requesting agent/model, tool name, command or path,
and bounded input detail. Approve and Deny are separate confirmation actions;
destructive-looking commands require a second confirmation sheet. While a
decision is in flight, both buttons are disabled. HTTP `409` means another
client already acted, so the app refreshes and reports the resolved state.

Question cards support single-select, multi-select, and free text exactly as
the existing API contract defines.

### 4.4 New task

The first slice supports:

- available agent from `GET /api/agents`;
- recent Desktop directory from `GET /api/recent-cwds`;
- prompt;
- permission mode: default, accept edits, or unrestricted;
- optional model when the selected agent advertises models.

The phone does not browse the Desktop filesystem. Free-form cwd entry is hidden
behind an advanced disclosure because path typos are hard to diagnose remotely.
`workspace_mode` defaults to `auto`.

### 4.5 Task detail

The task header shows status, agent/model, Desktop cwd, elapsed time, and cost.

The timeline renders a deliberately bounded event subset:

- user and assistant messages;
- reasoning/progress notes;
- tool calls with name and short summary;
- errors and retries;
- approval/question events;
- task/workspace terminal events.

Large tool input/output is collapsed. Unknown events render a compact generic
row instead of failing decoding. The app must not duplicate the full web
`transcriptProjection.ts` state machine in the first slice.

Available commands:

- running or waiting task: send guidance and cancel;
- terminal task: send follow-up;
- any task with a generation: inspect changed-file list;
- changed text file: inspect a simple unified/base-versus-final diff;
- retry, fork, restore, edit file, and workspace lifecycle operations are
  deferred until the core loop is stable.

### 4.6 Background behavior

For the first experience build:

- live updates are guaranteed only while the app is foregrounded;
- entering foreground performs full reconciliation;
- the app may show local notifications for events received immediately before
  suspension, but must not claim reliable background delivery;
- existing Bark/ntfy remains the supported background alert path.

Native APNs and notification deep links are a separate milestone because they
require an Apple entitlement, an APNs provider credential, server device-token
storage, and a stable externally reachable URL.

## 5. Existing API contract used by iOS

| Capability | Endpoint | First slice |
|------------|----------|-------------|
| Probe daemon | `GET /api/health`, `GET /api/version` | Required |
| Discover agents | `GET /api/agents` | Required |
| Recent Desktop roots | `GET /api/recent-cwds` | Required |
| List/create task | `GET/POST /api/tasks` | Required |
| Task snapshot | `GET /api/tasks/{id}` | Required |
| Incremental transcript | `GET /api/tasks/{id}/events?since_seq=` | Required |
| Live invalidations | `GET /api/ws` | Required |
| Guide/follow up | `POST /api/tasks/{id}/prompt` | Required |
| Cancel | `POST /api/tasks/{id}/cancel` | Required |
| Approval inbox/action | `GET /api/approvals`, `POST .../decision` | Required |
| Question inbox/action | `GET /api/user-questions`, `POST .../answer` | Required |
| Workspace generations | `GET /api/tasks/{id}/workspaces` | Stretch |
| Changed files/diff source | `GET .../diff`, `GET .../file` | Stretch |
| Projects | `GET /api/projects` | Deferred |
| Artifacts | `GET /api/artifacts` | Deferred |
| Terminal | `/api/terminal/*` | Forbidden remotely |

The implementation should model only fields needed by these screens, while
preserving forward compatibility with unknown JSON fields.

## 6. Repository layout

Create:

```text
ios/
  README.md
  Kin.xcodeproj/
  Kin/
    App/
      KinApp.swift
      AppModel.swift
      AppRoute.swift
    Configuration/
      ServerProfile.swift
      ConnectionState.swift
    Networking/
      APIClient.swift
      APIError.swift
      Endpoint.swift
      WebSocketClient.swift
      Reconciler.swift
    Security/
      KeychainStore.swift
      PairingPayload.swift
    Models/
      Agent.swift
      Task.swift
      TaskEvent.swift
      Approval.swift
      UserQuestion.swift
      Workspace.swift
      ServerMessage.swift
    Features/
      Connection/
      Control/
      Tasks/
      TaskDetail/
      NewTask/
      Settings/
    Components/
      ConnectionBanner.swift
      StatusBadge.swift
      ApprovalCard.swift
      QuestionCard.swift
      EventRow.swift
    Resources/
      Localizable.xcstrings
      Assets.xcassets/
  KinTests/
    Fixtures/
```

Keep feature views thin. `AppModel` owns navigation-level state;
`Reconciler` owns snapshot/live-event merging; `APIClient` owns transport and
JSON decoding. Do not let individual views create independent WebSockets.

## 7. State and concurrency rules

- UI-observable mutation occurs on `@MainActor`.
- `APIClient` and `WebSocketClient` are actors or otherwise serialize mutable
  transport state.
- Exactly one WebSocket exists per configured daemon.
- Every reconnect uses a monotonically increasing connection generation.
  Callbacks from older generations are discarded.
- Every list/detail load has an explicit `idle/loading/loaded/failed` state.
  Empty arrays are valid loaded results.
- Task events are keyed by `(task_id, seq)` and merged idempotently in ascending
  sequence order.
- `task_update`, `approval_update`, and `user_question_update` replace entities
  by ID; they never append duplicates.
- App foreground, WebSocket reconnect, and detected sequence gaps trigger HTTP
  reconciliation.
- User commands are never silently replayed after a timeout. The app fetches
  current state and asks the user to retry unless the result is already visible.

## 8. Detailed implementation tasks

### Task 0: Environment and project scaffold

**Files**

- Create `ios/Kin.xcodeproj`
- Create `ios/Kin/App/KinApp.swift`
- Create `ios/Kin/Resources/Localizable.xcstrings`
- Create `ios/KinTests/`
- Create `ios/README.md`

**Work**

1. Use the selected full Xcode installation. Environment verification completed
   with Xcode 26.6, Swift 6.3.3, and the iOS 26.5 SDK/Simulator Runtime.
2. Create an iOS 17 SwiftUI app with bundle ID `dev.openkin.ios`.
3. Enable camera usage text and local-network usage text.
4. Add `NSAppTransportSecurity/NSAllowsLocalNetworking = true`; do not add a
   global arbitrary-load exception.
5. Add English and Chinese string catalogs from the first commit.
6. Add a unit-test target and one launch smoke test.

**Verification**

```bash
xcodebuild -project ios/Kin.xcodeproj \
  -scheme Kin \
  -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' \
  build test
```

### Task 1: Connection profile, Keychain, and pairing

**Files**

- Add `Configuration/ServerProfile.swift`
- Add `Configuration/ConnectionState.swift`
- Add `Security/KeychainStore.swift`
- Add `Security/PairingPayload.swift`
- Add `Features/Connection/ConnectionView.swift`
- Add `Features/Connection/QRScannerView.swift`
- Add corresponding unit tests and JSON fixtures

**Work**

1. Parse the existing QR URL into normalized origin plus bearer token.
2. Reject credentials embedded in the URL outside the `token` query item.
3. Normalize away paths, query, fragments, and trailing slash from `baseURL`.
4. Enforce the HTTP/HTTPS policy from section 4.2.
5. Store metadata without secrets in `UserDefaults`; store the token under a
   stable Keychain service/account pair.
6. Probe health and authenticated access before committing the profile.
7. Support manual URL/token entry for Simulator testing.
8. Disconnect removes both metadata and Keychain secret.

**Tests**

- LAN HTTP, HTTPS tunnel, malformed URL, missing token, public HTTP rejection.
- Keychain add/read/update/delete using a test service namespace.
- A token never appears in `ServerProfile.description`, errors, or logs.

### Task 2: Typed REST client

**Files**

- Add `Networking/APIClient.swift`
- Add `Networking/APIError.swift`
- Add `Networking/Endpoint.swift`
- Add model files under `Models/`
- Add `KinTests/APIClientTests.swift`

**Work**

1. Build requests relative to the configured origin.
2. Attach bearer auth to every authenticated request.
3. Set finite request/resource timeouts.
4. Decode `{error: string}` consistently.
5. Map `401` to `unauthorized`, `409` to `conflict`, transport failures to
   `offline`, and incompatible decoding to an explicit protocol error.
6. Implement only the required endpoint matrix in section 5.
7. Use `URLProtocol` test doubles; unit tests must not require a live daemon.

**Tests**

- Correct method, path, query, body, auth header, status mapping, and decoding.
- Empty arrays decode as valid loaded state.
- Unknown response fields do not break decoding.
- Malformed required fields fail with a visible compatibility error.

### Task 3: One WebSocket and deterministic reconciliation

**Files**

- Add `Networking/WebSocketClient.swift`
- Add `Networking/Reconciler.swift`
- Add `Models/ServerMessage.swift`
- Add `KinTests/ReconcilerTests.swift`

**Work**

1. Connect to `/api/ws?token=...`, converting `http/https` to `ws/wss`.
2. Decode all five existing message kinds: task update/deleted, event,
   approval update, and user-question update.
3. Implement exponential reconnect from 1 to 15 seconds with one timer.
4. On open, app foreground, and reconnect, fetch snapshot lists in parallel.
5. For an open task, fetch events after its highest sequence.
6. Drop callbacks from stale connection generations.
7. Reconcile IDs and event sequence numbers idempotently.
8. Keep a visible reconnect banner; never present stale data as live.

**Tests**

- Duplicate and out-of-order messages.
- Socket disconnect during an in-flight snapshot.
- Old-generation callback after reconnect.
- Event gap filled by `since_seq`.
- Unknown message kind does not terminate the stream.

### Task 4: Control screen and action inbox

**Files**

- Add `Features/Control/ControlView.swift`
- Add `Features/Control/ControlViewModel.swift`
- Add `Components/ApprovalCard.swift`
- Add `Components/QuestionCard.swift`
- Add `Components/ConnectionBanner.swift`
- Add focused view-model tests

**Work**

1. Load approvals, questions, and active tasks concurrently.
2. Preserve explicit loading, loaded-empty, error, and reconnecting states.
3. Render actionable cards before informational task cards.
4. Implement approve/deny with in-flight locking and `409` reconciliation.
5. Implement single/multiple option answers plus free text.
6. Deep-link each card to its task detail.
7. Use a badge on the Control tab for total pending actions.

**Acceptance**

- A Desktop agent blocks for approval; the card appears on iPhone without
  manual refresh; one tap resolves it and the Desktop task resumes.
- A structured user question is answerable and disappears on success.
- Acting from Web and iOS concurrently produces one success and one clean
  resolved/conflict state, not duplicate UI.

### Task 5: Task list, detail, and live timeline

**Files**

- Add `Features/Tasks/TaskListView.swift`
- Add `Features/Tasks/TaskListViewModel.swift`
- Add `Features/TaskDetail/TaskDetailView.swift`
- Add `Features/TaskDetail/TaskDetailViewModel.swift`
- Add `Features/TaskDetail/EventProjection.swift`
- Add `Components/EventRow.swift`
- Add projection and view-model tests

**Work**

1. List active first, then terminal tasks by recency.
2. Support pull-to-refresh and local title/cwd search.
3. Load task and events concurrently.
4. Project the bounded event subset from section 4.5.
5. Coalesce streaming text by sequence/partial semantics without leaving a
   completed task in a fake loading state.
6. Show pending approval/question inline as well as in Control.
7. Implement Cancel and guidance/follow-up with explicit busy/error states.

**Acceptance**

- Start a task on Desktop and observe status/transcript progression on iPhone.
- Background and foreground the app; it catches up without duplicate events.
- Send guidance from iPhone while a task is active.
- Cancel from iPhone and observe the terminal state on both clients.
- Follow up on a completed task and preserve the same task/session.

### Task 6: New task from the phone

**Files**

- Add `Features/NewTask/NewTaskView.swift`
- Add `Features/NewTask/NewTaskViewModel.swift`
- Add focused tests

**Work**

1. Load available agents and recent Desktop cwd values.
2. Provide agent/model, cwd, permission, and prompt controls.
3. Default to the daemon's default agent and `workspace_mode=auto`.
4. Clearly label unrestricted permission and require confirmation.
5. Submit once, navigate to detail, and reconcile the returned task with WS.
6. Preserve the draft on transport failure.

**Acceptance**

- From iPhone, select an existing Desktop repository and start a task.
- The agent process runs on the Mac, not the phone.
- Invalid/unavailable agent and cwd failures remain visible with the draft.

### Task 7: Workspace change review

This is a stretch goal for the first experience build and required for the
first durable beta.

**Files**

- Add `Features/TaskDetail/WorkspaceChangesView.swift`
- Add `Features/TaskDetail/FileDiffView.swift`
- Extend workspace models and API client

**Work**

1. List generations and select the current/final generation.
2. Show changed files and addition/deletion counts.
3. Fetch base/final text on demand and render a bounded line diff.
4. Show binary/truncated files without attempting text rendering.
5. Keep all mutation and lifecycle controls out of this screen initially.

### Task 8: Desktop remote-access enablement

Do not block the first simulator/device build on Desktop UI changes.

**Tomorrow's runbook**

```bash
make build
./kin serve --lan
```

The packaged Desktop app should attach to that already-running daemon instead
of starting another one. Scan the printed QR in the iOS app.

**Follow-up Desktop work**

- Add a Remote Access setting with Off/LAN modes.
- Restart only a Desktop-owned sidecar when changing mode.
- Display active origin, connection QR, and a warning that LAN HTTP is visible
  to the local network but still bearer-protected.
- Preserve the existing loopback default.

No iOS implementation may weaken the loopback-only terminal or internal MCP
routes.

### Task 9: End-to-end verification and local delivery

**Automated**

```bash
go test ./internal/api ./internal/remote ./internal/task
xcodebuild -project ios/Kin.xcodeproj \
  -scheme Kin \
  -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' \
  build test
```

Use a fake agent fixture for deterministic task, approval, question, partial
message, error, and completion events. Do not require paid provider calls in CI.

**Physical-device scenario**

1. Mac and iPhone join the same LAN.
2. Start `./kin serve --lan`.
3. Pair by scanning QR.
4. Create a task against a recent Mac cwd.
5. Observe at least one progress/tool event.
6. Approve a file operation.
7. Answer one structured question.
8. Send guidance.
9. Inspect completion and, when Task 7 lands, changed files.
10. Turn Wi-Fi off/on or background/foreground the app and verify recovery.
11. Rotate the daemon token; verify the app becomes unauthorized rather than
    showing stale success.

Capture screenshots for Control, approval, task detail, offline, and empty
states at standard and large Dynamic Type.

## 9. Tomorrow experience slice

The minimum coherent build for tomorrow is Tasks 0-6 with these cuts:

- manual URL/token entry may substitute for camera scanning if physical-device
  signing or camera setup blocks progress;
- plain-text timeline is acceptable, but it must update live and handle unknown
  events safely;
- workspace diff is stretch;
- no APNs;
- no device registry;
- no persistent content cache beyond connection metadata and token;
- local install from Xcode, not TestFlight.

The experience is successful only if the phone can complete this loop:

> connect to Mac -> start task -> watch -> approve or answer -> guide/cancel ->
> see the final result.

A read-only task viewer does not meet the goal.

## 10. Verification matrix

| Area | Required cases |
|------|----------------|
| Pairing | valid LAN QR, valid HTTPS QR, bad token, unreachable host, public HTTP rejection |
| Authentication | Keychain persistence, 401 gate, token rotation, no token in logs |
| Realtime | initial snapshot, update, disconnect, reconnect, foreground catch-up, duplicate event |
| Approval | approve, deny, concurrent 409, malformed payload, destructive confirmation |
| Question | single, multiple, free text, already answered |
| Task | create, queued, running, waiting states, success, failure, cancel, follow-up |
| UI state | loading, loaded empty, error, offline, reconnecting, incompatible |
| Accessibility | VoiceOver labels, 44pt targets, Dynamic Type, contrast, Reduce Motion |
| Networking | LAN HTTP, private HTTPS tunnel, WSS reconnect, Desktop offline |
| Security | no terminal route, no provider secrets UI, no TLS bypass, no public HTTP |

## 11. Known risks

1. **Simulator development is ready, but physical-device signing is not.**
   Xcode has no Apple Development signing identity yet; add an Apple ID/team
   before installing the app on an iPhone.
2. **Desktop defaults to loopback.** Normal packaged Desktop launch is not
   reachable from iPhone until Task 8 follow-up lands; the first run uses an
   externally started `kin serve --lan`.
3. **The shared bearer has broad authority.** Treat the experience build as
   private-network software.
4. **No durable global WebSocket cursor exists.** Correctness depends on HTTP
   reconciliation after every reconnect.
5. **The event payload schema is intentionally tolerant and partly dynamic.**
   Native projection must degrade gracefully rather than duplicate every web
   renderer assumption.
6. **Background WebSocket is not reliable on iOS.** APNs is required before
   claiming timely approval notifications while the app is suspended.
7. **LAN HTTP needs local-network permission and ATS configuration.** Remote
   Internet use requires HTTPS; certificate validation must never be disabled.

## 12. Required hardening before beta

After validating the interaction loop, add:

1. Pairing endpoint that exchanges the one-time QR secret for a device-scoped
   credential.
2. Device registry with name, platform, creation/last-seen time, capabilities,
   and per-device revoke.
3. Audit attribution derived from authenticated device identity (`ios`,
   concrete device ID), replacing the current hard-coded `decided_via="web"`.
4. Least-privilege client scopes such as read, task-control, approval, and
   administration.
5. APNs device-token registration, notification provider, and task/approval
   deep links.
6. Capability/version endpoint so clients can gate features without relying on
   failed JSON decoding.
7. Bounded encrypted snapshot cache for offline reading.
8. API contract generation or shared fixtures. The repository documentation
   names OpenAPI as authoritative, but no current `api/openapi.yaml` exists;
   do not let Swift and TypeScript contracts drift silently.

## 13. Definition of done

The first native iOS remote-control release is done when:

- a physical iPhone can pair with a Desktop Kin daemon without copying secrets;
- task creation, live observation, approval, question answering, guidance,
  cancellation, and follow-up work end to end;
- reconnect and foreground reconciliation lose no durable task events;
- all destructive or authority-changing actions are explicit and audited;
- tokens stay in Keychain and out of logs/screenshots;
- terminal/internal routes remain inaccessible remotely;
- English and Chinese strings, loading/empty/error/offline states, and basic
  accessibility are complete;
- Go contract tests and iOS unit/UI tests pass;
- the physical-device LAN scenario passes twice from a clean app install.
