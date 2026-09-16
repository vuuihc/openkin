# iOS Console Parity

**Status:** Implementation complete; release validation pending
**Goal:** Make iOS a remote control console for the same Kin daemon used by
Desktop. The phone does not execute agents locally; it connects to the daemon
and exposes the high-value Desktop workflows.

## Scope

### P0

- Connect to a daemon over LAN, tailnet, or Relay.
- See active tasks, approvals, and questions in one control surface.
- Create tasks and continue an existing task conversation.
- Cancel, retry, continue-after-limit, fork, delete, and inspect task events.
- Review workspace changes and task output.
- Preserve profile-scoped credentials and reconnect state.

### P1

- Projects and editable One-Pagers.
- Artifacts library and reader.
- Routines: create, enable/disable, run now, delete.
- Agent authentication/availability and usage limits.
- Provider editing from iOS so the next remote task uses the selected daemon
  configuration.

The native pairing QR intentionally creates a revocable device credential.
Read-only mobile control works with that credential; provider/project/routine
administration requires scanning the separate Desktop `open:` master-token
link or entering the master token manually.

## Explicit Non-Goals

- Official OpenKin account login.
- Cloud-hosted user data or identity.
- Running Claude/Codex/other agents on the phone.
- Replacing the daemon's permission and audit model.

## Acceptance

- A user can pair once, open an active task, send follow-up guidance, answer
  an approval/question, inspect changes, and retry/fork the task from iOS.
- Projects, Artifacts, Routines, Agents/Usage, and Providers are reachable
  without opening Desktop.
- All writes continue through the existing authenticated daemon API.
- Existing Desktop and Web clients remain unchanged.
- iOS simulator tests and build pass; real-device testing remains a release
  gate.

## Verification

- `xcodegen generate --spec ios/project.yml`
- iOS simulator build
- iOS simulator tests: 19 passed

Remaining release validation is physical-device pairing, Relay acceptance, and
visual/manual workflow checks against a live daemon.
