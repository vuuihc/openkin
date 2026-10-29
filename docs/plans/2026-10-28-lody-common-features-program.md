# Common-feature parity program — inventory, gaps, plan

Status: round 1 in progress. This is the living ledger for the open-ended "beat
Lody on the features I actually use" program: inventory → gap matrix → plan →
implement → evaluate → repeat.

Reference for the Lody side: source read at `~/Workspace/works/Lody`
(`packages/components/src`), not screenshots. Kin-side evidence is in this
repo. Every row below cites where the claim comes from.

## 1. The common set

The daily loop, not the enterprise surface. Lody's team workspaces, billing,
invites, encrypted workspaces and beta flags are excluded: they are not what a
single owner running agents on their own machines touches, and matching them
would be cost without use. Twelve areas survive:

| # | Area | Why it is common |
|---|---|---|
| 1 | Conversation list | Every session starts by finding a session |
| 2 | Open conversation | Watching progress, reading the result |
| 3 | Composer | Sending, queueing while a round runs, attachments, delegation |
| 4 | Run config | Agent / model / permission / machine / workspace |
| 5 | Approvals and questions | The phone exists to answer these |
| 6 | Files and diffs | "What did it change" is the question after every round |
| 7 | Schedules | Recurring runs without a human |
| 8 | Projects | The grouping every list and diff hangs off |
| 9 | Search | Finding a conversation or a line from last week |
| 10 | Tabs / switching | Several conversations in flight |
| 11 | Usage and context | Cost, and how close a round is to the window |
| 12 | Sharing and notification | Getting the result out, and knowing when it lands |

## 2. Gap matrix

Severity: **S1** blocks a common task, **S2** costs taps or trust every day,
**S3** polish. "Reuse" is the open-source lever, if any, checked when the item
is scheduled — no version is pinned from memory.

### 2.1 Conversation list

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Server-backed list with filters (repo / project / status / PR / machine), mine-vs-team scope, archive screen, unread dots (`mobile-chat-list.tsx`, `mobile-filter-drawer.tsx:45`, `mobile-archive-screen.tsx:85`) | Project buckets over the first 100 tasks + 100 imported sessions; client substring filter (`SessionsPage.tsx:65,93,130`); pin/archive via localStorage (`taskPins.ts`) | Past 100 rows the UI cannot reach a conversation at all; no filter; no unread | **S1** | `@tanstack/react-virtual` for the list; the server already has `?q=` and a `before` cursor (`api.go:807`, `store.go:486`) |
| Swipe: pin / archive / restore / **delete**, long swipe auto-archives (`mobile-swipeable-row.tsx:341`) | Swipe: pin / archive only (`SwipeReveal.tsx`) | No delete or restore from the row | S2 | — |
| Multi-select: select all, delete (`mobile-chat-list.tsx:1018`) | Multi-select: pin / archive (`SessionsPage.tsx:208`) | No delete | S2 | — |

### 2.2 Open conversation

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Find in conversation (`session-chat-interface.tsx:1722`) | none | Cannot search a long transcript | **S1** | browser `window.find` is unreliable; a small match index over the projected items is enough |
| Turn duration ("Worked for"), turn info popover (`view.tsx:4955,4608`) | Round evidence card, no duration | Cannot tell how long a round took without reading timestamps | S2 | — |
| Goal chip, plan chip, PR/branch/worktree chips (`session-info-chips.tsx:129,306,356`) | header chips on desktop; phone has project subtitle only | Phone loses branch/PR state | S2 | — |
| Pinned-message banner (`session-pin.tsx:27`) | none | Cannot pin a message | S3 | — |
| Subagent panel with tokens, background count, cancel (`subagent-task-panel.tsx:176`) | `WorkerTimeline` (read-only timeline) | Cannot cancel a worker from the panel | S2 | — |
| Transcript renders progressively (Lody has virtualization in `ai-gui/view.tsx`) | `.map` over every item (`ChatStream.tsx:311`) | Long sessions jank; memory grows with the tab cache (8 mounted) | S2 | `@tanstack/react-virtual` |

### 2.3 Composer

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Queue rows: edit, drag-reorder, remove, steer (`message-queue-row.tsx:223`) | Queue badge; no list, no edit (`ChatStream.tsx:71`) | A queued message cannot be fixed before it runs | **S1** | — |
| Slash commands + prompt shortcuts (`mention-registry.ts:327`) | copy only (`Composer.tsx:366`) | No reusable prompts | S2 | — |
| Mentions: files, PRs, skills, commands, sessions, roles (`mention-registry.ts:53`) | agents + models only (`agentMention.ts:23`) | Cannot reference a file or another session | S2 | — |
| Attachments as structured parts | Path strings appended to the prompt (`Composer.tsx:197`); only the built-in Kin agent converts them (`kinagent/attachments.go:29`) | A Claude/Codex task receives a path, not the image | **S1** (data loss) | — |
| Paste-as-chip for long text (`session-chat-input-area.tsx:1364`) | raw textarea | — | S3 | — |

### 2.4 Run config

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Role / Agent / Model / Interaction / Reasoning / Permission / Plan / Fast (`mobile-run-config-sheet.tsx:117`) | Agent / Model / Permission + location rows (`RunConfigSheet.tsx:271`) | Six rows missing; documented as absent from the protocol (`RunConfigSheet.tsx:33`) | S2 | Role presets need no protocol: they are a saved prompt prefix. Plan/Fast map to permission modes some CLIs already expose |
| Desktop consolidated menu (`desktop-run-config-menu.tsx:61`) | strip under the composer (`TaskDetailPage.tsx:1407`) | Equivalent | — | — |
| Worktree setup/cleanup scripts per project | none | Cannot script worktree lifecycle | S3 | — |

### 2.5 Approvals

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Floating permission card on every screen, with a queue strip (`floating-permission-request.tsx:430,758`) | `/inbox` page + inline cards in the owning task (`ApprovalsPage.tsx:22`, `TaskDetailPage.tsx:906`) | An approval raised in task A is invisible while reading task B | **S1** | — |
| Question card with multi-select, custom text, notes (`ask-user-question-card.tsx:793`) | `UserQuestionCard` | Verify parity before claiming a gap | — | — |
| "Waiting for permission" marker in the tab sheet (`mobile-session-tab-sheet.tsx:249`) | none (phone has no tab sheet) | Folded into item 10 | S2 | — |

### 2.6 Files and diffs

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Per-turn diff cards (`view.tsx:5502`) | Reconstructed from tool payloads (`diffPreview.ts:1`, `RoundEvidenceCard.tsx:14`) | Edits made outside file tools are missing from the card | **S1** (wrong evidence) | The daemon already stores `task_checkpoints` per `event_seq` with tree OIDs (`migrate.go:332`, `store/checkpoints.go:10`) — the truthful source is there and unused |
| Changes sidebar with Code/Docs/Tests/Dev grouping (`session-changes-sidebar.tsx:366`) | `ChangedFilesBar` + `ChangedFilesList` | No grouping, no per-file review state | S2 | — |
| Mobile diff drawer (Changes vs Conversation diff) (`session-mobile-diff-drawer.tsx:75`) | dual-pane workspace panel | Phone diff is cramped | S2 | — |
| File viewer: preview, wrap, find, save, quick-open (`session-file-content-view.tsx:126`, `session-file-quick-open.tsx:235`) | `CodeViewer` (monaco) + `FileTree` | No find-in-file, no quick-open | S2 | monaco already has both; wire them |
| Image/CSV/Office/binary preview | images only, UNVERIFIED for CSV/Office | S3 | — | — |

### 2.7 Schedules

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Recurrence: daily / weekdays / weekly / monthly / hours / minutes / once, with next-run preview (`schedule-recurrence-editor.tsx:132`) | fixed `interval_secs` (`RoutineScheduleFields.tsx:4`, `internal/routines/scheduler.go:27`) | Cannot say "weekdays at 9" | **S1** | `robfig/cron/v3` (Go) for parsing + next-run; keep `interval_secs` as a compatible row |
| Agent/model/permission per schedule (`schedule-agent-controls.tsx:26`) | partial — verify | S2 | — | — |
| Run history | runs appear only as tasks | S2 | — | — |

### 2.8 Projects

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Project screen with conversations / files / settings tabs (`mobile-project-screen.tsx:934`) | one-pager + pulse + artifacts (`ProjectDetailPage.tsx:54`) | No conversations or files tab | S2 | — |
| Per-project settings, skills, default MCP (`project-settings.tsx:103`) | none | S2 | — | — |

### 2.9 Search

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Home search + in-conversation find + file quick-open + filter search | Three shallow layers, none of them content search (`SessionsPage.tsx:130`, `CommandPalette.tsx:95`, `kinagent/tools.go:195`) | Cannot find an old conversation or a line inside one | **S1** | server `?q=` exists; SQLite FTS5 if the driver ships it (verify), else LIKE over an index |

### 2.10 Tabs / switching

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Tab bar + mobile tab sheet with unread and waiting-permission states, drag reorder (`session-tab-bar.tsx:571`, `mobile-session-tab-sheet.tsx:144`) | Desktop tab strip, 12 tabs / 8 mounted (`SessionTabs.tsx`, `sessionTabs.ts:19`); phone has nothing | On a phone every switch is back → list → open | **S1** | — |

### 2.11 Usage and context

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Context usage + compacting, 5h/weekly windows, extra balance, reset forecast (`session-usage-popover.tsx:185,204,228,256`) | Tokens and cost only; no context-window field anywhere (`api/contract.ts`, OpenAPI) | Cannot see how close a round is to the window | S2 | the model catalog needs a `context_window`; adapters can report usage per turn |
| Machine quota (`machine-quota-compact.tsx:37`) | per-agent daily caps (`store/agent_limits.go:17`) | Different concept, comparable use | S3 | — |

### 2.12 Sharing and notification

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Public share link + share management (`share-management-setting.tsx:482`) | copy text, download HTML (`shareExport.ts`) | Cannot send a link | S2 | — |
| Share as image, themes, PNG (`chat-share-image-dialog.tsx:397`) | none | S3 | `html-to-image` or canvas |
| Push permission, completion notifications, Live Activity (`mobile-general-settings.tsx:619`) | Bark/ntfy webhooks only (`internal/notify/notify.go:19`) | Phone only learns when a webhook fires | S2 | APNs is a real cost; schedule last |
| Unread dots in tabs (`session-tab-bar.tsx:531`) | badge = currently pending, not new (`App.tsx:52`) | S2 | — | — |

## 3. Plan

Ordered by (common × severity) ÷ cost, one shippable slice at a time. Each slice
lands with tests, a `web/dist` rebuild, and the feature gate.

### Batch A — read path (round 1)

- **A1 Session search over the whole history.** Wire `SessionsPage` to `?q=`
  with a debounce; raise the ceiling past 100 with the existing `before`
  cursor; search imported sessions server-side too; render a flat, ranked
  result list with the matched field highlighted. Acceptance: a conversation
  older than 100 rows is findable from the phone in one search.
- **A2 Find in conversation.** Ctrl/Cmd+F and a phone entry from the session
  menu; match count, next/previous, jump to the turn. Acceptance: a phrase
  from the middle of a 200-turn session is reachable in two taps.
- **A3 Message actions while a round runs.** `showMessageActions={terminal}`
  hides copy/share exactly when a result is worth copying, and hides
  retry/fork until a round ends. Split the gate: read-only actions always,
  mutating actions when the round is terminal. Acceptance: copy works
  mid-round; retry/fork appear at the end.

### Batch B — switching and performance (round 2)

- **B1 Phone session switcher.** A sheet listing mounted tabs and recent
  sessions with running / waiting-permission / unread state, opened from the
  conversation header. Acceptance: switching between two live sessions takes
  two taps and never returns to the list.
- **B2 Transcript performance.** First framed as virtualization; measurement
  moved the target to the per-token re-render cost (see the B2 section for why
  windowing was dropped). Acceptance: a streaming token in a 300-turn session
  redraws one message, not three hundred.

### Batch C — truth and evidence (round 3)

- **C1 Per-turn diff from checkpoints.** Landed as a record written at capture
  time (see the C1 section): the stored tree OIDs answer, the payload is the
  fallback. Acceptance: an edit made by a non-file tool still appears in the
  round card.
- **C2 Context window.** Landed as model metadata in the price table plus a
  meter in the usage sheet (see the C2 section). Adapters do not report a
  window yet; the table is the source and an unknown model draws no meter.
  Acceptance: a session near its window says so before the next turn fails.
- **C3 Role presets.** Landed as a saved prompt prefix the new-chat run
  settings can drop into the draft (see the C3 section). Reasoning/Plan/Fast
  stay out until an adapter exposes them.

#### C3 — a role is a saved prompt, not a run setting (landed)

The reference client's role row sets a name, an emoji, a prompt prefix and the
agent and machine the role runs on. Only one of those four is a *prompt*
feature. The other three are run settings Kin already owns — the agent, the
model and the machine are chosen in the same strip — so copying them into a
second object would give every session two places to say which agent it uses,
and the two would disagree the first time someone changed one.

So a role here is the prefix and nothing else, and it does the one thing worth
keeping: the same long instruction, written once, inserted in a tap.

Three decisions:

- **The draft is the truth.** Picking a role writes its text at the top of the
  draft, followed by a blank line and whatever was already typed. The
  transcript therefore shows exactly what the agent was told. There is no
  hidden prompt channel, no "role applied" state to fall out of sync, and
  nothing to explain when a run behaves unlike the text on screen.
- **Taking a role off removes exactly what it put there.** The removal matches
  the role's text at the head of the draft *and* the seam after it — end of
  text, or whitespace containing a line break. A draft whose opening words
  have been edited into a longer sentence is the user's sentence now and is
  left alone; guessing there would delete a person's words to tidy up a
  setting. A role deleted from the list cannot be removed from a draft either,
  for the same reason: there is nothing left to recognize it by.
- **One role per draft.** Choosing another removes the previous prefix first,
  so switching never leaves the old instruction behind, and choosing "no role"
  is a real option that empties the draft of it.

The list lives in one settings key (`agent_roles`: a JSON array of
`{id,name,prompt}`) rather than in local storage, so a role written on the
laptop is on the phone — the same reason every other preference lives there.
The daemon stores it without interpreting it and validates only that it is a
JSON array; the meaning of a row belongs to the surface that writes it.

Where it appears is the new-chat page's run settings: a Role row in the phone's
sheet and a chip in the desktop strip, the same two places the agent and model
already live and the same place the reference client puts it. There is no role
control when there are no roles — a picker whose only entry is "none" is a
control that exists to be dismissed — and none on the session page, where the
role is already in the transcript and a prefix on a follow-up is just text.

Acceptance: from a new chat, reaching a draft that opens with a saved role
takes two taps at phone width and two clicks at desktop width, and what the
composer holds is the exact text that gets sent.

Verified: a helper table (parse rules for missing halves, duplicate and
hand-typed ids, clamping; insert/remove/toggle seams; switching and clearing)
and five DOM tests of the settings editor (add, edit by id, edit the prompt,
remove one row, save through the page's action). Two guards were red-verified
by mutation: deleting the seam check in `removeRole` makes the "keeps an
edited role in place" case delete the user's sentence, and skipping the
previous-role removal in `selectRole` leaves both prefixes in the draft.

### Batch D — automation (round 4)

- **D1 Recurrence.** Cron-style schedules with timezone and next-run preview,
  `interval_secs` preserved for old rows. Run history under the routine.

### Batch E — outbound (round 5)

- **E1 Share link.** A server-issued, revocable, read-only transcript URL.
- **E2 Push.** APNs/web-push after E1, because it needs the same server identity.

### Global approval (round 1)

- **G1** A floating approval card, so an approval raised in another task is
  answerable from wherever the reader is.

## 4. Evaluation

A slice counts as landed only when all four hold:

1. The acceptance sentence is demonstrated on a phone-width and a desktop-width
   build (screenshot or DOM assertion), not argued from source.
2. New behaviour has a test; a guard that could silently regress has one that
   fails when the guard is deleted (red-verified).
3. `tsc`, `vitest`, `go test` for touched packages, `npm run build` green.
4. A same-model review of the diff reports no blocker/major.

"Beats Lody" is judged per area on: taps to the common outcome, information
visible without opening a sheet, behaviour under failure (offline, empty,
mid-run), and whether the data shown is derived from the source of truth.
Recorded per round in the log below.

## 5. Log

### Round 1 — 2026-10-28

Inventory and matrix above. Batch A is being implemented; each landed slice is
recorded here with its acceptance evidence.

#### A1 — search reaches the whole library (landed)

What changed:

- `SessionsPage` sends the settled `?q=` to **both** list endpoints
  (`limit: 200` while searching, `100` otherwise) instead of filtering only the
  100 loaded rows. The field still narrows the loaded rows on the same frame,
  so typing never lags the request.
- `listAgentSessions` re-reads when the query settles; without the dependency
  the imported sessions kept answering the previous query.
- Matches are marked in the row title and the project heading
  (`HighlightedText`, `lib/highlightMatch.ts`). The split is plain
  case-insensitive `indexOf`, not a RegExp built from user input: a `(` in the
  field would throw and a `.` would match everything.

Acceptance: a conversation outside the recent 100 rows is returned by the
server query and rendered with the match marked. Verified by unit tests over
the splitter (11 cases), a DOM test over the mark rendering (5 cases), and a
source guard that fails if either fetch drops `q` or the effect drops its
dependency (both mutants red-verified).

Review (same model) found one blocker and three majors; all four were real and
fixed in the same slice:

- **Blocker — the local filter was narrower than the server's.** It tested the
  display title and the agent id only, so a task matched by prompt or cwd was
  returned by the daemon and then dropped on the way to the screen. The
  predicate now tests the daemon's own field set (title, prompt, cwd, agent, id;
  title, cwd, agent id, external ref for imported sessions). Regression tests
  cover a prompt-only match and a session matched through a cwd segment.
- **Major — a full-page loading flash on every settled keystroke.** A new
  live-list key starts unloaded, and the page blanked both lists while it
  fetched. It now retains the last loaded snapshot and narrows that locally
  until the answer arrives.
- **Major — a failed request read as an empty library.** The page never looked
  at the list resource's `error`; a dropped connection showed "no chats yet".
  It now renders a distinct load-error state.
- **Major — zero results after a server search showed the empty-library copy.**
  With the server doing the matching, "no rows" is the search's answer. The
  empty branch now chooses the search copy when a query is active, and a
  "searching…" state covers the window before the answer.

Nits fixed in the same pass: the highlight declines to mark when case folding
changes the string's length (`İ`), so it can never mark the wrong run; the
request parameters moved into `lib/sessionListParams.ts` and are tested
behaviourally instead of pinning call-site formatting; the project heading
carries an explicit `aria-label` so a `<mark>` cannot leak into its accessible
name; a query change clears the previous imported-session failure notice; and
the limit comment now states the daemon's 200-row clamp.

Residual risk: the authenticated phone/desktop visual check could not run in
this environment — the headless browser profile has no daemon token, and the
token is deliberately not copied into a tool call. Layout of the mark is
covered by classes that already exist (`truncate`, `text-inherit`), but the
first real look will be on the deployed Hub during release.

#### A2 — find reaches every message in the conversation (landed)

What changed:

- `ChatStream` grew a find bar: Ctrl/Cmd+F opens it, Escape closes, Enter and
  Shift+Enter step, next/previous wrap, an `n/total` count and a "no matches"
  state, and the active bubble is ringed and scrolled to centre. The matcher
  and the wrap-around step are pure functions in `lib/findInTranscript.ts`.
- The index is over the projected messages, not the DOM. `window.find` cannot
  say how many matches there are, cannot wrap, and in the Electron shell it
  scrolls the host page rather than the transcript column.
- The phone's session sheet gained 查找, because a phone has no Cmd+F. It opens
  the bar on `onDidDismiss` rather than on the tap: Ionic keeps keyboard focus
  inside an action sheet until it is removed, so focusing the field from the
  row's handler shows a bar that never raises a keyboard, and the removal then
  drops focus to `<body>`.
- Only the active pane may claim the shortcut (`findShortcut`). Sessions stay
  mounted behind the tab strip, so without it one Cmd+F opened a bar in every
  hidden pane.
- Closing cannot leave a mark behind: the hit list only exists while the bar is
  open, and a shut bar points at nothing. Escape defers one task boundary so a
  surface that already claimed the key — the mention menu, the command palette,
  a sheet — keeps it ("one Escape, one layer").

Acceptance: a phrase from the middle of a long session is reachable on a phone
in two taps (⋯ → 查找) and on a desktop with Cmd+F, with the count visible and
the match centred. Verified by 8 unit cases over the matcher/stepper, 14 jsdom
cases over the bar, and source guards over the sheet wiring. Six guards were
red-verified by mutation: the hidden-pane shortcut gate, the query reset, the
message anchors the scroll reads, the inner-Escape claim, the close-clears-mark
rule, and the step counter that re-centres a single match.

Review (same model) found **no blocker and four majors**, all real and all fixed
in the same slice:

- **Escape closed two layers at once.** The mention menu and the command palette
  answer the same key with `preventDefault` only, so the bar closed underneath
  them. The close now waits for the dispatch to finish and yields when the key
  was claimed.
- **The ring outlived the bar.** Typing a query, then pressing Escape, left the
  matched bubble ringed for the rest of the session. The hit list is now gated
  on `findOpen`, which clears the mark on the same render that removes the bar.
- **The phone entry fought the sheet for focus.** Opening from the row's own
  handler focused a field inside an overlay that still trapped focus. The row
  now leaves a note and `onDidDismiss` opens the bar.
- **This document still said A2 was unbuilt.** Corrected by this entry.

Nits fixed in the same pass: the fixed-width count cell clipped "No matches" in
English (natural width now, `tabular-nums` kept); the three bar buttons opted
out of the 44px touch floor the rest of the phone shell keeps; a query change
could paint the old ordinal for one frame; Enter on an empty result set left a
negative ordinal that would land on the *last* match once one streamed in;
closing dropped focus to `<body>` instead of restoring it; a single match could
not be re-centred after the reader scrolled away; and the match index was
recomputed on every streamed token while the bar was shut.

Deferred nit: opening the bar inserts ~44px at the top of the flow and shifts
the transcript down. The bar is sticky and in flow on purpose — an overlay
would need a positioned ancestor this page does not have — and B2's
virtualization is the natural place to revisit it.

Residual risk: the phone focus path could not be exercised in this environment
(no authenticated phone build here). The deferral follows Ionic's documented
dismissal order, but the keyboard actually raising on iOS still needs a device
check on the deployed Hub.

#### A3 — message actions while a round runs (verified; no change needed)

The plan asked to split the `showMessageActions={terminal}` gate. Reading the
render path first was the whole job: only retry/fork are gated on
`showMessageActions` (`canRetryFork`), while copy and save-artifact are gated
only on the message being complete (`canCopy`, `canSave`). The intended end
state — copy mid-round, retry/fork at the end — already holds, so A3 is a
verification rather than a change. Its old wording ("copy/share exactly when a
result is worth copying") described a bug that is not in the tree.

**Batch A is closed.** Next: batch B (phone session switcher, transcript
virtualization).

#### B1 — the phone's session switcher (landed)

The tab strip is desktop-only, so on a phone every switch was back → list →
open; the acceptance was two taps between two live sessions without returning
to the list. The conversation header now carries a switch control beside ⋯
that opens a sheet with two sections:

- **Open** — the tab order, in strip order.
- **Recent** — the sessions behind them (twelve).

Each row carries one mark, in precedence order: waiting (blocked on an approval
or a question), running, failed, unread (finished and not yet seen), idle.
Waiting is read from the task's own `waiting_approval` / `waiting_input` status
*and* the pending lists, so the mark survives the moment between a status
update and a list refresh. A tab whose task fell off the loaded page is still
listed — untitled, or waiting when the pending lists know it — because a
switcher missing the session in front of the reader is worse than an untitled
row.

The host assembles the rows from the subscriptions the sidebar already reads
(task list, pending approvals/questions, viewed state), so the sheet adds no
polling of its own. The control exists only on the phone: both the header
button and the sheet are `md:hidden`.

Review (same model) found three majors, all real and all fixed in this slice:

- **Marking viewed on every status change reversed a desktop rule.** The
  sidebar deliberately keeps its green dot when a watched session finishes
  (`handledSelectionRef` and its comment say so). The write moved out of an
  always-on effect into the open handler: asking "what is new?" is the moment
  the session in front stops being new, and this control only exists on the
  phone.
- **"Waiting" ignored the task's own status.** The daemon really does set
  `waiting_approval` and `waiting_input`; the mark now reads them first and
  treats the pending lists as the complement, not the only source.
- **An open tab missing from the loaded page was always idle**, even when the
  pending lists named it. That branch now answers waiting too.

Nits fixed in the same pass: the viewed snapshot moved to
`useSyncExternalStore` with a string snapshot (a fresh array would re-render
forever); the active row is drawn from the detail subscription the pane already
holds, so a session older than the newest hundred keeps its name and state; row
tap targets reach the 44px floor with a press state; and the Chinese "waiting"
label is 待处理, because the state covers questions as well as approvals.

Deferred nit: after a switch, focus is not moved into the new pane — `Sheet`
restores it to the opener, which is now hidden. Keyboard-only, narrow widths
only.

Residual risk: there is no authenticated phone build in this environment, so
the two-tap flow and the sheet's feel were verified in jsdom and in the source,
not on a device.

#### B2 — transcript performance (landed)

The plan said "window the transcript". Measuring first changed the answer. A
local benchmark (jsdom, one streaming token that grows the last message, median
of four updates plus the settling update) put the cost where it was not
expected. The harness was rewritten after review: each iteration hands down a
*new* event array — what a WebSocket event really does — so the projection runs
inside the measurement, and the fifth update clears the partial flag on a
byte-identical body, which is the real end of a stream.

| 300 turns | before | after | speedup |
|---|---|---|---|
| with tool cards | 97.2ms | 23.5ms | 4.1× |
| without tool cards | 77.4ms | 12.9ms | 6.0× |
| settling update (tools) | 90.1ms | 23.6ms | 3.8× |

At 100 turns the same harness reads 32.6ms → 11.2ms with tool cards and
27.4ms → 8.3ms without. The projection is ~1ms of the total either way; the
rest was re-rendering every message body, because a token rebuilds every item
object and nothing below the transcript was memoized.

So the change memoizes what a token does not change:

- `Markdown` is memoized, so an unchanged body is not re-parsed (the parse is
  the expensive half of a redraw, and the other pages that draw markdown get
  the same protection against poll-driven re-renders);
- `MessageBody` is memoized on `(text, partial)` — the boundary the streaming
  tests pin, and the one place that decides whether a message redraws;
- `AssistantMessageItem` and `MessageRow` are memoized with comparators that
  compare what is drawn (key, text, partial, seq, message scope, selection,
  find hit, busy flags, queued, save-button presence) and deliberately ignore
  callback identity, which changes on every parent render and would otherwise
  defeat the memo for the ninety-nine messages that did not change.

The comparators are exported and pinned clause by clause: one table row per
prop that changes a render, plus a row proving a rebuilt item with fresh
closures compares equal. That table is what catches the failure mode a DOM test
cannot — a prop whose clause was forgotten keeps drawing the old value forever.
Six mutations were run against the new tests to prove they fail: dropping the
partial, seq, queued or save-presence clause each turns exactly its own row
red, and removing both body memos turns the "control flag does not re-parse"
case red.

What is left at 300 turns is the tool-card subtree: the same transcript
streams in 12.9ms without tool cards, so ~10ms is the card scaffolding, whose
steps the projection rebuilds every token. The next lever there is
projection-level identity reuse, not more React memo. First paint is untouched
by this work (~300ms for 300 turns) — opening a very long session still pays
the full parse, which is the only case where a real virtual list would earn its
costs.

Windowing was prototyped and dropped. `content-visibility: auto` plus
`contain-intrinsic-size` on a box per turn cut first layout in Chromium from
40.5ms to 3.3ms, but (a) scrolling a fully laid-out 300-turn transcript already
costs ~0.1ms per scroll step, so it bought nothing for the acceptance case;
(b) the placeholder height left the scroll height at 54% of the truth until
turns were visited (62.7k of 116.4k px on first paint, 116.4k after a walk),
which is a visible scrollbar and scroll-anchoring artifact on exactly the long
sessions it was meant to help; and (c) the skipped boxes imply paint
containment, which clips the selection/find rings that sit outside the box, and
`TaskDetailPage`'s scroll restore watches a child that does not resize when a
skipped turn renders. A real virtual list would additionally cost the find
bar's jump to an unrendered `[data-message-key]`, the tab cache's scroll
restore, and native cross-turn selection. Recorded here so the next round does
not re-litigate it without new measurements.

Residual risk: ~23ms per token at 300 turns under jsdom (a browser commits
less). Callbacks are compared by behaviour, not identity, so a memoized message
can hold a callback from an earlier render; the only callback that reads
evolving task metadata is save-artifact's derived title, and it now reads the
title from `taskTitleRef` rather than its closure.

#### C1 — the round card reads the workspace (landed)

The plan said "replace payload reconstruction with the stored tree OIDs". The
checkpoints were already there — one per user message, each a `git write-tree`
of the worktree — but nothing compared them, so the round card could only list
what a file tool said it wrote. An agent that renamed a symbol with `sed`, ran
a formatter, or generated a file left no card, or a wrong one.

The shape that landed is a record, not an endpoint:

- when a turn's checkpoint is captured, the engine diffs it against the
  previous checkpoint and appends a `round_changed` event: the round's
  `from_seq`/`to_seq`, both tree OIDs, the true file count, and up to 200
  files with status and line counts (`internal/task/engine.go`,
  `recordRoundChanges`);
- the diff itself is git's (`workspace.ListTreeChanges`): one
  `diff-tree --name-status --find-renames` pass for the list, one
  `--numstat --no-renames` pass for the counts, run against the task's private
  checkpoint object directory. The environment setup was copied three times
  before this; it is now `checkpointEnv`;
- the console prefers the record for the round it names and falls back to the
  payload reconstruction for everything else — shared checkouts, tasks that
  ran elsewhere, sessions older than the record, and the newest round, whose
  closing checkpoint does not exist until the next turn starts;
- an empty record is a record: the two snapshots agree, so no card is drawn
  even when a tool payload claims a write. A write the next turn reverted is
  not a change to report;
- the card's scope sentence follows the source (`chat.evidence.scopeWorkspace`),
  because "only what file tools changed" would now be false for recorded
  rounds. Previews still come from the payloads: a file both sources know
  shows its before/after, a shell-only file opens to "nothing reconstructible".

Why an event rather than `GET /tasks/{id}/rounds/{seq}/diff`: a session draws
one card per round, so a per-round endpoint is one request per card on screen,
and the answer would have to be cached against a stream that truncates on
retry. The event is written where the facts are (the capture), travels with
the transcript the card already reads, and is deleted with the turns it
describes when a turn is retried.

Acceptance: a file rewritten by a shell command appears in the round card with
its status and line counts, and a round whose writes were reverted shows no
card.

Verified: a real temp-repo test (shell rewrite, new file, deletion — statuses
and counts), two engine tests (two turns produce exactly one record with the
right `from_seq` and files; a failed diff produces none while both checkpoints
still land), four console tests (record wins over payloads, shell-only file
listed, empty record suppresses the payload card, previews survive for shared
paths). Five mutations were run to prove the tests fail: no record call,
record despite a failed diff, self-diff, card ignores the record, empty record
falls back to payloads.

Residual risk and bounds: only isolated worktrees have checkpoints, so the
feature is absent for shared checkouts and remote tasks by construction; the
record for a round appears when the next turn starts, and a session that ends
never records its last round (payload fallback); the two boundaries are the
user messages, so a hand edit made between turns is attributed to the round
before it; a record is capped at 200 files (the card shows six and counts the
rest).

#### C2 — the usage sheet shows how full the window is (landed)

The sheet could say what a session had spent and never how much room was left.
Those are different questions: totals grow for as long as the session lives,
while the window is a ceiling on one request, and a session that reaches it
loses detail or fails its next turn. Lody answers it in the composer; Kin now
answers it where the reader already looks for numbers.

Three decisions shaped the slice:

- **The window is model metadata, not usage.** It went into the price table
  (`PriceEntry.Ctx`), because that file already carries one row per model from
  the one upstream dataset that publishes both — LiteLLM's
  `model_prices_and_context_window.json`. `scripts/gen_default_price_table.py`
  now emits `ctx` from `max_input_tokens`; a hand-written override without it
  stays valid and simply has no known window.
- **The number is the last request, not the session.** `store.TaskUsage` gained
  a `context` block: the input side (prompt + cache reads + cache writes, the
  three things that occupy the window) of the most recent record from the
  task's own agent. Records without an input count are skipped; so are worker
  records from other agents (a dispatched task has one conversation per
  worker, and the reader is in the host's) and the host's own controller calls
  (plan refinement, synthesis), which the engine stamps
  `provider: controller` — their prompt is a brief, not the session.
- **A missing half draws nothing.** `contextFill` answers null unless both the
  request size and the window are known, so an unlisted model shows its tokens
  with no denominator instead of an empty bar that reads as "plenty of room".

The endpoint resolves the window from the loaded price table (which honours a
user override) and adds `context_window` beside the usage payload; the console
draws a thin bar under `usage.context`, blue below 80%, amber to 95%, red at
and above it, with one sentence at those thresholds and none otherwise. A
request past the ceiling keeps its honest percentage (e.g. 103%) while the bar
clamps and `aria-valuenow` stays at 100.

The regenerated table also carries what the generator used to throw away:
ids upstream has since pruned keep their previous row (a retired id with a
stale price beats a silent zero), and the two Anthropic ids the built-in
catalog actually resolves to (`claude-opus-4-8`, `claude-sonnet-4-6`) were
added to the curated set — the catalog's own defaults previously had no price
and no window. Five models (`gpt-5.1-chat`, `grok-code-fast*`, `o1-mini`) carry
upstream price refreshes from the same run; no other price moved.

Two gaps the review found in the generator, both fixed. A kept row is copied
whole and the committed table predated the window column, so five retired
Claude ids (`claude-opus-4-1`, `claude-sonnet-4-20250514`, …) would have gone
without a denominator forever; `KEPT_CTX` supplies their 200k default window and
is deliberately limited to ids whose default is not in doubt — 46 of 56 rows now
carry a window, and the ten that do not are Grok ids whose ceiling is the open
question. And an id *removed from `ALLOW`* used to vanish from the table with no
line anywhere; the generator now reports it in SOURCE.txt and on stderr, which
is the same "a retired model losing its price silently" harm the keep policy
exists to prevent.

Acceptance: a session near its window says so before the next turn fails.

Verified: store tests (latest request not the sum; a controller record and an
input-less record are skipped; the pinned model is the fallback; a legacy task
with no observed request has no context), price-table tests (the built-in rows
for every catalog model, alias/prefix lookup, an entry without `ctx` is
unknown, negative `ctx` is rejected, retired ids survive regeneration), an API
test (the response carries `context` and `272000` for `gpt-5-codex`, and zero
for an unlisted pin), a helper table (thresholds on the rounded percentage, clamping,
the null cases) and eight DOM tests (the meter only when both halves are known,
the clamp, the two hints, silence when there is room, and the card and phone
trees each reaching it). Eight
mutations were red-verified: first-request-instead-of-last, no agent filter, no
input-count filter, no controller-record filter, zero window reported as known,
endpoint not enriching, `contextFill` ignoring the window, and the meter drawn
with no data.

A same-model review of the diff reported no blockers, one major — the tracked
`web/dist/index.html` was built before the threshold edit, so the shipped bundle
still carried ratio-based levels — and six nits. The rebuild fixed the major;
three nits were fixed in place: the controller stamp became one exported
constant (`store.UsageSourceController`) that the engine writes and the store
reads, so a rename is a compile error rather than a silent filter miss; the two
generator gaps above; and the tests the review found missing (the side-rail card
and the phone sheet each draw the meter, and a saved `price_table` override
supplies — or withholds — the window the endpoint reports). Two were considered
and declined, with the reason recorded here rather than left implicit:

- **Droid's model ids are still out of the curated set.** 41 of droid's 46 ids
  have no row, so most droid sessions draw no meter. Adding them changes
  default *pricing* coverage as well (models that previously reported cost as
  unknown would start estimating), which is a different slice; it belongs with
  a droid-specific pass, not with the window.
- **`latestContext` still walks past a record with no input count.** The review
  read such a record as "the newest request, so an older number understates
  fill". It is a cost or output report, not a request — a request that reports
  usage reports an input count — and stopping there would blank the meter for
  every turn whose last record is cost-only. Walking past it does not make the
  number older than the newest *request*.

Residual risk and bounds: the window is whatever LiteLLM says the model's
*maximum input* is, which for a subscription plan can be larger than the
effective per-request ceiling (a 1M row for a 200k plan would understate
pressure); the denominator is displayed and the table is editable in Settings,
and preferring a window an adapter reports remains the follow-up once one does.
The meter refreshes when the task row's totals change, i.e. once per completed
turn, not mid-turn. Cost and context both key off the model name, so an agent
that reports no model relies on the task's pin.

#### D — a routine can run on the calendar, not only on a timer (landed)

Lody's schedules are wall-clock rules: manual, every N minutes or hours, daily,
weekdays, weekly on chosen days, monthly on chosen dates, or once at an instant,
each with a time zone. Kin had `interval_secs` and nothing else, so "every
weekday at 09:00" could not be expressed at all, and a 24-hour interval drifted
by however long each run took.

The interval stays. It is what every existing routine was created with, it is
the fallback when a rule is cleared, and it is the pace the missed-run policy
measures against when there is no rule. A routine may now also carry a
`recurrence` — a small JSON rule (`daily`, `weekdays`, `weekly`, `monthly`,
`once`) in an additive column. Only two things consult it: the next due instant
and the "how late is too late" threshold for the skip policy. Claims, leases,
the in-flight budget and the dispatch ledger are untouched, which is why this
did not need a scheduler rewrite.

Decisions inside it, and why:

- **The rule carries its own time zone**, defaulted from the browser when the
  form writes it. The daemon is usually a container running in UTC; a rule
  without a zone would fire at the wrong hour for its user and look correct in
  the database.
- **A monthly day the month does not have means that month's last day.** A
  "the 31st" routine runs on 28 February rather than skipping the month, because
  silently not running is the failure a user cannot see.
- **A `once` rule retires itself** (`enabled = false`) the moment it has been
  dispatched. Left enabled it would sit in the due list forever, either firing
  again or showing a next run that will never come.
- **An unreadable stored rule does not fall back to the interval.** It records
  `last_outcome = failed` with the parse error and refuses to fire. Falling back
  would run a corrupt rule at an arbitrary time, and a `once` rule would repeat
  forever.
- **`interval_secs` is derived server-side** from the rule's own period when the
  client does not send one, so the form never asks for a number the scheduler
  ignores.
- **The first run of a new rule is the rule's next occurrence**, not "as soon
  as the scheduler looks": creating a weekday-morning routine on a Tuesday
  afternoon must not run it on Tuesday afternoon.

Coverage: eleven rule-table tests (strict-future comparison, weekends skipped,
chosen days, monthly clamping into February and into a leap February, the
earliest of several days, one-off semantics, the rule's zone rather than the
caller's, wall-clock stability across a DST spring-forward, the period each kind
reports, validation refusals, parse rules), four scheduler tests (due instant,
once retirement, unreadable rule, skip threshold by the rule's own period), four
store tests (round trip, empty default, set and clear, and an upgrade from a
database whose `routines` table predates the column), three HTTP tests (create
with a rule, refusal of an unfireable rule and of a past one-off, and a patch
that moves the next run with the rule), and eight each on the client rule
module and the schedule form.

Eight mutations were red-verified: `>=` instead of strict `>`, the caller's zone
instead of the rule's, no monthly clamp, no once retirement, no unreadable-rule
guard, the interval threshold instead of the rule's period, serializing a
half-written row, and dropping the last chosen weekday.

The upgrade test found a real defect before it shipped: a database already at
the current `user_version` but missing the new column was not repaired by the
numbered migration alone, because the runner stops at "version is current". The
column is now also reconciled on every open (`ensureRoutineRecurrenceSchema`),
the same way `users.role` is.

#### Verifying D found the console living on a ten-second poll (fixed)

Checking the new role editor by hand, a freshly added row disappeared about six
seconds after it was added. The row is draft state, so something was replacing
it with the stored list — and the only writer of that list is the page load,
which reruns when the realtime stream reconnects.

The stream was reconnecting every ten seconds. `/api/events` re-checks its
credential on a ticker (`principalRecheck`), and `principalStillValid` handled
device and user principals only; a request carrying the master token — the
desktop console, and any local `kin` client — fell into the `default` branch and
was told its credential was invalid. The daemon hung up on schedule. Measured
against a live node: `curl` with the master token received the `retry:` preamble
and then EOF at exactly 10s, with no heartbeat in between.

Why it matters beyond the role row: the client treats a closed stream as "I may
have missed something" and refetches the page snapshot on reconnect, by design.
So every page was quietly reloading itself every eleven seconds, and any draft
in progress — a new role, a price table, a webhook URL — was replaced by what
was stored. That is also why several screens felt like they "reset" for no
reason.

The credential decision now lives in `credentialStillValid`, which takes the
principal and the token instead of reading them out of a context, so it can be
tested without holding a stream open for ten seconds. The master credential is
exempt (it cannot be revoked); a device still has to be active, and a browser
session still has to authenticate. Five table cases plus a red check: removing
the master exemption fails both master cases.

Post-fix, a stream held open with the master token survives past the recheck and
keeps delivering heartbeats.

Deliberately not changed: the reconnect handler still reloads the page snapshot,
drafts included. With the stream fixed that only happens on a genuine
disconnect, where re-reading the server is the correct behaviour; a
draft-preserving merge is a bigger design change than this defect justifies.

#### E1 — a conversation can be handed out as a link (landed)

Lody can share a session as a read-only page. Kin could not: the only way to
show someone a conversation was to give them the console, which means giving
them the machine. E1 adds the link.

**The surface.** Three authenticated routes on the task — `GET`/`POST`/`DELETE
/api/tasks/{id}/share` — and two public ones: `GET /s/{token}`, a standalone
HTML page, and `GET /api/public/shares/{token}`, the same conversation as JSON.
The page carries no bundle, no web font and no script, so it opens in any
browser and reads the same in five years. Both public responses are `no-store`,
`no-referrer` and `noindex, nofollow`: a revoked link that a search engine
cached is a link that is still readable.

**Decisions, and the reasons.**

- *One live link per task.* Minting again revokes the old one in the same
  request. "Create a new link" is how an owner replaces one they lost, and
  leaving the old one alive would mean two doors for one decision.
- *The token is returned once.* The daemon stores only its digest, exactly as it
  does for device credentials, so the URL exists solely in the response that
  minted it. That is why the dialog says so plainly and offers "create" again
  rather than pretending it can show the link later.
- *The console builds the URL.* `window.location.origin` is the address the
  reader of this console was reached on — the Hub when the phone shared it, the
  machine itself when the desktop did. A server-side guess would be wrong for a
  Hub that proxies several nodes.
- *The transcript is a deliberately small subset.* Final messages only (no
  streamed partials, they repeat the final text), no subagent sidechains, and
  text blocks only — which is what drops tool calls and tool echoes that travel
  on the same channel. Publishing less than the owner sees is the safe
  direction, and the rule is the same one the console applies to decide a
  message is user-facing.
- *The audience rule is the console's own, and it is the one that matters.*
  A task log also carries the work of subagents and workers, marked
  `visibility: {"user": false, "task": true}`; the console keeps those in the
  task log, and the first version of this page published them — 1,927 such
  assistant messages exist on the author's own node, and they would have been
  rendered under the main agent's name. `shareMessageOf` now mirrors
  `isUserFacingEvent`: the orchestrator's own words are always for the reader,
  then an explicit `visibility.user` decides, then the speaker does (historical
  rows predate the field and are identified by a worker speaker). A worker the
  console does show keeps its own name on the page rather than the header's.
- *Bounded three ways, and honest about it.* A share keeps the most recent 800
  messages, out of the newest 2000 message events, each line clamped to 12KB.
  It reads one row past the event window so that a cut window is reported as
  `truncated` rather than silently presenting a partial conversation as whole.
  A public page is not a mirror of the database, and a stranger should not be
  able to make one expensive.
- *The page speaks the reader's language.* Chrome words (You, read-only, the
  footer, the revoked notice) follow `Accept-Language`; the conversation itself
  is published as written.

**Storage.** Migration 41 creates `session_shares` (id, task, token digest,
created, expires, revoked) plus a task index. The DDL is one exported constant
that both the migration and the every-open reconciler apply, so the two cannot
drift — and the reconciler matters more than usual here: a share read happens
on an unauthenticated path, where a missing table would be a 500 shown to a
stranger.

**Verification.** Store tests cover live-until-revoked, the expiry bound,
per-task isolation, the reconciler on a dropped table, message-event selection,
the delete cascade, and that a failed insert inside a replace leaves the old
link working. API tests cover the published subset (partial, sidechain, tool
echo, tool use, sidechain, and every task-only visibility shape excluded; a
visible worker named), HTML escaping, revoke, replace-on-create, the window cut,
the per-line clamp, string content, the reader's language, and that the state
response carries no token. Every guard was red-verified by mutation — including
the audience filter, which fails the subset test when deleted, the way the
stealth of the original defect demands. Console tests cover create → URL shown
once and focused, revoke → link gone, a link revoked elsewhere → dropped,
Escape, and a task change → the old link dropped. Then by hand, against a
throwaway daemon seeded with exactly those shapes at 390px and 1280px: three
messages rendered, a `<script>` payload shown as text, no script tags in the
document, no horizontal overflow, and a revoked token answering 404 on both
public routes.

**Not in this slice.** The public routes take no attempt limit of their own (a
256-bit token makes guessing hopeless, so this is a volume question, not an
enumeration one). Nothing sets `expires_at` yet (the column and the read
path are ready; the console does not offer "expires in a day"), there is no view
count or access log, and the link's URL cannot be shown again by design.

**Follow-up — the page renders the conversation, not its source.** The first
landing escaped each message verbatim, so a reader got `**done**`, triple
backticks around every code block and tables as rows of pipes: the markup, not
the answer. Verified live on the node, it was the one thing about the page that
read as a raw log. Messages are now rendered with `github.com/yuin/goldmark`
(GFM, hard wraps so a single newline stays a line break, matching the console's
paragraphs). goldmark is one module with no transitive dependencies, and only
the HTML page uses it — the JSON endpoint still publishes the source, because a
caller that renders the conversation itself should not be handed pre-rendered
markup.

Two boundaries moved with it, both tested rather than argued:

- *Raw HTML is shown, not dropped.* goldmark's default replaces raw HTML with a
  comment: safe, and it silently eats content — an agent writes `<div>` and
  `<script>` for a living, so a sentence would arrive with a hole in it. A node
  renderer writes those bytes back as escaped text, which is what the console's
  own renderer does with them.
- *A `javascript:` destination never becomes an anchor.* goldmark's link
  renderer refuses the scheme. The test pins it beside a working `https:` link,
  so it cannot pass by rendering no links at all.

The review of the first version found the boundary it had missed, and it was
the serious one: an image. goldmark renders `![](https://…)` as an `<img>`, so
an agent that had been prompt-injected by a page it fetched could put a URL in
its answer, and every reader of the link would then call that host — a read
receipt with their IP, a blind `GET` into their own network at worst. Images
are now rendered as the markdown that asked for them, which is also what the
console does (it has no image renderer either), and the page carries
`default-src 'none'; style-src 'unsafe-inline'; img-src 'none'` so the whole
document class is closed rather than the one case. The same review measured the
page's cost: the per-line clamp bounds one message, not the sum, so 800 full
lines were ~9.6MB of markdown and hundreds of milliseconds of CPU per request
on a route anyone holding a link can repeat. A third cap, `shareTotalBytes`
(512KB), spends the budget from the newest message backwards and reports the
cut as truncated.

Red-verified by mutation: removing the raw-HTML renderer, dropping the image
escaping, removing the image renderer, dropping the CSP header, dropping the
byte budget, raising the render limit, dropping the prompt clamp, restoring the
old ellipsis arithmetic, removing `WithHardWraps`, swapping GFM for a narrower
extension, and putting the `HTML` field back on the wire each fail the test
that names them.

A second pass found two ways the caps did not hold, both now closed. The prompt
fallback ran *after* the byte budget and skipped the line clamp, and a prompt
is the one input here nobody bounds — the create route accepts any body, so a
legacy task with a multi-megabyte prompt would have rendered all of it on every
anonymous request; it now passes the same clamp and the same budget. And the
budget counts *source* bytes while markdown expands: a page of nested
blockquotes renders to roughly thirty bytes per source byte. A third pass
separated the two consequences the first fix had written down as one. The
*cost* is bounded by the source budget, because that is all the parser ever
sees — 512KB, whatever it renders to. The *output* is bounded separately by
`shareRenderBytes`, a per-message cap past which the message is shown as its
escaped source. It was first written as a refusing writer, on the theory that
an error from `Write` stops goldmark's walk: it does not. The HTML renderer
discards write errors and the walk reports them together at flush, so the
conversion runs to completion either way — measured, capped and uncapped cost
the same. The cap is now a plain post-check on the buffer, described as a size
bound, and the tests pin both ends: a line built to explode (twelve thousand
nesting levels) falls back to its source, and a dense but ordinary table — two
thousand compact rows, six bytes in and thirty-five out — still renders as a
table. The first cap was 64KB, which that table exceeds; it is now sixteen
times the line cap, clear of the densest ordinary content measured (~7.3×).
The clamp also stopped appending its ellipsis outside the cap it advertises. On the test side,
the image-escape guard had been pinned by a URL that escaping leaves unchanged
— removing the escaping was a live XSS the suite still passed — so the payload
now carries markup in both the alt text and the destination.

The console side got one fix from the same live pass — focusing the minted
field selects the whole value and a selection that long scrolls the input to
its end, so the dialog now scrolls back to the URL's scheme.

#### G1 — an approval is answerable from any screen (landed)

An approval blocks the agent that asked for it, and it was visible in exactly
two places: `/inbox`, and the transcript of the task it belongs to. A reader in
any other conversation, in settings, or on the project list had no way to know
an agent had stopped — the one state here that costs wall-clock time for every
minute nobody looks. Lody floats a permission card over every screen; Kin now
floats one too.

**What floats, and what does not.** `lib/floatingApprovals.ts` is the rule, as
a pure function so it can be argued with without a browser:

- Nothing over `/inbox`, which already lists every waiting approval with more
  room than a card has.
- Nothing for the conversation on screen, whose transcript renders its own
  approval inline beside the tool call that asked — that card is the better
  one, and two live copies of one decision invite answering it twice.
- Everything else floats, including while reading a *different* conversation.

The card shows the approval that has waited longest, not the newest: a surface
that always shows the latest arrival starves the queue. The rest are counted in
the strip above it (`+2`), which is also a link to the task, and the card
itself is `ApprovalCard` unchanged — the same diff preview and buttons as the
inbox, so the decision reads the same wherever it is made.

**One decision path.** Answering used to be a private four-step dance, with two
copies: one inside `ApprovalsPage`, a slightly different one inside the
conversation page (no refetch when the call failed), and a third in the
menu-bar tray that swallowed failures entirely. `useApprovalDecision` is now
that path, used by the inbox, the floating card, the transcript and the tray;
the page keeps only its own bookkeeping (`handledHere`, so the focus notice
does not call an item it just answered "missing"). The hook also refuses a
second answer for an approval already in flight — the inbox's keyboard model
does not consult `busy`, and a held key would otherwise post a 409 and toast a
failure for something that worked.

**The composer.** The first version pinned the card to a guessed offset and, in
the browser, covered the chat composer on both widths — the one thing it must
never do. The conversation page now marks its bottom band
(`data-kin-bottom-chrome`: the waiting strip plus the input, ~180px on a phone
and taller with attachments) and the card measures it, following the real
height. A cold load draws the shell before the task has loaded, so the
measurement also waits for the band to appear (MutationObserver), and re-runs
when the route changes; without that the card kept the offset it took when
there was nothing to measure — which is exactly what the first live pass
caught.

**What the review caught.** Two holes a live pass missed because it never
visited a conversation before navigating away:

- *Cached panes.* `TaskSessionHost` keeps up to eight visited conversations
  mounted and hides the inactive ones with `display:none`. Their composer bands
  stayed in the document, and a page-wide query could pick a hidden one — a box
  with no size, an offset that put the card off the top of the screen. Only the
  visible pane marks its band now, and a zero-size box is treated as "not laid
  out yet" rather than measured.
- *The draft screen.* `/new` is where a cold launch lands and it pins the same
  composer; a rule keyed on the conversation route alone left a pending
  approval covering the draft input. The draft composer marks the same band,
  and the shell asks the card to measure on both routes.

The floating card also sits inside its own error boundary: it renders an
agent-supplied payload, and a throw in one card must not take the shell around
every screen down with it. The inner boundary is keyed by the approval, so a
payload that cannot render costs that one card and the next approval renders —
a boundary stuck in its caught state would hide every later approval until a
reload.

**What the second review caught.** Three things a user could hit, none of them
visible in the first live pass:

- *The third composer screen.* `/agent-sessions/<id>` pins the same continue
  box and did not carry the band marker, and it is a detail route, so the card
  measured nothing and sat on the composer at both widths. It marks its band
  now; `/artifacts/<id>` has no band at all and is no longer asked for one, so
  the card keeps its own offset there instead of watching for a band that never
  comes.
- *The navigation drawer.* The phone drawer is `z-40` like the card, and the
  card comes later in the DOM — so an approval floated over the drawer's scrim
  with live buttons. The card is not rendered while the drawer is open.
- *Focus after a deny.* Focus recovery always went to *Approve*, so a reader
  who denied one request was one reflexive Enter from approving the next. The
  recovery remembers the decision and lands on the same button; a failed
  decision disarms it, so a later queue change cannot pull focus out of
  whatever the reader moved on to.

Nits fixed in the same pass: the card no longer advertises `A`/`D` (only the
inbox and the transcript bind them); the strip is a polite live region so an
arrival is announced, and the `+N` badge keeps its sentence for screen readers
instead of an `aria-label` on a plain span; the "the title is joined onto every
approval" comment now says live approvals arrive without one.

**What the third review caught.** The layer under the previous fixes:

- *The drawer state across `md`.* The drawer is `md:hidden`, but "open" lived on
  in state, and every control that could close it was inside the hidden
  subtree. Rotating with it open — or dragging a phone-sized window wide —
  would suppress the floating card for the rest of the session, which is the
  opposite of what the suppression is for. The drawer now closes itself when
  the viewport is, or becomes, wide.
- *A stale task name.* The card preferred the title joined onto the approval
  row, which is whatever the task was called when the pending list was
  fetched. The shell's live list wins now; the joined title is the fallback for
  a task that page does not hold.
- *One frame at the wrong offset.* The measurement ran in a passive effect, so
  a mount — a route change, or coming back from the drawer — painted once at
  the dock-clearing fallback, over the composer, before the layout effect
  moved it. It is a layout effect now.

Nits fixed in the same pass: the outer boundary takes a `resetKey` (the set of
pending ids) and drops its caught state when the queue changes, so one bad
render cannot hide every later approval where there is no Retry to reach; the
wiring scan is tighter — the measured-route assignment is checked as a whole
and the band markers must sit on their own attribute line, so a marker behind
`false &&` or a stray `|| detailRoute` fails the test. Still deferred: the
cold-load observer is unbounded on a conversation whose task never loads;
answering the last approval drops focus to the document; a live region's first
arrival is announced best-effort by platform; and focus edges when the queue
changes while a decision is in flight are untested.

**Acceptance** (scratch daemon on :7788, two pending approvals in two tasks;
re-measured after the review rounds):

- Phone 390×844, `/sessions`: card bottom 696, the dock's "new chat" button top
  704, dock top 776 — clear of both. Shows the older request, `+1` beside it.
- Phone 390×844, `/new`: card bottom 700 against the draft composer band top
  708 — an 8px gap, the landing screen's input clear.
- Phone 390×844, `/tasks/task-g1-a` then task-g1-b (client-side, so both panes
  stay mounted and one is `display:none`): exactly one band in the document —
  the visible pane's, top 664 — card bottom 656. The cached pane's zero-size
  box is never measured.
- Phone 390×844, drawer open: no card in the document; closing it brings the
  card back over the dock.
- Desktop 1280×900, `/tasks/task-g1-b`: card bottom 753 against a band top of
  761, composer text top 820, right edge 1256 — fully clear.
- `/inbox`: no floating card, all approvals listed.
- Approving the floating card writes `approved`/`web` on the daemon and removes
  the card without a refetch; the inbox count drops through the shared
  resource.

**Tests.** Selection rules (5 cases), the card (which one, answering *that*
one, the queue count, unknown-task fallback, focus moving to the next
decision and to the same choice after a deny, focus not stolen after a failed
decision, no `A`/`D` letters, the measured anchor on a conversation and on the
draft, the late-composer re-measure, the hidden zero-size band, re-measure and
reset on a route change, the dock-clearing fallbacks, and both observers being
disconnected on unmount), containment (a throwing payload keeps the strip and
the next approval still renders), the shared decision path (busy, applied
answer, failure toast + refetch, one request per approval), the drawer closing
on a wide screen (already wide, becomes wide, closed overlay untouched,
listener removed), the boundary's empty fallback / default panel / reset key,
and a source scan of the wiring (the three band markers, the active-pane
condition, the measured route set, the drawer suppression and its wide-screen
close, and the shell and tray going through the hook). Red-verified by
mutation: dropping the inbox exclusion, the visible-task filter, the
oldest-first pick, the shared-resource update, the refetch on failure, the
late-composer observer, the zero-size guard, the route dependency, the route
gate, the in-flight guard, the deny-specific focus target, the focus disarm,
the boundary key, the key-letter gate, both observer cleanups, the
agent-session band, the wide-screen close, the boundary reset, the live-title
preference, the measured-route assignment, and the drawer render guard each
fail the test that names them.
