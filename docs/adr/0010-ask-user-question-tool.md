# ADR 0010: Ask User Question Tool

## Status

Accepted (2026-07-24)

## Context

Kin agents today can only do one of two things when they need something from
the user mid-turn: act unilaterally (guess), or block on the binary tool-use
approval bridge (`internal/approvemcp`, spec §4.2) that gates *risky actions*
via `PermissionMode`. There is no channel for an agent to pause and ask a
structured clarifying question — "which of these three approaches?" — before
proceeding. Interactive coding assistants (including the harness driving this
very authoring session) ship a native `AskUserQuestion` tool for exactly this.
Kin has no equivalent, for any agent tier.

The existing `Approval` primitive (`internal/store/approvals.go`,
`internal/task/approvals.go`) is adjacent but the wrong shape to reuse: its
`Decision` is a fixed `approved|denied|expired` enum representing consent to
act, gated by `PermissionMode`. A clarifying question is not a permission
check — it always needs the user's attention regardless of permission mode,
and its "decision" is an arbitrary chosen option (or options, or free text),
not allow/deny.

Separately: Kin's `claude-code` adapter launches `claude -p ... --output-format
stream-json` with stdout/stderr piped but no stdin channel
(`internal/adapter/claudecode/adapter.go`). Claude Code's own built-in
`AskUserQuestion` tool has no way to be answered in that mode. Whatever we
build must not depend on that built-in tool working headlessly.

## Decision

1. Introduce a new engine primitive, **UserQuestion**, modeled as a sibling of
   `Approval` (own store table, own REST surface, own bus event, own status)
   — not a variant of it.
2. Expose it to agents as a second MCP tool, `ask_user_question`, registered
   on the same `--mcp-config` server that already carries the `approve` tool
   (`internal/approvemcp`). No new CLI flag is required: `--permission-prompt-tool`
   only designates the callback used for *permission* checks; any other tool
   on that MCP server is discovered and callable by the model like any normal
   MCP tool.
3. A `UserQuestion` always reaches the user, independent of `PermissionMode`
   (default / accept_edits / yolo) — it is a request for information, not a
   request for consent to act.
4. Task status gains `waiting_input` (parallel to `waiting_approval`) so the
   console can tell "needs your permission" apart from "needs your answer."
5. Ship for the `claude-code` adapter first — the one adapter with an
   existing MCP bridge (`agent.CapabilityApprovals`). Other adapters adopt it
   by wiring the same MCP tool once they grow an equivalent bridge.
6. Interrupt/cancel handling mirrors approvals exactly:
   `Engine.FollowUpWith`'s interrupt path must resolve pending user questions
   (not only pending approvals) before killing the subprocess, or the blocked
   `approve-mcp` long-poll — and the `claude` process behind it — hangs.

## Non-goals

- Bridging Claude Code's own built-in `AskUserQuestion` tool. Kin ships its
  own MCP tool with an equivalent shape instead; whether the model prefers it
  over a (non-functional, headless) built-in tool is a prompting/description
  concern, not a protocol one.
- Codex, kinagent, generic CLI (Tier 2), rawpty support.
- Auto-answering questions in `yolo` mode (e.g. always pick the first
  option). Revisit if it proves necessary in practice.
- A new top-level "Inbox" IA merging approvals and questions. v1 folds
  questions into the existing pending-approvals list and keyboard-navigation
  queue on `TaskDetailPage`.

## Consequences

- Adding an interactive channel is one MCP tool + one engine primitive, not a
  fork of the approval engine — `Approval.Decision` keeps its clean
  permission-only semantics.
- `Engine.StartExpiryLoop` / `ExpireStale` generalize to sweep both approvals
  and user questions, so an unattended question cannot hang a task (or a
  `claude` process) forever.
- The console gains a second "needs you" card type; `TaskDetailPage`'s
  focus/keyboard-shortcut queue must merge both types for a coherent
  Tab/Enter flow.
- A later Tier-2/Codex bridge is additive: same store table, same bus event,
  new adapter-side wiring only.

## Alternatives considered

1. **Overload `Approval.Kind = "user_question"`** — rejected: `Decision` has
   no field for which option(s) were picked; would force either a second
   free-text-encoded field inside `payload`/`decided_via` (fragile) or
   widening `Decision` past a clean enum.
2. **Let the model just say the question in plain text and wait for a normal
   follow-up reply** — already works today with zero code, but loses
   structured options, keyboard-driven answering, and the ability to
   deterministically block the turn until answered (the model has to guess
   whether the user's next message answers the question it asked).
3. **Reuse the approval endpoints with `kind: "tool_use"`, options encoded in
   `payload`, answered via `approved`/`denied`** — rejected: only expresses
   two outcomes; cannot represent 3+ options or multi-select.

## Follow-up

See [docs/plans/2026-07-24-ask-user-question-tool.md](../plans/2026-07-24-ask-user-question-tool.md)
for the task-by-task implementation plan.
