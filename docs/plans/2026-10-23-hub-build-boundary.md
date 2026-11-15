# Hub Build Boundary — executable plan

> Decision: `docs/adr/0025-hub-build-boundary.md`.
> Goal: `kin-hub` builds with only the Hub in it, and the boundary is enforced
> by a test rather than by convention. One module, two binaries, and no change
> to what `kin` does today.
>
> **Out of scope:** a separate repository, a separate Go module, any change to
> the module path, and any change to the `kin` binary's behaviour. Those stay
> available and become mechanical once this plan is done.

## How progress is measured

```bash
go list -deps ./cmd/kin     | grep -c 'openkin/internal'
go list -deps ./cmd/kin-hub | grep -c 'openkin/internal'
```

Baseline 2026-10-23: `kin` carries **42** internal packages; `kin-hub` does not
exist. The number is the metric because the image size follows it.

## Why this is a sequence and not a move

`go list -deps ./cmd/kin` already returns the entire `internal/` tree, and the
only `--role` branch in the repository is `internal/server/server.go:427`, which
adds ACME and accounts and nothing else. So there is no Hub-shaped subset to
extract. What exists is a composition root that builds every subsystem for every
role, and an API package that imports twenty-two internal packages.

The blocking edges, worst first:

| # | Edge | Where |
|---|---|---|
| B5 | `internal/server` builds everything, one 1263-line file | `internal/server/server.go:21-47` |
| B1 | `internal/api` → `internal/node` | `api.go:33`, `devices.go:18`, `node.go:14` |
| B2 | `internal/api` → `internal/auth` | `api.go:25`, `auth.go:11` |
| B6 | `internal/api` → ACME, via `internal/remote` | `api.go:41` |
| B4 | `internal/node`'s hub half → `store`, `task` | `node/approvals.go:12-14` |
| B3 | `internal/auth` → `internal/store` | `auth/service.go` |
| B9 | hub-only lease registry inside the protocol package | `remote/worker/registry.go` |

There are no import cycles, and the graph has real leaves
(`remote/worker`, `store`, `adapter`, `remote`, `workspace`, `secret`,
`skills`, `terminal`, `notify`, `sessionctx`, `approvalbridge`,
`remote/relay`, `remote/tsnet`). Every edge above is a layering problem, which
is why each stage below is a refactor rather than a redesign.

## Stages

Each stage is behaviour-preserving, ends green on `go build ./...`,
`go test ./...` and `go vet ./...`, and is one commit. The boundary test grows
one rule per stage, so it is never red on `main`.

### S1 — the protocol package becomes a leaf

**What.** Move `internal/remote/worker/registry.go` (the ADR 0020 worker lease
registry) to `internal/hub/workers`. Add a boundary test asserting
`internal/remote/worker` imports nothing else in the module.

**Why.** `internal/remote/worker/protocol.go` is the Hub↔Node wire specification
and already imports nothing internal; ADR 0022 D10 is the reason it must stay
open and stable. A hub-only lease registry living in it is the first step of the
drift the ADR forbids.

**Touches.** `remote/worker/registry.go` and its test, `api/api.go:141`,
`api/workers.go`, `server/server.go:306,571,728,1031`. Purely mechanical: the
file imports only the standard library.

### S2 — divide `internal/node` into its two real halves

**What.** The Hub's half (`adapter.go`, `connections.go`, `conn.go`, `turns.go`,
`approvals.go`, 1459 lines) stays in `internal/node`. The Node's half
(`client.go`, `executor.go`, `approvalrelay.go`, 1112 lines) moves to
`internal/nodeclient`.

**Why.** The package doc says "Package node is the Hub's half of the Node control
channel" (`node/connections.go:1`) and three files in it are the opposite end of
that channel. Until the two halves are separate packages, neither side can be
declared in the boundary test.

**Touches.** Call sites in `internal/server`, `internal/api`. No logic change.

### S3 — `internal/api` stops importing the Hub's insides

**What.** Two independent moves.
- Declare the account surface `api` actually uses (`Accounts`, `OIDC`) as
  interfaces in `internal/api`; `auth.Service` satisfies them. `api` keeps its
  nil-means-disabled behaviour, which it already documents at `api.go:80-158`.
- Move ACME/TLS termination (`remote/hub.go`, `remote.HubConfig`) out of
  `internal/remote` to `internal/hub/acme`, leaving the daemon token and
  transport helpers behind.

**Why.** B2 and B6. `internal/api` is the console API and runs in every role, so
it may not depend on a subsystem only one role has.

**Note.** `internal/api` → `internal/node` (B1) is deliberately left for S4: the
`Nodes`/`NodeFrames` fields are the Hub's channel and belong with the Hub wiring,
not with a generic console API.

### S4 — the composition root gets a seam

**What.** Split `internal/server`'s wiring so the Hub-side subsystems it builds
(auth, accounts, ACME, the Node channel, worker leases, federation) are
constructed on one path and the local-execution subsystems (agent registry, all
nine adapters, terminal, browser worker, MCP, A2A, skills, connectors, eval,
routines) on another, meeting at an explicit interface.

**Why.** B5. This is the stage that actually lets a binary be built without the
agent runtime, and it is the one with real design content.

**Risk.** ADR 0022 D9 — standalone must remain Hub plus an in-process Node on one
scheduling and event path. This stage may not introduce a second path; if the
seam starts to look like two schedulers, stop and reconsider.

### S5 — `cmd/kin-hub`

**What.** Add the second binary. Switch `Dockerfile` and `docker-compose.yml` to
it. Record the before/after `go list -deps` count and the image size.

**Why.** This is the deliverable: a Hub that does not ship ten agent adapters, a
terminal, a browser worker, an MCP host, and an eval runner.

## Separately, and not part of the above

Found while mapping the boundary, and each is its own small fix rather than part
of the split:

- `internal/server/server.go:230` registers the local device with a hard-coded
  `Role: "hub"`. Whether that is wrong depends on whether a machine running
  `--hub` is a Hub locally — the comment above it argues it is. Confirm the
  intent before changing it; `devices.role` has a `CHECK (role IN
  ('node','hub','client'))` constraint it is currently satisfying.
- `internal/remote/import_boundary_test.go` scans imports by hand, line by line.
  A `go list -deps` version is shorter and cannot be fooled by an import
  spelling the scanner does not expect. The new boundary test uses the `go list`
  approach; the old one can follow when someone is next in the file.

## Verification

Per stage, after the change and before the commit:

```bash
gofmt -l $(git diff --name-only HEAD | grep '\.go$')
go build ./...
go vet ./...
go test ./...
```

Before S5's commit, plus `docker build` for the Hub image. After any stage that
touches the console's API surface, `cd ui && npm run build`. The plan changes no
persistence, so migrations and upgrade coverage are untouched.
