# ADR 0034: The Browser Panel Lives in the Desktop Shell

**Status:** Accepted as design (CEO, 2026-11-20). Implementation is a separate row; no code ships in this PR.
**Date:** 2026-11-20
**Related:** `docs/plans/2026-11-02-lody-parity-gap-report.md:17` (the parity report's six, item "多标签工作区侧栏 + 浏览器面板") · RSI row `R-browser-panel-adr` · `internal/api/secure.go:20-31` (`consoleCSP`; `object-src 'none'` at `:28`, `frame-ancestors 'none'` at `:31`) · `desktop/src/console-url.ts:14` (`isAllowedURL`) · `desktop/src/window.ts:224-226` (the console's `webPreferences`), `:334-345` (`will-navigate`, `setWindowOpenHandler`) · `desktop/src/preload.ts:49` (`window.kinDesktop`) · `ui/src/lib/panels.ts:28` (`PANEL_IDS`), `:101-104` (`terminal`, the `ctx.desktop` gate) · `ui/src/lib/desktop.ts:27` (`KinDesktopAPI`), `:46` (`Window.kinDesktop`) · `mobile/capacitor.config.ts:26` (the native bridge is injected into every main-frame document) · `desktop/package.json:13` (`node --test`), `:20` (`electron: ^33.2.1`)

## Context

The parity report puts a browser panel in its top six, and the need is concrete: look at a
local dev server or a URL without leaving the console. Kin can already hand a workspace
file to an installed app (ADR 0032), but there is no surface that loads a page. Three
boundaries stand between the console and one.

**The console cannot frame a third-party page.** `consoleCSP` is `default-src 'self'` with
no `frame-src` (`internal/api/secure.go:20-31`), so a frame falls back to `'self'` and a
third-party iframe or `blob:` document is refused. `object-src 'none'`, `frame-ancestors
'none'` and `X-Frame-Options: DENY` close the neighbouring doors. This is deliberate, not
an oversight: the policy's own comment says the right CSP is one that never has to list a
CDN.

**The console window must never become the page.** `isAllowedURL`
(`desktop/src/console-url.ts:14`) admits `about:` or http(s) on the daemon host and port,
and nothing else; `will-navigate` and `setWindowOpenHandler`
(`desktop/src/window.ts:334-345`) enforce it, sending other URLs to `shell.openExternal`.
That window also carries the preload that exposes `window.kinDesktop`
(`desktop/src/preload.ts:49`) — including `openInApp(absolutePath, appId)`, a
local-filesystem primitive. Arbitrary web content must never share that renderer.

**The phone is worse, not easier.** The phone is a Capacitor WKWebView that loads the Hub
console, and Capacitor injects the native bridge into every main-frame document
(`mobile/capacitor.config.ts:26`). A third-party origin in that webview would receive the
plugin surface, including the pending auth callback. The config's own comment already
explains why `allowNavigation` stays empty.

The desktop shell, by contrast, is already native code that supervises a local daemon,
posts notifications and opens files in local apps. A child web view is a smaller step than
it sounds — but it is a new renderer with network access, its own session and a new trust
boundary. This ADR writes that boundary down before the code exists.

## Decision

**A browser panel exists only in the desktop shell. It is a `WebContentsView` the shell
owns, not a frame in the console. The console's CSP and the window's navigation lockdown do
not move. The phone keeps the system browser. The Hub never proxies a node-local URL.**

### 1. Surface: a fifth panel, desktop-gated

`PANEL_IDS` (`ui/src/lib/panels.ts:28`) gains `browser` as a fifth id, with a descriptor
whose `available` is `(ctx) => ctx.desktop` — the same gate `terminal` uses
(`ui/src/lib/panels.ts:101-104`) and the same reason: the panel is a view of the machine
running the console. On the phone the id is not offered at all. A disabled panel that
could never load is worse than no panel; the phone gets a sentence and the system browser.

### 2. Rendering: a `WebContentsView` the shell owns

The shell creates a `WebContentsView` (Electron `^33.2.1`, `desktop/package.json:20`) and
adds it to the window's view tree as a sibling of the console's webContents. The console
renders a placeholder rectangle where the panel body goes and reports that rect; the main
process sets the view's bounds, clamped to the console's content bounds. The view is not an
iframe and not a `<webview>` in the React tree (see Alternatives), and the console never
receives a handle to it — it can only ask the shell to load a URL into a view the shell
already owns.

The shell has never positioned a native child view before (`desktop/src` has no
`contentView` use today), so resize, panel collapse, focus and window-state restore are new
code in the implementation row. A native view also paints above the console's page; a
console overlay that must cover the panel rectangle (the command palette, a dialog) needs
the shell to hide or detach the view. That coordination belongs to the implementation row
and a missed case is a visual defect, not a security one.

### 3. Isolation of the view

The view's webPreferences are `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, and **no preload** — so the page sees no `window.kinDesktop` and
there is no IPC channel from the page. Its session is its own partition,
`persist:kin-browser`, never the console's session:

- a dev-server login survives an app restart, and that persistence is the point;
- the cookie jar is shared by every workspace on the machine, like one OS browser profile,
  not scoped per task;
- signing out of a dev server is that server's own logout; a "clear browsing data" action
  is not in v1, and nothing in the console claims otherwise.

Additionally, in the view's session and webContents:

- permission requests are denied by default (camera, microphone, geolocation,
  notifications, clipboard read) — no prompt is forwarded to the person;
- `window.open` is denied; a popup URL that passes the URL rule is handed to the OS
  browser, never opened as a second Kin window;
- downloads are denied in v1 (`will-download` is prevented);
- devtools are off in v1.

### 4. URL rule and the one bridge message

Only `http:` and `https:` load. `file:`, `data:`, `blob:`, `javascript:`, `about:` and
everything else are refused, and a refused load leaves the view blank rather than showing
the previous page under a new address. The rule applies to every top-level navigation, not
just the first: `will-navigate` and `will-redirect` are checked too, so a redirect cannot
land a refused scheme after an allowed start. The panel header shows the full URL and its
origin.

The console asks the shell to load a URL over **one narrow bridge message**, a new optional
member of `KinDesktopAPI` (`ui/src/lib/desktop.ts:27`) alongside the existing optional
`markConsoleInteractive`. The same message carries the panel rectangle — a call with a URL
opens and loads, a bounds-only call repositions the existing view — so the console gains
one method, not a general IPC surface. That message can only load the browser view: the
IPC handler takes no window or target argument, and the main process holds the console
window and the browser view as separate objects, so there is no path from the renderer to
`consoleWindow.loadURL`. The shell re-validates the scheme itself with a pure module
(`desktop/src/browser-url.ts`) and never trusts the renderer's check. In the other
direction the shell reports the URL it actually loaded (or the load that failed) over the
same one-way channel, so the header cannot claim a page that is not there; that is a
report, not a second capability.

The shell's own rule is not `isAllowedURL`: that function is the console window's rule
(daemon host and port only) and reusing or loosening it would move the navigation lockdown
this ADR exists to preserve. `browser-url.ts` is a separate, narrower predicate:
absolute http(s) only.

### 5. Phone: no embedded browser

The phone does not get the panel. A URL on the phone opens the system browser — a real
session, the platform's isolation, one tap — and the copy says that is what will happen. No
nested webview is added: the Capacitor bridge reaches every main-frame document
(`mobile/capacitor.config.ts:26`), and an in-app browser would either receive that bridge or
require a new native plugin and a second webview with its own permission and cookie
behaviour. That is a separate decision with its own ADR, not a side effect of this one.

### 6. The Hub does not proxy node-local URLs

The Hub never fetches a node's `http://localhost:<port>` or LAN address on a phone's behalf.
Doing so would make the Hub an SSRF bridge into every node's loopback and LAN, under the
Hub's authority and reachable by anyone who can see the task; it would also route page
bytes and cookies through a relay that is not meant to carry them. This is refused, not
deferred. A phone that needs to see a dev server has the system browser and, if the server
is reachable on the LAN, its address — the same reach any browser on that network has.

### 7. Loopback is the use case

On desktop, `http://localhost:<port>` is allowed and is the main reason the panel exists:
the shell and the daemon share the machine, and a dev server is usually on loopback. The
rule is by scheme, not by host, so the view can also reach any http(s) host the machine can
reach, including the LAN and the daemon's own console URL — the same set the OS browser on
that machine reaches. What it cannot do is read local files, run `javascript:`, borrow the
console's session, or borrow the console window's bridge. The console makes no claim that
the phone can reach the same address.

## Consequences

- The console's security posture does not move: no CSP change, no `webPreferences` change on
  the console window, no new preload surface, no new dependency. The phone is unchanged.
- While the panel is open there is one more renderer process with network access. It has no
  node integration, no preload and no console session; it is a separate cookie jar
  (`persist:kin-browser`) with all the honesty and all the limits stated in §3.
- A native view is not a DOM node: it paints above the console page, so console overlays
  that must cover the panel need coordination from the shell. This is the price of not
  widening the CSP, and it is accepted.
- The bridge member is optional, the same pattern as `markConsoleInteractive`. A new console
  in an older shell must hide the panel when the method is absent rather than draw a
  rectangle that cannot load.
- The panel asks for one URL and shows one page. That is the whole v1 contract; anything
  that suggests tabs, history or downloads is a later ADR.
- The view's host rule is the scheme. Loading a page that then talks to `localhost` from
  inside the page is ordinary web behaviour and is not mediated by Kin; the daemon's own
  auth is unchanged.

## Alternatives considered

- **An iframe plus a widened CSP.** It would need `frame-src` for http(s) and localhost,
  which permanently widens a policy that deliberately lists no third party. It would put
  web content in the console's document tree and renderer process, where the preload that
  exposes `window.kinDesktop` lives — the same-origin policy would be the only wall between
  a page and `openInApp`. And `X-Frame-Options: DENY` / `frame-ancestors` on real sites
  (GitHub, dashboards, many dev tools) would leave the panel blank for exactly the pages
  people want, indistinguishable from a broken page. Rejected: a permanent policy widening
  for a feature that would fail on a large share of URLs.
- **`<webview>` in the React tree.** It isolates the guest process, but enabling it is a
  change to the console window's `webPreferences` (`webviewTag: true`) — the window this
  ADR keeps still — and the tag lives in the renderer that holds the preload. Electron's
  documentation itself discourages the tag and does not guarantee its API. It also leaves
  the URL rule in React, i.e. on the renderer side of the trust line. Rejected: the
  boundary would live on the wrong side.
- **A phone in-app browser.** The Capacitor webview carries the native bridge into every
  main-frame document (`mobile/capacitor.config.ts:26`); a third-party origin there receives
  the plugin surface. A nested webview is not available in the current shell, and an in-app
  Safari view would be a new native plugin with its own permission and cookie behaviour.
  The phone's job is quick review; one tap to the system browser keeps the user's real
  sessions and the platform's isolation. Rejected for v1.
- **A Hub URL proxy.** The Hub would fetch `http://127.0.0.1:<port>` or a LAN address on
  behalf of a phone. That makes the Hub an SSRF bridge into every node's loopback and LAN,
  under the Hub's authority, and puts page bytes through a relay not meant to carry them.
  Rejected outright, not deferred.
- **OS browser only, no panel.** Honest and free: a URL action calls `shell.openExternal`.
  But the need is to look at a dev server *while* reading the conversation; the OS browser
  takes the whole screen and the localhost page has its own session with no link back to the
  task. This is the fallback if the implementation row cannot close the isolation or
  evidence questions. The panel earns its native surface only because the shell already
  runs native code and the boundary fits in this page.

**What would reverse this.** If the implementation cannot deny permissions, downloads and
popups, or cannot keep the URL rule out of the console window's `webPreferences`, fall back
to the OS-browser answer. If a console overlay cannot reliably cover the native view and
the workaround distorts the console, that is a second reason to fall back. If phone preview
becomes a repeated request, it gets its own ADR with its own bridge and session argument;
this one does not extend to it.

## Evidence seam

The shell has no DOM harness: `desktop` tests are pure `node --test` over modules
(`desktop/package.json:13`) with no Electron host. So the URL rule must live in
`desktop/src/browser-url.ts` and be proven by a table test, `browser-url.test.ts`, in that
suite:

- accepted: `https://example.com`, `http://localhost:5173`, `http://127.0.0.1:3000`,
  uppercase `HTTPS://example.com` (normalised by the URL parser);
- refused: `file:///etc/hosts`, `data:text/html,hi`, `blob:https://example.com/x`,
  `javascript:alert(1)`, a tab/newline-obfuscated `java\tscript:alert(1)` (the URL parser
  strips the characters, so the check still sees `javascript:`), `about:blank`, `ftp://`,
  an empty string, a relative path, and a malformed URL.

The implementation row must also carry evidence the test cannot produce, and the PR must
say the walker cannot prove it:

1. a 1100×760 screenshot with the panel open on a local page, the header showing the URL
   and origin;
2. a refused-URL check: request `file:///etc/hosts` and `javascript:alert(1)`, confirm the
   view stays blank, the header names the refusal, and the shell logs the refused scheme;
3. a page inside the view calling `window.open` opens the OS browser, not a second Kin
   window;
4. a page requesting camera or notification permission is denied without a prompt;
5. a download link leaves no file on disk.

None of 2–5 is visible to a DOM assertion, because the panel is native chrome beside the
console, not a node in its document. The pure tests prove the rule's truth table; the
screenshots and the refusal log prove the wiring. The walker cannot prove either the
positioning or the denials, and the implementation PR must say so rather than imply the
suite covered it.

## Out of scope

- A phone in-app browser or any nested webview.
- Multi-tab, history, bookmarks, downloads, devtools, a password manager, or a "clear
  browsing data" action.
- Any CSP change, any new dependency, any change to the console window's
  `webPreferences`, and any `KinDesktopAPI` change beyond the one load message (§4).
- A Hub proxy of node-local or LAN URLs, for any device.
- PDF, Office or video rendering; ADR 0032 keeps documents on the OS viewer.
