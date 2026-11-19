# ADR 0032: Documents Open Outside the Console

**Status:** Accepted (CEO, 2026-11-19; documentation only)
**Date:** 2026-11-19
**Related:** `rsi/GOAL.md` P9 out-of-scope ("PDF and Office preview … one ADR, then one PR") · RSI queue row 7 (`R-preview-adr`) · `internal/api/secure.go` (`consoleCSP`) · `internal/api/workspace_generations.go` (`rawFileType`) · `ui/src/components/workspace/workspacePreview.ts` · `ui/src/components/workspace/WorkspacePanel.tsx` · `ui/src/components/workspace/FilePreview.tsx` · `ui/src/components/workspace/CodeViewer.tsx` · `ui/src/components/workspace/OpenInMenu.tsx` · `ui/src/lib/desktop.ts` · `desktop/src/window.ts` · `desktop/src/ipc.ts` · `desktop/src/preload.ts`

## Context

Open a `.pdf`, `.docx`, `.xlsx` or `.pptx` from the workspace file panel and the pane
shows the file's name, one sentence — "This file type cannot be shown here. Download it
to open it." (`workspace.viewer.binaryHint`) — and a Download button. The classification
is deliberate: `workspacePreview.ts` keeps those extensions in `BINARY_EXTENSIONS` and
maps them to the `binary` preview; `rawFileType` types a `.pdf` as `application/pdf` with
`drawable=false`, and an Office extension falls through its image list to
`application/octet-stream` with `drawable=false`. A PDF is recognized and still not drawn.

Reading the document therefore means leaving the console for the OS viewer, on the flow —
review → read what changed — where the conversation is supposed to be enough. That gap is
real. It is also not a UI task, because three boundaries stand between the panel and a
rendered document.

**The console's CSP closes the document surface.** `consoleCSP` in
`internal/api/secure.go` sets `object-src 'none'` and carries no `frame-src`, so frames
fall back to `default-src 'self'` and a `blob:` document frame is denied. `img-src` and
`media-src` do carry `blob:`, because image and media previews draw bytes the console
decodes itself — a narrow allowance for decoders the console owns, not a licence for a
document frame. The security headers in the same file also send `X-Frame-Options: DENY`,
and the policy carries `frame-ancestors 'none'`.

**No renderer is installed.** `ui/package.json`, `desktop/package.json` and `go.mod` name
no PDF or Office parser. `rawFileType`'s own comment keeps SVG out on purpose — "as a
document it can carry script" — which is the same question a PDF or Office renderer
reopens, with a larger attack surface. MANDATE admits a new dependency only through a
facade/ADR PR left open.

**A document URL cannot become a window in the desktop shell.** `setWindowOpenHandler` in
`desktop/src/window.ts` allows only `isAllowedURL` targets — `about:`, or http(s) on the
daemon host and port — denies the Electron window for anything else, and hands that URL
to `shell.openExternal`. `will-navigate` blocks the same set. A `blob:` document URL sent
that way would land in the OS browser without the app's session, where it cannot resolve.

**The affordance the need asks for already exists, for the panes that have a header.**
The desktop shell exposes `kin:list-external-apps` and `kin:open-in-app` through its
bridge (`ui/src/lib/desktop.ts` on the renderer side, `desktop/src/preload.ts` and
`desktop/src/ipc.ts` in the shell), and `OpenInMenu` drives it: it hides itself when
`isKinDesktop()` is false, and otherwise opens an absolute workspace path in an installed
app or Finder. Today it renders in the code viewer header (`CodeViewer.tsx:699`) and the
HTML preview header (`FilePreview.tsx:448`) — but not in the undrawable branch of
`WorkspacePanel.tsx`, which renders `DownloadPreview` with Download alone.

## Decision

**Do not add an in-app PDF or Office renderer now. A document opens outside the console,
from the console.**

The smallest next PR is one affordance: render the existing `OpenInMenu` beside Download
in the undrawable-file preview — the `preview === "binary"` branch that renders
`DownloadPreview` — passing the same workspace root the HTML pane already passes
(`normalizeFileResponse(file)?.root || cwd`, `WorkspacePanel.tsx:1482`). The hint changes
to name both honest routes: download the file, or, in the desktop app on this Mac, open it
in an installed application.

That PR adds no endpoint, no dependency and no CSP change. `OpenInMenu`'s existing
`isKinDesktop()` gate keeps browser and phone on Download alone, so both surfaces keep the
sentence and the button they have. "Open in…" takes an absolute path and hands it to a
local app, so it is honest only when the node's filesystem is the shell's; when the bridge
refuses, the menu shows the refusal rather than pretending the file opened.

This ADR is the decision record, not the change. The menu, the rewritten hint in both
locales, and the 390/1100 screenshots are the next PR's delivery.

## Consequences

- The empty state stays honest about why: the console does not render documents, and the
  two routes that do work are named on the pane instead of one.
- A remote node and the phone still download. "Open in…" is desktop-only and assumes the
  node runs on the same machine as the shell — the same assumption the shell already makes
  wherever it hands a workspace path to a local app.
- The security posture does not move: no decoder in the browser, no document frame, no
  widened CSP, no new dependency, and no new endpoint whose auth or bounds need review.
- Reading a document still means leaving the conversation. That is the cost accepted for
  this round, and it is smaller than a second rendering pipeline the product would own.
- Revisit when in-app reading is a repeated request rather than one review-time need. That
  revisit is a renderer ADR — dependency, CSP, sandbox and an evidence plan — not a
  drive-by dependency; this ADR does not block it.

## Alternatives considered

- **Bundle a renderer** (`pdfjs-dist`, a docx/xlsx parser). Rejected: a new dependency and
  a decoder-owned document surface, admitted only through a dependency ADR (MANDATE). It is
  the largest step, not the smallest, and it buys nothing for Office without a second
  parser.
- **Widen the CSP** (`frame-src`/`object-src blob:`) and let Electron's built-in PDF viewer
  draw it. Rejected: it loosens a boundary the console deliberately closed (`object-src
  'none'`, `X-Frame-Options: DENY`) for a format whose readers have historically run
  script.
- **Convert on the node** (LibreOffice or similar). Rejected: a new process dependency on
  the user's machine and a second rendering pipeline, for a file the OS already knows how
  to open.
