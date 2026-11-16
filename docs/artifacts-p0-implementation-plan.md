# Artifacts P0 — Implementation Plan (for implementer)

**Audience:** an implementer who will write the code end-to-end.
**Authoritative spec:** [ADR 0003](./adr/0003-artifacts-and-reader.md) and [TODO.md](./TODO.md) "Theme: Artifacts". This plan turns the P0 checklist into concrete files, functions, and acceptance tests. **Do not invent scope beyond P0.** P1 (companion sidebar, tags/search, artifact-scoped thread) is out of scope for this task.

> **Golden rule:** copy the existing patterns in this repo. Every backend and frontend piece below has a near-identical sibling already in the codebase — mirror it exactly (naming, error handling, JSON shape, styling). When unsure, match the referenced file.

---

## 0. What "done" means (P0 acceptance, from TODO.md)

- [ ] A supervised agent (or the user) produces a study primer (`.md` or `.html`) → user saves it to Artifacts in one or two taps.
- [ ] Same artifact opens on phone through Kin remote without a separate file transfer (this is free once it's an API route + UI page — the remote ladder already proxies all `/api/*`).
- [ ] Artifact retains a working link back to the source task/session.
- [ ] Library survives daemon restart; files remain user-visible on disk under `~/.kin/artifacts/`.
- [ ] HTML artifacts render **sandboxed** (iframe with `sandbox` attr, no same-origin, no scripts). Markdown renders via the existing `Markdown.tsx` component.

**Non-goals for P0:** companion chat, tags, full-text search, archive filters beyond a simple status flag, annotations, wiki extract, file sync.

---

## 1. Architecture (mirrors the existing task/approval slices)

| Layer | New file | Sibling to copy |
|-------|----------|-----------------|
| Schema | add `migration004` in `internal/store/migrate.go` | existing `migration002`/`003` |
| Store model + CRUD | `internal/store/artifacts.go` | `internal/store/approvals.go` |
| Store tests | `internal/store/artifacts_test.go` | `internal/store/store_test.go` |
| Files on disk | write under `ArtifactsDir` | `internal/api/uploads.go` (`uploadsDir`, `MkdirAll(dir, 0o700)`) |
| HTTP handlers | `internal/api/artifacts.go` | `internal/api/api.go` handlers + `internal/api/workspace.go` (path safety) |
| Handler tests | `internal/api/artifacts_test.go` | `internal/api/workspace_test.go` |
| Wiring | `internal/api/api.go` routes + `internal/api/api.go` `Server` struct + `internal/server/server.go` construction | `UploadsDir` field is the template |
| UI client | types + funcs in `ui/src/api/client.ts` | existing `listTasks` / `listApprovals` |
| UI library page | `ui/src/pages/ArtifactsPage.tsx` | `ui/src/pages/TasksPage.tsx` |
| UI reader page | `ui/src/pages/ArtifactDetailPage.tsx` | `ui/src/pages/TaskDetailPage.tsx` |
| Nav + route | `ui/src/App.tsx`, `ui/src/components/layout/Sidebar.tsx`, `ui/src/components/icons.tsx` | existing `/tasks` nav entry |
| i18n | `ui/src/i18n/locales/en.ts` + `zh.ts` | existing `nav.*` keys |

**The remote/phone story requires no new code** — everything is a `/api/*` route behind `s.Auth.Middleware`, which the existing remote ladder already exposes.

---

## 2. Data model

### 2.1 SQLite table (migration004, bump `schemaVersion` to 4)

Add to `internal/store/migrate.go`:

```go
const migration004 = `
CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- 'markdown' | 'html' | 'text'
  rel_path    TEXT NOT NULL,              -- path relative to ArtifactsDir, e.g. '2026/07/<id>.md'
  size        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'proposed', -- 'proposed' | 'saved' | 'archived'
  source_task_id TEXT REFERENCES tasks(id),     -- nullable; provenance link
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_status ON artifacts(status, created_at DESC);
`
```

Then extend `migrate()` following the **exact same shape** as the `if v == 2 { ... }` block: add an `if v == 3 { ... }` block that begins a tx, execs `migration004`, sets `PRAGMA user_version = 4`, commits. Also bump `const schemaVersion = 4`. **Fresh installs**: migration001 runs and jumps straight to `schemaVersion`, so migration001 does **not** create the artifacts table — that is fine because a fresh DB at `user_version=0` runs migration001 then sets `user_version=4` and skips the incremental blocks. ⚠️ **This means a brand-new DB will NOT have the artifacts table.** To avoid that bug, **append the `CREATE TABLE artifacts` statement to `migration001` as well** (same way `kin_messages` appears in both migration001 and migration003). Match that existing precedent exactly.

### 2.2 Kind constants & status constants

In `internal/store/artifacts.go`:

```go
const (
	ArtifactKindMarkdown = "markdown"
	ArtifactKindHTML     = "html"
	ArtifactKindText     = "text"

	ArtifactProposed = "proposed"
	ArtifactSaved    = "saved"
	ArtifactArchived = "archived"
)
```

### 2.3 Go struct (JSON tags mirror `Approval`)

```go
type Artifact struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Kind         string  `json:"kind"`
	RelPath      string  `json:"-"`               // never leak disk layout to clients
	Size         int64   `json:"size"`
	Status       string  `json:"status"`
	SourceTaskID *string `json:"source_task_id,omitempty"`
	CreatedAt    int64   `json:"created_at"`
	UpdatedAt    int64   `json:"updated_at"`
	// Joined from tasks for the list view (optional):
	SourceTaskTitle string `json:"source_task_title,omitempty"`
}
```

---

## 3. Store CRUD (`internal/store/artifacts.go`)

Copy the structure of `approvals.go`. Implement:

- `func (s *Store) InsertArtifact(ctx, a Artifact) error` — INSERT all columns. Default `Status` to `ArtifactProposed` if empty. Use `NowMilli()` for created/updated if zero.
- `func (s *Store) GetArtifact(ctx, id string) (Artifact, error)` — SELECT by id; return `ErrNotFound` on `sql.ErrNoRows` (reuse existing `ErrNotFound`).
- `type ListArtifactsOpts struct { Status string; Limit int }`
- `func (s *Store) ListArtifacts(ctx, opts) ([]Artifact, error)` — LEFT JOIN tasks for `source_task_title`, filter by status if set, `ORDER BY a.created_at DESC LIMIT ?`, default limit 100 / cap 500 (copy the approvals limit logic). Return `[]Artifact{}` (non-nil) when empty.
- `func (s *Store) UpdateArtifactStatus(ctx, id, status string) (Artifact, error)` — UPDATE status + updated_at, then re-`GetArtifact`. Return `ErrNotFound` if 0 rows.
- `func (s *Store) DeleteArtifact(ctx, id string) error` — used when archiving hard-deletes are NOT wanted; for P0 prefer status='archived' over row delete. **Only add Delete if you also delete the file; otherwise skip it and use status.**

Use a shared `const artifactColumns = "id, title, kind, rel_path, size, status, source_task_id, created_at, updated_at"` and a `scanArtifact(scanner)` helper, exactly like `scanApproval`. Handle `source_task_id` as `sql.NullString`.

---

## 4. Files on disk + server wiring

### 4.1 Server field

In `internal/api/api.go` `Server` struct, add next to `UploadsDir`:

```go
// ArtifactsDir is where artifact file bodies are stored. Empty disables artifacts.
ArtifactsDir string
```

In `internal/server/server.go` where `srvAPI := &api.Server{ ... }` is built (around line 255), add:

```go
ArtifactsDir: filepath.Join(stateDir, "artifacts"),
```

### 4.2 Path safety (reuse workspace.go pattern)

Artifact bodies live at `filepath.Join(s.ArtifactsDir, relPath)`. **Generate `relPath` server-side only** — never accept a client-supplied path. Build it as `filepath.Join(yyyy, mm, id+ext)` where ext is `.md`/`.html`/`.txt` by kind. Before any read, verify the resolved absolute path is within `ArtifactsDir` using the same `pathWithinRoot(root, target)` helper that `workspace.go` already defines (either reuse it by exporting/moving it, or duplicate the tiny function — duplicating is acceptable, match its logic). `MkdirAll(dir, 0o700)` before writing, mirroring `uploads.go`.

---

## 5. HTTP handlers (`internal/api/artifacts.go`)

Register these in `internal/api/api.go` inside the **token-auth group** (the `r.Group` that already has `s.Auth.Middleware`), next to the tasks routes:

```go
r.Get("/api/artifacts", s.handleListArtifacts)
r.Post("/api/artifacts", s.handleCreateArtifact)
r.Get("/api/artifacts/{id}", s.handleGetArtifact)          // metadata
r.Get("/api/artifacts/{id}/content", s.handleGetArtifactContent) // raw body
r.Post("/api/artifacts/{id}/status", s.handleSetArtifactStatus)  // {status: "saved"|"archived"}
```

Handler contracts (use existing `writeJSON` helper, chi `URLParam`, and the same error-JSON shape `{"error": "..."}`):

- **`handleListArtifacts`** — read `status` query param, call `ListArtifacts`, `writeJSON(200, list)`.
- **`handleCreateArtifact`** — decode JSON body `{title, kind, content, source_task_id?, status?}`. Validate:
  - `kind ∈ {markdown, html, text}` else 400.
  - `title` non-empty (fallback to `"Untitled"` is fine).
  - `content` size ≤ a sane cap (reuse/define e.g. 5 MiB) else 413.
  - Generate `id` (copy how tasks generate ids — look for the id/ULID helper already used by `InsertTask`; reuse the same generator).
  - Compute `relPath`, `MkdirAll`, write file `0o600`, set `size = len(content)`.
  - `InsertArtifact`, then `writeJSON(201, artifact)`.
  - **If `ArtifactsDir == ""`**: `writeJSON(503, {"error":"artifacts not configured"})` (mirror uploads).
- **`handleGetArtifact`** — metadata JSON; `ErrNotFound` → 404.
- **`handleGetArtifactContent`** — read the file, set `Content-Type: text/plain; charset=utf-8` for md/text, `text/plain` for html too (⚠️ **never** serve stored HTML as `text/html` from this JSON API host — the reader sandboxes it client-side; serving raw text avoids the daemon origin executing it). Return the bytes. 404 if row or file missing.
- **`handleSetArtifactStatus`** — decode `{status}`, validate ∈ {saved, archived, proposed}, call `UpdateArtifactStatus`, return the updated row. Archiving does **not** delete the file in P0.

**Security note (write this as a code comment too):** stored HTML is untrusted. The API must never return it with an executable content-type, and the UI must only render it inside a sandboxed iframe (§7.3).

---

## 6. Capture from a session (P0 = manual save)

P0 is **manual save**, not auto-propose. Wire one entry point:

- On the task detail transcript, add a "Save as artifact" affordance on an assistant message (or a selection). It calls `POST /api/artifacts` with `{title: <derived from first heading or task title>, kind: <"markdown" if the message body looks like md, else "text">, content: <message text>, source_task_id: <task id>, status: "saved"}`.
- Keep kind detection trivial for P0: if content contains `<html` or `<!doctype html` (case-insensitive) → `html`; else `markdown`.
- Do **not** build the propose/accept approval flow in P0 (that's the ADR's future policy). Manual save with `status: "saved"` is enough to hit the acceptance criteria.

Reference the existing message action buttons in `ui/src/components/chat/ChatStream.tsx` / `Transcript.tsx` for where/how to add a button, and `ui/src/pages/TaskDetailPage.tsx` for the task id in scope.

---

## 7. Frontend

### 7.1 API client (`ui/src/api/client.ts`)

Add a type and functions mirroring `listTasks`/`getTask`:

```ts
export type Artifact = {
  id: string;
  title: string;
  kind: "markdown" | "html" | "text";
  size: number;
  status: "proposed" | "saved" | "archived";
  source_task_id?: string;
  source_task_title?: string;
  created_at: number;
  updated_at: number;
};

export function listArtifacts(status?: string): Promise<Artifact[]> { /* apiFetch(`/api/artifacts${qs}`) */ }
export function getArtifact(id: string): Promise<Artifact> { /* ... */ }
export function getArtifactContent(id: string): Promise<string> {
  // apiFetch returns JSON by default; add a text variant or fetch().text().
  // Look at how readTaskWorkspaceFile handles the body; content is plain text.
}
export function createArtifact(body: {
  title: string; kind: string; content: string; source_task_id?: string; status?: string;
}): Promise<Artifact> { /* POST */ }
export function setArtifactStatus(id: string, status: string): Promise<Artifact> { /* POST */ }
```

`getArtifactContent` returns **text, not JSON** — check `apiFetch`'s implementation (line ~53); if it force-parses JSON, add a sibling `apiFetchText` or use the existing `authenticatedURL(path)` + `fetch`. Mirror whatever `readTaskWorkspaceFile` does for file bodies.

### 7.2 Library page (`ui/src/pages/ArtifactsPage.tsx`)

Copy `TasksPage.tsx` layout. Show a list of artifacts (title, kind badge, relative time, source task link if present). Clicking a row → `navigate('/artifacts/:id')`. Default filter to status `saved` (hide `archived`; `proposed` may be shown with a badge). Add an "Archive" action per row calling `setArtifactStatus(id, "archived")`.

### 7.3 Reader page (`ui/src/pages/ArtifactDetailPage.tsx`) — **the security-critical piece**

- Load metadata via `getArtifact(id)` and body via `getArtifactContent(id)`.
- If `kind === "markdown"` or `"text"` → render with the existing `<Markdown text={content} />` component (`ui/src/components/Markdown.tsx`). For `text`, a `<pre>` is also fine.
- If `kind === "html"` → render inside a **sandboxed iframe**:
  ```tsx
  <iframe
    title={artifact.title}
    sandbox=""                       // no scripts, no same-origin, no forms
    srcDoc={content}
    className="w-full h-full border-0 bg-white"
  />
  ```
  **`sandbox=""` (empty) is required** — it forbids scripts, same-origin, popups, form submission, and top-navigation. Do not add `allow-scripts` or `allow-same-origin`. This is the trust boundary from ADR 0003 §Consequences.
- Show a header with the title, a "back to source task" link (`/tasks/:source_task_id`) when `source_task_id` is set, and an Archive button.

### 7.4 Nav, route, icon, i18n

- `ui/src/App.tsx`: add `<Route path="/artifacts" element={<ArtifactsPage />} />` and `<Route path="/artifacts/:id" element={<ArtifactDetailPage />} />` (import both).
- `ui/src/components/layout/Sidebar.tsx`: add a `<NavLink to="/artifacts">` in the bottom nav group next to Tasks/Usage/Settings, using a new icon.
- `ui/src/components/icons.tsx`: add an `IconArtifacts` (a document/book glyph) following the existing icon component signature (`size`, `strokeWidth`, `className`).
- `ui/src/i18n/locales/en.ts` and `zh.ts`: add `nav.artifacts` ("Artifacts" / "产物库") and any page strings (`artifacts.empty`, `artifacts.archive`, `artifacts.backToTask`, etc.). Add keys to **both** locales — a missing key in one is a lint/test failure.

---

## 8. Tests to write (required — CI runs `go test ./...`)

- `internal/store/artifacts_test.go`: open `store.Open(":memory:")` (see `context_pack_test.go`), insert → get → list (status filter) → update status → confirm. Assert `ErrNotFound` on missing id.
- `internal/api/artifacts_test.go`: copy `workspace_test.go` harness. Test: create artifact (201, file written under a temp `ArtifactsDir`), list (200 includes it), get content (200, body matches, content-type is `text/plain`), set status archived (200), and that a client-supplied `../` in any field cannot escape `ArtifactsDir` (path stays contained). Test 503 when `ArtifactsDir` empty.
- Frontend: no test harness change required unless one exists for pages; ensure `npm run build` (or the repo's `tsc`/lint) passes. Run whatever `ui/package.json` defines (`npm run build` / `npm run lint`).

---

## 9. Verification checklist (run before handing back)

```bash
# Backend
gofmt -l internal/          # must print nothing
go build ./...
go test ./internal/store/ ./internal/api/

# Frontend
cd ui && npm run build       # or: npm run lint && npx tsc --noEmit
```

Manual smoke (implementer should do this):
1. Start the daemon, create an artifact via `curl -H "Authorization: Bearer $TOKEN" -X POST .../api/artifacts -d '{"title":"T","kind":"markdown","content":"# hi"}'`.
2. Confirm a file appears under `~/.kin/artifacts/<yyyy>/<mm>/<id>.md`.
3. Restart the daemon; `GET /api/artifacts` still lists it (survives restart).
4. Open the UI `/artifacts`, click through to the reader, confirm markdown renders and an HTML artifact renders inside a sandboxed iframe (view source: `sandbox=""`).

---

## 10. Constraints & style (do not violate)

1. **Match existing patterns exactly.** Error JSON is `{"error": "..."}`. Handlers use `writeJSON`. Store methods return `ErrNotFound`. Timestamps are `NowMilli()` (ms since epoch).
2. **Never trust client paths.** `rel_path` is server-generated only; validate containment with the `workspace.go` helper.
3. **Never serve stored HTML with an executable content-type**, and only render it in `sandbox=""` iframes.
4. **Migrations are append-only.** Add migration004; also append the CREATE to migration001 so fresh installs get the table. Never edit an already-shipped migration's body.
5. **Don't touch `web/dist/`** — it's a build artifact; the UI build regenerates it.
6. **Stay within P0.** No companion chat, tags, search, or auto-propose. If tempted, stop and leave a `// TODO(P1):` comment instead.
7. Add doc comments to every exported Go symbol (the repo does this consistently).
8. Update the P0 checkboxes in `docs/TODO.md` as you complete each item.

---

## 11. Suggested commit order (small, reviewable steps)

1. `store: artifacts table (migration004) + model + CRUD + tests`
2. `api: artifacts routes (list/create/get/content/status) + path safety + tests`
3. `server: wire ArtifactsDir`
4. `ui: artifacts client + library page + sandboxed reader + nav/route/i18n`
5. `ui: manual "save as artifact" from task transcript`
6. `docs: check off Artifacts P0 in TODO.md`

Each commit should build and pass tests on its own.
