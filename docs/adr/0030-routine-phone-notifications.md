# ADR 0030: Routine Phone Notifications Fan Out Through the Hub

**Status:** Accepted
**Date:** 2026-11-13
**Related:** ADR 0011 (Routines) · ADR 0022 (Hub/Node split) · KIN-NOTIFY-001

## Context

A routine is scheduled and run on one machine (ADR 0011, ADR 0022): the Node
owns the routine, the run, and the report. A phone, however, registers its APNs
token with the Hub — the daemon whose console it opens — not with every Node.
So a noteworthy routine report or a circuit-breaker disabled alert produced on
a Node had no way to reach the phones the Hub registered. The Node's own
`notify.Sender` could only ring its own desktop and its own registrations
(usually none in a Hub deployment).

KIN-NOTIFY-001 already fixed the rule "registration and send live on the same
daemon". That holds for the *Hub's own* tasks; this ADR does not move APNs
credentials or registrations. It only lets the Hub perform the fan-out it is
already responsible for, on behalf of a routine whose data lives elsewhere.

## Decision

Reuse the authenticated Node control WebSocket. A Node that finishes a
noteworthy routine run, or whose routine trips the circuit breaker, sends a new
optional `routine.notify` frame to the Hub. The Hub resolves the source device
and the recipient from the authenticated connection and its own records, builds
a safe link, and calls its existing `notify.Sender` to fan the alert out over
APNs. Nothing about the alert — owner, device id, URL, broadcast flag, APNs
token, recipient — is taken from the frame.

### Capability negotiation

`hello_ack` gains an optional `routine_notify` boolean. A Node sends
`routine.notify` only when the Hub's `hello_ack` says it understands it. An old
Hub refuses an unknown frame kind by closing the whole connection, so a
Node-first rollout would take remote execution offline; the negotiated flag
keeps a new Node safe against an old Hub. An old Node ignores the extra
`hello_ack` field and works unchanged.

### Wire shape

`routine.notify` carries only the content: `event` (`report` or `disabled`),
`event_id`, `routine_id`, `task_id`, `title`, `body`. Every field is bounded and
validated on both ends. The Hub answers `routine.notify.ack` with the `event_id`.

### Recipient resolution and links

- The source device is `sender.DeviceID()` (the authenticated connection).
- The recipient account is `devices.owner_user_id` for that device, with the
  existing ownerless→operator fallback inside `notify.Sender`.
- A report links to `/machines/<device>/tasks/<task>` (the existing remote
  task route, added to `parseNotificationRoute`'s allowlist).
- A disabled alert links to `/routines?device=<device>`; the Routines page
  follows that device and stores the selection in each history entry.
- A revoked device is denied at the handler; one device cannot name another
  account, recipient, or URL.

### Reliability

Neither the Node task engine nor the Node socket reader blocks on network:

- The Hub fan-out runs in a bounded pool of goroutines (a token channel, not a
  queue grown by the reader). When every slot is taken the frame is refused
  **before** it is deduped or acknowledged, so a saturated Hub does not falsely
  ack an event it is about to drop; the Node retries unacknowledged events on
  the same connection every five seconds and also replays them on reconnect.
- The Node holds reports in a bounded in-memory outbox. A single sender
  goroutine owns the socket writes; the queue mutex is never held across a
  write, so a stalled Hub cannot block `Send`, `SetSender`, ACK handling, the
  heartbeat, or the socket reader. Each write has a deadline; a failed write
  keeps the current sender installed so the retry ticker can try it again, and
  the connection loop replaces the sender if the socket itself has gone away.
- The outbox is also used when the capability is **unknown**: a report that
  fires before the first successful handshake is queued, not dropped, and is
  flushed once a later `hello_ack` advertises `routine_notify`. The Node never
  transmits the frame to a Hub that did not advertise it.
- The Hub dedupes by (authenticated device, `event_id`) with a FIFO-bounded
  in-memory table, and only accepts the *current* connection for that device
  (same generation). A replaced connection or a revoked credential is refused
  without an ack. Registry lookup failures fail closed rather than degrading
  to an operator-wide send.
- Apple's 4 KiB payload cap is enforced on the actual serialized JSON at the
  `apns.Client` boundary (JSON escaping and multibyte text count), keeping the
  routing fields and clipping the alert title and then body on UTF-8
  boundaries.

All of this is process-local and APNs is best-effort: this is explicitly not
durable, and not exactly-once.

## Consequences

- Routine reports and disabled alerts reach iPhones registered on the Hub, even
  though the routine runs on a Node.
- Local desktop notices and standalone APNs are unchanged: the Node still
  publishes to its own desktop bus and its own registrations before forwarding.
- Upgrade order is Hub first, then Node. An old Node against a new Hub sends
  nothing new; a new Node against an old Hub sees no capability and stays
  silent. Both sides should be updated together.
- **Cross-registration duplication:** if a phone is registered with *both* a
  Node and its Hub (possible when a Node also serves a console directly), the
  Node's own APNs fan-out and the Hub's forwarded fan-out can both ring it for
  the same routine report. This is not deduplicated across processes. In the
  normal Hub deployment phones register only with the Hub, so it does not occur.
- The Node-side queue and the Hub-side dedupe are lost on process restart; an
  alert queued across a crash is not recovered.
- A report that fires before the first successful handshake is queued until a
  supported handshake arrives; if the Node is only ever paired with an old Hub,
  that queue is bounded and never transmits an unknown frame, so the local
  desktop notice and runs feed remain the only signals on that deployment.

## Alternatives considered

1. **Ship APNs credentials/registrations to the Node.** Rejected: breaks
   KIN-NOTIFY-001's "registration and send on the same daemon" and ADR 0022's
   "secrets never leave a Node" — the Hub is where the phones already register.
2. **A general notification-relay framework.** Rejected: out of scope; this is
   one message on an already-authenticated channel, with the smallest possible
   surface.
3. **Durable outbox / exactly-once.** Rejected: the inbox is the source of
   truth and the alert is best-effort; a durable queue would add schema and
   recovery machinery for a banner whose item is already in the feed.
