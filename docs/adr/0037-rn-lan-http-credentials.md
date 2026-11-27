# ADR 0037: A LAN `http` Hub — One Explicit, Per-Origin Confirmation for a Plaintext Credential

**Status:** Accepted (CEO call 2026-11-27, on the owner's 2026-11-27 dogfood report and the
`KIN-MOBILE-002` D3 signature).
**Date:** 2026-11-27
**Amends:** None. ADR 0035 §3 (the phone is an Expo/RN client) and ADR 0036 §2 (the RN auth and
transport adapters) stand; this ADR decides one refusal inside them.
**Related:** `docs/adr/0035-mobile-rn-client-and-surface-reduction.md:51` ·
`docs/adr/0036-rn-client-layout-shared-ts-and-light-gate.md` §2 ·
`docs/product/stories/KIN-MOBILE-002.md` §范围 R2 / §验收 R2 (D3) · `KIN-MOBILE-001.md` ·
`rsi/MANDATE.md:34` · `mobile-rn/src/auth/hub.ts:100` (the refusal being scoped).

## Context

The RN client has exactly one Hub-address normalizer, `normalizeHubOrigin`
(`mobile-rn/src/auth/hub.ts:87-103`). It refuses a non-loopback `http` origin at
`mobile-rn/src/auth/hub.ts:100`; `:45` names the `insecure` reason, and `:184` / `:203` turn the
null origin into `{ ok: false, reason: "insecure", origin: null }` before any request. The refusal
is pinned by `mobile-rn/src/auth/hub.test.ts:181` ("an http Hub off loopback is refused before any
request"), which also asserts zero fetches.

That refusal blocks the owner's actual deployment: the Hub runs on his own LAN, at an address like
`192.168.1.42`, and the phone is on the same network. The shipped Capacitor shell already reaches it
by loading the Hub's URL directly, which is what makes the `kin_session` cookie first-party
(`mobile/capacitor.config.ts:6-12`). The parity story names the block in its own scope:
`docs/product/stories/KIN-MOBILE-002.md` §范围 R2 cites `mobile-rn/src/auth/hub.ts:100` as the
reason a LAN http Hub cannot connect today.

The cookie is the credential. A Hub session stores only the origin
(`mobile-rn/src/auth/tokenStore.ts:19-20`); the `kin_session` cookie lives in the platform jar and
travels on every `/api` call made with a Hub session (`mobile-rn/src/api/transport.ts:30-32`,
`:93-95`). The store's own comment says a plaintext origin off this machine is refused "before any
request" because that cookie is a credential (`mobile-rn/src/auth/tokenStore.ts:73-76`). Over
`http`, that credential is readable by anything on the path.

`rsi/MANDATE.md:34` requires an ADR for auth/transport semantics and leaves the implementing PR
open with `needs-ceo`; adding an ADR is itself auto-approved (`rsi/MANDATE.md:9`). The owner signed
D3 on `docs/product/stories/KIN-MOBILE-002.review.html:400-403`: 「显式确认一次后可连」 — an
explicit 不安全 confirmation that names the plaintext credential, remembered for that address. The
story is still `draft` in this tree; the tightened acceptance wording lands with #815
(`rsi/mobile-002-sign`), so this ADR cites the story's section names and test file rather than line
numbers. D3's five cases are the contract this decision hands to the implementation.

## Decision

### 1. Default deny stays; the allowance is an explicit, default-off opt-in

`normalizeHubOrigin` remains the only Hub-address normalizer and keeps refusing a non-loopback
`http` origin for every caller that does not opt in. The opt-in is an explicit, default-off argument
supplied by the sign-in/pair flow after it has shown the confirmation; omitted, it is today's
refusal. `apiFetch` and the transport (`mobile-rn/src/api/transport.ts:13`) never grow an insecure
switch, a global "allow http" flag, or a fourth reason code: they keep receiving an origin that was
already allowed. A caller that forgets the opt-in fails closed, and the `kin://connect` link only
pre-fills the screen (`mobile-rn/src/auth/hub.ts:105-123`), so a link cannot bypass the confirmation.

Evidence: one normalizer with no allowance today (`mobile-rn/src/auth/hub.ts:87-103`); the transport
has exactly three reasons and no notion of an insecure origin
(`mobile-rn/src/api/transport.ts:13`); the refusal and its zero-request assertion are pinned at
`mobile-rn/src/auth/hub.test.ts:181`, and that test must stay green with the opt-in omitted.

### 2. The confirmation is per origin and lives in the Hub session record

Scope is the normalized origin — scheme + host + port, which is what `URL.origin` returns
(`mobile-rn/src/auth/hub.ts:102`) and what the Hub session already stores
(`mobile-rn/src/auth/tokenStore.ts:19-20`). The confirmation is one optional boolean on that record
(`{ kind: "hub", origin, insecure: true }` when given) — never AsyncStorage, never a global boolean,
never a separate key. `clearSession` deletes the one Keychain entry
(`mobile-rn/src/auth/tokenStore.ts:137-139`) and sign-out calls it
(`mobile-rn/src/auth/hub.ts:253-254`), so signing out forgets both the session and the confirmation.
The same origin is not asked twice while that record exists; a different origin has no record and
re-confirms.

Two consequences are part of the decision, not left to the implementation:

- The stored-shape validators must accept a plaintext origin only when the record itself carries the
  confirmation. `isSession` sends Hub records through `isHubOrigin`
  (`mobile-rn/src/auth/tokenStore.ts:93-101`), which refuses `http` off loopback (`:76-81`); without
  this, a confirmed session would be silently dropped on the next launch and the phone would boot
  signed out. The flag is authority only in the device-local record: no server response, URL, or
  AsyncStorage value may set it. A record without the flag is still refused (fail closed).
- `normalizeSession` reads only the fields it knows (`mobile-rn/src/auth/tokenStore.ts:103-113`), so
  it must carry the flag through; dropping it would make the marker in decision 4 disappear on the
  next read.

Evidence: the record union and one-key write/delete (`mobile-rn/src/auth/tokenStore.ts:19-20`,
`:130-139`); the Hub branch of `isSession` and the loopback refusal
(`mobile-rn/src/auth/tokenStore.ts:76-81`, `:96-98`); the post-login write (`mobile-rn/src/auth/hub.ts:236-238`).

### 3. The warning names the risk, and rejecting costs nothing

The confirmation copy names 凭据明文传输 and says the `kin_session` cookie is the credential
travelling unencrypted; it asks once, for this address, in Chinese and English
(`docs/product/TASTE.md:53-54`, rule 10 "四个状态，两种语言"). Rejecting makes no request and stores
nothing: the screen returns to the form, so the next attempt asks again. `https` needs no
confirmation and connects directly. The contract is D3's five cases, carried by
`docs/product/stories/KIN-MOBILE-002.md` §验收 R2 row and its named test file
`mobile-rn/src/screens/pair.visual.test.tsx`:

| case | expected |
|---|---|
| reject | no request, no stored confirmation, next attempt asks again |
| confirm | the warning precedes the first request; confirm connects |
| same-origin reconnect | the stored record suppresses the warning |
| address change | a different origin asks again |
| https direct | no warning |

Evidence: the credential description (`mobile-rn/src/auth/hub.ts:10-17`,
`mobile-rn/src/auth/tokenStore.ts:73-76`); the bilingual rule (`docs/product/TASTE.md:53-54`); the
signed page (`docs/product/stories/KIN-MOBILE-002.review.html:400-403`); the acceptance row and test
file (`docs/product/stories/KIN-MOBILE-002.md` §验收 R2 row); the "no request on reject" shape exists
in `mobile-rn/src/auth/hub.test.ts:181-185`.

### 4. A confirmed insecure origin stays visibly marked

While the phone is on a plaintext origin, the pair screen keeps one honest line naming 不安全 / the
plaintext credential. It is a screen state, not a modal on every launch, and it never blocks use:
the owner confirmed once and the app runs. The marker is read from the stored record's flag
(decision 2), so it survives a relaunch without a network call and disappears with sign-out.

Evidence: the flag is on the record the screen already reads
(`mobile-rn/src/auth/tokenStore.ts:115-128`); D3 asks to remember the address
(`docs/product/stories/KIN-MOBILE-002.review.html:400-403`); rule 10 requires a named, translated branch (`docs/product/TASTE.md:53-54`).

### 5. Platform facts are verified on a device, not assumed

ATS already permits the connection: `NSAllowsLocalNetworking` is true (`mobile-rn/app.json:17`).
That is an ATS exception, not the local-network privacy prompt. The implementation probes on an
iPhone against a real LAN Hub and records what it observed in the PR body; if the local-network
prompt does not appear with a reason, it adds `NSLocalNetworkUsageDescription` to
`mobile-rn/app.json` with one honest sentence. The key is absent today — the only local-network key
in the file is `NSAllowsLocalNetworking` (`mobile-rn/app.json:17`). Android is out of scope for
`KIN-MOBILE-002` (`docs/product/stories/KIN-MOBILE-002.md` §不做: Android 另开故事).

Evidence: `mobile-rn/app.json:16-19`; the story's Android exclusion in §不做; a search for `NSLocalNetworkUsageDescription` under `mobile-rn/` returns no line.

### 6. The implementation PR belongs to Ethan

Changing `mobile-rn/src/auth/hub.ts` and `mobile-rn/src/auth/tokenStore.ts` semantics is the
`rsi/MANDATE.md:34` red line: the implementing PR carries `needs-ceo`, cites this ADR, and stays
open for Ethan. This ADR PR is docs-only and may merge, because adding an ADR is auto-approved
(`rsi/MANDATE.md:9`).

Evidence: the red line (`rsi/MANDATE.md:34`); the auto-approval (`rsi/MANDATE.md:9`); this branch's diff is the one ADR file.

### 7. What this does not decide

Server-side authentication and session lifetime, cookie attributes (`Secure`, `SameSite`, domain),
TLS or certificate pinning, Hub configuration, and any new dependency: none change here.
Evidence: those files are absent from this branch's diff; the transport keeps its three reasons (`mobile-rn/src/api/transport.ts:13`).

## Consequences

- **The owner's LAN Hub becomes reachable from the RN client**, the parity block `KIN-MOBILE-002`
  §范围 R2 names; the sign-in screen warns once per address and connects.
- **Residual risk, stated plainly.** On `http`, anything that can observe the phone's traffic on
  that LAN — another device on the same Wi-Fi, a compromised access point — can read the
  `kin_session` cookie and replay it until it expires or is revoked. This ADR adds no TLS,
  certificate pinning, or server-side check. It bounds the risk four ways: the credential is only
  sent after an explicit confirmation that names it; the confirmation is scoped to one origin and
  re-asked when the address changes; every caller that did not opt in still fails closed, including
  a stored record without the flag; and the origin stays visibly marked 不安全 while in use. A
  household LAN the owner controls is the intended setting; a café network is not.
- **The two opt-in points must agree.** The normalizer's allowance (decision 1) and the
  stored-record validator's allowance (decision 2) are separate paths; the implementation must test
  both, including that a record without the flag is rejected — an old or hand-edited record cannot
  quietly widen the rule.
- **Feel and native prompts remain device evidence.** The local-network prompt and any ATS
  behaviour are device facts (decision 5); a green test run is not that evidence.
- **Out of scope:** server-side auth, cookie attributes, TLS/pinning, Hub config, Android, and the
  Capacitor shell.

## Reversibility

Remove the opt-in argument from the sign-in flow and the confirmation flag from the session record,
delete this ADR, and the behaviour returns to today's: `normalizeHubOrigin` refuses a non-loopback
`http` origin for every caller (`mobile-rn/src/auth/hub.ts:100`), and
`mobile-rn/src/auth/hub.test.ts:181` passes unchanged. The default-deny normalizer is never changed
by the implementation, so the reversal deletes an allowance rather than restoring a guard. A phone
that had confirmed a LAN origin keeps a record the reverted code refuses: signed out, like any
record that fails validation (`mobile-rn/src/auth/tokenStore.ts:115-128`).
