# ADR 0035: Shrink the Console to a Minimal Contract, Then Build the Phone on Expo/RN

**Status:** Accepted as direction (owner, 2026-11-21). No product code ships in this PR; the contract that
gates the rewrite is a separate story.
**Date:** 2026-11-21
**Supersedes:** the "no native/RN second client" half of DECISIONS 2026-11-20 23:47 (`rsi/GOAL.md:434`,
`:473`; `docs/product/stories/*` P15 out-of-scope) — by **owner override**, not because its conditions were met.
**Related:** `docs/plans/2026-11-21-surface-reduction.md` (the plan this records) ·
`docs/plans/2026-11-21-phone-performance-baseline.md:105-152` (what today's measurement does and does not
attribute) · `b5135739` (`feat(mobile): run the console in a Capacitor shell instead of SwiftUI`, −15,364 lines
of native iOS) · `ui/src/App.tsx:214` (the `/usage` redirect) · `mobile/capacitor.config.ts:50`

## Context

The owner's phone experience is the worst surface the product has: startup and interaction both read as slow,
while the same build on a Mac reads as fast. Two things are true at once, and the earlier decision only
honoured the first.

**What is measured.** `docs/plans/2026-11-21-phone-performance-baseline.md` walked the five suspected causes and
found four of them `not attributable`: the non-passive `touchmove` is gated to an active long-press, the list's
missing `React.memo` produced no long task in 1,195 frames, no virtualization was not the cause at 61 messages,
and the entry chunk cannot explain an interaction frame. The strongest remaining candidate is the glass header's
`backdrop-filter` (transcript frame p90 16.3 ms with zero long tasks — a paint signature, not a script one), and
that was **not isolated**. So the current evidence does not say "the web stack cannot do this"; it says "nobody
has isolated the cause, and the two cheap web fixes are worth one story each".

**What is judged.** The owner's own conclusion after daily use is structural, and it is his call to make: the
console was built as a monitoring surface (15 `<Route>`s, ~10 real pages, 6 Settings tabs), the phone inherited
all of it, and the borrowed weight is what he feels. He decided to (a) cut the surface to a minimal contract and
(b) rebuild the phone client on the same stack T3 Code uses. This ADR records that direction; it does not claim
the measurement proved it.

**Why the old decision existed.** On 2026-11-20 23:47 the loop decided not to grow a second client, with two
named revival conditions: a requirement only native can satisfy, and startup-failure evidence. `b5135739` is the
receipt: a SwiftUI iOS client was deleted because keeping two clients in step cost more than it returned.
**Neither condition is met today**, and this ADR says so plainly. The owner is overriding the decision on
product grounds — three days of dogfooding says the surface is wrong, and the surface is cheaper to fix by
deleting than by re-rendering. An override recorded as an override is honest; one dressed up as "the conditions
were met" would poison every future reading of this file.

## Decision

**T3 split — one shared core, two native-feeling shells.**

1. **Delete first, rewrite second.** The UI shrinks to a minimal contract (5–6 routes, 2 Settings surfaces)
   before any RN code exists. Deleting a page is not deleting a capability: routines, projects, agents,
   providers and routing keep their Go backends and become tools + cards inside the conversation.
2. **Desktop does not move.** Electron + React/Vite stays the desktop shell; `web/dist` stays the console the
   Hub serves. No desktop rewrite rides along with this.
3. **The phone is a new Expo/RN client**, with local Swift/Kotlin modules only where RN is weak: glass/nav bar,
   scroll edges, push, background reconnect, secure storage. Not a full-native rewrite — T3's own mobile client
   is RN + native modules, and that is the target shape.
4. **The Go daemon and the shared TypeScript are not rewritten.** `transcriptProjection`, the API client/types,
   the card schema, i18n and task-title logic get extracted so the RN client imports them. A second copy of any
   of those is a defect, not a shortcut.
5. **A page may only be deleted after its replacement is green.** The tool/card that absorbs the page's
   capability ships first, with a test; the page is deleted in a later commit once that test passes. The one
   exception is code with no callers at all.
6. **RN is its own ADR + phase, behind a frozen contract.** No `mobile/` or `ui/` RN code before the minimal
   contract story is signed and its review page read.

## Consequences

- **The loop gains a measurement it did not have**: `removed-surfaces` (every path the plan says is gone must
  not exist on `main`) and a route-manifest test (only contract routes; a new route needs a story). Both are
  gates, not checklists — `ApprovalsPage` was merged back in once while the plan stayed green, which is exactly
  the failure a checklist does not catch.
- **Sequencing is enforced by entry conditions, not intentions.** P17 does not open because a document landed;
  it opens when P16's reading surface is fully green, `#543`'s acceptance registration has landed, and the
  minimal contract is signed. Until then the plan is a record, not a licence.
- **The RN MVP is bounded**: pairing/login → conversation list → read/send/stream → approvals/questions →
  provider/usage sheets. Settings pages are not in the MVP. If the MVP cannot reach parity on those four faces,
  the answer is to stop and record why — not to widen the MVP.
- **What would prove this wrong**: the phone still feels slow after (a) the surface reduction and (b) the two
  web paint fixes, or the RN client cannot reach parity on the four faces without a second copy of shared
  logic. Either outcome is recorded here and re-decides the direction rather than being absorbed silently.

## Reversibility

This ADR and its plan are direction only: revert both files and the loop is back to "no second client" with no
product code to unwind. The dead-code deletion is a separate chore and reverts on its own. Once RN code exists,
the reversal cost is the `mobile/` tree — which is why the contract is signed before that tree is created.
