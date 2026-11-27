# ADR 0036: The RN Phone Client — `mobile-rn/`, In-Place Shared TS, and a Light Gate

**Status:** Accepted (owner delegation, 2026-11-24).
**Date:** 2026-11-24
**Amends:** ADR 0035 §4. ADR 0035 said the shared TypeScript "gets extracted so the RN client
imports them" (`docs/adr/0035-mobile-rn-client-and-surface-reduction.md:54-55`). This ADR replaces
that extraction with in-place import plus two named adapters; every other part of 0035 stands.
**Related:** `docs/adr/0035-mobile-rn-client-and-surface-reduction.md:51` (the phone is a new Expo/RN
client) · `docs/adr/0035-mobile-rn-client-and-surface-reduction.md:60` (RN is its own ADR, behind a
frozen contract) · `docs/product/stories/KIN-MOBILE-001.md` (the parity story this ADR unblocks) ·
`docs/product/stories/KIN-CONTRACT-001.md:3` (the frozen four-page contract) ·
`rsi/MANDATE.md:34-35` (dependency rules) · `rsi/DECISIONS.md` (2026-11-24, the CEO call and waiver).

## Context

ADR 0035 accepted the direction and made RN wait for a frozen contract. That wait is over:
`KIN-CONTRACT-001` is `approved` (`docs/product/stories/KIN-CONTRACT-001.md:3`), it freezes the four
pages (`/sessions`, `/tasks/:id`, `/routines`, `/settings`), and the phone faces this ADR builds are
the ones those pages already signed — list, conversation, approvals/questions, provider/usage.

What still blocks `mobile-rn/` is not a product decision. It is the missing answer to three
engineering questions: where the tree lives, how the RN bundle consumes shared TypeScript without a
second copy, and what verification a PR that touches only RN must pass. The dependency rule is the
fourth: `rsi/MANDATE.md:35` says a new dependency enters only through a facade/ADR PR left open for
the CEO, and the owner waived that *for `mobile-rn/package.json` only* on 2026-11-24 (recorded in
`rsi/DECISIONS.md`; the waiver does not extend to `ui/package.json` or `go.mod`).

The web phone shell is parked, not deleted. Today's phone client is the Capacitor shell
(`mobile/package.json:4`: "Capacitor shell that runs the Kin console on iOS"). It keeps shipping until
RN reaches parity on the four faces; deleting it is a later, separate story.

## Decision

### 1. Layout: a new top-level `mobile-rn/`

- The RN client is a new top-level `mobile-rn/` directory: Expo SDK 58, TypeScript `strict: true`,
  expo-router file-based routes. It is a sibling of `ui/`, not a subdirectory, so the web build,
  the Go embed and the desktop shell cannot accidentally include it.
- `mobile/` (Capacitor) stays untouched and shipping. RN replaces it only at parity (§5), in its own
  cutover story. Until then both trees exist; neither is a fallback flag inside the other.
- No file under `ui/` or `web/dist/` changes because RN exists. The desktop stays Electron + Vite
  (ADR 0035 §2).

Evidence: the layout is absent today and the shell it will replace is tracked —
`test ! -d mobile-rn && echo "mobile-rn absent"` prints `mobile-rn absent`, and
`mobile/package.json:4` names the Capacitor shell. The story's R1 row is the delivery that creates
the directory; this ADR alone creates none.

### 2. Shared TypeScript is imported in place, not extracted

The RN Metro config watches the repository root (`watchFolders`) and its tsconfig `paths` resolve the
shared modules below. Nothing moves out of `ui/`. Moving those files would put the web UI gates — the
UX walk and the per-merge verification — on a refactor that changes nothing for the web, which is
why this ADR replaces 0035 §4's extraction with import-in-place. The rule, enforced by R1's contract
test, is:

> A module the RN bundle imports may not reference `window`, `document`, `localStorage`,
> `sessionStorage` or `react-dom`. When a shared module does, the RN side supplies one named adapter
> and the Metro resolver aliases that module to it. A second copy of shared logic is a defect.

A name is a browser global only when it is used as a value: a declaration, parameter, property key
or label that happens to be called `window` is not one, and a reference bound by such a local
declaration reads that binding rather than the global. The contract test proves both directions by
name (`KIN-MOBILE-001: a name that declares or labels is not a browser global`).

**Importable as-is.** These contain no direct DOM reference on this branch:

| Module | Evidence |
|---|---|
| `ui/src/api/contract.ts` | type-only import from the generated schema (`ui/src/api/contract.ts:1`) |
| `ui/src/api/generated/openapi.ts` | generated types/constants only |
| `ui/src/i18n/locales/en.ts`, `ui/src/i18n/locales/zh.ts` | locale data; `t()` lives elsewhere |
| `ui/src/components/chat/transcriptProjection.ts` | no direct DOM reference; its i18n import is the adapter seam below (`ui/src/components/chat/transcriptProjection.ts:1-17`) |
| `ui/src/components/chat/eventMeta.ts` | canonical speaker/phase decoding used by the projection; type-only imports, no DOM reference |
| DOM-free files under `ui/src/lib/**` | e.g. `ui/src/lib/attachments.ts`, `ui/src/lib/friendlyError.ts`, `ui/src/lib/needsYou.ts` |
| `ui/src/lib/phoneSessionBuckets.ts` | R3's device → project → conversation grouping, imported in place. Its type imports from `ui/src/api/client.ts` are erased; its only value import of a DOM-carrying module is `./taskOrder`, which resolves to Adapter 3 below |
| `ui/src/lib/agentSessionTitle.ts`, `ui/src/lib/agentMention.ts` | the bucket module's own DOM-free dependencies, reached by the same import |
| `ui/src/lib/usage.ts` | the provider/usage sheet's fold (`summarizeUsage`, `formatTokenCount`, `cacheRateLabel`). It names no module once the fold's input row type is declared locally (`ui/src/lib/usage.ts:8`), so the RN typecheck never reaches the web client. Its `window` identifiers are a property signature (`:161`), the `contextFill` parameter (`:189`, read as a value at `:192`) and a property assignment (`:200`) — a name, a binding and a label, never the browser global |

R4's read reaches the projection's real closure, not just the file:
`eventMeta.ts`, `lib/attachments.ts`, `lib/friendlyError.ts`,
`lib/roundEvidence.ts`, `lib/changedFiles.ts`, and `lib/diffPreview.ts`. Only
its `ui/src/i18n/index.ts` import carries a browser global, and that is
Adapter 1 below. (The live stream's `ui/src/lib/eventStream.ts` import is in
place — see the R4 note under the adapters.)

The command that backs the table (no output is the proof):

```bash
rg -n "window\.|document\.|localStorage|sessionStorage|react-dom" \
  ui/src/api/contract.ts ui/src/api/generated/openapi.ts \
  ui/src/i18n/locales/en.ts ui/src/i18n/locales/zh.ts \
  ui/src/components/chat/transcriptProjection.ts \
  ui/src/components/chat/eventMeta.ts
```

`ui/src/lib/**` is not a hand list: R1's test walks the actual import closure of every module RN
imports and fails on the first unguarded reference, so a new helper cannot slip in later.

**Adapter 1 — i18n (`mobile-rn/src/i18n.ts`).** The catalog lookup and interpolation in
`ui/src/i18n/index.ts` are DOM-free, but the module itself persists the locale and syncs tabs:
`document.documentElement.lang` (`ui/src/i18n/index.ts:33`), `localStorage.getItem`
(`:43`), `localStorage.setItem` (`:60`), `window.dispatchEvent` (`:67`) and the
`window.addEventListener`/`removeEventListener` pair (`:75`, `:80`). Those are guarded by `typeof`
checks and `try/catch`, but the rule above is a reference rule, not a runtime-survival rule. The RN
adapter exposes the same signatures (`t`, `getLocale`, `setLocale`, `subscribeLocale`) over the same
`ui/src/i18n/locales/*` catalogs; it adds no strings. Metro aliases `ui/src/i18n/index.ts` to it, so
`transcriptProjection`'s `t` import resolves without editing the shared file.

**Adapter 2 — API transport (`mobile-rn/src/api/transport.ts`).** `ui/src/api/client.ts` is not
importable as is. Today it reads and writes browser state in four places:

| Seam | Lines |
|---|---|
| Token in `localStorage` (get/set/remove) | `ui/src/api/client.ts:58`, `:65`, `:70` |
| Relay cookie + relay room/key in `localStorage` | `ui/src/api/client.ts:105`, `:116-117`, `:129-130`, `:135`, `:167`, `:171`, `:192-193` |
| URL capture and history rewrite (`?token=`/`?room=`/`?key=`) | `ui/src/api/client.ts:124`, `:158`, `:176-177`, `:182`, `:195`, `:240-241` |
| Browser fetch defaults (`credentials: "same-origin"`) and stream reader | `ui/src/api/client.ts:296`, `:356`, `:2704`, `:2739`, `:2758` |

The command behind the table is `rg -n "window\.|localStorage|document\." ui/src/api/client.ts`
(26 matching lines on this branch); the table groups them by seam. The RN transport implements the
same method signatures over `expo-secure-store`, React Native `fetch`/`WebSocket` and
`AbortController`. It may not add endpoints or change payload shapes; it is a transport, not a second
client. Type-only imports from `client.ts` (e.g. `TaskEvent` in
`ui/src/components/chat/transcriptProjection.ts:1`) are erased by the TypeScript transform, so they do
not pull the browser module into the RN bundle.

**Adapter 3 — conversation order (`mobile-rn/src/list/taskOrder.ts`).** R3 imports
`ui/src/lib/phoneSessionBuckets.ts` in place. That module's only value import of a browser-bound
module is `./taskOrder`, whose read/write helpers use `localStorage`; its ordering function is pure.
The RN adapter carries that one function behind the same signature, and Metro resolves
`ui/src/lib/taskOrder.ts` to it by file path (the shared module imports it relatively, so a
specifier alias cannot intercept it). R3 has no reorder surface, so the function is not reached at
runtime; the adapter exists so the grouping can be imported rather than forked.

R1's shared-import contract test enforces three things: the import closure rule above, that every
alias target in the Metro config is named in this ADR, and that the shared modules carrying DOM
references are exactly the ones mapped to a named adapter (so an alias cannot silently paper over a
new one). Adapters are substituted during the closure walk: the effective closure is DOM-free while
the unaliased graph still names every module the adapter stands in for.

R4's live round imports `highestContiguousSeq`, `hasSequenceGap` and `mergeEventsBySeq` in place from
`ui/src/lib/eventStream.ts` (`mobile-rn/src/thread/threadModel.ts:27`), with
`mobile-rn/src/thread/stream.ts` as the SSE transport (Adapter 2's seam), not a second browser reader.

### 3. Dependencies: exact pins, RN only

No dependency enters `ui/package.json` or `go.mod`. `mobile-rn/package.json` is the only manifest this
decision covers. Every version is an **exact pin** (no `^`, no `~`) and was published at least seven
days before 2026-11-24, so a compromised or broken release cannot enter unreviewed. Publish dates were
read from `npm view <pkg> time --json` on 2026-11-24; the signature test parses this table and fails
on a range, a missing date, or a date after 2026-11-17.

| package | version | published | why / first slice |
|---|---|---|---|
| `expo` | `58.0.26` | 2026-11-17 | SDK 58 runtime; R1 |
| `expo-router` | `58.0.32` | 2026-11-17 | file-based routes; R1 |
| `react-native` | `0.88.1` | 2026-10-27 | renderer; R1 |
| `react` | `19.3.1` | 2026-10-14 | RN 0.88 requires `^19.3.0`; R1 |
| `react-native-screens` | `4.30.1` | 2026-10-28 | native screen containers required by the router; R1 |
| `react-native-safe-area-context` | `5.11.1` | 2026-11-03 | notch/home-indicator insets; R1 |
| `expo-linking` | `58.0.17` | 2026-11-11 | deep links into one conversation; R2 |
| `expo-constants` | `58.0.16` | 2026-11-11 | runtime config/version; R1 |
| `expo-status-bar` | `58.0.5` | 2026-11-11 | status-bar style per bar/sheet; R1 |
| `expo-secure-store` | `58.0.3` | 2026-11-11 | token in Keychain, not AsyncStorage; R2 |
| `expo-notifications` | `58.1.9` | 2026-11-11 | approval/question push; R7 |
| `expo-blur` | `58.0.6` | 2026-11-11 | glass bottom bar/header; R7 |
| `jest-expo` | `58.0.15` | 2026-11-17 | test preset; R1 |
| `typescript` | `5.7.2` | 2024-11-22 | same compiler family as `ui` (`ui/package.json` pins `^5.7.2`), so shared files typecheck the same way; R1 |
| `@types/react` | `19.3.0` | 2026-09-09 | React 19 types; R1 |
| `@testing-library/react-native` | `14.1.0` | 2026-10-08 | component tests; R3 |

The owner's waiver is narrow: the CEO may merge the dependency ADR PR directly **for
`mobile-rn/package.json` only**. `ui/package.json` and `go.mod` remain under `rsi/MANDATE.md:35`
(facade/ADR PR left open). A future RN package addition edits this table and the signature test in the
same PR; a version bump to an already-pinned package is a normal code change, not a new dependency.

### 4. Light gate for RN-only diffs

A diff confined to `mobile-rn/` (plus docs/rsi) passes this gate, and only this gate:

1. `npx tsc --noEmit` in `mobile-rn/`;
2. `npx jest` in `mobile-rn/` (jest-expo preset);
3. the shared-import contract test from §2;
4. a `mobile-rn` job wired into `scripts/check.sh` (R1 adds it; AGENTS.md rule 12 says a suite nobody
   wires is a green light for a regression — the job id is fixed here so the scaffold PR must add it);
5. one independent review of the full diff.

The UX walk is not part of it, and no new skip flag is needed: `rsi/runtime/merge.sh:752-753` walks
only when the diff contains a non-test `ui/src/**/*.tsx` or `*.css` file (or the UI toolchain
manifests), so an RN-only PR already skips it. Anything touching `ui/`, `go.mod`, `internal/`,
`cmd/` or `scripts/` leaves this light path and takes the normal gate.

**What the light gate does not prove.** It cannot prove how the app feels on a real phone or
simulator: frame pacing under the glass bar, keyboard avoidance, scroll edge, push delivery, and
background reconnect are device behaviours. Ethan's own dogfood on an iPhone is the acceptance for
feel; a green light gate is not that acceptance. R7's native-module work therefore lands with device
evidence in its PR body, not with a claim that jest covered it.

### 5. Cutover and kill criteria

RN replaces the Capacitor shell when the **four faces** are at parity, no earlier:

1. conversation list (device → project → conversation, folded, ≥10 rows on an 820 screenful, 44pt
   targets — the signed `KIN-CONTINUE-007` contract);
2. conversation read/send/stream/interrupt;
3. approvals and questions;
4. provider/usage sheets.

When all four are green on a real device, a separate cutover story deletes `mobile/` and points the
release at the RN build. The Capacitor shell is not deleted in any R1–R7 PR.

**What would prove this wrong** (restating ADR 0035's own kill condition): if parity on those four
faces cannot be reached without a second copy of shared logic — a forked projection, a second API
client with its own payload rules, or a second set of task-title/card schemas — stop and record which
face forced the fork. The answer is then to re-decide the direction, not to widen the MVP. A face
that needs a native module is not a fork; it is R7's scope.

### 6. MVP slices, in order

Each slice is one PR, ≤ ~800 changed lines, with its own tests.

| slice | scope | gate evidence |
|---|---|---|
| R1 | scaffold: Expo app, strict TS, router shell, Metro `watchFolders`/tsconfig paths, shared-import contract test, `scripts/check.sh` `mobile-rn` job | `tsc`, `jest`, contract test, job wired |
| R2 | pairing/login + secure storage: token capture, Keychain, first list load, signed-out/expired states | jest + device walkthrough in PR body |
| R3 | conversation list: device → project → conversation, folds, ≥10 rows at 820, 44pt targets | jest + 390/820 screenshots |
| R4 | conversation read + stream + composer + interrupt/queue | jest + streaming evidence |
| R5 | approvals and questions: pending count, approve/deny, answer, resolved state | jest + device evidence |
| R6 | provider/usage sheets: provider list, usage window, model/cost read-only | jest + screenshots |
| R7 | native modules: glass/nav bar, scroll edge, push, background reconnect | device evidence; jest for the JS fallbacks |

## Consequences

- **The web gates stay off the RN path.** In-place import means no extraction PR, so the web console's
  UX walk and per-merge verification are not spent on a refactor that changes nothing for the web.
  The cost is two adapters (i18n, transport) and a resolver rule that must stay honest; R1's contract
  test is the thing that keeps it honest.
- **The phone contract already exists.** KIN-MOBILE-001 is a parity story: it reuses the signed
  screens and behaviours of `KIN-CONTRACT-001`, `KIN-CONTINUE-002/003/005/007` and `KIN-RESULT-*`
  rather than designing a second product. A screen that disagrees with a signed story is a bug in the
  RN screen, not a new decision.
- **The dependency surface is small and dated.** Sixteen exact pins, each old enough to have survived
  a week of public use, and a test that refuses a range. The trade-off is manual bump PRs; that is
  deliberate while the client is new.
- **Feel remains a human acceptance.** The light gate is cheap because it does not pretend to measure
  feel. If dogfood says the RN client feels wrong, the gate will still be green — and that is the
  signal to change the client, not the gate.

## Reversibility

This ADR creates no product code. Revert it together with `KIN-MOBILE-001`, its review page and the
2026-11-24 `rsi/DECISIONS.md` line, and the loop is back to "RN blocked on an ADR" with the Capacitor
shell untouched. Once R1 lands, the reversal cost is the `mobile-rn/` tree; `mobile/` was never
modified, so the shipping phone path is unaffected either way.
