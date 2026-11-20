# ADR 0035: The Bundled Console May Read From the Hub

**Status:** Proposed — needs owner (Ethan) approval. The code in this PR stays behind a CEO hold and is not merged until he picks option ①.
**Date:** 2026-11-21
**Related:** `mobile/capacitor.config.ts:8-12` (why the phone loads the Hub's origin today), `:50` (`webDir`, the bundled copy) · `internal/api/secure.go:37-49` (`securityHeaders`, the middleware this one sits beside), `:57-67` (`sameSiteRequest`), `:73-83` (`originOf`), `:94-109` (`csrfGuard`; `OPTIONS` exempt at `:97-99`, state changes refused at `:101-105`) · `internal/api/api.go:302-307` (the middleware chain: `securityHeaders`, then `corsForBundledConsole`, then `csrfGuard`, all ahead of auth), `:335-336` (`/api/health` and `/api/version` on the unauthenticated router) · `internal/api/cors.go:28` (the two-entry allow-list), `:37-48` (the exact match), `:57-86` (the middleware) · `internal/api/cors_test.go` (the acceptance table) · RSI row `R-continue-006-cors` · `ui/src/lib/consoleVersion.ts:120-123` (the version probe fetches `/` with `credentials: "same-origin"`, so a cross-origin read carries no credential) · the pending cross-origin decision put to the owner on 2026-11-21 02:20 (local RSI state, `needs-ceo.md`; gitignored)

## Context

The phone is a Capacitor WKWebView that loads the Hub's own console, so login and every relative `/api` call behave as they do in a browser (`mobile/capacitor.config.ts:8-12`). The copy of `web/dist` that ships inside the app (`webDir: "../web/dist"`, `:50`) is only a fallback: it draws the connect screen, and it is what a phone falls back to when its stored Hub cannot be reached.

That fallback cannot read the Hub. A page served from the app's own origin — `capacitor://localhost` on iOS, `http://localhost` on Android — fetching the Hub's static console or `/api/version` is a cross-origin read, and **the Hub sends no CORS headers today**: `git grep -n 'Access-Control-Allow-Origin' -- internal/` returns nothing at `origin/main`. `csrfGuard` exempts `OPTIONS` from the state-change check (`internal/api/secure.go:97-99`) but nothing answers a preflight, and a WKWebView refuses the read before the bytes arrive. So `KIN-CONTINUE-006` (open the app on its bundled console, upgrade the Hub in the background) is blocked at its premise: its boot half needs the bundled page to fetch the shell and learn the Hub version.

Three options were put to the owner on 2026-11-21 02:20:

1. **A Hub-side origin allow-list** — a small middleware naming the two app origins, reads only, no cookies, with tests and this ADR.
2. **A native bridge** — leave the server alone and have Swift hand the bundled console its last-known state. It touches no external contract, but it needs native code and a real device to verify, and the web gate cannot cover it.
3. **Do nothing** — keep #482's bounded retry and the visible "reload", and the story stays parked.

**Option ① is recommended.** It is the smallest change that unblocks the whole story: the permission is a fixed two-origin allow-list, not a pattern; it carries no cookies, because the bundled console uses a Bearer credential rather than a Hub session; it changes no token, no route contract and no auth group; and it is a server-side table a test can pin. Option ② leaves the cross-origin wall standing for every other reader and cannot be proven by this repository's gates. Option ③ leaves the phone on "up to 12 seconds of spinner, then a reload button".

## Decision

**A new middleware, `corsForBundledConsole` (`internal/api/cors.go:57`), grants the bundled console's two origins read access to the Hub. It is mounted beside `securityHeaders` and ahead of `csrfGuard` and auth (`internal/api/api.go:302-307`), so every route — static console assets included — carries the grant and a preflight is answered before a credential is required.**

1. **Match exactly.** The `Origin` header is compared against a two-entry allow-list, `capacitor://localhost` (iOS) and `http://localhost` (Android), case-insensitively across the whole origin (its only case-insensitive components are scheme and host; the entries carry no port or path). No prefix or suffix matching. No port is accepted on `http://localhost`, so `http://localhost:3000` is a different origin and is refused. An answer names the canonical allow-list entry, never the request's casing.
2. **Reads get the grant.** For an allowed origin on `GET` or `HEAD`, the answer carries `Access-Control-Allow-Origin: <canonical origin>` and `Vary: Origin`. Never `*`. An origin not on the list gets no CORS header at all — not an error response, and not a refusal of the request itself.
3. **Preflight allows reads only.** `OPTIONS` with an allowed origin and an `Access-Control-Request-Method` of `GET` or `HEAD` is answered `204` with an empty body and:
   - `Access-Control-Allow-Origin: <canonical origin>`
   - `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
   - `Access-Control-Allow-Headers: Authorization`
   - `Access-Control-Max-Age: 600`

   A preflight naming `POST`, `PUT`, `PATCH` or `DELETE` gets no allow headers, so the browser refuses the real request before it is sent.
4. **Never credentials.** No answer carries `Access-Control-Allow-Credentials`. Cookies are not part of this path; the app origin never receives a Hub session.
5. **`csrfGuard` is untouched.** A state-changing request whose `Origin` is `capacitor://localhost` is still `403 cross-site request refused` (`internal/api/secure.go:101-105`). That is deliberate: the grant is a read permission. The bundled console may read; it still cannot send anything to the Hub.

## Consequences

- The bundled console can fetch the shell and learn the Hub version from its own origin. `KIN-CONTINUE-006`'s **boot** half is unblocked by this ADR; its **conversation** half is not, and needs a later row and a later decision.
- The grant is origin- and method-level, not path-level. It lets those two origins make cross-origin reads of whatever the Hub answers **without a cookie**: the static console, `/api/version`, `/api/health`, public share JSON, and any authenticated `GET` for which the app already holds a Bearer credential. It does not grant a Hub session, and it does not grant a write.
- **Residual risk:** anything that can serve a page from `http://localhost` on port 80 on the same machine can read the Hub's public endpoints through a browser. No credentials, no cookies and no state changes are exposed. On iOS the app origin is private to the app; on Android, port 80 on loopback requires an app that can bind it on that device.
- The allow-list is two platform constants, not configuration. A future Capacitor scheme or a desktop-shell origin is a new decision, not an entry someone appends in passing.
- No schema, no migration, no auth-group change, no cookie semantics, no route contract change, no new dependency.

## Alternatives considered

- **A Hub-side proxy of the node-local console.** Refused: the Hub must never proxy a node-local URL (ADR 0034 §6). It would make the Hub an SSRF bridge into every node's loopback under the Hub's authority.
- **A native bridge (option ②).** It would leave the server untouched, but it needs Swift and a real device to verify, and the web gate cannot cover it. It also solves only the app's first paint, not any other reader of the Hub's console set.
- **A wildcard or reflected origin.** Refused. A wildcard would grant every site the same read, and reflecting an unlisted origin turns an allow-list into a mirror.
- **Adding the app origins to `sameSiteRequest` so the app can POST.** Refused here and explicitly out of scope: the app origin has no Hub session, and widening a CSRF guard to make a read grant "complete" is how a read permission becomes a write permission.
- **Do nothing (option ③).** Honest and free, but it leaves the story parked and the phone on the bounded retry plus a reload button.

**Reverse:** delete `internal/api/cors.go`, its two mount lines in `internal/api/api.go`, the `corsForBundledConsole` comment in `internal/api/secure.go`, `internal/api/cors_test.go`, and this ADR. Nothing is persisted; no client depends on the headers yet, because the phone does not use them until `R-continue-006-boot`.
