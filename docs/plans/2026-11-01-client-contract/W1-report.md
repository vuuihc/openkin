# W1 — Contract coverage and authentication

Status: **complete**. Code commit: `15e19081` on
`lody/w1-client-contract-api`; this report follows in its own commit.
Date: 2026-11-01.

## Result

`./scripts/check-api-coverage.sh` exits 0:

```
routes: 181 registered, 165 documented operations, 121 client paths
note: 16 registered operations are not in the spec (run with --verbose to list)
OK: every client-used path and method is documented and registered; no stale paths
```

The P0 operations named in the program plan — `GET /api/sessions` with
`updated_since`, `/api/events`, `/api/sessions/wait`, task detail, prompt,
approvals, and questions — were already present in the base spec. The measured
gaps were elsewhere: the spec declared no `securitySchemes`, and 68 paths that
a shipped client calls had no entry. Two client calls also used a method the
spec did not declare (`DELETE /api/tasks/{id}` and
`PUT /api/tasks/{id}/workspaces/{id}/file`). Those are now covered, and the
check that keeps them covered runs on every change set.

## Changes

### `scripts/check-api-coverage.sh` (new)

Compares three path sets, with every path parameter normalised to `{}`:

1. Routes registered by the chi router in `internal/api` (read from the
   registration calls and `r.Route` prefixes, not a hand-kept list),
   including routers it mounts. A mount such as `r.Mount("/a2a",
   s.A2A.Handler())` is resolved to the package whose name appears in the
   expression and whose `Handler()` builds a `chi.NewRouter()`; that router's
   registrations are parsed under the mount prefix. An unresolvable mount
   fails the check rather than exempting its subtree.
2. Paths declared under `paths:` in `api/openapi.yaml`.
3. API paths (`/api/…`, `/a2a/…`) used by `ui/src`, `desktop/src`, and
   `mobile/`, found inside string literals so `${base}/api/health` and
   `wss://${host}/api/terminal/...` are seen as well as bare `/api/...`.

It fails on a client-used path that is undocumented or not registered, and —
when the call makes its method visible — on a client-used method that is
undocumented or not registered. A call's method comes from the request-init
argument of its `fetch`/`apiFetch`/`authFetch` call (the third argument for
`authFetch`, which takes the token second); a call with no init is GET, and an
init that is a variable or whose spread can override the method leaves the
method unknown, so that call is compared by path only. Only a top-level
`method: "<literal>"` counts: a nested object's key, a comment, or a shorthand
property does not. It also fails on a documented operation whose method+path
is not registered, on a mounted router it cannot locate, and on a client
literal whose shape it cannot compare (for example `/api/tasks/${id}.json`),
because collapsing those to the parent path would silently mark an
undocumented child as covered. A whole-segment interpolation is always a
parameter, even when it is written `${id ?? ""}`; only a variable named for a
query or a ternary carrying a literal query string ends the path.

Routes that are registered but undocumented are reported as a count (listed
with `--verbose`) but are not drift: some surfaces are deliberately outside
the client contract.

The console is scanned as a whole (`ui/src`), not only its `api/` layer,
because URL literals also live beside the components that use them. That is
how the previously invisible terminal WebSocket path was found. Template
literals are read through nested `${...}` interpolations and comments are
skipped, so a backtick in prose cannot swallow the literal after it.

Red verification (`scripts/mutants.py`, 7/7 detected): renaming the a2a
`tasks/{id}/events` route, changing a documented client `POST` to `PUT` in a
console `apiFetch` call, in a nested-generic `apiFetch<Record<string,
unknown>>` call, and in a desktop `authFetch` call, appending `.json` to a
client task path, making a task-id interpolation nullish
(`${id ?? ""}/missing`), and making the `/a2a` mount expression unresolvable
each make the check exit non-zero.

### `scripts/check.sh`

Adds an always-on `api-coverage` job. It cannot be gated on changed files: a
new client call is drift even when neither the spec nor the Go router changed,
and neither the Go nor the console job sees it.

### `api/openapi.yaml`

- Root `security` plus `components.securitySchemes`: `bearerAuth`,
  `sessionCookie` (`kin_session`), `tokenQuery` (`?token=`), and relay
  `room`/`key` transport parameters.
- `info.description` documents the four credentials, how a device is paired
  (including the recovery header), how accounts and browser sessions work,
  the operator/holder/loopback authorization classes, and which surfaces are
  optional (`/a2a/*` behind `KIN_A2A_ENABLED=1`; terminal routes on a local
  desktop only).
- 73 new paths, 90 new operations, and 104 new schemas, all additive. The
  largest groups are auth/accounts, agents, projects and one-pagers,
  providers, routines, routing, machines, source/workspace reads, uploads,
  and usage. Public operations (`/api/health`, `/api/version`,
  `/api/pairing/exchange`, share links, the root agent card) override the root
  requirement with `security: []`; the `/a2a` mount and its agent-card alias
  stay authenticated.
- The terminal WebSocket (`GET /api/terminal/sessions/{id}/ws`) is documented
  with its frame protocol and error statuses.
- Contract corrections found during review: a device token cannot read or
  write terminals (loopback + operator only); `/api/auth/me` is cookie-only;
  the pairing exchange carries `X-Kin-Pairing-Recovery` and its 200 recovery
  response; the recovery window is five minutes from the exchange, not from
  the pairing session's creation; a pairing-session request body is required
  (an absent body is 400); manual routing preview requires agent, provider,
  and model; routine deletion can answer 409 and run-now can answer 400;
  `runs=1` always returns the page object; a one-pager `updated_at` is an
  optimistic lock (409), not client bookkeeping; all six project subresources
  can answer 503; artifact creation can answer 413; source reads carry their
  remote-machine statuses (409/500/501/503/504) instead of an unreachable
  403; the legacy workspace write answers 400/403/404/409/413 and cannot
  answer 503; the pairing-session, device-list, and device-revoke descriptions say
  they are operator-only; `TaskLimitWait`
  records seconds for `reset_at` and milliseconds for the other timestamps.

### `ui/src/api/generated/openapi.ts`

Regenerated with `npm run generate:api`; the checked-in file matches a fresh
generation (`scripts/check-openapi.sh`).

No Go handler, database, desktop, or mobile source was changed, so runtime
behavior and existing response shapes are untouched.

## Coverage before and after

Measured with the final script; “before” is `HEAD` (commit `cc96de57`) with
the same client scan and the same mounted-router parsing.

| Measure | Before | After |
|---|---:|---:|
| Client-used paths | 121 | 121 |
| Client-used paths not documented | 68 | **0** |
| Client-used paths not registered | 0 | 0 |
| Client-used methods not documented (where visible) | 2 | **0** |
| Client-used methods not registered (where visible) | 0 | 0 |
| Documented operations no longer registered | 0 | 0 |
| Registered operations not documented | 106 | 16 |
| Spec paths | 70 | 143 |
| Spec operations | 75 | 165 |
| Spec schemas | 66 | 170 |

The “before” run counts the seven routes of the mounted `/a2a` router, which
the final script parses; the base spec documents six of them. The original
three-root, bare-literal scan (the program plan's literal scope) reported 118
client paths and 67 undocumented; the final scan is a superset that also sees
the terminal WebSocket and paths embedded in larger URLs.

The 16 registered-but-undocumented operations left are deliberately outside
the client contract: the loopback-only internal approval/question bridge (4),
`/mcp`, `/api/node` (the node control channel), the connectors API (8),
`/api/routines/health`, and `/api/cloudflare/oauth/callback`. They are listed
by `./scripts/check-api-coverage.sh --verbose`.

## Commands and results

| Command | Result |
|---|---|
| `./scripts/check-api-coverage.sh` | exit 0; 181 routes, 165 documented operations, 121 client paths |
| `./scripts/check-api-coverage.sh --verbose` | exit 0; lists the 16 undocumented registered operations |
| `./scripts/mutants.py` (7 mutants) | 7/7 red: a2a route rename, console/nested-generic/desktop POST→PUT, uncomparable child path, nullish segment, unresolvable mount |
| `./scripts/check-openapi.sh` | exit 0; generated types match the spec |
| `cd ui && npm run generate:api` | regenerated `src/api/generated/openapi.ts` (openapi-typescript 7.9.1) |
| `go test -timeout 300s -count=1 ./internal/api/...` | pass (`ok …/internal/api 43.696s`) |
| `./scripts/check.sh` | 12/12 jobs pass: gofmt, vet, gotest, desktop-test, desktop-tsc, ui-test, ui-tsc, api-contract, api-coverage, shell-syntax, python-syntax, stories |
| `ruby -ryaml -e 'YAML.load_file("api/openapi.yaml")'` | parses cleanly |

`desktop/node_modules` was missing in the worktree at first, which made the
`desktop-tsc` job fail on an unrelated missing dependency; `npm ci` in
`desktop/` restored it and the job passed.

## Review

Four high-model review passes were run on the frozen tree.

The first pass reported one blocker, three majors, and eleven nits:

- Blocker: the `/a2a` mount exempted its whole subtree from comparison, so a
  renamed subroute would pass. The check now parses the mounted router and
  fails on a mount it cannot resolve.
- Major: client calls were compared by path only. Methods are now inferred
  where the call makes them visible; this found two real base-spec omissions
  (`DELETE /api/tasks/{id}` and
  `PUT /api/tasks/{id}/workspaces/{id}/file`).
- Major: an interpolation that was not a whole path segment collapsed the URL
  to a documented parent. Such literals now fail as uncomparable.
- Major: the pairing-session body was documented as optional while the
  handler refuses an absent body.

The second pass reported no blocker and four majors, all fixed:

- `listProjectArtifacts` was missing the 503 the other project subresources
  gained.
- The legacy workspace write documented an unreachable 503 and omitted the
  reachable 404 from the task-scope guard.
- A whole-segment nullish interpolation (`${id ?? ""}`) still collapsed to
  the parent path. Whole segments are now always parameters; only a query
  variable or a ternary carrying a literal query string ends the path.
- Desktop `authFetch(path, token, init)` takes the init third, so its methods
  were never compared. The init argument is now per-function.

The third pass reported no blocker and one major: a call with a nested
generic (`apiFetch<Record<string, unknown>>`) was not recognised as a call
at all, so its method was never compared. The call scanner was replaced with
one that reads code only — skipping strings and comments — then balances a
generic argument list (braces, semicolons, arrow-function `=>`, nested angle
brackets, and quoted `>` included) before requiring `(`. A quoted `"method"`
key is now recognised. On the same tree it associates 137 client methods
against the previous scanner's 136; the only addition is
`POST /api/tasks/{id}/replay`, and a POST→PUT mutation of that call is now
red.

The fourth pass, focused on that delta, confirmed the nested-generic and
inline-object-type calls are checked, no method association was lost, and
the quoted-key and query-suffix probes behave as intended. It reported no
surviving blocker or major. Its residual observations — a comparison-shaped
`apiFetch < a > (…)` read as a generic call, a top-level string value
`"method"` read as a key, comments inside type arguments, a call written
inside `${…}`, a trailing-slash whole-segment query suffix, and the `enrol`
wrapper — are recorded under open questions; no current client code has any
of those shapes.

The first pass also corrected the terminal WebSocket's absence from the scan,
`/api/auth/me` being declared public, the prose-only pairing recovery,
over-claimed device-token terminal access, manual routing preview's required
fields, routine deletion's missing 409, the one-pager optimistic lock, and
the limit-wait timestamp units. The remaining nits were parser/documentation
limits and are recorded below.

## Open questions

- The check is literal-based. It cannot see a URL whose path is assembled in a
  variable and passed to `apiFetch(path)`. No such construction exists in the
  scanned roots today; the literal shapes it cannot compare fail loudly rather
  than collapsing to a parent. Method comparison is likewise limited to calls
  whose request init is an object literal: a method carried in a variable or a
  spread leaves that call compared by path only. A shared wrapper that takes
  the path as a parameter (`enrol(path, …)` in `ui/src/api/account.ts`) keeps
  its literal at the wrapper's call site, so the wrapper's POST is compared by
  path only; the callers' paths are still covered.
- Mount resolution is a heuristic: it looks for an `internal` package whose
  name appears in the handler expression and which builds a `chi.NewRouter()`
  in a `Handler()` method. A second mounted router with an ambiguous name
  would fail the check (not resolve silently) until the matcher is taught
  about it.
- The nested-template scanner counts braces inside `${...}` without parsing
  strings inside the expression. A `}` inside a nested string there would
  desynchronize it; no current call site has that shape.
- A comparison-shaped expression (`apiFetch < a > ("/api/…")`) is read as a
  generic call, so it can be method-checked as if it were a request. The
  regex this replaced had the same blind spot; removing it needs a real
  TypeScript parser. No current call has that shape.
- A top-level string value `"method"` in an init object is read as a quoted
  key and resets the method to unknown, so `{ method: "PUT", note: "method" }`
  would not fail. No current call has that shape.
- `generic_end` does not skip comments inside a type-argument list, and a call
  written inside a template's `${…}` is not scanned. Neither shape exists in
  the current client code.
- A whole-segment interpolation is assumed to be one path segment even if its
  runtime value contains `/`; a path suffix after a trailing slash
  (`${id}/${qs ? …}`) is read as a second segment, which fails loudly rather
  than passing silently. No current call has either shape.
- The program plan names `ui/src/api` as the console source; the check scans
  all of `ui/src`. This is a deliberate superset: restricting to `api/` hid a
  real call in `ui/src/lib/terminal.ts`.
- Out-of-repo clients and non-`/api` paths (share links under `/s/{token}`,
  the root agent card) are outside the scan. The contract they use is the
  spec's, not a repo literal.
- The 16 undocumented registered operations remain. Some (connectors, node
  control, `/mcp`) are not part of the P0 client loop; documenting them would
  be a separate contract decision, not drift.
