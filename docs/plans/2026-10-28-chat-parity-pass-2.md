# Chat parity with Lody — second pass (mobile + desktop knobs)

Status: implemented, awaiting the feature-completion gate.

The first phone-parity pass (`2026-10-28-phone-parity-with-lody.md`) aligned
three surfaces with the reference. A follow-up review against Lody's own
source (`~/Workspace/works/Lody/packages/components/src`) produced a twelve
item gap list; this pass closes every item except the explicitly-excluded
one (multi-tab session switching, item 5) and the two already documented as
deliberate gaps (per-row `+N −N` diff stats, the context-window ring).

Reference implementation (read, not guessed):

- `mobile/mobile-run-config-button.tsx` + `mobile-run-config-sheet.tsx`
  (one composer control, one sheet)
- `ai-gui/mobile-message-actions.ts` (tap-to-reveal, one at a time)
- `sessions/session-usage-popover.tsx` (usage at the input, not a bar)
- `mobile/mobile-chat-list.tsx` + `mobile/mobile-swipeable-row.tsx`
  (long-press multi-select, swipe reveal, pinned bucket)
- `mobile/mobile-home-screen.tsx` (identity disc as the drawer trigger)

## What changed

### New chat — one run-config entry (items 1, 2, 10, 11)

The phone's new-chat screen had two entries for the same settings: the
composer's run-config face (agent · model · mode) and the "这次怎么跑" bar
below it, whose sheet repeated the agent/model/permission rows. The bar and
its sheet are gone; the face's sheet (`RunConfigSheet`) is now the one
surface, and it gains the location rows the bar owned (机器 / 目录 / 分支 /
团队分发 / 例行) via a new `extraRows` slot plus an Agent picker row for a
session that has not started (`agents` + `onAgentChange`). Desktop keeps the
same settings in one strip (`hidden md:flex`), the shape the session page
already uses, replacing the three card groups (执行 / 路由 / 工作区).

角色 / 推理 / Plan / Fast rows remain absent for the documented reason: the
daemon protocol this console speaks has neither concept (see
`2026-10-28-phone-parity-with-lody.md` "Deliberate gaps"), and a row that
cannot be honoured is worse than a row that is not drawn. The sheet now names
the model the session is actually running, which is the visible half of the
gap.

The phone hero slims to one line (avatar + title) so the input is visually
central; the two explanatory paragraphs and the agents link stay on desktop,
where the column has room for them.

### Message actions — hidden until tapped (item 3)

`lib/mobileMessageActions.ts` is the same module-level store the reference
uses: actions rest hidden on a phone, a tap on the message body reveals them,
one message at a time, and a second tap hides them. Taps on links/controls or
a live text selection do not toggle. Desktop hover behaviour is unchanged.
`AssistantMessageItem` is now its own component because the reveal is a hook
and hooks belong in components, not map callbacks.

### Usage — off the transcript, at the input (item 4)

The always-on 任务用量摘要 bar is gone from the phone (the changed-files bar
stays; desktop keeps the strip below the side-rail breakpoint). The phone's
composer footer carries a compact trigger (the token total) that opens a
sheet with the same details — tokens, spend, cache, requests. There is no
context-window ring because Kin has no reliable per-model context size (the
documented gap).

### Sessions list — selection and swipe (items 6, 7)

- Long-press a row → multi-select with a toolbar (select all, count, 置顶 /
  取消置顶, 归档, 取消).
- Swipe a row left → the same two actions as chips (pin, archive), one row
  open at a time, the drag's trailing click swallowed so it cannot navigate.
- Pinned tasks lift into a 置顶 bucket at the top (`withPinnedBucket` in
  `phoneSessionBuckets`; pins are a phone-side localStorage preference like
  the sidebar's project pins).
- 归档 archives the row's project (the sidebar's archive semantics), so the
  list and the drawer can never disagree.
- The dock's FAB reserves list height (`h-60` spacer), so the last row's
  relative time is never under the pencil.

### Drawer trigger — one shape everywhere (item 8)

`IdentityDisc` (the K disc the sessions bar already led with) is now the
leading control on every phone screen; the hamburger glyph is gone. One
destination, one shape.

### Inbox — one empty state (item 9)

The "没有待审批项" line only renders when something is under it; an empty
page has exactly the 全部处理完了 card.

### Model names — the face and strip say what runs (item 12)

The session page derives the effective model from the transcript
(`findSpeakerModel`) when `task.model` is empty — a provider fallback is
invisible in the task row — and the composer face and the desktop strip name
it instead of 默认. The stored value stays empty, so a follow-up still lets
the daemon choose. New chat has no run yet to name, so an unpicked model
honestly reads 默认 there.

## Verification

- `tsc --noEmit`, `vitest run` (939 tests), `npm run lint` (0 errors, same
  18 pre-existing warnings as the base), `npm run build` all green. New
  tests: the reveal store (one-at-a-time, same-named keys across scopes,
  selection/tap guards), task pins, `withPinnedBucket` (lift, empty,
  agent-session rows).
- Phone (390×844) and desktop (1440×900) inspection against the vite dev
  server: new chat shows one face + sheet with all rows; the task page has
  no usage bar and the face/strip name grok-4.7; sessions rows are clean,
  long-press enters selection, a real drag reveals the chips and does not
  navigate; inbox has one empty state; the identity disc leads every header.
- The run-config sheet's dispatch popover opens without clipping (the sheet
  body scrolls; the old sheet's clipping rule was respected by not putting
  `overflow-hidden` on rows).
- Residual risk: pointer-gesture feel (long-press threshold, swipe snap) was
  verified headless with real CDP input, not on a physical phone; the live
  `:7777` daemon embeds an older bundle, so phone QA ran against vite with
  the `/api` proxy.

## High-model review (feature completion gate)

Advanced-model review of the full diff reported 0 blockers, 3 majors,
8 nits; every major and all cheap nits were fixed in the same pass:

- **Reveal store scoped by task**: message keys are `t-<seq>` and seq
  restarts per task while the tab host keeps several sessions mounted, so a
  module-level key lit up the same-named message in every session.
  `ChatStream` now takes `messageScope` (the task id) and keys the store by
  it; regression test covers same-named keys in two scopes.
- **Desktop click no longer reveals**: the tap-to-reveal handler is gated on
  the same `(max-width: 639px)` cut the visibility classes use, and the
  revealed branch keeps the `sm:` hover classes, so a stale reveal after a
  resize still behaves as hover on desktop. Verified at 1440×900.
- **Selection excludes imported sessions**: rows without a task have no pin
  or archive target, so they are neither selectable nor counted by
  select-all; the toolbar checkbox carries the platform's indeterminate
  state for partial selection.
- Nits fixed: the swipe wrapper re-issues changed drags (no mid-drag
  freeze), arms click-suppression on pointerup only (a cancelled gesture
  cannot eat the next tap), the transcript-named custom row materialises
  the actual model instead of blanking, the usage trigger is 44pt,
  dead `newChatControlGroups` and its test are removed, and Shift+Enter on
  a row enters selection (the keyboard path to the batch actions).
- Nits deferred with reasons: keyboard entry uses Shift+Enter without a
  visible hint (a hint row on the phone would be another always-on line);
  select-all caps to task rows but not to the visible preview (the count
  is what the toolbar says).
