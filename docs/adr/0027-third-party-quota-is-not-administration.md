# ADR 0027: Spending Third-Party Quota Is Not Daemon Administration

- Status: Accepted
- Date: 2026-10-24

## Context

`operatorOnly` guards the routes that administer a daemon: its settings,
providers, connectors, devices, and files. ADR 0026 settled *who* passes it —
the master token, and an account whose role is `owner`. A paired device token
deliberately does not, because a phone or a desktop client drives tasks; it does
not reconfigure the machine it is paired with.

Read pull-request state then became a feature, in two routes:

- `GET /api/tasks/{id}/pr` reads the cache. Any authenticated principal may call
  it, and it teaches a phone whether a branch has a pull request at all.
- `POST /api/tasks/{id}/pr/refresh` queries GitHub and waits. It is the only
  route that touches the network for this feature, and it was written as
  `operatorOnly`.

The second route broke the first one on the client that matters. A branch nobody
has looked at yet has no row, and only a query can create one — so the phone,
which cannot open a terminal and run `gh`, saw "this branch has not been checked
yet" with no way to change it. The panel's own automatic ask was refused 403
before the user ever saw the screen.

The question underneath is not about pull requests. It is: **is spending the
node's shared third-party quota an act of administering the node?** Rate limit
belongs to the machine, is shared with every other tool on it, and a hand that
keeps tapping can exhaust it. That reads like administration. But the caller
here is not reconfiguring anything — it is asking a question about state that
already exists on GitHub, and the answer is cached and shown to the same person
either way.

## Decision

**A paired device may spend the node's GitHub query quota, and only that.**

The exception is written as its own middleware, `githubQueryOnly`, mounted on
`POST /api/tasks/{id}/pr/refresh` and nowhere else. `operatorOnly` keeps its 51
remaining routes and its meaning; the two predicates are separate functions so
that widening one cannot silently widen the other.

The reasoning that admits a device is not new here. It is the premise the
repository already committed to: pairing is itself `operatorOnly`, so a device
credential is minted by the machine's holder and acts for them — which is why
`ScopeForPrincipal` treats a device as unscoped (`internal/store/task_scope.go`).
"Device" reads as "the owner's own client", and the owner is already an operator.

**A member account is still refused.** A member is another person on the node,
not one of its owner's devices, and the same distinction decides both this gate
and the task scope.

**The bound is the tap, not a budget.** The hourly anonymous budget belongs to
the background pass, which spends without anyone watching; a forced query is
spent because a person asked for it, and there is exactly one of those per panel
open. Past that it is GitHub's own refusal and the backoff that follows it that
stop a hand that keeps tapping. This is weaker than a budget and is written down
as weaker rather than dressed up: the honest statement is that a device holding
a valid credential can spend the owner's quota by tapping, which is also true of
the owner sitting at the desk.

**Writes are a separate question.** Pushing a branch and opening a pull request
change state on GitHub and on the node's repository. That is not covered by this
decision and gets its own gate, most likely keyed on who owns the task rather
than on who operates the node.

## Consequences

A paired phone can now see the first answer for a branch nobody has looked at,
which was the point: the whole feature is meant to be usable from a phone.

The set of routes an operator-only rule protects is no longer describable as
"everything that costs money". Anyone auditing the surface has to read the route
table rather than grep for `operatorOnly` and assume it is complete. That is a
real cost, paid once, and it is why the exception is one route wide and lives in
its own named middleware rather than as a condition inside `operatorOnly`.

The tests pin both directions, because each is the other's failure mode:
`TestRefreshPRAllowsAPairedDevice` (a device gets 200, and the same credential
still gets 403 on `/api/settings`), and `TestRefreshPRRefusesAMember` (a member
gets 403 on a task it owns, having first been shown to get 200 on the read —
otherwise `taskInScope`'s 404 would mask the gate and the test would pass
whatever the gate said). Restoring `operatorOnly` fails the first;
`return true` fails the second.
