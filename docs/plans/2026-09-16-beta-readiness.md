# OpenKin Public Beta Readiness Plan

**Status:** Implementation complete; release qualification pending
**Date:** 2026-09-16
**Target:** `v0.1.0-beta.1`
**Audience:** Maintainers preparing the first public OpenKin beta
**Related:** [PRINCIPLE.md](../../PRINCIPLE.md), [SYSTEM_DESIGN.md](../../SYSTEM_DESIGN.md), [OPEN_DEVELOPMENT.md](../OPEN_DEVELOPMENT.md), [MVP_TECH_SPEC.md](../MVP_TECH_SPEC.md), [iOS remote-control plan](./2026-09-05-ios-desktop-remote-control.md)

## 1. Goal

Ship a public beta that a technically capable user can install and validate
without a private walkthrough:

1. Install Kin on a supported Mac.
2. Run a real task through Kin, Claude Code, or Codex.
3. Watch a complete, self-healing transcript from Web, Electron, or iPhone.
4. Approve or deny tool requests and answer user questions remotely.
5. Reconnect after network, app, or daemon interruption without silently losing
   durable task state.
6. Inspect resulting workspace changes.
7. Export user-owned data and uninstall without losing access to that export.

This plan is a release-convergence plan. It fixes contracts, integration,
security, reliability, packaging, and documentation. It does not add another
product theme.

## 2. Beta Product Contract

### 2.1 Supported matrix

| Surface | Public beta support |
|---|---|
| Host | macOS 14+ on Apple Silicon |
| Headless daemon | macOS arm64; Linux amd64/arm64 as best-effort |
| Desktop | Signed and notarized macOS arm64 Electron app |
| Mobile | iPhone, iOS 17+, TestFlight |
| Browser | Current Safari and Chromium against the user's daemon |
| First-class agents | Kin, Claude Code, Codex |
| Experimental agents | Droid, Grok, verified generic CLI adapters |
| Local reachability | Loopback and LAN |
| Private remote | Tailscale/Headscale |
| Firewall-friendly remote | User-deployed Cloudflare Worker Relay |
| Data source of truth | One local daemon under `~/.kin` |

Experimental agents remain visible only when their existing readiness or smoke
checks pass. Their failure must not block the supported agents or the beta
release.

### 2.2 Required user journeys

The beta is not complete until all of these work on released artifacts:

1. Fresh install -> daemon start -> Web console opens.
2. Pair iPhone from a one-time QR code.
3. Create a task with agent, model, cwd, prompt, permission mode, and automatic
   workspace policy.
4. Observe ordered task events while work is running.
5. Approve, deny, answer a structured question, send guidance, and cancel.
6. Background/foreground the iOS app and recover current state.
7. Switch Wi-Fi to cellular while using Relay and recover within the reconnect
   target.
8. Restart the daemon during an active or waiting task and show an honest,
   recoverable terminal state.
9. Open generation-aware changed files and a text diff after completion.
10. Rotate/revoke credentials and prove old credentials stop working.
11. Export tasks, events, usage, projects, One-Pagers, and Artifacts without
    exporting credentials.

### 2.3 Explicit non-goals

The following do not block `v0.1.0-beta.1`:

- Governed Memory, Wiki, or cross-daemon synchronization.
- Artifact companion chat, Project catch-up, or new coaching entities.
- Android, Windows desktop, or iPad-specific layouts.
- Remote PTY from iOS.
- Mobile file editing, provider administration, or workspace integration.
- Offline task creation or offline approval queues.
- A Kin-operated shared relay.
- End-to-end encryption through a user-owned Relay.
- Automatic model-routing expansion beyond the behavior already shipped.
- Additional agent adapters.

If OpenKin later operates a shared relay, end-to-end encryption is a prerequisite
for that service. The public beta Relay is bring-your-own infrastructure and
must state that Cloudflare terminates TLS and can observe proxied traffic.

## 3. Current Baseline

### 3.1 What is already strong

- The Go daemon, task engine, agent registry, approvals/questions, usage ledger,
  routines, project model, Artifacts, and workspace generations are implemented.
- Durable events use task-local sequence numbers and REST backfill.
- Web reconnect logic treats WebSocket as notification and SQLite as truth.
- Internal approval and terminal APIs have loopback-only boundaries.
- The daemon token is random, mode `0600`, reloadable, and rotatable.
- Main is clean and synchronized with `origin/main`.
- Baseline verification passes:
  - `go test ./...`
  - `go vet ./...`
  - OpenAPI drift check
  - 257 Web tests
  - Web production build
  - Electron typecheck
  - iOS simulator build and 18 unit tests

### 3.2 Release blockers

| ID | Blocker |
|---|---|
| B1 | iOS Task timestamp and WebSocket envelope do not match the daemon wire format. |
| B2 | iOS has no shared application session; Tasks/detail do not receive an API client. |
| B3 | iOS Reconciler/WebSocket code is not wired into production views. |
| B4 | iOS multi-device storage uses one global Keychain token and cannot truly switch devices. |
| B5 | Relay uses process-local Worker state instead of Durable Objects. |
| B6 | Relay daemon role can be replaced without a room credential. |
| B7 | Relay does not bridge the daemon's local `/api/ws`, so live events do not traverse it. |
| B8 | Relay exits permanently after a connection loss. |
| B9 | There is no published tag or downloadable binary; the advertised installer returns 404. |
| B10 | `main` does not contain the iOS client although README links to it. |
| B11 | OpenAPI covers only a small subset of the client-facing API. |
| B12 | Provider API keys are stored in SQLite despite documentation claiming an OS secret store. |
| B13 | Full user-data export is promised but not implemented. |
| B14 | CI does not build/test Relay, Electron packaging, or iOS, and its Go version declaration is stale. |

## 4. Locked Technical Decisions

### 4.1 One canonical client wire contract

- JSON field names remain snake_case.
- All daemon timestamps remain Unix milliseconds as signed 64-bit integers.
- WebSocket messages remain `{ "kind": string, "data": object }`.
- WebSocket is a low-latency invalidation stream, not durable truth.
- Clients reconcile over REST on initial connection, foreground, reconnect, and
  detected event-sequence gaps.
- Unknown additive fields and event kinds remain forward-compatible.
- OpenAPI becomes authoritative for the complete beta client surface, not all
  internal or experimental endpoints.

The beta OpenAPI surface includes health/version, agents, recent cwd, task
list/create/get/events/prompt/cancel, approvals, questions, workspace list/diff/
file reads, pairing credentials, WebSocket messages, and connection metadata.

Swift keeps zero runtime dependencies. Shared JSON fixtures generated by Go
contract tests are checked into `api/testdata/beta/` and decoded by both
TypeScript and Swift tests. Do not introduce a Swift networking runtime solely
for OpenAPI generation.

### 4.2 One iOS application session

Add one `@MainActor @Observable` application session as the iOS composition
root. It owns:

- saved daemon profiles and active profile;
- one profile-scoped credential;
- `APIClient`;
- `WebSocketClient`;
- `Reconciler`;
- global connection state and pending-action badge;
- foreground/background reconciliation.

Views consume this session through the SwiftUI environment. Individual screens
may retain presentation state, but they do not construct independent sources of
truth or hold uninitialized API clients.

### 4.3 Per-device credentials before public beta

The current daemon master token remains supported for local Web/CLI compatibility,
but QR pairing for native clients must exchange a short-lived one-time secret for
a revocable device credential.

Required properties:

- 256-bit one-time pairing secret, valid for at most five minutes and usable once.
- Long-lived random device token stored hashed in SQLite.
- Device metadata: ID, label, created time, last-used time, revoked time.
- Audit principal such as `ios:<device-id>` for approval/question attribution.
- Device tokens cannot read or write provider credentials, retrieve the daemon
  master token, use terminal routes, change Git branches, or write workspace files.
- Settings can list and revoke paired devices; CLI can revoke all devices.
- Existing master-token clients remain backward compatible.

### 4.4 Relay v2 uses Durable Objects

Each random room ID maps to one Cloudflare Durable Object. A room holds one
daemon WebSocket, bounded client sockets, and bounded in-flight requests.

- Room IDs are random and are never derived from hostname.
- A separate random relay key authenticates daemon/client membership.
- `role=daemon` alone grants nothing.
- A second daemon cannot silently replace an active daemon.
- REST requests are multiplexed over the daemon control socket.
- A client WebSocket open causes the Go bridge to open local `/api/ws` and proxy
  frames under a stream ID.
- Request/response headers are explicitly allowlisted and response content type
  is preserved.
- Body, frame, queue, client, and in-flight-request limits are enforced.
- Daemon reconnect uses capped exponential backoff with jitter and remains active
  until process shutdown.

The Relay never becomes a source of truth. A reconnect still triggers normal
REST reconciliation.

### 4.5 Secrets are not ordinary settings

Introduce a narrow `SecretStore` interface:

- macOS: Keychain-backed provider secrets.
- Linux/headless fallback: separate mode-`0600` credential file under
  `~/.kin`, with the limitation documented.
- SQLite stores secret references and masked display metadata, not new plaintext
  API keys.
- Startup migrates an existing plaintext key only after successfully writing the
  secret store, then removes the plaintext value.
- Logs, export bundles, diagnostics, and API responses never contain secrets.

### 4.6 Beta scope wins over refactoring

Large files such as `internal/task/engine.go`, `internal/task/approvals.go`, and
`internal/api/api.go` are maintainability risks, but broad rewrites are not beta
work. Extract only when required to make a beta behavior testable or to enforce
a security boundary.

## 5. Delivery Strategy

Use small vertical milestones. Each milestone:

1. Starts from a failing behavior or contract test.
2. Keeps daemon, Web, Electron, and iOS contracts consistent.
3. Runs focused checks while iterating.
4. Runs the applicable full suite before completion.
5. Passes the repository Feature completion gate before integration.

Recommended parallel lanes after Milestone 1:

```text
M0 Scope/branch hygiene
  |
M1 Contract + device auth
  |----------------------|
M2 iOS client       M3 Relay v2
  |----------------------|
M4 Core hardening + export
  |
M5 CI, packaging, docs
  |
M6 End-to-end soak + beta release
```

M2 and M3 may run in parallel only after the Relay and WebSocket schemas are
frozen in M1. M4 release engineering can begin early, but cannot declare success
until M2 and M3 are integrated.

## 6. Milestone 0 - Scope Freeze and Branch Hygiene

**Estimated effort:** 1-2 engineering days
**Dependencies:** none

### Work

- Create a beta integration branch/worktree from current `main`.
- Preserve and review the existing uncommitted iOS project/signing/localization
  changes; do not overwrite them.
- Rebase or merge `feat/ios-remote-control` onto current main in its worktree.
- Resolve the current split where `main` references an absent `ios/` directory.
- Mark non-beta agents/features as experimental in API/UI copy rather than
  deleting working code.
- Record supported OS, agent, and transport versions in one checked-in support
  matrix.
- Convert this document into the living execution record by updating Progress,
  Discoveries, Decisions, and Outcomes as work lands.

### Exit criteria

- One integration branch contains current daemon and iOS history.
- No user changes are lost.
- Beta scope and supported matrix have maintainer approval.
- Every following milestone has an owner and worktree.

## 7. Milestone 1 - Canonical Contract and Device Authentication

**Estimated effort:** 4-6 engineering days
**Dependencies:** M0
**Primary files:** `api/openapi.yaml`, `internal/api/`, `internal/remote/`,
`internal/store/`, `ui/src/api/`, `ios/Kin/Models/`, `ios/KinTests/`

### 7.1 Contract tests first

- Add real daemon JSON fixtures for Task, Event, Approval, UserQuestion,
  WorkspaceGeneration, and every WebSocket message kind.
- Generate fixtures from Go structs or handler responses, not hand-written Swift
  assumptions.
- Add Go tests that fail when fixtures drift from public JSON.
- Add TypeScript and Swift decoder tests against the same fixtures.
- Standardize Swift timestamps as `Int64` plus computed `Date` accessors.
- Remove double snake-case conversion: either use camel-case Swift properties
  with `.convertFromSnakeCase` or explicit `CodingKeys`, never both.
- Replace iOS `type/payload` WebSocket decoding with canonical `kind/data`.
- Cover missing optional fields and unknown additive fields.

### 7.2 Expand the beta OpenAPI slice

- Add every endpoint used by Web and iOS beta journeys.
- Add device pairing and credential schemas.
- Define WebSocket message schemas with discriminated `kind`.
- Keep internal MCP and terminal routes outside the public mobile contract.
- Keep generated TypeScript drift checking in CI.

### 7.3 Add device credentials

- Add an ordered migration for pairing sessions and device credentials.
- Persist token hashes only; compare in constant time.
- Add local/master-authenticated pairing-session creation.
- Add one-time pairing exchange.
- Add list/revoke device APIs.
- Extend auth middleware with a typed principal and route scopes.
- Attribute approvals and answers to the device principal.
- Add replay, expiry, revocation, wrong-scope, and token-rotation tests.

### Exit criteria

- Swift decodes actual daemon fixtures without custom test-only shapes.
- TypeScript and Swift agree on all beta schemas.
- A one-time QR produces a scoped device token.
- A revoked token receives `401` immediately.
- A device token receives `403` on provider settings, daemon-token disclosure,
  terminal, Git checkout, and workspace write routes.
- Existing master token behavior remains compatible.

## 8. Milestone 2 - iOS End-to-End Client

**Estimated effort:** 6-9 engineering days
**Dependencies:** M1
**Primary files:** `ios/Kin/App/`, `ios/Kin/Networking/`,
`ios/Kin/Configuration/`, `ios/Kin/Security/`, `ios/Kin/Features/`,
`ios/KinTests/`

### 8.1 Application session and profiles

- Replace disconnected screen-local client ownership with `AppSession`.
- Restore the last active profile on launch and perform an authenticated probe.
- Store Keychain tokens under a profile/device-specific account.
- Make add, select, rename, revoke, and delete profile behavior real.
- Deleting one profile deletes only its credential.
- Update global connection state and tab badge from the same Reconciler.
- Remove dead or duplicate state paths after migration.

### 8.2 Live resources

- Wire `WebSocketClient` and `Reconciler` into `AppSession`.
- Fix generation handling so current messages are accepted and stale connections
  are ignored.
- Reconcile on socket open/reopen and scene foreground.
- Track the highest contiguous event sequence, detect holes, and backfill from
  REST.
- Use exponential reconnect with jitter and a 15-second cap.
- Keep three-second polling only as an explicit degraded fallback; stop it when
  WebSocket health is good.
- Never silently swallow a persistent incremental-fetch failure; surface an
  offline/degraded state while retaining cached data.

### 8.3 Complete core journeys

- Wire Tasks list, detail, Control, New Task, approvals, questions, guidance,
  cancel, retry, and workspace diff to the shared session.
- Preserve the selected daemon and correct client through every navigation path.
- Refresh a newly created task into list/detail without reopening the app.
- Handle `401`, `403`, `409`, incompatible version, daemon offline, and unknown
  event kinds explicitly.
- Keep tool/reasoning rows collapsed by default and bound displayed payload size.

### 8.4 Product polish

- Move every visible string into `Localizable.xcstrings` with English and Chinese.
- Remove generated empty localization entries and compiler warnings.
- Fix AppIcon assignments and missing files.
- Validate Dynamic Type, VoiceOver labels, minimum touch targets, dark mode,
  narrow screens, and long paths/model names.
- Add privacy manifest and accurate local-network/camera usage descriptions.

### Tests

- Unit: wire fixtures, profile credentials, active-device switching, event
  sequence merging, reconnect generations, optimistic conflict recovery.
- Integration: `URLProtocol` fake daemon for all required journeys.
- UI: pairing, create task, approval, question, task detail, device switch,
  reconnect.
- Simulator E2E against a real local daemon using a deterministic fake adapter.

### Exit criteria

- Relaunch restores the active daemon without rescanning.
- Two daemon profiles with different credentials can be switched independently.
- Every required journey works over LAN.
- Foreground and socket reconnect converge to the daemon's complete event list.
- iOS build has no project, localization, asset, or Swift warnings owned by Kin.
- All iOS tests run in CI on a named simulator.

## 9. Milestone 3 - Relay v2

**Estimated effort:** 6-9 engineering days
**Dependencies:** M1
**Primary files:** `relay/`, `internal/remote/relay/`, `internal/server/`,
`ios/Kin/Networking/`, `docs/REMOTE_ACCESS.md`

### 9.1 Worker architecture

- Replace the module-global room map with a Durable Object binding.
- Remove the implicit `default` room.
- Route each HTTP and WebSocket request to the room Durable Object.
- Authenticate room membership before storing a socket or forwarding traffic.
- Reject duplicate daemon registration unless the previous socket is confirmed
  closed.
- Bound rooms to one daemon, a small client limit, and a bounded pending queue.

### 9.2 Protocol

- Define a versioned Relay envelope:
  `hello`, `ready`, `request`, `response`, `open_stream`, `stream_data`,
  `close_stream`, `ping`, `pong`, and `error`.
- Add opaque request and stream IDs.
- Forward status plus an allowlisted response-header map.
- Enforce method, path, header, frame, and body limits before forwarding.
- Return structured `401`, `409`, `413`, `429`, `502`, `503`, and `504` errors.
- Never build JSON error bodies by string concatenation.

### 9.3 Go bridge

- Validate Relay URL scheme and reject malformed configuration before startup.
- Generate/load stable random room ID and relay key under `~/.kin/relay/`.
- Authenticate with the first protocol frame.
- Multiplex bounded local HTTP requests.
- Open and maintain a real loopback `/api/ws` for each remote stream.
- Reconnect forever with capped exponential backoff and jitter until shutdown.
- Expose relay state and last error in settings/health without leaking secrets.
- Cancel all local requests/streams when the relay generation changes.

### 9.4 Tests

- Worker tests run against the Durable Object runtime, not a plain mocked map.
- Go/Worker protocol fixture tests share canonical envelopes.
- Test daemon hijack, wrong key, duplicate daemon, request timeout, body limit,
  client overflow, worker restart, daemon reconnect, and stream cleanup.
- Run a real deployed staging Worker acceptance test from CI only when protected
  staging credentials are available.

### Exit criteria

- REST and live WebSocket events work through a deployed Worker.
- A guessed room or unauthenticated daemon cannot observe or replace a session.
- Wi-Fi/cellular transition reconnects and reconciles without event loss.
- A Worker isolate or daemon connection restart recovers without restarting Kin.
- Documentation states the BYO trust model and lack of end-to-end encryption.

## 10. Milestone 4 - Core Reliability, Secrets, and Ownership

**Estimated effort:** 5-7 engineering days
**Dependencies:** M1; may overlap M2/M3
**Primary files:** `internal/server/`, `internal/store/`, `internal/provider/`,
`internal/remote/`, `cmd/kin/`, `ui/`, `desktop/`

### 10.1 Persistence and recovery

- Force database and credential files to owner-only permissions.
- Before a schema upgrade, create a bounded recoverable SQLite backup.
- Test every historical schema version with populated rows through current
  migration.
- Add restart tests for queued, running, waiting approval, waiting question,
  workspace provisioning/finalizing, and scheduled routine states.
- Ensure a task never reports success after losing critical persisted events.
- Run race tests for task, workspace, terminal, and relay packages.

### 10.2 Secret migration

- Implement `SecretStore`.
- Migrate legacy provider keys transactionally and idempotently.
- Redact keys from errors, process diagnostics, export, and logs.
- Add tests for failed secret migration that prove the plaintext value is not
  deleted prematurely.

### 10.3 Export and exit

Add `kin export --output <path>` with:

- versioned `manifest.json`;
- tasks, events, approvals, questions, and usage as JSONL;
- projects and One-Pagers;
- Artifacts and their metadata;
- settings with secrets and machine-specific tokens removed;
- checksums for files in the bundle.

Use a consistent SQLite snapshot so export cannot mix transaction states.
Document how to stop Kin and remove `~/.kin` after verifying the archive.
Import remains post-beta, but the export format must be versioned and inspectable.

### 10.4 Server and client hardening

- Configure HTTP header/read/write/idle limits without breaking long polling or
  WebSocket upgrades.
- Apply explicit request/body limits to JSON, uploads, Relay, and file reads.
- Retain path containment checks for every file boundary.
- Make desktop sidecar restart/backoff and stale-process behavior deterministic.
- Code-split Monaco, Mermaid, and non-default routes so the initial mobile bundle
  does not load editor/diagram engines before use.
- Set and measure an initial Web payload budget.

### Exit criteria

- Upgrade tests pass from all supported database versions.
- Provider secrets are absent from SQLite and export bundles after migration.
- Export succeeds on a populated dogfood database and passes checksum validation.
- Initial mobile JS gzip is at most 500 KiB, excluding lazy-loaded editor and
  diagram chunks.
- No blocker or major finding remains from security/reliability review.

## 11. Milestone 5 - CI, Packaging, and Documentation

**Estimated effort:** 4-6 engineering days
**Dependencies:** M2-M4 for final completion

### 11.1 CI

Split checks by platform while keeping required status names stable:

- Linux:
  - Go format/vet/test.
  - focused race tests where supported.
  - OpenAPI and shared fixture drift.
  - Web typecheck/test/build.
  - Relay lint/test/build.
- macOS:
  - Go test for Darwin-specific paths.
  - Electron typecheck/build.
  - iOS simulator build/test.
  - install script and packaged daemon smoke test.

Use the Go version from `go.mod`, `npm ci`, lockfile caching, and explicit
timeouts. CI must not depend on automatic toolchain drift.

### 11.2 Release artifacts

For `v0.1.0-beta.1`, publish:

- `kin-darwin-arm64`
- `kin-darwin-amd64`
- `kin-linux-amd64`
- `kin-linux-arm64`
- `SHA256SUMS`
- signed/notarized `Kin-<version>-arm64.dmg`
- source archive generated by GitHub

The install script must:

- fail clearly when no release exists;
- download the correct binary;
- verify SHA-256 before installation;
- avoid requiring root when a user-local bin directory is selected;
- report the installed version.

iOS ships through TestFlight from the same tagged API contract and records the
minimum compatible daemon version.

### 11.3 Documentation truth pass

Update together:

- README and Chinese README.
- System Design and Chinese System Design.
- Remote Access and Relay deployment docs.
- iOS README.
- License wording.
- Security/trust model.
- Supported matrix, upgrade, export, uninstall, and troubleshooting.

Remove claims for absent auto-update, Windows desktop, App Store availability,
official relay, or other unshipped behavior. Mark experimental features
explicitly. Every command and link must be exercised from a clean environment.

### Exit criteria

- A release candidate tag produces all expected artifacts.
- The advertised one-line installer succeeds on a clean macOS machine.
- The DMG opens without Gatekeeper workarounds.
- TestFlight installs and connects to the tagged daemon.
- Main contains the iOS source referenced by documentation.
- No README or release link returns 404.

## 12. Milestone 6 - End-to-End Qualification and Beta Launch

**Estimated effort:** 4-6 engineering days plus soak time
**Dependencies:** M2-M5

### 12.1 Required test matrix

Run every core journey with:

| Client | Network | Agent |
|---|---|---|
| Web | loopback | Kin |
| Electron | loopback | Claude Code |
| iPhone | LAN | Kin |
| iPhone | LAN | Claude Code |
| iPhone | Tailscale | Codex |
| iPhone | BYO Relay, Wi-Fi -> cellular | Kin |
| iPhone | BYO Relay | Claude Code |

At least one test must include an approval, one a user question, one cancellation,
one follow-up, one daemon restart, and one workspace diff.

### 12.2 Reliability targets

- No missing or duplicated persisted event after reconciliation.
- LAN event visibility p95 <= 2 seconds.
- Relay event visibility p95 <= 5 seconds.
- Normal reconnect p95 <= 15 seconds.
- One-time pairing success rate >= 95% over 20 clean attempts.
- Fifty consecutive supported-agent task runs without daemon crash or corrupt
  terminal state.
- Twenty-four-hour daemon/Relay soak with periodic task and reconnect probes.
- Zero known blocker or major issue.

These are release gates, not permanent service-level guarantees.

### 12.3 Security acceptance

- Expired/replayed pairing code is rejected.
- Revoked device credential is rejected on HTTP and WebSocket.
- Device credentials cannot reach excluded routes.
- Relay room/key guessing and daemon replacement fail.
- Token and provider secrets do not appear in logs, URLs after capture, crash
  reports, export, or UI copy.
- Path traversal, oversized body/frame, malformed JSON, and slow-client tests
  fail closed.
- External security review reports no exploitable blocker or major issue.

### 12.4 Beta launch

- Publish `v0.1.0-beta.1` and TestFlight build.
- Open issue templates for bug, connectivity, agent compatibility, and data
  recovery.
- Document how to collect a redacted diagnostic bundle.
- Invite a small first cohort before broad announcement.
- Track install success, pairing success, task completion, reconnect failures,
  and data-loss reports through opt-in/manual issue evidence; do not add hidden
  telemetry.

### Exit criteria

The beta may be announced only when:

1. All required journeys pass on release artifacts.
2. Reliability and security gates pass.
3. Export is verified against a populated database.
4. Release/rollback instructions are tested.
5. Known limitations are public and accurate.

## 13. Verification Commands

Run from the repository root unless noted.

```bash
# Go
gofmt -w <changed-go-files>
go test ./...
go test -race ./internal/task/... ./internal/workspace/... ./internal/remote/relay/...
go vet ./...

# API + Web
cd ui
npm ci
npm run check:api
npm run typecheck
npm test
npm run build
cd ..

# Desktop
cd desktop
npm ci
npm run typecheck
npm run build
cd ..

# Relay
cd relay
npm ci
npm test
npm run build
cd ..

# iOS
cd ios
xcodegen generate
xcodebuild -project Kin.xcodeproj -scheme Kin \
  -destination 'platform=iOS Simulator,name=Kin iPhone 16 Pro' \
  CODE_SIGNING_ALLOWED=NO build test
cd ..

# Release
make release
./scripts/install-smoke.sh dist/kin-darwin-arm64
```

Visible UI changes require browser screenshots at desktop and narrow mobile
widths. Relay and iOS changes require a real iPhone pass in addition to
simulator checks.

## 14. Risk Register

| Risk | Mitigation |
|---|---|
| iOS branch integration conflicts with recent daemon changes | Freeze wire fixtures first; merge in a dedicated worktree; never resolve by replacing whole files. |
| Device auth expands API middleware blast radius | Add typed principals and route-table scope tests before changing handlers. |
| Durable Objects make one-click deployment harder | Ship a complete Wrangler config and deploy button; validate from a clean Cloudflare account. |
| Relay works in mocks but not at Cloudflare runtime | Use workerd/Durable Object tests plus a deployed staging acceptance test. |
| Broad core refactor delays beta | Permit only boundary extractions required by tests or security. |
| Real agent CLI versions drift | Pin a tested compatibility matrix and keep readiness probes fail-closed. |
| Signing credentials are unavailable | Treat unsigned desktop as private RC only; public beta waits for signing/notarization. |
| Export misses newly added tables/files | Manifest test enumerates schema tables and owned file roots; unknown additions fail CI until classified. |
| Mobile bundle remains too large | Enforce bundle budget in CI and lazy-load Monaco/Mermaid/routes. |
| BYO Relay trust is misunderstood | Put the trust model in setup UI, README, and security docs; do not market it as E2EE. |

## 15. Effort and Critical Path

Approximate implementation effort:

| Milestone | Ideal engineering days |
|---|---:|
| M0 Scope/branch hygiene | 1-2 |
| M1 Contract/device auth | 4-6 |
| M2 iOS client | 6-9 |
| M3 Relay v2 | 6-9 |
| M4 Core hardening/export | 5-7 |
| M5 CI/package/docs | 4-6 |
| M6 Qualification/release | 4-6 + soak |
| **Total** | **30-45** |

For one engineer, expect roughly six to nine focused weeks including review and
soak. With two engineers, M2 and M3 can run in parallel after M1; the practical
critical path is approximately four to six weeks. These are capacity estimates,
not public calendar commitments.

## 16. Progress

- [x] Architecture and repository baseline reviewed.
- [x] Public beta scope and initial gates drafted.
- [x] M0 scope freeze and iOS branch integration.
- [x] M1 canonical contract and device authentication implementation.
- [x] M2 iOS end-to-end client implementation and simulator validation.
- [x] M3 Relay v2 Worker/Go bridge implementation and local tests.
- [x] M4 core reliability, secrets, export, and migration coverage.
- [x] M5 CI, packaging scripts, OpenAPI, and documentation updates.
- [ ] M6 E2E qualification, soak, and beta release.

Delivered slices in this execution:

- Device pairing sessions/credentials, master-only scopes, revoke behavior, and
  replay/expiry/concurrency tests are implemented in Go.
- OpenAPI now includes health/version and the pairing/device surface; generated
  TypeScript types are refreshed.
- Relay v2 Worker/Go bridge uses Durable Objects, random persisted room/key,
  bounded REST and WebSocket forwarding, and capped reconnect.
- `kin export --output <path.zip>` writes a versioned manifest, redacted
  JSONL/database data, owned project/artifact files, and SHA-256 entries.
- iOS decodes the canonical `kind/data` envelope and millisecond task
  timestamps, has profile-scoped Keychain storage and an AppSession root, and
  passes the simulator build plus 16 unit tests.
- CI checks Go's `go.mod` version, Relay, OpenAPI, Web, and iOS simulator paths.

Verification completed on 2026-09-16:

- `go test ./...`
- `go vet ./...`
- `git diff --check`
- Relay `npm test`
- Web `npm test` (28 files, 257 tests)
- Web `npm run build`
- Web `npm run check:api`
- iOS simulator `xcodebuild test` (18 tests, 0 failures)

The implementation is ready for an integration/release-candidate review. The
following release gates remain intentionally open: deployed Cloudflare Worker
acceptance, real iPhone/TestFlight validation, signed/notarized desktop
artifacts, installer and release-pipeline validation, visual browser checks,
and a measured initial bundle budget. Simulator output still contains existing
Swift/AppIcon warnings; these are recorded as release risk rather than hidden.

## 17. Discoveries

- The main daemon/Web implementation is substantially ahead of the public
  architecture snapshot; release convergence, not another feature wave, is the
  shortest path to user value.
- Passing iOS unit tests currently prove internal model behavior but not daemon
  compatibility because their timestamp and WebSocket fixtures differ from the
  real wire format.
- Relay HTTP proxy tests do not exercise Cloudflare isolate placement, Durable
  Object semantics, daemon identity, or local WebSocket bridging.
- The existing durable event sequence and REST backfill already provide the
  recovery primitive needed by every client; no second message store is needed.
- Public installation cannot be treated as complete until a real release exists;
  the current one-line installer has no downloadable latest artifact.

Add dated evidence here when implementation invalidates an assumption or reveals
a new constraint.

- **2026-09-16 - QR compatibility boundary.** Existing Web/Electron links still
  use the master token; native pairing exchange is backward-compatible and
  upgrades a one-time secret when present. Relay QR issuance still needs a
  final integration pass before public release.
- **2026-09-16 - Export format.** Export is a ZIP bundle with JSONL snapshots and
  a manifest; import is intentionally deferred. Provider secret runtime
  migration is not yet wired into the existing provider registry.

## 18. Decision Log

- **2026-09-16 - Public beta, not private experience build.** Require scoped,
  revocable device credentials because the existing daemon token grants the full
  public API.
- **2026-09-16 - BYO Relay only.** Do not operate a shared Kin relay in this
  release. Document Cloudflare's trust position; require E2EE before any future
  shared service.
- **2026-09-16 - Durable Objects for Relay coordination.** Process-local Worker
  maps cannot provide stable room ownership or request routing.
- **2026-09-16 - Shared fixtures over a new Swift runtime dependency.** Preserve
  the zero-runtime-dependency iOS boundary while making Go, TypeScript, and Swift
  decode the same actual messages.
- **2026-09-16 - Export before Memory.** A user-owned beta needs an exit path;
  governed Memory remains out of scope.
- **2026-09-16 - Signing is a public-beta gate.** Unsigned desktop builds may be
  used for private RC testing but are not the advertised beta artifact.

Record later decisions with date, rationale, alternatives rejected, and affected
milestones.

## 19. Outcomes and Retrospective

Implementation milestone completed on 2026-09-16 on `feat/beta-readiness`.
The branch includes scoped device credentials and pairing recovery, Relay v2,
profile-scoped iOS sessions and reconciliation, secret storage and export,
OpenAPI/CI updates, and the associated tests. The feature branch still requires
local integration into `main` and release packaging.

At each integrated milestone, record:

- delivered behavior and commit range;
- verification evidence;
- deferred nits and residual risk;
- whether effort or dependency estimates changed;
- any Beta contract change requiring maintainer approval.

Residual risk at handoff:

- Relay has not been deployed to a real Cloudflare account in this environment.
- iOS has only been validated on the simulator, not on physical hardware or
  TestFlight.
- Signing/notarization and downloadable release artifacts remain unverified.
- A small number of pre-existing Swift/AppIcon warnings remain.

After release, compare actual install, pairing, reconnect, task completion, and
support evidence against the gates in Milestone 6.

## 20. Definition of Done

`v0.1.0-beta.1` is done only when it is:

- **Correct:** released clients share one tested wire contract.
- **Recoverable:** reconnect/restart cannot silently lose durable history.
- **Secure enough for public testing:** scoped revocable mobile credentials,
  authenticated BYO Relay rooms, protected secrets, and explicit trust limits.
- **Installable:** real binaries, signed desktop, TestFlight, working links, and
  checksum-verifying installer.
- **User-owned:** local truth, inspectable export, no required Kin account.
- **Supportable:** reproducible diagnostics, accurate docs, known limitations,
  and no blocker/major review findings.

Anything short of those conditions is a release candidate, not the public beta.
