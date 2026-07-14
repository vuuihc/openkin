# Implementation notes

Deviations from [MVP_TECH_SPEC.md](./MVP_TECH_SPEC.md), gotchas, and discovered CLI behavior.

## M0

### Auth exemptions for health/version

Spec §6: *All `/api/*` require Authorization: Bearer or `?token=`.*

M0 deliverable explicitly requires `GET /api/health` without auth. `/api/version` is also left unauthenticated so operators and load balancers can probe without the secret. All other `/api/*` routes (starting with `/api/tasks`) enforce token auth.

### UI embed path: `web/dist` not bare `web/`

Spec layout shows `web/` as the Vite build output. Vite's `emptyOutDir: true` would delete a co-located `web/embed.go`. Build output therefore goes to `web/dist/`, and `web/embed.go` embeds `all:dist`. The public URL path is still `/` (contents of `dist` are served at the HTTP root).

### Dependencies not yet pulled

§2 lists packages used in later milestones. M0 only requires:

- `github.com/go-chi/chi/v5`
- `modernc.org/sqlite`

Not yet in `go.mod` (will add when first used): `creack/pty`, `nhooyr.io/websocket`, `oklog/ulid`, `tailscale.com/tsnet`, `skip2/go-qrcode`, `oapi-codegen`. UI has `zustand` and `react-router-dom` (router needed for nav skeleton; not listed in §2 table but implied by multi-page §9).

### `react-router-dom`

§2 UI row names Vite/React/TS/Tailwind/zustand only. Client-side routes for Tasks / Approvals / Settings need a router; `react-router-dom` v6 is used. No other state/query libraries.

### OpenAPI / codegen deferred

`api/openapi.yaml` and oapi-codegen are §2 choices for the full API surface. M0 hand-writes the three endpoints; OpenAPI lands when the surface stabilizes (M1+).

### CGO

Confirmed pure Go: `modernc.org/sqlite` only. No `CGO_ENABLED` requirement; builds with `CGO_ENABLED=0`.
