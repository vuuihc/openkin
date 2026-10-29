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
- **B2 Transcript virtualization.** Window the transcript; keep the tab cache
  meaningful. Acceptance: a 300-turn session scrolls without dropping frames.

### Batch C — truth and evidence (round 3)

- **C1 Per-turn diff from checkpoints.** Replace payload reconstruction with
  the stored tree OIDs; fall back to the payload when a checkpoint is missing.
  Acceptance: an edit made by a non-file tool still appears in the round card.
- **C2 Context window.** Add `context_window` to the model catalog, report
  per-turn usage from adapters, draw a meter in the usage sheet.
- **C3 Role presets.** A saved prompt prefix chosen per draft/session, no
  protocol change. Reasoning/Plan/Fast stay out until an adapter exposes them.

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
