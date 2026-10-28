# Phone parity with Lody — three surfaces

Status: in progress (2026-10-28)

The phone console is being aligned, surface by surface, with the three Lody
screens the user supplied: the conversation list, an open conversation, and the
run-settings sheet. "Parity" here means layout and interaction pattern, not
branding, copy or theme: OpenKin keeps its own tokens, wording and data.

Reference implementation (read, not guessed): the Lody checkout at
`~/Workspace/works/Lody` —

- `packages/components/src/components/mobile/mobile-home-screen.tsx` (header)
- `packages/components/src/components/mobile/mobile-workspace-tabbar.tsx` (dock)
- `packages/components/src/components/mobile/mobile-chat-list.tsx` + `mobile-project-screen.tsx` (buckets, rows)
- `packages/components/src/components/mobile/mobile-run-config-*.tsx` and `mobile-inline-picker.tsx` (run settings)
- `packages/components/src/components/sessions/session-chat-input-area.tsx` + `chat-composer.tsx` (composer)

## Surface 1 — conversation list

- Header on `/sessions`: 36px identity avatar (opens the drawer), a filled
  search pill that filters in place, then the inbox disc (with the pending
  badge) and the settings gear. The two trailing actions are 36px filled discs
  inside their 44px hit boxes: bare glyphs on a glass bar read as decoration.
  No hamburger, no page title, no command-palette icon on this route.
- Buckets by project, newest activity first, the no-project bucket last.
  Heading = 20px mark + name + chevron, all three in one tight left-aligned
  cluster, in the muted ink. The mark is an open folder while the bucket is
  open and a closed one when it is folded. Tap folds the bucket.
- A bucket shows five rows, then `展开全部 (N)`; the toggle sits on the avatar
  column (not the page gutter) so it reads as the tail of this list, and the
  expanded list ends with `收起`.
- Rows are flat (no card), 44px minimum, full-bleed press wash: status dot,
  agent avatar, one-line title, right-aligned muted time. The machine is a
  small glyph on remote rows, and the row's accessible name says it too.
- Archived projects are dropped here exactly as the sidebar drops them: the
  list subscribes to the sidebar's prefs, so archiving from the drawer empties
  this page without a reload. Restoring brings the project back.
- Dock tabs become 对话 / 例行任务 / 项目. The compose FAB is an ink disc with
  a pencil, not a brand-blue plus.

Search is local to the loaded list (100 rows) and lives in `?q=`, so the header
and the list cannot disagree. `?q=` is edited by one component
(`SessionsSearch`) rendered twice: in the bar on a phone, and in the page's own
header from `md` up, where the bar is hidden — a query with no visible field
would be a filter nobody can clear. A server-side search over the whole library
is a later step if the cap matters.

The page keeps an `<h1>` at every width even though the phone shows no title
(the rows are the page): `sr-only` on a phone, visible from `md` up. Without it
the bar's removal would have left the main phone screen with no heading for
screen-reader navigation.

## Surface 2 — open conversation

- Composer becomes the Lody card: rounded-2xl elevated surface, the textarea on
  its own row, and one footer row of `[+] [run-config face] … [send]`.
- The run-config face is the single control: agent mark, model label truncated
  from the head, then the permission mode. Tapping opens the run-settings
  sheet. The old phone strip under the composer (permission + model) is gone;
  desktop keeps it, including cwd/repo/branch/machine.
- Breakpoints, stated once because two different ones are in play: the card
  takes its desktop shape at `sm` (640px), while the face and the strip swap at
  `md` (768px). Between 640 and 767 the flat desktop card carries the phone
  face — the strip does not exist yet at that width, so the alternative is a
  screen with no model control at all.
- The send control is a circular ink button with an up arrow; the attach
  control is a plus.
- The header subtitle names the project, with the running state appended while
  a round is live.

## Surface 3 — run settings

- A `Sheet` titled 运行设置, rows as separate cards 4px apart: label column
  (5rem) + a filled value control. Rows: Agent (a read-only value once the
  session exists), 模型, 模式.
- The value control carries **no chevron** — the reference's trigger is a value
  on a filled surface. The open row is signalled by a ring plus a darker fill.
- Tapping a row expands the picker **inline, full width, directly under that
  card** — not inside the value column, where it would read as a dropdown. The
  expansion holds the search field (when the list is long), the options with a
  check on the current one, and for the model row the custom-id field. One row
  open at a time. Escape closes the expansion first, then the sheet.
- Custom model ids remain reachable: the model list ends with 自定义模型…,
  which reveals a text field in the same expansion.

The sheet does not reuse `SearchSelect`: that component *is* a trigger plus a
floating panel, and the reference's row has to expand inline underneath itself.
What is shared is the part that decides what the options mean —
`modelPickerOptions` / `modelPickerSelection` / `modelPickTarget` — and the
keyboard contract is copied rather than reinvented: the IME composition guard,
ArrowDown/ArrowUp between the field and the list, Home/End inside the list, and
Enter taking the first match. If a third searchable list appears, the field and
list should become a shared headless piece; two is not yet worth the
abstraction.

## Deliberate gaps (documented, not silently missing)

- 角色 (saved role presets) and 推理 (reasoning effort) are not implemented in
  the daemon protocol we use; the rows are omitted rather than faked.
- The chat-bubble header button in Lody opens its multi-tab session sheet;
  OpenKin has no session tabs, so the header keeps only `…`.
- The context-window ring is omitted: the console has token counts but no
  reliable context-window size per agent/model.
- Per-row `+N −N` diff stats need per-task aggregates the list endpoint does
  not return; the row trailing shows time instead.
- An imported agent session carries no live working state (the catalog reports
  it idle), so the status dot is drawn for Kin's own tasks; an imported row is
  a static entry until it is opened.
- The cross-project 进行中 section is gone with `sessionBuckets`: the
  reference has no such section, and a running row is already marked by its
  pulsing dot. The cost is that a long-running task can sit below five newer
  finished ones inside its project; the sidestep, if it turns out to matter,
  is to sort non-terminal rows first inside a bucket rather than reviving a
  heading.
- The usage and changed-files strips above the chat stay this round; moving
  them into the conversation or the `…` sheet is a separate change.

## Verification

- `tsc --noEmit`, `vitest run` (929 tests), `npm run build`; unit tests for the
  project buckets (including the archive filter), the search filter, and DOM
  tests for the run-settings sheet (including Escape layering, focus return and
  the ArrowDown/ArrowUp round trip through the search field).
- `src/pages/phoneRunConfigFace.test.ts` guards the one split that no type or
  DOM test can see: the face is `md:hidden` and the desktop strip is
  `hidden md:flex`. Both halves were red-verified by deleting the gate.
- Phone-width inspection (390×844) of all three surfaces against the supplied
  screenshots, plus a desktop-width regression check. The desktop composer is
  unchanged: the run-config face's slot is `md:hidden` and the below-composer
  strip is `hidden md:flex`, so each width gets exactly one model control.
- Feature completion gate: same-model review in two passes. The first reported
  two majors — archived projects leaking back into the list, and the width split
  being unguarded — both fixed and re-verified (the layout guard was
  red-checked by deleting the gate). The second pass confirmed both fixes and
  reported no blocker or major; its four nits were fixed in the same pass: the
  sidebar's `__root__` archive sentinel now hides this list's no-project bucket
  (red-verified), the write-only `active` row field is gone, a row's accessible
  name carries the status the dot encodes, and a bucket heading is inert while
  a search has every bucket force-opened.
- Residual risk recorded at handoff: the live `:7777` daemon on this machine is
  a checkout sidecar rather than the launchd node, so an embedded-console check
  can serve a stale bundle; phone QA here ran against the Vite dev server with
  the `/api` proxy.
- Removed with this change: `lib/sessionBuckets.ts` (the old machine→time
  grouping) and its locale keys. Its only consumer was the page this rewrote.
