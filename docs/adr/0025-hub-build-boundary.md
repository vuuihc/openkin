# ADR 0025: Hub Build Boundary

- Status: Accepted
- Date: 2026-10-23

## Context

ADR 0022 separated session ownership from agent execution and gave Kin two
roles carried by one binary. It deliberately said nothing about how the code is
arranged. This ADR is about that arrangement, and about where the next batch of
Hub code is allowed to land.

The measured state is worth stating plainly, because the `--role` flag suggests
more separation than exists. `internal/server/server.go:427` is the only
`--role` branch in the repository, and it does exactly two things:

```go
if flags.Role == RoleHub {
	hub, err = remote.NewHub(remote.HubConfig{Domain: …, Email: …, StateDir: stateDir})
	accounts = authsvc.New(st, authsvc.Config{})
	oidcProvider, err = buildOIDCProvider(context.Background(), hub)
}
```

ACME certificate management, and the account system. That is the whole
difference. The turn engine, all nine agent adapters, the integrated terminal,
the browser worker, MCP, A2A, skills, connectors, eval, and routines are
constructed unconditionally afterwards, in every role. `go list -deps ./cmd/kin`
returns all 42 packages under `internal/`.

The consequence is concrete: the image serving a Hub, which runs no agents at
all, carries the entire agent runtime and every adapter it will never invoke.

This cannot be fixed by subtraction, and the reason is a decision rather than an
oversight. ADR 0022 D9 requires that standalone mode be a Hub with an in-process
Node, sharing one scheduling and event path with a remote Node, and forbids a
separate local-execution fast path. Hub code is therefore present in `kin` by
design. It can be given an artifact of its own; it cannot be removed from the one
that already exists.

Three facts about the wire protocol bear on the shape of the split. It is
already a clean package: `internal/remote/worker` imports nothing else in the
module, and both sides import it symmetrically. ADR 0022 D10 makes the Hub an
authority that must see plaintext in order to allocate sequence numbers and
arbitrate approvals, which is precisely why the protocol specification has to
stay open even in a world where some implementation does not. And the Hub's own
half of that channel currently lives in the same Go package as the Node's half,
under a package doc that claims the package is only the Hub's side
(`internal/node/connections.go:1`) while `client.go`, `executor.go` and
`approvalrelay.go` sit beside it.

`docs/plans/2026-10-23-m4-handoff.md` §8 sets the product frame this decision
serves: the line that matters is "runs on your machine" versus "I operate it for
you", not "client versus server". A self-hosted Hub sits on the open side of
that line. A multi-tenant control plane sits on the other, and does not exist
yet. Building the boundary now is what keeps the eventual second thing from
growing across the first.

## Decision

**The Hub becomes a separately buildable artifact without becoming a separate
codebase.** One module, two binaries, and a boundary between them that a
compiler and a test enforce rather than a convention.

1. **`kin-hub` contains only the Hub.** Accounts, TLS termination, the session
   store, `events.seq` allocation, approval authority, scheduling, the console
   API, and the Hub's half of the Node channel. `cmd/kin` keeps standalone and
   Node, unchanged in behaviour.

2. **Standalone still embeds the Hub.** ADR 0022 D9 is upheld without
   exception. There is no second scheduler and no second event writer, and a
   Hub-only artifact is a packaging decision, not a second implementation.

3. **The boundary is enforced, not documented.** A test derived from
   `go list -deps` fails when a package crosses it, following the precedent set
   by `internal/remote/import_boundary_test.go`. Rules are added as each stage
   of the split lands, so the test is never red on `main`.

4. **New Hub code lands in `internal/hub/…`.** Either there, or in a package
   that is already Hub-only. A package both sides need stays where it is and
   takes its Hub-side dependencies as interfaces; it does not grow a role flag.

5. **The protocol package stays a leaf.** `internal/remote/worker` may not
   import anything else in the module and may not accumulate hub-only concepts.
   It currently violates the second half — `registry.go` is the ADR 0020 worker
   lease registry, which only a Hub has — and that file moves.

6. **Four things never move to a Hub-only side:** the Node and daemon, the
   protocol specification, the console, and the CLI. PRINCIPLE §10 requires the
   open core to contain the runtime and a basic client, and two of the four
   cannot be kept secret in any case: the console is JavaScript shipped to a
   browser, and a developer tool with a closed CLI has no users.

## Consequences

A Hub image stops carrying ten agent adapters, a terminal, a browser worker, an
MCP host, and an eval runner. That is the visible win, and it is measurable:
`go list -deps` on the two `cmd/` roots is the metric, and the image size
follows it.

The invisible win is the one the decision was actually made for. Hub code now
has a side, so the next Hub feature has an obvious home and cannot accidentally
depend on the agent runtime. That is what §8 asked for when it said the choice
had to be made before the next batch of Hub code, not after.

The costs are honest and mostly land on the composition root. `internal/server`
today holds the wiring for every role in one 1263-line file, and `internal/api`
imports twenty-two internal packages including `node`, `auth`, and `remote`.
Until those are factored, `kin-hub` cannot be smaller than `kin` by very much,
so the split is a sequence of refactors rather than one move. Each stage is
independently verifiable and behaviour-preserving; none of them is a rewrite.

Two smaller consequences are worth recording. `internal/node` has to be divided
into its two real halves, which means a package rename and a round of call-site
edits rather than a design change. And `internal/remote` currently holds both
ACME/TLS termination (Hub-side) and the daemon token and transport helpers
(shared), so `remote.Hub` has to move before `internal/api` can stop pulling
`autocert` into every build.

Nothing about the module path changes, so no import path in any consumer
changes, and the desktop shell, the launchd Node service, and the existing
compose deployment keep working against the same `kin` binary throughout.

## Alternatives considered

**A separate repository now.** Rejected as the first step, not as a
destination. It buys a repository boundary and costs a second CI, a second
release process, a second place to change the protocol, and a decision about
whether the new repository inherits history that was just rewritten — while the
code inside is still one tangle. Every argument for it is an argument for the
boundary, which can be built where the code already is and moved afterwards at
mechanical cost. See §8 of the M4 handoff for the three-repository shape this
remains compatible with.

**A separate Go module in the same repository.** Rejected for now. It would
enforce the boundary slightly harder than a test does, at the price of a
`go.work` for local development and a `replace` directive that does not
propagate to anyone who imports the module. The test gives most of the
enforcement for none of the packaging cost; the module split stays available and
becomes trivial once the boundary is real.

**Build tags on the existing binary.** Rejected: it would mean two compilation
configurations of one package set, which is the drift ADR 0022 D9 exists to
prevent, and it makes `go vet ./...` and editor tooling see half the program at
a time.

**Removing the agent runtime from `--role hub` without a second binary.**
Rejected because it cannot be done: the runtime is reachable from
`internal/server` and `internal/api` unconditionally, so the choice is between
two binaries and no separation, not between one binary and two.
