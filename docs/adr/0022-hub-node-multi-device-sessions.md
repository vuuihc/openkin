# ADR 0022: Hub and Node Split for Multi-Device Sessions

## Status

Accepted 2026-10-22. Amends the multi-device non-goals recorded in
`docs/plans/2026-09-05-ios-desktop-remote-control.md` §2, `SYSTEM_DESIGN.md` §2,
and the "later or never" list in `PRINCIPLE.md` §5.11. Those documents carry
matching withdrawal notes rather than being rewritten, so the original reasoning
stays readable.

## Context

Kin currently runs as one fully authoritative daemon per machine. Every
conversation-domain table (`tasks`, `events`, `kin_messages`, `approvals`,
`user_questions`, `agent_sessions`, `task_agent_sessions`) is globally scoped
to that one database and has no device, user, or owner column. Device identity
exists only in the authentication plane (`remote.Principal`) and is used for
auth, the `masterOnly` gate, audit attribution, and WebSocket revocation
polling — never for data ownership.

Multi-device use today therefore means holding N independent daemons and
switching between them. The iOS client models this explicitly with
`ServerProfile` plus a desktop switcher; nothing is shared across devices.

Earlier plans rejected closing this gap. `2026-09-05-ios-desktop-remote-control.md`
locks "one authoritative daemon, the phone is a remote projection, not a second
writable Kin replica" and lists peer-to-peer and multi-master database
synchronization as non-goals. `SYSTEM_DESIGN.md` §2 puts "full sync product,
multi-user" under "explicitly later — or never". `PRINCIPLE.md` §5.11 defaults
against multi-device orchestration and full sync stacks before single-machine
excellence.

Two facts now make the gap a recurring pain rather than a prepaid story.
Users already switch between daemons to reach work that ran elsewhere, losing
conversation continuity on every switch; and the existing local session hub
(`docs/plans/2026-09-17-local-agent-session-hub.md`) already established the
intent to "keep one Kin conversation while switching the execution backend" —
but only within one machine.

A structural constraint rules out the obvious solution. `events.seq` is
allocated as `MAX(seq)+1` inside the insert transaction with
`MaxOpenConns(1)`, so the store is single-writer by construction. Two daemons
appending to the same conversation would collide. Any design that lets more
than one process write a conversation's event log is unsound without
introducing the conflict-resolution machinery this project has deliberately
avoided.

A survey of comparable tools (2026-10-22, primary sources) also shapes the
boundaries below. Remote agent supervision is a populated space, but
"self-hostable" is a weak axis within it: many tools are self-hostable only
because the relay is a local process, which makes the operator the user by
construction. The genuinely scarce property is a relay the user does *not*
have to trust, and a handful of projects achieve it with end-to-end
encryption. That property is unavailable to Kin for a structural reason rather
than a missing feature: a Hub that arbitrates approvals and allocates sequence
numbers must see plaintext. The same survey found that no comparable project
states its residual trust boundary completely, and that every major commercial
offering keeps session content on vendor infrastructure even when it offers
self-hosted execution. Kin's position is therefore "no vendor in the path,
with the boundary written down", not "self-hosted therefore private".

## Decision

Separate **session ownership** from **agent execution**. A Kin deployment
gains two roles, carried by one binary:

- a **Hub** owns sessions: it is the authoritative store, the sole allocator
  of event sequence numbers, the approval authority, and the scheduler;
- a **Node** executes turns: it owns locally installed agents, workspaces, and
  credentials, and streams turn events to the Hub.

`kin serve` with no role remains **standalone** — Hub and one local Node in the
same process. This is the default and preserves today's behaviour exactly, so
no existing user configures anything or learns a new concept.

The following boundaries are part of the decision, not implementation detail:

1. **Single writer.** Only the Hub allocates `events.seq`. A Node never writes
   its own event log; it uploads events and the Hub appends them. This is what
   keeps the design free of multi-master conflict resolution.
2. **One active turn per session.** The Hub serializes turns on a session.
   This is both a correctness requirement for sequencing and the existing
   interrupt-then-guide product behaviour.
3. **Execution follows the workspace.** A turn runs only on a Node that can
   resolve the session's workspace anchor *and* has the requested agent
   installed. If neither exists the turn fails with an explicit, explainable
   reason. The Hub never silently substitutes a device or an agent, so a
   session keeps exactly one routing owner.
4. **Secrets never leave a Node.** Provider API keys, agent credentials, and
   the local secret store do not travel to the Hub. The Hub stores only
   non-sensitive capability metadata, which is also what keeps passive
   settings views from reading secrets or probing third parties.
5. **Kin's own transcript is authoritative.** `events` becomes the single
   source of truth for a conversation. Provider-owned JSONL stores
   (`~/.claude/projects`, `~/.codex/sessions`, `~/.factory/sessions`) are
   demoted to device-local evidence and are no longer required to save or
   resume a session. This is what makes a conversation portable at all, since
   those files are only reachable on the machine that owns them.
6. **Native agent session ids are device-scoped.** A Claude Code `sessionId`
   or Codex `session_id` is only resumable on the machine that produced it.
   The binding identity is `(device_id, agent_id, external_ref)`. Crossing
   devices clears the native session reference and rebuilds context from Kin's
   own transcript — the mechanism that already exists for crossing agents.
7. **No new conversation entity.** A Kin session remains the Task, as M9
   established.
8. **HTTP cursors remain the source of truth.** Real-time transport stays an
   accelerator. Multi-device sync adds a monotonic cross-task cursor; it does
   not turn the WebSocket into a reliable delivery channel.
9. **One code path for local and remote execution.** Standalone mode is a Hub
   with an in-process Node, sharing the same scheduling and event path as a
   remote Node. A separate local-execution fast path is not permitted, because
   it would drift from the remote path that carries the real risk.
10. **The Hub is an authority, not a relay, and the trust boundary is stated
    rather than implied.** A Hub must hold plaintext to allocate sequence
    numbers, arbitrate approvals, and schedule turns, so Kin cannot offer the
    "operator-blind relay" property that some comparable tools implement with
    end-to-end encryption, and does not claim to. What Kin commits to is
    narrower and verifiable: no vendor sits in the path (a standalone
    deployment has no Hub at all), secrets never leave a Node, and a Hub is
    expected to run on a machine its owner trusts. Deploying a Hub on an
    untrusted host is out of scope and will not be mitigated with client-side
    encryption, because that would contradict the Hub's role.

Authentication for a multi-device Hub is operator-configured and optional. Its
purpose is narrow: letting a new device join and immediately see the account's
sessions without requiring an already-authorised device to be at hand, which is
what token pairing alone cannot do. OpenKin operates no account service and
hosts no user data, and standalone mode never authenticates at all. Login mints
a device credential and subsequent traffic uses that credential, so a Hub does
not depend on any external provider being reachable for devices that are
already paired. This keeps the §5.1 promise "core capability does not require an
official account" intact: signing in happens against the user's own Hub.

Accounts and credentials are separate layers. A user is a `users` row with an
immutable id; credentials are `user_identities` rows keyed by
`(provider, subject)`. One account can therefore be reached by GitHub, by an
operator-chosen OIDC provider, or by a local password, and every path lands in
the same session set. Three constraints make that safe:

- **The account key is the user id, never an email address.** OpenID Connect Core
  §5.7 requires that `email` "MUST NOT be used as unique identifiers for the
  End-User", a constraint that binds fully compliant providers rather than
  criticising any particular one. Concretely, GitHub permits unverified
  addresses on an account, and its own best-practice guidance says to "never use
  identifiers that can change over time, including user handles, organization
  slugs, or email addresses", because an account keyed by email would otherwise
  be claimable by anyone who sets someone else's address on their own account.
  The `subject` for each provider must likewise be an identifier the provider
  never reassigns: GitHub's numeric `id`, which GitHub documents as a value that
  "will never change for the user or be used to point to a different user",
  rather than its mutable `login`. Provider support for `email_verified` also
  varies — Google and Okta supply it, Microsoft Entra ID workforce tenants do
  not, and Entra External ID carries it only as an inbound claim mapped from a
  federated provider — and where it is supplied its JSON type is not consistent,
  so any design resting on that claim breaks when the provider changes.
- **Linking a second credential is an authenticated action**, performed by a
  user who is already signed in. Automatic account merging by matching email is
  not implemented at any point.
- **Ownership is claimed with a one-time code printed to the Hub's terminal**,
  not by whichever login arrives first. An exposed Hub would otherwise be
  claimable by a stranger during the window before its owner first signs in.

GitHub does not issue ID tokens and its discovery document carries neither an
`email` nor an `email_verified` claim, so it is a separate OAuth 2.0 adapter
rather than a configuration of the OIDC one; a generic OIDC client would fail at
ID-token verification. This is also why the GitHub-specific error
`unverified_user_email`, which GitHub returns instead of a token when a user's
primary address is unverified, must be surfaced as its own message.

A local password provider makes the Hub an identity provider, and the
obligations that creates ship with it rather than later: argon2id hashing, and
per-address and per-account rate limiting and lockout on the login endpoint.
Password reset is a CLI command on the Hub host rather than an emailed link,
because self-service reset would require an outbound mail path and would itself
rest on the assumption that an email address is trustworthy.

The Agent Client Protocol is adopted as an additional adapter family, not a
replacement. Its `session/request_permission` maps onto the existing approval
inbox, and its `fs/*` and `terminal/*` reverse requests give the Hub a single
place to enforce workspace and terminal policy instead of relying on each
vendor's sandbox flags. Existing adapters continue to work; convergence is
evidence-driven and out of scope here.

## Consequences

Conversations survive device changes, and the agent that produced any given
turn is recorded explicitly rather than inferred. Cross-device agent switching
reuses the existing handoff path, so no second orchestration mechanism is
introduced.

The Hub becomes a single point of failure for session access; standalone mode
and Hub data export are the mitigations. Devices can carry sessions whose
workspace does not exist locally, so a session may be readable on a device
that cannot execute it — this must be visible in the UI rather than presented
as a working action. Remote execution also reintroduces the durability gap
ADR 0020 left open: worker leases were in-memory and an in-flight remote
assignment could not be recovered. Multi-device sessions require durable
device registration, turn assignment reconciliation, and a definite terminal
state for a turn whose Node disconnects mid-flight, including preserving the
partial transcript and never auto-approving a pending permission request.

Adopting the Hub role also means the daemon is expected to face a network. It
currently serves plaintext HTTP with no request timeouts and enforces
authorization with a coarse master-or-device split, so a deployment exposed
beyond loopback needs TLS termination, server timeouts, per-device rate
limiting, and the read/write/admin ladder that ADR 0017 already defined for
MCP extended to REST.

Data model changes are additive: a user table, a durable device registry with
per-device agent capability rows, workspace anchors with per-device path
resolution, and device and owner columns on conversation-domain tables.
`tasks.session_ref` is retained as a compatibility projection rather than
removed, because five adapters use it as their resume entry point.

## Alternatives considered

**Multi-master replication between daemons.** Rejected: it contradicts the
event-sequence single-writer constraint and would require conflict resolution
the project has deliberately kept out of scope.

**Login-free pairing only.** Rejected for the multi-device Hub role: pairing
alone does not scope sessions to an account across devices. It remains the
mechanism for adding a device to an already-authenticated account, and remains
the only mechanism in standalone mode.

**Server-side execution only.** Rejected: it would require agents, repository
checkouts, and credentials to live on the Hub machine, contradicting the
existing model where the device that owns the working tree runs the agent.

**Copying provider transcripts into Kin for portability.** Rejected: it
duplicates large device-local files and still leaves the source path
unresolvable elsewhere. Making Kin's own event log authoritative achieves the
same portability without a copy.
