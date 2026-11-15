# ADR 0029: A Member Works Inside the Projects the Holder Registered

- Status: Accepted
- Date: 2026-10-26

## Context

ADR 0026 and ADR 0028 gave a Hub accounts that are not the holder. What they
bounded is what a member *reads*: `TaskScope` filters the task list by owner, and
`holderOnly` keeps a guest away from the machine's own records. Nothing bounded
where a member's work *ran*, and creating a task is running an agent in a
directory — on the holder's machine, as the holder's own CLI, with the holder's
credentials in reach.

The gap is one field wide. `POST /api/tasks` takes a `cwd`, is reachable by any
authenticated principal, and passes it to the engine, which starts a process
there. A member could name the holder's home directory, or a sibling project the
holder never mentioned, and the machine would work in it: read it, write it,
commit in it. Visibility rules would then decide who could see the task, which is
a conversation about the leak after it happened.

This is S2 of the hosted plan, and its acceptance criterion is the shape of the
fix: **a member creating a task with `cwd` = the holder's home is refused, and a
`cwd` under a registered project is allowed.**

## Decision

**The bound is the projects the holder registered.** Registering a project is
already an operator action — `POST /api/projects` is `operatorOnly` — so "a
directory the holder curated" needed no new entity, no new column, and no new
screen. It is also the list the rest of the product already treats as the set of
places this machine works.

**Containment, not equality.** A project root is where checkouts live, so a
directory *under* a registered root is inside it. The comparison resolves both
sides first and then compares path segments, because the two cheaper spellings
are each wrong in a way that hands over a directory: a string prefix accepts
`project2` for `project`, and comparing a path as written accepts
`project/../home`.

What resolution buys is a decision about the path as it is *now*: a directory
inside a registered project that is replaced by a symlink after the check and
before the turn starts is a race this does not close, and closing it would mean
pinning the directory for the life of the task. It is recorded rather than fixed
because it is worth nothing on its own — see the capability residual below.

**The verdict lives in the engine, not in the handlers.** `Engine.Create` is the
single entrance — REST, MCP, A2A, the routine scheduler, the eval runner, the
session attach and replay all reach the same function. One check there covers
every surface, and a surface added later inherits it without being told.
`CreateRequest.OwnerUserID` is already the field the engine trusts for isolation,
so it is the field the new bound reads rather than a field invented for it.

Fork is the exception and is deliberately not counted above: it builds a
`store.Task` and inserts it (`internal/task/approvals.go`), so it never passes
through `Create` and this guard does not run for it. It does not need to. A fork
copies the source's `OwnerUserID` and `Cwd`, the caller can only fork a task
their own scope already shows them, and the fork request carries no directory of
its own — so a fork lands where its source already was, for the account that
already owned it.

**The role comes from the account row, not from the request.** A `Role` or
`AllowedRoots` field on `CreateRequest` would be a fourth thing each surface has
to remember to fill, and its zero value could not be both safe and compatible:
defaulting to holder is a hole the day one surface forgets, and defaulting to
member refuses every caller that constructs a request today.

**The verdict is `store.ActsForHolder`'s, not a role comparison written here.**
That function is the one place that answers "does this principal act for this
machine", and `task_scope.go` says outright that a second answer is how the two
come to disagree — with a member's isolation on one side of the drift. It is
asked with a user principal built from the stored role, so an owner passes and a
member is confined.

**An empty `OwnerUserID` means no check at all.** It is the master token, a
paired device, and a standalone daemon with no accounts. None of those is a guest
on the machine, and unowned tasks belong to whoever holds it. An id that resolves
to no account is the opposite case and is refused, which is the direction
`TaskScope`'s zero value already fails in.

**The ownerless tasks that come from rows are covered by a second rule.** A
routine firing on a timer, an eval case, and an attach to a recorded session each
build their request from storage, so no request ever carried an account for them.
They are safe because the routes that create them are holder-gated, which is a
fact about routes rather than about the engine — so it is pinned by
`TestAMemberCannotReachTheRoutesThatCreateAnUnownedTask` in `internal/api`, and
that test is where a route has to justify itself before moving to a gate a member
can pass.

A rerun is the same shape and was the exception to this paragraph: `POST
/api/tasks/{id}/replay` sits behind the task scope rather than behind a role, so
a member could reach it, and it built its request from the source row without
copying the owner. Fixing it did not widen the guard — the source's directory had
already been checked when the member created that task — but it is worth naming,
because it was the one route reachable by a member that this paragraph claimed
did not exist. A route on that list moving behind a member-visible gate is still
what reopens the bound.

**A dispatched task is judged by the machine that runs it.** A `cwd` on a task
with an `ExecutingDeviceID` names a path on another machine, which enforces its
own roots, and that machine's check is closed in the direction that matters: no
declared roots and a relative `cwd` are each refused (`node.Executor.allowedCwd`).
Judging it by this machine's project list would refuse a directory that is valid
where the work actually happens.

**The exception is the holder's, not everyone's.** A member naming a device is
refused before their `cwd` is read at all. The reason is what the exemption would
otherwise hand them: the choice of which list judges their directory. The
receiving machine's roots are its own projects *plus* its checkout root *plus*
whatever `--node-root` it was started with — a wider list than the projects
curated here — so "another machine will check it" is only a safe answer when the
caller had a right to pick that machine. Listing the machines a Hub knows is
`holderOnly`, so a member cannot enumerate them; what they *can* do is read the
`executing_device_id` off a task of their own, which is enough to name a device
and not enough to name one that helps. Naming any of them is refused here, so the
field's effect is never to leave this bound behind.

The Hub's check on a dispatch target is weaker than its name suggests, and the
difference is why the refusal lives here rather than beside it:
`ValidateExecutingDevice` asks whether the device is known and not revoked, not
whether the caller has any business sending work to it.

## Consequences

- A member's directory picker is the holder's project list rather than the
  filesystem. That is console work (the hosted plan's §7.2), not a security
  change; `/api/recent-cwds` stays `holderOnly`, so the member gets a 403 today
  rather than an aggregated list of the holder's directories.
- Forking is not a way around the bound. A fork copies `src.OwnerUserID` and
  `src.Cwd` from a task the caller could already see, so a member's fork stays
  theirs, in a directory they were already allowed to use.
- Registering a project is now a security-relevant action, not just
  bookkeeping. It is already operator-only, for its own reasons; this adds one
  more reason it should stay that way.
- The refusal names the fix — "ask the owner to add that directory as a project"
  — and deliberately does not list the registered directories. A person who
  cannot tell a boundary from a bug asks for the wrong repair.
- **Residual, and it is the one that matters: this is a placement boundary, not
  a capability boundary.** A member's agent runs as the daemon's OS user, with
  that user's CLI logins, and two things inside a legitimate project are not
  restricted by role at all:
  - `permission_mode` is the caller's own field, and nothing checks it against
    a role — `validateGenericCLIPermission` only *requires* `accept_edits` or
    `yolo` for agents with no approval channel, and accepts either from anyone.
    So a member can run an unattended agent inside their project.
  - The member answers their own task's approvals, which is ADR 0026's decision
    (a member approving their own task is the product working) and is also the
    second half of the same exposure.
  So a registered project that contains, or can reach, the holder's `~/.ssh` is
  enough to copy it out over the network. The project list decides *where* a
  member's agent may work; the machine's OS user is still what decides *what it
  can touch*.
- Which is the right proportion for the check-then-run race above. A member who
  learns a device id can no longer dispatch work to another machine — naming one
  is refused outright — so the only way of reaching a directory this bound does
  not cover is the race, and a member standing inside any registered project
  already has more reach than it would buy. It is worth stating so nobody reads
  this bound as more than it is; it is not worth building around before the
  capability question is answered.
- **Fork and rerun do not answer the device question the same way, and the
  difference is deliberate but not obviously right.** Both mean "the same work
  again where it already ran", and both copy the device id from the source, so a
  holder's fork of a dispatched task still dispatches. A member's *rerun* of one
  is now refused by the same rule that refuses any other member-named device,
  while a member's *fork* of the same task is not — `Fork` inserts a row directly
  and never reaches this guard. Nothing is reachable that was not reachable
  before (the fork lands in the directory the source already had, on the machine
  it already had), but the asymmetry is real and this is where it is written
  down. Applying "a member cannot name a device" to fork too would be the
  consistent answer; it is not done here because a fork is not a dispatch the
  caller asked for by name, and because the case needs a member to hold a task
  that predates the rule.
