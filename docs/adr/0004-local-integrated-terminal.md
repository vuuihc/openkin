# ADR 0004: Integrated Terminal and Where It Runs

**Status:** Accepted, revised 2026-10-23
**Date:** 2026-07-17
**Related:** [SYSTEM_DESIGN.md](../../SYSTEM_DESIGN.md) · [ADR 0022](0022-hub-node-multi-device-sessions.md) · [Integrated terminal plan](../plans/2026-07-17-integrated-terminal.md) · [Cross-device terminal research](../plans/2026-10-22-m1-m2-progress.md)

## Context

The Electron desktop app benefits from a persistent, VS Code-style terminal for
working in the current task or draft directory. A local interactive shell has
fundamentally different authority and traffic characteristics from Kin tasks: it
runs with the local user account's shell permissions, produces high-volume binary
PTY traffic, and must survive renderer reloads without becoming task history.

Kin's normal console is reachable through the remote-access ladder. Reusing that
exposure for a shell would turn possession of a Kin token into remote command
execution. Reusing `internal/adapter/rawpty` would also couple an interactive
terminal's lifetime to a one-shot task adapter that has no input, resize,
attachment, or replay contract.

The original decision below then ruled the terminal a local desktop convenience
and forbade it on every remote surface. **That product surface was withdrawn on
2026-10-23**, when the goal became a multi-device console. The withdrawal is
recorded under "Revision" below; the reasoning above still holds, which is why
the guards it produced are kept rather than deleted.

## Decision

- A terminal belongs to the machine that owns the workspace, not to the client
  viewing it. Terminal output is an item on the session stream, exactly like any
  other action a task produces, so it needs no second channel and reconnects
  through the cursor that already exists. This is the same rule as ADR 0022 D8:
  remote execution is an `adapter.Adapter`, and the Hub forwards and assigns
  `seq` rather than interpreting.
- **Every terminal route requires an explicit opt-in from the operator of the
  machine that would run the shell.** The switch is off by default and is not
  implied by any Hub credential, device token, or account role — a valid Kin
  token arriving over LAN, Tailnet, Funnel, or a Hub still needs the machine's
  own consent. Forwarded headers can never grant it.
- A remote terminal is a larger hole than dispatching a turn: it is an
  interactive shell with no approval channel in front of it. The opt-in is the
  gate that replaces the loopback check the original decision relied on, and a
  refusal must say why.
- Terminal sessions and their bounded replay buffers remain ephemeral in the
  sense that matters: they carry no approval semantics, no cost accounting, and
  no audit obligations of their own. Their output is session history, not a
  second record of it.
- The backend detects and owns an immutable set of shell profiles. Clients may
  submit only a backend-issued profile ID and never an executable path or
  argument list. This is not weakened by remote access.
- A standalone terminal runtime owns PTY processes, attachment, resize, replay,
  exit, and cleanup. `internal/adapter/rawpty` remains a one-shot task adapter
  and is not reused as the session runtime.
- Starting a terminal intentionally grants the shell authority of the local user
  account. It is a direct operator action, not an approval-gated Kin tool, and it
  does not inherit the task approval model.

## Consequences

- The terminal is reachable from any device that can reach the machine, once
  that machine's operator has opened it — which is the point of the revision.
- The opt-in is per machine and explicit, so pairing a device, claiming a Hub, or
  holding the master token does not carry shell authority with it.
- Profile detection and server-owned arguments prevent any client, local or
  remote, from turning session creation into arbitrary executable selection.
- Renderer reload can reattach to live in-memory sessions, while daemon shutdown
  destroys all PTY process groups and buffered output.
- The feature uses the existing HTTP/WebSocket language boundary without adding
  Electron IPC or a native Node PTY dependency.

## Revision 2026-10-23

The product surface changed, the security reasoning did not. What was withdrawn:

- "not rendered in the normal browser, phone, tray, LAN, Tailnet, or Funnel
  surfaces" — the terminal is no longer desktop-only. It is a session-stream
  item, so every console renders it.
- "excluded from SQLite, export bundles, task events" — output that is a session
  item is session history. The parts of that list that still hold are the ones
  about approvals, cost accounting, and audit history.
- "a real loopback TCP peer" as the gate — replaced by the machine operator's
  explicit opt-in, because a loopback peer check cannot survive the terminal
  being remote and would have been silently wrong rather than loudly refused.

Both withdrawn positions were load-bearing when written, so they are recorded
here rather than deleted: the next reader deserves to know that a terminal was
once judged too dangerous to expose, and why the gate moved instead of vanishing.

**Not yet implemented.** No `--allow-terminal` (or equivalent) flag exists in the
tree today; the terminal is still local and still gated the old way. This ADR
records the decision so that whoever builds it does not build it open by default.
Until then the current behaviour is unchanged.

## Rejected alternatives

1. **Electron `node-pty` over IPC** — adds a second terminal backend and native
   Node packaging path while bypassing the documented UI-to-core HTTP/WebSocket
   boundary.
2. **Reuse `rawpty.Adapter`** — its task-scoped, one-shot `/bin/sh -c` contract
   cannot safely represent interactive input, resize, replay, attachments, or
   independent session lifetime.
3. **Keep the loopback-only gate and refuse remote terminals** — would have kept
   the strongest possible gate, but the multi-device console is the product: a
   terminal visible only on the machine that runs it is not the feature. Rejected
   in favour of an explicit opt-in, which is weaker but honest and revocable.
4. **Rely on the Hub's role model** (owner sees the terminal, members do not) —
   a role answers "who is this account", not "may this machine run a shell for
   anyone at all". Conflating them would grant shell authority as a side effect
   of claiming a Hub.
5. **Persist terminal transcripts as their own record** — would duplicate session
   history and add secret exposure, retention, export, and audit obligations
   outside this feature's scope.
