# Common-feature parity program — inventory, gaps, plan

Status: rounds 1–23 landed. This is the living ledger for
the open-ended "beat Lody on the features I actually use" program: inventory →
gap matrix → plan → implement → evaluate → repeat.

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

**Re-audited 2026-10-29 against `77f0ea51`.** Every row below was checked
against the code, not against the row above it, and several had gone stale:
in-conversation find, public share links, the floating approval card, the phone
session switcher, the context meter and server-side search had all landed since
the matrix was written, and the list rows carried stale S1s for pains that were
already gone. What is left is S2 and S3 — no S1 remains: the last one, an
attachment lost when the task runs on another machine, closed with F4 below.

### 2.1 Conversation list

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Server-backed list with filters (repo / project / status / PR / machine), mine-vs-team scope, archive screen, unread dots (`mobile-chat-list.tsx`, `mobile-filter-drawer.tsx:45`, `mobile-archive-screen.tsx:85`) | Search is server-side over the whole library (`sessionListParams.ts`); a filter control carries status to the daemon in `?status=`, `?scope=archived` is the archived-projects view with per-project restore, and "load older" pages both feeds by `before=` (`SessionFilters.tsx`, `SessionsPage.tsx`); rows carry a status/unread dot (`sessionViewed.ts:111-119`) | No project or machine filter, and the archive view restores but does not delete | S3 | — |
| Swipe: pin / archive / restore / **delete**, long swipe auto-archives (`mobile-swipeable-row.tsx:341`) | Swipe reveals Pin and Archive only (`SessionsPage.tsx:734-757`, `SwipeReveal.tsx:78-124`); archive acts on the whole project (`SessionsPage.tsx:284-288`); delete lives inside a session (`TaskDetailPage.tsx:1087-1090`) | No delete or restore from the row, no long-swipe | S3 | — |
| Multi-select: select all, delete (`mobile-chat-list.tsx:1018`) | Multi-select: select all, pin, archive (`SessionsPage.tsx:353-395`) | No batch delete | S3 | — |

### 2.2 Open conversation

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Find in conversation (`session-chat-interface.tsx:1722`) | `ChatStream` owns the bar: Cmd/Ctrl+F, count, next/prev, scroll to hit, Escape (`ChatStream.tsx:167-272`) | Closed | — | — |
| Turn duration ("Worked for"), turn info popover (`view.tsx:4955,4608`) | Round evidence card with file count and size, no duration (`RoundEvidenceCard.tsx:43-78`) | Cannot tell how long a round took | S3 | — |
| Goal chip, plan chip, PR/branch/worktree chips (`session-info-chips.tsx:129,306,356`) | desktop header chips (`TaskDetailPage.tsx:1505-1554`); phone subtitle is project + status only; branch/PR one tap away in the sheet | No goal or plan chip anywhere; branch/PR not visible at a glance on the phone | S3 | — |
| Pinned-message banner (`session-pin.tsx:27`) | none; message actions are Retry / Fork / Save-as-artifact | Cannot pin a message | S3 | — |
| Subagent panel with tokens, background count, cancel (`subagent-task-panel.tsx:176`) | `WorkerTimeline` shows each worker's own tokens and stops one step without ending the turn (`POST /tasks/{id}/workers/{executionId}/{stepIndex}/cancel`, R12B); Kin's workers are turn-scoped, so there is no background count to show | Closed | — | — |
| Transcript renders progressively (Lody has virtualization in `ai-gui/view.tsx`) | one message redraws per token (B2, `d275d3ba`); windowing was prototyped, measured and dropped (B2 notes: scroll height, selection rings, find jumps) | Opening a very long session still parses and builds the whole transcript once (~300ms at 300 turns) | S3 | none — the B2 measurement is why |

### 2.3 Composer

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Queue rows: edit, drag-reorder, remove, steer (`message-queue-row.tsx:223`) | Queued rows carry withdraw and edit (withdraw + refill the composer) end to end (`TaskDetailPage.tsx` `onEditQueued`, `withdrawQueuedPrompt`, F1) | No drag reorder and no steer | S3 | — |
| Slash commands + prompt shortcuts (`mention-registry.ts:327`, `mention-prompt-shortcut-source.tsx`) | the `/` menu lists the saved roles, narrows by name or prompt text, and inserts one into the draft mid-session (R23, `Composer.slash.dom.test.tsx`); a token with a space is prose and Enter sends it | Prompt shortcuts closed. Lody's availability ranking and dependency checks have no counterpart, and built-in commands (`/clear` and the like) do not exist | S3 | — |
| Mentions: files, PRs, skills, commands, sessions, roles (`mention-registry.ts:53`) | agents + models (`agentMention.ts`); files since `0490c3c` (`Composer.files.dom.test.tsx`) | No PR, skill, command, session or role mentions | S2 | — |
| Attachments as structured parts | Path strings appended to the prompt (`Composer.tsx:201-212`); only the Kin agent converts them into structured content (`kinagent/attachments.go:38-75`); a remote node fetches the upload and rewrites the path (F4, `node/fetch.go`, `hubAttachments`) | A Claude/Codex task receives a path, not an image part. Those CLIs read files by path themselves, so the image still arrives; only content the CLI cannot open (and the model never sees as an image block) is lost | S3 | — |
| Paste-as-chip for long text (`session-chat-input-area.tsx:1364`) | pasted text lands in the textarea (`Composer.tsx:503-508`) | — | S3 | — |
### 2.4 Run config

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Role / Agent / Model / Interaction / Reasoning / Permission / Plan / Fast (`mobile-run-config-sheet.tsx:117`) | Role (prompt prefix, `NewChatPage.tsx:520-545`), Agent / Model / Permission (`RunConfigSheet.tsx:195`) | Interaction / Reasoning / Plan / Fast remain, and all four are protocol-limited: no adapter carries reasoning effort or a plan-mode rung | S3 | Plan/Fast map to permission modes some CLIs already expose |
| Desktop consolidated menu (`desktop-run-config-menu.tsx:61`) | strip under the composer (`TaskDetailPage.tsx:1407`) | Equivalent | — | — |
| Worktree setup/cleanup scripts per project | `git worktree add/remove` only; hooks are deliberately disabled (`workspace/checkpoint.go:130`) | Cannot script worktree lifecycle | S3 | — |

### 2.5 Approvals

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Floating permission card on every screen, with a queue strip (`floating-permission-request.tsx:430,758`) | `FloatingApproval` over every screen, oldest first, with focus recovery (`FloatingApproval.tsx`) | Closed by G1 | — | — |
| Question card with multi-select, custom text, notes (`ask-user-question-card.tsx:793`) | `UserQuestionCard` | Verify parity before claiming a gap | — | — |
| "Waiting for permission" marker in the tab sheet (`mobile-session-tab-sheet.tsx:249`) | phone session switcher sheet carries a "Needs you" pill (`SessionSwitcherSheet.tsx:95-100`) | Closed | — | — |

### 2.6 Files and diffs

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Per-turn diff cards (`view.tsx:5502`) | `round_changed` records shell edits with counts; previews come from tool payloads (`roundEvidence.ts:102-178`) | Shell-only edits open to "nothing reconstructible" | S3 | — |
| Changes sidebar with Code/Docs/Tests/Dev grouping (`session-changes-sidebar.tsx:366`) | flat list sorted by seq (`ChangedFilesList.tsx:21-102`); Keep/Discard exist in the viewer header for terminal tasks | No grouping, no persisted per-file reviewed state | S3 | — |
| Mobile diff drawer (Changes vs Conversation diff) (`session-mobile-diff-drawer.tsx:75`) | one pane at a time under `md`: the list, then a full-height file with a back control (R15, `WorkspacePanel.tsx`); md+ keeps both panes | Closed for the viewer; no separate conversation-diff pane, because the per-turn diff cards already live in the conversation one tap away | — | — |
| File viewer: preview, wrap, find, save, quick-open (`session-file-content-view.tsx:126`, `session-file-quick-open.tsx:235`) | `CodeViewer` (monaco): wrap on, read-only unless the workspace is writable, Cmd+S save (`CodeViewer.tsx:54-57,164-169`); monaco's own find owns Ctrl/Cmd+F inside the editor; file quick-open over the checkout with ⌘P/Ctrl+P, the panel's search button and the phone sheet (R13, `FileQuickOpen.tsx`) | `FileTree` itself still has no name filter — quick-open is the way to a known file, the tree is for browsing; no image/CSV/binary preview (next row) | S3 | — |
| Image/CSV/Office/binary preview | text and Markdown only; the file API refuses non-UTF-8 (`workspace/diff.go:158-160`) | Images draw inline, CSV/TSV lay out as tables with a source switch, and other binary files open as downloads (R24); Office documents are a download, not rendered | S3 | — |

### 2.7 Schedules

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Recurrence: daily / weekdays / weekly / monthly / hours / minutes / once, with next-run preview (`schedule-recurrence-editor.tsx:132`) | all seven kinds, with the two step rules zone-aligned and validated to divide their unit (R19, `recurrence.go`), server-computed next due in the list (`RoutinesPage.tsx:535-537`), the create form reused as an editor for those same fields (R17, `routineEdit.ts`), and the form previewing the daemon's own next run (R21, `POST /api/routines/preview`, `useRoutinePreview.ts`) | Closed (R21); the preview is absent in New Chat's routine composer, which has no preview line yet | — | — |
| Agent/model/permission per schedule (`schedule-agent-controls.tsx:26`) | agent, model and permission are per-routine end to end (R20): `store.Routine.Model` → `scheduler.go:513-529` → `task.CreateRequest.Model`; both the Routines editor and New Chat's routine mode carry the picker | Closed (R20) | — | — |
| Run history | a global routine-run feed with unread and mark-read (`RoutinesPage.tsx:114-117,442-485`), plus each routine's runs under its editor: ten newest, live-updated from the same task websocket, with older pages of ten (R22, `routineHistory.ts`) | Closed (R22); "more" is inferred from a full page, so exactly ten runs cost one empty request, and a push that lands while the initial fetch is in flight can be lost (see Round 22) | — | — |

### 2.8 Projects

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Project screen with conversations / files / settings tabs (`mobile-project-screen.tsx:934`) | Overview + Chats tabs (R12A); the Chats tab merges the project's Kin tasks with imported sessions under its roots, URL-backed (`ProjectDetailPage.tsx`) | No files or settings tab | S3 | — |
| Per-project settings, skills, default MCP (`project-settings.tsx:103`) | project mode is the only per-project setting (`projects.go:32-43`); skills are filesystem-scoped (`.kin/skills`); MCP is not configurable at all | No per-project settings, skills or MCP | S3 | — |

### 2.9 Search

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Home search + in-conversation find + file quick-open + filter search | server `?q=` over titles/prompts/cwd/agent (`store.go:291-299,490-500`), in-conversation find (closed), ⌘K palette over the latest 80 tasks (`CommandPalette.tsx`), file quick-open over the checkout (R13, `FileQuickOpen.tsx`), transcript search with a jump to the match (R14, `/api/search/transcript`, `CommandPalette.tsx`) | File *contents* are not searched (names only) | S3 | The search reads the derived `transcript_messages` table (R14), so it matches the message the reader sees; FTS5 over that table is the next step if the library outgrows a substring scan |

### 2.10 Tabs / switching

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Tab bar + mobile tab sheet with unread and waiting-permission states, drag reorder (`session-tab-bar.tsx:571`, `mobile-session-tab-sheet.tsx:144`) | phone switcher sheet with a "Needs you" pill and unread dots (`SessionSwitcherSheet.tsx:95-129`), ordered by status (`sessionSwitcher.ts:38-46`); the desktop strip dots waiting/failed/unread and names the state in the tab's accessible name (R16, `SessionTabs.tsx:36-45`, `SessionTabs.tsx:155-166`); the phone's switch control carries the strongest mark (`MobileHeader.tsx:96-121`) | No pointer drag reorder | S3 | — |

### 2.11 Usage and context

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Context usage + compacting, 5h/weekly windows, extra balance, reset forecast (`session-usage-popover.tsx:185,204,228,256`) | context meter with 80/95% thresholds (`TaskUsageSummary.tsx:307-365`), limit card with reset time when a provider rejects (`LimitCard.tsx:79-104`) | No proactive 5h/weekly window figures, no extra balance, no manual compact | S3 | — |
| Machine quota (`machine-quota-compact.tsx:37`) | per-agent daily caps (`agent_limits.go:17`) | Different concept, comparable use | S3 | — |

### 2.12 Sharing and notification

| Lody | Kin today | Gap | Sev | Reuse |
|---|---|---|---|---|
| Public share link + share management (`share-management-setting.tsx:482`) | per-task share link, copy and revoke (`ShareDialog.tsx`, `/s/{token}`) | Closed (no expiry control or console-wide list) | — | — |
| Share as image, themes, PNG (`chat-share-image-dialog.tsx:397`) | text and HTML export only (`shareExport.ts:15-20`) | No image export, no theme choice | S3 | `html-to-image` or canvas |
| Push permission, completion notifications, Live Activity (`mobile-general-settings.tsx:619`) | Web Push with VAPID (E2), completion and approval notifications, iOS Home Screen PWA | No Live Activity; iOS needs the console on the Home Screen | S3 | APNs remains the native path |
| Unread dots in tabs (`session-tab-bar.tsx:531`) | unread dots in the sidebar, the phone list, the switcher sheet, the desktop tab strip and the phone's switch control (`sessionViewed.ts:111-120`; strip and control in R16) | Closed | — | — |

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

### Batch F — what the re-audit leaves (round 6)

Ordered by daily cost, not by column order. All are S2.

- **F1 A queued message is editable and removable.** (Landed.) The daemon
  already held the queue (`task_pending_prompts`, `GET /prompts`); the console
  only badged it. Acceptance: a queued message can be deleted before it runs,
  and the transcript stops badging it — `DELETE /api/tasks/{id}/prompts/{id}`,
  the × in the badge, and the `prompt_withdrawn` notice that keeps the
  transcript honest on every device. Edit is remove-then-refill: a pencil beside
  the × withdraws the row and puts the prompt back in the composer exactly as it
  was sent — attachment block included, because that block is how the images
  travel and the composer cannot rebuild the uploads behind a summary line.
  The refill happens only when the daemon answers that it deleted the row — a
  404 can mean the turn boundary already took the message, and a copy of a
  running message is a message sent twice — and only into an empty composer,
  checked at the tap and again when the answer lands (replacing a draft
  somebody is already writing is not what tapping one message asks for). Both
  rules are unit-tested, the badge's two controls carry the message excerpt in
  their accessible names so they can be told apart, and the composer takes the
  focus when the text lands.
- **F2 The workspace owns its own find.** (Landed.) Monaco already claims
  Cmd/Ctrl+F from inside its own textarea — checked in the running console, where
  the key opens the editor's find widget and focus never leaves it — so the
  editor half needed no wiring. The half that did: a panel is a full-surface
  overlay, and the conversation kept claiming the chord while one was open, so
  Cmd+F over the file list opened a find bar *behind* the overlay and typed into
  it (`elementFromPoint` at its centre landed on the editor). The page now passes
  `findShortcut={active && panel === null}`: an editor still owns the chord, and
  everywhere uncovered still opens the conversation's.
- **F2b A change row opens the file it names.** (Landed; found while checking
  F2.) The viewer is rooted at the workspace, and the tree speaks relative
  paths, but the change list carries what the tool reported — claude-code and
  the ACP adapters report absolute ones — so opening a changed file answered
  `absolute path not allowed` and drew the daemon's complaint. The panel now
  maps the path into the workspace first; a path outside it says the file cannot
  be read here instead of asking the daemon to phrase it.
- **F3 `@file` mentions.** (Landed; see the F3 sections.) One mention source over the task workspace tree, so
  a path can be referenced without typing it on a phone. Acceptance: typing
  `@` in the composer offers workspace files and inserts the path.
  Plan: there is no flat file index — `source/tree` lists one directory at a
  time, and on the phone the task runs on another machine, so a picker built by
  walking the tree would be a burst of relay round trips. Add one bounded
  question to the worker protocol (`WorkspaceFilesParams{Path, Query, Limit}`,
  answered by `git ls-files --cached --others --exclude-standard` plus a
  case-insensitive substring filter, ≤ 50 results), expose it as
  `GET /api/tasks/{id}/source/files?q=`, and let the composer's `@` menu ask it
  once the query has a character. Insert the workspace-relative path;
  `parseAgentDirective` only treats tokens that name a known agent as mentions,
  so a path stays text. Offer no file section where the listing is unavailable
  rather than an empty one.
- **F4 An attachment survives the trip.** (Landed 2026-10-29.) An upload lives
  under the Hub's state dir; a task running on another machine received a path
  that does not exist. Acceptance: an image attached on the phone is visible to
  a Claude Code task running on a different machine.
  Design: the Hub cannot reach a node — the node dialled out — so the node
  fetches. The alternative, chunking 20 MiB through the 256 KiB query protocol,
  is eighty round trips for one photo.

  What shipped:
  - **One parser for the block.** `internal/attach` now owns the
    `Attached …:` grammar the composer writes; the Kin adapter reads it there
    too, so "the files the adapter would open" and "the files the Hub ships" are
    the same set by construction rather than by two regexes agreeing. It peels
    a block line by line, so a bullet that is not `label: path` stays in the
    text instead of leaving with the block — which is what lets a failure note
    reach the model at all.
  - **The dispatch names the files, never carries them.**
    `worker.Dispatch.Attachments` is `{path, stored}`: the text the prompt
    already contains, and the name the Hub stores it under. `hubAttachments`
    only claims paths directly inside the uploads directory, that are there
    now, and that are regular files; anything else in the block (a path a person
    typed) is left alone, because the Hub is not its source of truth.
  - **The node fetches over the route that already exists.** `GET
    /api/uploads/{name}` is `holderOnly`, so a paired device already passes; the
    fetcher uses the device credential the control channel dialled with, keeps
    the Hub's path prefix, and writes to `<state>/attachments/<task>/` through a
    temp file and a rename.
  - **The prompt is rewritten before the agent starts**, after the executor's
    refusals: a turn this machine will not run is not worth downloading for.
    `notTransferred(…)` replaces a failed file's path. A line parses as an
    attachment only when the text after its last colon is one token, and the
    note always closes with "— attach it again)", so it never does: the agent
    reads a sentence, and the adapter does not try to open prose as a path. The
    reason is cut without splitting a character.
  - **Bounds.** 16 files per dispatch, 4 KiB per path, 20 MiB per file (the
    Hub's own upload ceiling), 64 MiB per turn, 60 s per file; `MaxFrameBytes`
    and `Dispatch.Validate` hold the list to the prompt it describes (each path
    must appear in the prompt and be listed once). `SafeAttachmentName` and
    `SafeTaskID` live in `worker`, beside the fields they validate, because both
    ends must agree and the protocol package may import nothing else
    (ADR 0025 D5).
  - **Cleanup is age, not deletion.** The Hub never tells a node a task was
    deleted, so the honest bound is time: directories unused for 14 days go, and
    every dispatched turn runs the (hourly-throttled) sweep. A task that has not
    run in two weeks will not run a follow-up that reads its photo. There is no
    per-task cap — a task that keeps running with new files grows — which is the
    same posture as the Hub's own uploads directory.
  - **Known bound, deliberately.** A message with more than 16 attachments
    leaves the rest with the Hub's path — exactly what every attachment did
    before this slice, so no regression, and no framebusting retry loop.
  - **Known rough edge.** A prompt that quotes an older attachment block gives
    the parser one body rather than two, so a second `Attached …:` header can
    be left in the text without its list under it. Cosmetic, and better than
    before this slice, when the whole tail was dropped; removing a header whose
    lines all became entries is the follow-up that would tidy it.

  Tests. 28 guards, each red-verified by mutation (deleted, test seen to fail,
  file restored and compared): uploads-dir containment, regular-file check,
  dispatch bound, raw-text quoting, `SafeAttachmentName` at both ends,
  `SafeTaskID`, the protocol package staying a leaf, copy reuse, byte bound
  (with and without `Content-Length`), turn budget, sweep TTL, use-marking
  `Chtimes`, `ws`/`wss` mapping, executor rewrite hook, adapter naming the
  files, four `Dispatch.Validate` rules, `holderOnly` on the upload route, the
  fetch's `Authorization` header, a block line that is not a file staying in
  the text, the paragraph join, a note not parsing as a path, and rune-safe
  truncation. Package totals: 2 attach (seven table cases), 3 worker (one with
  eight cases), 21 node (five hub-side, thirteen fetcher, two executor, one
  adapter), and one api end to end; the moved parser keeps the Kin adapter's
  own tests green. One seam is covered piecewise rather than end to end — the
  api test drives the upload route and the fetcher, the adapter test covers the
  dispatch naming — because a harness running Hub adapter → frame → node
  executor would mostly re-test those two halves through a third copy of them.
  Demonstration: `TestAMachineCanFetchAnUploadThroughTheHubsOwnRoute` uploads a
  PNG through the real route with the master token, pairs a device, and has
  `node.AttachmentFetcher` pull it with only that device token — bytes equal,
  prompt rewritten. No UI surface changed: the composer already writes the
  block, and the transcript already strips it.

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

### How a round runs (2026-10-29, from the round-10 retrospective)

Round 10 spent most of its time on verification ceremony, not code: fifteen
mutants applied by hand, two serial review passes, a 150-line log written at
the end, live checks re-scripted from scratch, and one hung test that cost ten
minutes. The order below keeps the ceremony but takes it off the critical
path.

1. Implement, then run `./scripts/check.sh`: changed Go packages, `go vet`,
   `gofmt`, desktop tests, `tsc` and `bash -n`, in parallel, one summary.
2. Start the same-model review in the background as soon as those pass, and
   write this round's log section while it runs — change, guards, mutants,
   live checks, review verdict. Fill it in as results arrive instead of
   reconstructing it afterwards.
3. Red-verify from a manifest with `./scripts/mutants.py round.json`: it runs
   the test unmutated first (a red baseline would make every mutant look
   detected), applies each replacement, requires the test to fail, restores,
   and proves the restore byte for byte.
4. Fix blockers and majors, then re-review only the fix diff. An S2 slice gets
   the full nit pass; a four-item S3 batch only needs blocker/major.
5. `./scripts/check.sh --all`, commit, integrate.
6. Rebuild desktop when the console changed, or every two or three daemon-only
   rounds — each rebuild restarts the live node.

Round shape: one or two S2 slices, or four S3 slices per batch. The gate is
unchanged; it just stops being serial.

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

#### E2 — a notification reaches a closed tab (landed)

Lody pushes to the phone through its own mobile app. Kin's only out-of-app
channel was Bark or ntfy — a third-party app the reader had to install and
configure. G1 answers "an approval exists while you are looking"; E2 answers
"while you are not".

**The shape.** Web Push: RFC 8030 delivery, RFC 8291 payload encryption,
RFC 8292 VAPID. The transport is `internal/webpush`, written against the
standards rather than pulled in as a dependency, because the two primitives it
needs — P-256 ECDH and HKDF — are in the standard library, and the RFC
publishes a complete example that the test reproduces byte for byte. That
vector is the reason to trust the package: a mistake in the KDF chain or the
header layout shows up as a diff, not as "it worked in a browser once".

**Where the pieces live.**

- `push_subscriptions` (migration 42): endpoint unique, keys, created. One row
  per browser; subscribing again updates in place, because a second row would
  double every notification.
- The VAPID key pair is a setting (`push.vapid_private`), minted on first use
  and deliberately absent from the settings API's puttable set — a client that
  could write it could sign notifications no browser subscribed to.
- `internal/push` connects the registry to the existing fan-out: an approval
  that reaches Bark or ntfy now also reaches every subscribed browser, from
  the same `notify.Payload` and the same deep link
  (`/inbox?focus=<id>`).
- The console subscribes only on an explicit "Enable on this device".
  Permission prompts raised by a passive settings page get denied out of
  reflex, and a denial is sticky. Opening Settings does not call
  `/api/push/config` either: that endpoint mints the key pair on first use,
  and a view that mints key material just by being opened is the implicit
  side effect the integration rules forbid.
- `ui/public/sw.js` is a push-only worker, not a cache. It is served with
  `no-cache`: a cached worker outlives the deploy that fixed it.

**Decisions, and the reasons.**

- *The endpoint is untrusted.* It arrives from the browser, and the daemon
  posts to it on a timer with nobody watching. Subscribe validates https, a
  real P-256 point and a 16-byte secret; the dialer refuses loopback, private
  and link-local addresses, so a forged registration cannot turn the daemon
  into a probe of its own network.
- *404 and 410 are facts; 500 is weather.* A retired subscription is deleted;
  a transient failure keeps the row and reports the error, because the next
  notification should still try.
- *The channel never blocks the event.* Delivery runs inside the existing
  fire-and-forget send, sequentially across browsers, so a slow push service
  delays the others by at most its timeout and never the approval that raised
  it.
- *Subscription is an operator action.* A notification carries task titles,
  and the address the daemon posts to is worth protecting: every push route
  sits behind the same operator gate as the settings page it lives on, not
  merely "any valid token".
- *A subscription belongs to the daemon that served the console.* The Hub does
  not proxy console HTTP to nodes, so a phone on the Hub's origin subscribes to
  the Hub and a phone on a node's origin subscribes to that node. Both are
  served, because both daemons run the same wiring.
- *The Hub already raises the approval, so it already pushes it.* A node's
  `approval.request` frame is answered by `node.Approvals.ask`, which calls
  `Engine.RequestApproval` on the Hub (`internal/server/server.go:496` passes
  the same engine that carries the notifier). That call is what fires
  `NotifyApproval`, so a phone subscribed from the Hub's console is woken by a
  question an agent asked on some other machine — the phone-on-Hub route, which
  is the one this reader actually uses. Checked by reading the wiring, not by
  assumption: the earlier draft of this note claimed approvals "live on the
  node" and was wrong.

**Verification.** Unit: the RFC 8291 vector; a decrypt round-trip against a
fresh subscription key; VAPID structure, audience and ES256 signature; key
persistence across a restart; 410 prunes, 500 keeps, unusable keys drop;
endpoint validation; the private-address refusal through the real dialer;
store round-trip and one-row-per-endpoint; API auth, subscribe, refusal,
unsubscribe and test; the notify fan-out and channel independence; the static
cache policy. Console: key conversion from URL-safe and padded base64,
serialization refusal, a declined permission never subscribing, disable
unsubscribing and reporting the endpoint, the section's four states, and that
mounting it fetches nothing. Red-verified by mutation: the 0x02 padding
delimiter, the VAPID audience, the stored key, the validation call, the
fan-out, and the no-fetch-on-mount rule each fail the test that names them.

Live on a scratch daemon (:7790): `/api/push/config` returns an 87-character
key and 0 subscribers; subscribe answers 201 and the count becomes 1;
`/sw.js` is served `200 text/javascript` with `no-cache`; a test send reports
the per-channel error and keeps the row; unsubscribe answers 204; a
registration pointing at `https://127.0.0.1:9` is refused at dial time.

**Fix pass after review.**

- *A subscription is bound to the key it was made with.* `enablePush` used to
  return whatever subscription the browser held. After a restored database
  minted a new VAPID pair, that subscription was dead — the push service answers
  403 to a token signed by a key it never saw — while the settings page still
  said "on". Enabling now compares `options.applicationServerKey` with the
  daemon's key and re-subscribes on a mismatch.
- *`kin notify test` had no browser channel.* The command built a `Sender`
  without a `Push`, so an operator whose only channel was a subscribed browser
  was told "no notification channels configured". It now carries the same push
  service the daemon does.
- *Two notify tests raced.* `TestNotifyApprovalClickIsTheApprovalURL` and
  `TestNotifyQuestionAndQuotaUseActionableLinks` read a slice the httptest
  handler wrote from `Send`'s goroutine; `go test` passed because nothing ran
  them under `-race`. A mutexed recorder fixed both, and `-race` is now part of
  the check list for this slice.

**Second review pass (same-model sub-agent, `77f0ea51`).** No blocker; six
majors, all fixed here:

- *Redirects.* The committed client followed them, so an endpoint could name
  `http://` somewhere else and receive the VAPID header and the ciphertext in
  clear. `CheckRedirect` now refuses; two tests drive a real redirect through
  the policy and pin it on `defaultClient`.
- *Browser push was starved.* `Deliver` ran Bark, then ntfy, then push inside
  one 15 s budget, and each webhook can spend 10.2 s. A dead Bark URL meant the
  push channel ran with an expired context and the only working channel dropped
  the message silently. Channels now run side by side with fixed result slots,
  and push outcomes are logged with the others. `TestDeliverDoesNotLetASlowWebhookStarvePush`
  holds a webhook open past the deadline and asserts push still ran live.
- *The permission prompt lost the gesture.* The section awaited
  `GET /api/push/config` before asking, and WebKit drops the user activation at
  the first await — on iOS, the platform the hint names, the button did nothing
  or got the permission denied for good. `requestPushPermission()` is now the
  first statement of the click handler; the config fetch waits until after it.
- *Per-message randomness was untested.* A mutant with a constant salt and a
  reused ephemeral key passed the whole package. `TestEncryptUsesFreshRandomnessPerMessage`
  compares salt, key id and ciphertext across two calls and decrypts both.
- *Payloads were unbounded.* The header advertises one 4096-byte record, but
  the encoder emitted any length; a multi-kilobyte routine `tldr` produced an
  invalid body that push services answer 413 to, which the sender retries
  forever. `clampPayload` trims to `recordSize-17` on a rune boundary.
- *The dialer's deny list was too short.* `IsPrivate()` misses 100.64/10 — the
  CGNAT and Tailscale range, in a repo that ships `--tailscale` — plus
  benchmarking, IETF, `0/8`, and NAT64-wrapped private IPv4; a literal that
  would not parse was allowed through. `publicAddr` is deny-by-default and the
  table test covers each range.

Also fixed from the nit list: `disablePush` now reports a browser that refused
to unsubscribe instead of claiming "off" and deleting the daemon row; a
permission denial toasts the localized blocked message rather than English; the
service worker tags notifications by target URL so a routine report cannot
silently replace an unanswered approval; the settings hint no longer claims
every tap opens an inbox item; `POST /api/push/subscribe` returns the id of the
row it really stored, which on a re-subscribe is the original row's, not the
freshly minted ULID it used to report.

**Deferred with a reason.** `GET /api/push/config` still mints the VAPID pair
on first read — the browser cannot subscribe without the key, and the console
only calls it from the click; a prefetch would create node-local key material,
which is harmless and never leaves the database. `/api/push/test` still posts
to every subscription sequentially; with one or two browsers a settings button
that waits a few seconds is acceptable, and the response already reports each
result. A permanently rejected subscription (401/403) is still retried on every
notification rather than backed off; the log line now makes it visible, and a
backoff column is a schema change for a case one browser produces once.

**Not in this slice.** No delivery receipts and no per-device labels — the
browser is the only identity. No expiring subscriptions. On iOS, Web Push
requires the console to be added to the Home Screen; a plain Safari tab cannot
subscribe, and a Capacitor shell would need APNs instead.

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

#### F1 — a queued message can be taken back (landed)

A message sent while a round is running waits in `task_pending_prompts` for the
next turn boundary. The console could only show that wait — a "Queued" badge in
the transcript — and the only way to take a message back was to stop the task,
which throws away the round and every other queued message with it. Lody's queue
rows are editable and removable; this lands the remove half. Edit is the same
gesture followed by a refill of the composer, and is a separate slice.

**The bubble cannot disappear, so the transcript has to say what happened.**
Events are immutable: the user's message was written when it was accepted, and
withdrawing the queue row leaves it on screen. With no record, every device would
read that bubble as delivered, and the agent's next turn would silently not
mention it. `Store.WithdrawPendingPrompt` deletes the row and appends a `notice`
event (`code: prompt_withdrawn`) in one transaction — the shape `Cancel` already
uses for its discard report, and for the same reason: a process that dies between
the two writes would leave a message nobody will answer and no record of why.
The note does not quote the text. A withdrawal is often the sender taking back
something they regret, and a copy in a second event would keep exactly what they
asked to remove.

**Wording belongs to the console.** The daemon writes one language; the reader
may be in another. The projection maps `code: prompt_withdrawn` to
`chat.withdrawnNote` and leaves every other notice as the agent's own words.

**404 is an answer, not a failure.** The turn boundary and the withdraw can race
for the same row. Both are single transactions, so one wins and the other finds
nothing: a 404 means the message ran, or another device withdrew it first, and
the queue poll that follows is the truth. The console removes the badge
optimistically — the tap should not wait for a round trip — and only a real error
puts it back, by re-reading the queue and saying what went wrong.

**Where the control lives.** A small × inside the existing badge, because that
badge is the state it undoes. It exists only while the message is still waiting,
and only when the page can act on the queue at all (`onUnqueue` is optional, so a
transcript the caller only reads shows the badge and nothing to press). The
handler reads the queue through a ref: the rows are memoized and keep the closure
they were first given — that is what keeps a long transcript cheap — so the
closure must not capture the queue it was drawn with. A poll the daemon answered
before the delete landed can still arrive after it, so the page also remembers
the ids it has withdrawn and drops them from every later list
(`withoutWithdrawn`); only a real failure un-marks the id, which is what lets the
badge come back.

**Tests.** Store: the row goes and the rest of the queue keeps its order, a
cross-task id cannot reach another task's row, a second withdraw is a no-op with
no second note, and the note never repeats the text. API: 204/404/400, and the
note written with the row but not on a 404, and the note published on the bus so
the devices that were not looking at the queue hear about it too. UI: the control
appears only on a queued message and only when the caller offers the action,
clicking it reports the message's seq, the note follows the reader's locale while
an ordinary notice stays untranslated, and the queue filter drops a withdrawn row
by id — by row id, not the seq the transcript marks — while returning the same
array when there is nothing to drop. Red-verified by mutation: dropping the note
write (both the store and the API test fail), dropping the code check (the locale
test fails), dropping the row's `onUnqueue` gate (the hidden-control test fails),
passing the wrong seq (the click test fails), dropping the publish (the live test
fails), and dropping the withdrawn filter (the queue-filter tests fail).

**Review pass two: the identity the scan matched on was one adapter's.** The
mid-stream fix above assumed the note sits between a preview and the message
that replaces it *and that the message has an id to match on*. Only droid stamps
both `message_id` and `index`; claude-code sends `index` alone, ACP
`message_id` alone, and kinagent neither, so for the default adapter the note
still left the first half of the answer on screen under the whole of it. The
note now carries `withdrawal`, and exactly one withdrawal note is transparent to
the scan: it steps over the note for the single preview directly behind it — the
text the arriving message is replacing — and then stops. Text from an earlier
message that never got a final version is left alone, because with no id it is
the only copy. The test fixture runs all four adapter shapes through the same
transcript. The row's memo comparator also missed the new prop, so a queued row
that lost the action kept drawing its button (the save button's clause already
compares presence for the same reason). And a rejected request no longer means a
failed withdrawal: a delete can land and its answer be lost to a reset
connection, so the page re-reads the queue and only reports a failure when the
message is still waiting.

**The edit half (landed).** A pencil beside the × withdraws the row and puts the
prompt back in the composer exactly as it was sent — attachment block included,
because that block is how the images travel and the composer cannot rebuild the
uploads behind a summary line. The transcript hides the block for display; in
the composer it is the message.

The edit cannot reuse the × path, because it needs an answer the × does not:
*whether the row was withdrawn or had already been taken by the turn boundary*.
A 404 says only that the row was gone. If the boundary took it the message is
running, and a refill would put a copy of it back in the composer — sent twice.
So the text is refilled only on an answer that says the daemon deleted the row.
The other outcomes say what happened and leave the message where it still can be
copied from: a 404 toasts "no longer queued — it may already be running"; a
failed request is first checked against the queue (the delete can land and only
its answer be lost), and if the row is gone by then the same message is shown,
because from here a lost answer and a boundary pop cannot be told apart.

The rule lives in `startEdit` in `queuedPrompts.ts`, not in the page, because it
is the part worth testing: it is the only place that decides whether a refill
may happen. It reports one of four endings — `withdrawn` (the daemon deleted the
row), `gone` (404, or missing from a re-list: possibly running), `stillQueued`
(the queue says the message is still waiting, so the badge goes back), or
`unknown` (the request failed and the queue could not be read either). The row
is marked withdrawn *before* the request, exactly as the × does, so the badge
that the page drops optimistically cannot be put back by a poll answered before
the delete landed; only a real failure un-marks it, and a row that vanished from
the re-list is marked again. The page refills on `withdrawn` and on nothing else.

Two smaller rules, both because the refill replaces what is in the composer: it
waits for an empty one, checked at the tap *and again* when the answer lands (a
round trip is long enough to type into), and a second edit tap is refused while
the first is in flight (`chat.editBusy`) rather than withdrawing a second message
the composer cannot take yet. That refusal is a deadline, not a flag: `apiFetch`
has no timeout, so a request the network dropped stops refusing taps after 20 s
(`editStillRunning`) instead of for the life of the page. The settlement clears
only its own deadline — a stalled request can answer after a later tap has
already taken the pencil, and zeroing then would let a third run beside the
second. When the text lands the composer takes the focus, so the next keystroke
goes where the person is looking; setting a textarea's value leaves its caret at
the end, so the edit starts where the message does. A phone may not raise its
keyboard for it — the focus runs after a network answer, and iOS only opens the
keyboard from a gesture — so the text is there and tapping it is one tap.

The focus signal travels with the task id. A composer mounted for another task
must not read a leftover number as a request to take the focus on mount, and a
mount-time focus cannot be cancelled from the parent: React runs the child's
passive effects first. Keying the signal by task makes it a render, not a race.

**A send that resolves mid-refill must not delete the refill.** The composer
clears itself as it submits and the page clears the draft when the POST returns.
Between those two moments the edit can refill the composer — and the send's
cleanup then blanks text the person is holding, with no toast. The page now
clears only when the draft is still the one the send started from. The failure
path has the same shape: the composer restores what it cleared, which is wrong
once a refill has taken the box. It cannot tell from the textarea — the refill's
write reaches the DOM a render later than the page's ref — so the submit handler
says so: the re-thrown error carries `keepComposer`, and the composer restores
only without it. Both halves have a test.

**Tests.** `startEdit` (each of the four endings, each settling exactly once, the
mark made before the request, the un-mark before the re-list, the re-mark for a
row that vanished from it); `editStillRunning` (none, fresh, one millisecond
short of the deadline, at it); `canRefillComposer` (whitespace is empty, typed
text and an attached file are not); the composer shows an `initialValue` that
arrives after the first render, focuses on a signal, leaves an ordinary
deep-link prefill unfocused, and keeps a refill that landed while a send was
failing while still restoring its own text when nothing else touched the box;
the pencil appears beside the × only when the caller offers it, reports the seq,
and the memo table redraws when it comes or goes. The page's wiring is held by a
source test: the composer guard precedes the request and is checked twice, the
deadline helper is used, a settlement clears only its own deadline, the refill
is called in exactly one place — the `withdrawn` branch — and the send's draft
check and `keepComposer` assignment are present. Red-verified by mutation:
reporting a 404 as withdrawn, marking the row only after the request, leaving a
failed delete marked, leaving a re-list-gone row unmarked, always clearing the
draft after a send, refilling in the `gone` branch, dropping the in-flight
deadline, letting a stalled settlement clear a newer deadline, never setting
`keepComposer`, and letting the composer ignore it each fail the test that names
them.

**Verified live.** The Hub was redeployed on the image built from this commit
and serves `assets/index-CiOm9dG5.js` — the bundle this repository builds — with
the three new strings present in it; the container reports healthy.

Deferred, with reasons: the queue poll re-arms on `events.length`, so while an
answer streams continuously the queue is not re-read (pre-existing; it only
delays reconciling a failed withdrawal until the stream pauses). A queued row
whose `user_seq` is 0 — the event write failed when it was accepted — has no
bubble to put a badge on, so the console cannot offer to withdraw it even though
the endpoint would accept it. Rare, and the fix is a queue view, not a badge.
The refill writes through localStorage, which swallows quota and private-mode
errors: a failed write leaves the draft ref holding text the composer never
shows. That is the draft store's existing behaviour for every keystroke, so the
fix belongs there, not in this feature. A refilled message that had attachments
carries the raw block — absolute paths included — because the text *is* the
message and the block is how the images travel; deleting the block drops the
images, which is the honest result of editing that part away. The focus counter
is not consumed: it stays non-zero, so a composer that remounts for the same
task (not reachable through the current page host) would take the focus again —
the draft is in the box either way. A settlement that arrives after the page
unmounted still writes the draft and can raise one global toast, the same cost
the × path already has. And when the withdraw wins a race with a failed send,
the failed send's attachments are dropped with its text: the box belongs to the
refill, and merging two messages has no honest answer.
### Round 7 — the desktop shell (2026-10-29)

The console had been through six rounds; the Electron shell around it had been
written carefully and never audited against a running machine. Doing that found
the shell holding its own copy of the bug the console keeps finding — state that
looks shared and is not — and a window that can come back where no screen exists.

#### H1 — one daemon per machine (landed)

**What was wrong.** On the dogfood machine `lsof -iTCP:7777 -sTCP:LISTEN` showed
two listeners: the installed node (`~/.kin/node/kin serve`, kept alive by
launchd, on the IPv6 wildcard) and a repo-local `./kin supervise` child on
`127.0.0.1`. Both had `~/.kin/kin.db` open, each with its own WAL, and the
Electron main process was the parent of the repo-local one.

**Why.** `desktop-rebuild.sh` kills the listener on :7777 on purpose so the new
build is the one serving the console. On a machine set up as a node, the
supervisor brings its child back a few seconds later — measured at 8.6 s on the
live machine — which is longer than the sidecar's single 1.5 s health probe. The
shell concluded nothing was running and spawned its own daemon. macOS allowed
the second bind: the installed node held the wildcard address, the newcomer took
the IPv4 loopback, and both reported success. (A live experiment confirms the
shape: with both bound, `127.0.0.1` reaches the newcomer and the wildcard
listener keeps serving everyone else.)

**What it cost.** Two daemons over one database, each with its own in-memory bus,
runner and flags (`--hub`, `--lan`, `--allow-yolo` on one, none on the other).
The console, which loads the UI from `127.0.0.1`, watched the repo daemon; the
phone reached the other through the hub. A task started in one did not stream to
the other, and approvals raised in one did not reach the other's subscribers —
the same class of divergence the phone/desktop split was supposed to end.

**The fix.** `daemon-rival.ts`: a kin process is evidence that a daemon is
coming back even while its listener is down. When nothing answers, the sidecar
now looks for `kin supervise` / `kin serve` processes and waits up to 15 s
(500 ms polls) for one to answer: attach when it does, spawn only when the
process is gone, and refuse — with the reason shown as a notification from the
tray's Start — when it is there and never answers. A cold machine has no such
process and spawns at once, so first launch is not slower.

Process matching is deliberately strict (the word `kin` at the start of the
command or at the end of a path, then `supervise` / `serve`), because a search
for `kin serve` in this repository would otherwise read as a daemon. The cost is
that a daemon started through `sh -c` or `nohup` is not recognised: the old
behaviour, not a new failure.

The port is part of the question. Scratch daemons on other ports are part of
this repository's own workflow, and one of those (`kin serve --port 7790`) holds
nothing on :7777 — treating it as a rival would refuse to start the desktop
daemon for as long as the scratch one lived. A command line with no `--port` is
the daemon's default :7777, so it counts only when that is the port being asked
about; a value that cannot be read stays a rival.

**Tests.** The parser over a process table holding supervisors, servers, a
one-shot `kin version`, a `Kin.app`, a `rg kin serve` and the shell's own pid;
the port rule (flagless is :7777 and only :7777, both spellings Go accepts with
a space or `=`, a scratch daemon on :7790 excluded, a word that only contains
`port` ignored, an unreadable value kept, and the process list filtered by
port); the wait outcomes (no process → no health probe at all; answers on the
third poll → attach; process exits mid-wait → spawn; never answers → refuse at
the deadline; unreadable `ps` → spawn). The sidecar cannot be loaded outside
Electron, so a source test holds the wiring: the question is asked before
`spawn`, and the "stuck" branch returns before it. Red-verified by mutation:
dropping the no-rival early return (2 tests fail), sleeping past the deadline
(1), removing the wait block (3), and ignoring the port (the port suite).

**Verified live.** After a rebuild exactly one process listens on :7777 — the
installed node — and the shell logs `daemon already running … (external)`, then
`WS connected`. Killing that node's child makes the shell's socket drop and
reconnect, while the wait itself, run against the same machine, returns
`healthy` after 8.6 s: without it the shell would have spawned at ~1.5 s.

#### H2 — a window that was on a display that is gone (landed)

**What was wrong.** `loadBounds` trusted `window-bounds.json`. The file records
where the window was on the desk of the day it was last moved; unplug the
external display and the numbers name a point on no screen. macOS creates the
window anyway, the app runs, the tray is there, and no window ever appears — the
only way back is to find and delete the file.

**The fix.** `window-bounds.ts` keeps a saved rect only while a grabbable strip
of its title bar — 120 points wide, 20 clear of the menu bar — lands on a
connected display. Otherwise the window is centred on the primary display at a
size that display can hold. Sizes below 720×480 and non-finite numbers are
repaired in the same place, and the create path now gets concrete x/y instead of
relying on Electron's own centring.

**Tests.** On-screen, second display, unplugged display, a corner-only overlap,
a title bar above the screen, a title bar dipping under the menu bar (kept), an
oversized window (shrunk), first launch, and garbage numbers. Red-verified by
mutation: zeroing either threshold and dropping the size clamp each fail their
case.

**Deferred, with reasons.** The restored size was the one gap this left, and it
is H6 below. The daemon itself had no single-writer lock on `~/.kin` — the
desktop no longer creates a second daemon, but a `kin supervise` started
elsewhere can; that invariant is H8 in Round 10. The shell holds no dock badge
for pending approvals and has no global shortcut; neither has produced a
dogfooding complaint yet, and the dock icon is hidden while the app is idle, so
a badge there would be invisible exactly when it is wanted — the tray title
already carries the count.

#### H3 — the popover opens instead of reloading (landed)

**What was wrong.** `TrayPopover.show` navigated on every click, so the menu-bar
popover reloaded the whole SPA each time: a flash, a lost scroll position and a
fresh WebSocket handshake for a window that had only been hidden. The page is
live — `TrayPage` reads through `useLiveResources` — so the hidden window was
already up to date.

**The fix.** A hidden popover is shown, not reloaded. Whether it has to load is
decided from what the shell recorded when it loaded — never from the URL, which
cannot answer either question. The console captures `?token=` at boot and strips
it from the address bar, so a live page's URL carries no token and a URL-based
token check calls every page stale; and a failed load leaves the URL it aimed at,
so the URL cannot say "this page never arrived" either. The popover therefore
keeps the token it loaded with and a flag set by `did-finish-load` (an error page
finishes too, so `did-fail-load` clears it again), and reloads when it never
finished, when the page is not exactly `/tray`, or when the token it holds is not
the one in `~/.kin/token`. Escape now closes it as well; click-away already did.

**Tests.** The load decision (a window that never finished, the live page whose
URL no longer carries the token, a failed load whose URL still names the target,
a replaced token, no token on either side, another route, a longer path with the
same prefix, `/tray/settings`, an unparseable URL) and the route comparison
(query, hash and one trailing slash ignored; prefix-only paths and other origins
separated). Red-verified by mutation: dropping the "never finished" check (1
fails), reading the token back out of the URL — the original bug (1), and
prefix-only route matching (2).

#### H4 — a banner only for the task you are not watching (landed)

**What was wrong.** Every finished task raised a native notification, including
the one whose transcript was on screen in the focused window — the case
dogfooding hits constantly, since running a task to watch it end is the point.
The banner told the reader what the screen had just told them.

**The fix.** The shell stays quiet when the main window is focused *and* the URL
it is showing is that task's transcript, and announces everything else. Being in
front is not enough on its own: a reader watching one task still wants to hear
that another finished. `task-notifications.ts` holds the decision and the URL
reading; `main.ts` answers "focused" from the window and "which task" from
`/tasks/<id>`.

**Tests.** The three terminal statuses (and four that are not), the URL reader
(plain, trailing slash, query, percent-encoded, `/inbox`, a nested path,
garbage), and the announcement matrix (on screen in front → quiet; another task
in front → announce; on screen but not in front → announce; unfinished → never).
Red-verified by mutation: never suppressing (1 fails), treating focus alone as
enough (1), letting the id match across slashes (1), dropping the decode (1).

#### H5 — what the review of the shell found (landed)

A same-model review of H1–H4 read the console's token bootstrap and the Electron
behaviour the changes rest on, and found that one of them rested on a false
premise. Everything below is the correction, with the reasoning kept because the
false version was plausible enough to have been written once already.

- **H3's URL check was inverted by the console's own boot.** `captureTokenFromURL`
  moves `?token=` into localStorage and rewrites the address bar, so
  `webContents.getURL()` for a perfectly live page has no token — the old check
  decided "stale" on every open and the popover kept reloading, which is the
  bug H3 set out to remove. A failed load keeps the URL too, so the old check
  also meant a popover stuck on Chromium's error page was never reloaded after
  the retry budget ran out. The decision now reads the load record (token used,
  finished or not) instead of the URL; the tests that encoded the false premise
  were replaced, not adjusted.
- **H1's rival matcher ignored the port.** `kin serve --port 7790` matched, so a
  scratch daemon could make the shell refuse to start its own daemon for as long
  as the scratch one lived. The matcher now reads `--port` in both spellings Go
  accepts (space or `=`), treats a flagless daemon as :7777, and keeps an
  unreadable value as a rival — refusing to spawn is the safer mistake.
- **H1's "stuck" ending was silent at startup and never re-probed.** Only the
  tray's Start showed the reason, and nothing asked again: if a supervisor
  restart took longer than one 15 s wait, the window sat on a dead URL until the
  person clicked Start. Startup now announces the reason like the tray does, and
  `daemon-retry.ts` asks again every 15 s (bounded at 20 attempts) until a daemon
  answers, wiring the WS, pending approvals and both windows when it does. An
  explicit Stop or quit ends the retry instead of undoing it.
- **The suppression branch skipped the dedupe key.** A finish watched on screen
  now records its key too, so a later rebroadcast cannot turn it into a banner
  after the reader looks away.
- **A corrupt bounds file could still throw or produce an infinite window.**
  `savedBoundsFrom` accepts only two finite positive sizes (`1e999` parses to
  Infinity), and the size clamp treats non-finite as no size. The main window
  now uses the same `MIN_WIDTH`/`MIN_HEIGHT` the restore path does.
- **The desktop suite ran only locally.** CI's desktop job now runs `npm test`
  as well as typecheck and bundle; the wiring test reads its source from
  `desktop/` or the repository root rather than assuming the cwd.

**Tests.** 49 across 12 suites. Red-verified by mutation: each of the six fixes
above fails its suite when reverted (dropping the "never finished" check, reading
the token from the URL, prefix-only route matching, ignoring `--port`, treating
the first retry as success, dropping the resolved check, accepting Infinity in
the bounds file, letting Infinity through the size clamp).

#### F3 — the @ menu reaches the workspace (landed)

Typing `@` in the composer offered agents and nothing else. The tree route
could list one directory at a time, and for a phone-started task each of those
listings is a relay round trip — a picker that walks the tree is a burst of
them, over the slowest link in the system.

- **One question, bounded.** `worker.WorkspaceFilesParams{Path, Query, Limit}`
  answers with the workspace-relative paths that match, capped at
  `MaxWorkspaceFiles = 50` and with `Truncated` when there were more. The query
  is required and bounded at 200 bytes with no control characters; the limit is
  clamped again inside the workspace layer, so a caller cannot ask for an
  unbounded answer.
- **Answered where the files are.** The machine resolves the path through
  `r.own` — the same boundary a dispatched turn is held to — and computes the
  answer with `Manager.ListLiveFiles`, so a machine's answer and the Hub's are
  the same computation over different filesystems. `GET
  /api/tasks/{id}/source/files?q=` maps either answer into the same envelope.
- **What "files" means.** `git ls-files --cached --others --exclude-standard`,
  NUL-separated, with the same pinned empty `core.hooksPath` every other git
  call uses and the task's scope as a pathspec. Ignored files stay out: an @
  menu that offers `.env` is a privacy bug, not a convenience. A directory that
  is not a checkout answers 400, and the console then shows no file section
  rather than an empty one.
- **Ordered by likely intent.** A plain substring filter answers in git's
  alphabetical order, where a query matching a directory name buries the file
  of that name under every path through it: basename prefix, path prefix,
  basename contains, then anything else; ties by shorter path and then
  alphabetically.
- **One list, two kinds of row.** The composer asks only once the query has a
  character, 200 ms after typing settles, and only the newest answer may land —
  the caret has moved past every older question. Agents stay first and files
  follow under their own heading, navigated as one list; picking a row inserts
  the workspace-relative path and a trailing space.
- **A path is not a delegation.** `parseAgentDirective` reads `@name` only when
  the token does not continue into a name or a path, so an inserted
  `@claude-code/notes.md` stays text while a sentence-ending `@codex.` is still
  a mention. The lookahead lists the name characters as well as `/` and `[`,
  because otherwise the regex engine backtracks to a shorter prefix that
  passes.

**Tests.** 8 Go (3 workspace, 2 node, 3 API) and 10 console (5 parser, 5
composer). Red-verified by mutation: dropping the remote branch makes the Hub
answer with its own decoy checkout, dropping the query bound answers a
201-byte query with 200, dropping `--exclude-standard` offers an ignored
`secret.txt`, dropping the scope pathspec returns files outside the task's
directory, replacing the ranking with alphabetical order misorders the answer,
dropping `r.own` answers about a directory outside the machine's roots, and on
the console side reverting the parser lookahead, removing the stale-answer
guard, or removing the searching-state reset each fails its test.

#### F3 — what the review of the diff found (landed)

- **A scoped task's paths pointed at the wrong directory.** git ran at the
  repository root and answered `docs/guide.md`; the agent reading the prompt
  works in `docs`, so the path meant `docs/docs/guide.md`. The node branch had
  always answered relative to the task's directory (it runs git there), so the
  same task behaved differently depending on which machine ran it. `ListLiveFiles`
  now strips the scope from git's paths, and both layers have a test that pins
  `guide.md` for a `docs`-scoped task.
- **A trailing sentence stop reopened the menu.** Adding `.` to the mention
  token class meant `ask @claude.` searched the workspace for `claude.` —
  `CLAUDE.md` matched — and Enter inserted the path instead of sending the
  message. A token that does not end in a name character or `/` is now prose:
  the menu closes, and Enter is the message's again. The same rule fixes
  `@claude，` and `@claude)`.
- **The list could grow taller than the screen.** Up to 50 rows rendered upward
  from the composer; on a phone the agent rows and the best matches were
  off-screen, and arrow keys moved the highlight where nothing could be seen.
  The rows now scroll inside `max-h-[min(50vh,20rem)]`, and the highlighted row
  is scrolled into view as it moves.
- **Stale rows stayed selectable.** A new query now clears the previous answer
  immediately, so the menu shows "searching" rather than rows the person has
  already typed past, and the highlight returns to the first row when the query
  changes.
- **The local branch skipped the field's control-character rule** that the
  node's own parse applies, so `?q=a%0Ab` was answered locally and refused
  remotely. Both branches now read the field through one `sourceFileQuery`,
  which also refuses it before a machine that is away is asked anything.
- **`ListLiveFiles` had no empty-root guard.** Unreachable from the routes
  today, but `git.Run` with no directory runs wherever the daemon happens to
  be; the invariant is now checked where the other live reads check it.
- The `@` token accepts non-ASCII, so `@文档/说明.md` can be typed on a phone;
  the agent-only menu keeps its delegation wording, and the "agents & files"
  title appears only when a file row is on screen or on its way.

**Tests after the review.** 11 Go (4 workspace, 2 node, 5 API) and 16 console
(5 parser, 11 composer). New mutations verified: restoring the root-relative
paths fails both the workspace and the API scoped tests, removing the field
check answers a malformed query with 409 instead of 400, and on the console the
sentence-stop rule, the non-ASCII token class, the stale-row clear, the
keep-in-view effect and the highlight reset each fail their test when reverted.

Deferred, and deliberately: an in-flight file search is not cancelled when the
query changes — its answer is dropped, but the node still runs one
`git ls-files` per settled query. Adding a cancel means giving the worker
protocol a request-scoped context, which is a protocol change, not a menu one.

### Round 8 — the window that forgot how it was left (2026-10-29)

#### H6 — a window comes back the way it was left (landed)

**What was wrong.** H2 made the saved rect safe — a window whose display was
unplugged comes back on a screen instead of nowhere — but the *state* was never
saved. A maximised window came back at its restored size, and a full-screen one
came back as a normal window, every launch. The shell saved whatever
`getBounds()` answered on `resize` and `move`, which on macOS is the screen's
rect once the window is maximised or full screen: remembering that would have
made the restored size the whole display.

**The fix.** The saved file now carries `maximized` and `fullScreen` beside the
rect, and the rect is always the window's *normal* one (`getNormalBounds()`),
which Electron answers the same way in all three states. `restoreWindowState`
decides between `normal`, `maximized` and `fullscreen` from the file, with full
screen winning when both are set — a full-screen window reports maximized on
some platforms, and restoring it merely maximized would drop it out of the Space
it was left in. A file written before the flags existed restores normal, which
is what it meant, and only a literal `true` counts: a hand-edited `"true"` or
`1` is a corrupt file, not a state to act on.

The four transitions that change the state without changing the size
(`maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`) are hooked
next to `resize`/`move`, because macOS full screen keeps the window's normal
bounds and moves it to another Space — no resize event fires. Both restores run
inside `ready-to-show`: `maximize()`, then `show()`, then `setFullScreen(true)`.
`maximize()` displays a hidden window by itself, so calling it in `create()`
would put a blank window on screen before the renderer had painted; `show()` is
still called because `maximize()` shows but does not focus; and macOS ignores
full screen for a window that is not on screen yet.

Quitting from full screen leaves the Space, and the `leave-full-screen` event
that follows would record `fullScreen: false` for a window its owner left in
full screen. `persistBounds` therefore stops once the app is quitting: by then
the file already holds the last live state.

The rect and the state are returned together, by `restoreWindow`, from one read
of the file. The first version kept the old `loadBounds(): Rect` and asked
`restoreWindowState` about *that* rect: the flags are optional fields, so it
type-checked, saw no flags, and restored `normal` forever. The state only ever
existed at the file, and the plumbing between the file and the window was the
one place the unit tests did not look.

**Tests.** `restoreWindowState` (full screen, maximized, a pre-flag file, both
flags set, and a state that must not move the rect — the clamp still decides
where it lands); `restoreWindow` (the rect and the state from one read,
including when the rect has to be clamped to the primary display, and a
pre-flag file restoring normal); `savedBoundsFrom` (a plain boolean pair kept,
`"true"`/`1` rejected, legacy files unchanged). Because `window.ts` imports
electron and cannot be loaded under `node --test`, the wiring is held by a
source test in the shape `sidecar.wiring.test.ts` established: the state is
read through `restoreWindow(` and never `restoreWindowState(rect)`,
`persistBounds` saves `getNormalBounds()` and stops once the app is quitting,
all four transitions are hooked with a body that calls `persistBounds`, and both
restores run inside `ready-to-show` — maximize before show, full screen after
it, each behind its own `state === …` condition. Red-verified by mutation:
saving the on-screen rect, dropping the `unmaximize` hook, emptying a transition
handler, restoring full screen as maximized, accepting a truthy flag, setting
full screen before the show, maximizing unconditionally, maximizing before
`ready-to-show`, dropping the quitting guard, deriving the state from the
restored rect inside `restoreWindow`, and putting the old rect-then-state shape
back in `window.ts` — each fails the test that names it.

**Verified live.** On the rebuilt shell, a file saying `maximized: true` brought
the window back maximized with `getNormalBounds()` still the saved 1000×700
rect; un-maximizing returned it to exactly that rect and flipped the flag
without touching it. A file saying `fullScreen: true` came back in its Space
with the same normal rect; quitting from full screen left the file saying
`fullScreen: true` — the quitting guard — and the next launch restored the
Space. One trap worth recording: the dev shell's userData is
`~/Library/Application Support/Kin-dev`, not `Kin`, and the first pass of this
check read the wrong file and proved nothing.

The same pass turned up a pre-existing bug outside this change: a Quit from the
app menu — an Apple Event, the same path as Cmd-Q — leaves the process running.
`will-quit` prevents the default, `quitApp` calls `app.quit()` while that first
quit is still in progress, and the nested quit is ignored. The tray's Quit calls
`quitApp` directly and never passes through the prevented handler, which is
presumably why this went unnoticed. That is the next round, not this one.

Deferred, with reasons: the same as H2 — the state-directory lock is H8 in
Round 10; no dock badge, no global shortcut.

### Round 9 — the quit that did not quit (2026-10-29)

#### H7 — a Quit that actually quits (landed)

**What was wrong.** Quitting from the app menu — Cmd-Q, the Dock's Quit, or an
Apple Event — closed the window and left the process running. The tray's Quit
worked, which is why it went unnoticed: that path called `quitApp()` directly,
so `will-quit` found `quitting` already true and let the quit proceed. Every
other path reached `will-quit` with `quitting` false, and the handler did this:

    e.preventDefault();
    void quitApp();

`quitApp()` calls `app.quit()`, but Electron 33's `Browser::Quit` returns
immediately while `is_quitting_` is set — and `will-quit` is emitted before that
flag is cleared. The second request was dropped, the default had already been
prevented, and the process stayed alive with its window closed, its tray
destroyed and its socket disconnected: invisible, and killable only from
Activity Monitor.

**The fix.** Cleanup moved into `beginQuit()`, called from `before-quit`;
nothing is prevented; the `will-quit` handler is gone. The tray's Quit calls
`quitApp()` = `beginQuit()` + `app.quit()`, and the menu path reaches the same
cleanup through `before-quit` and then proceeds on its own — one quit in flight,
whichever asked for it. The `quitting` latch makes the cleanup run once.
`app.exit()` skips the lifecycle events by design and is used only for the
single-instance loser, before there is a window or tray to clean up.

**Tests.** A source-shape test (`quit.wiring.test.ts`), because the lifecycle
events cannot be loaded under `node --test`. Comments are stripped before
anything is asserted, so a commented-out call is not a call; registrations are
found through `app.(on|once|addListener)` with either quote and an optional
space, so a second handler cannot hide behind spelling; the before-quit body
comes from a brace walk and must be exactly `beginQuit();`; `beginQuit` must
guard before it latches and before every cleanup call; `app.quit()` must appear
exactly once in the whole file; the tray's Quit must be a whole-line
`quitApp();`.

Red-verified by mutation: the eight mutants the first review used to show the
earlier version was too literal — commented-out call, dead branch, `once` and
single-quoted and spaced `will-quit`, a second cancelling `before-quit`,
`app.quit()` in the handler, `app.quit()` in `beginQuit`, and the re-entry guard
dropped — plus the guard moved after the latch, all fail the suite now.

**Verified live.** On the rebuilt shell,
`osascript -e 'tell application id "dev.kin.app" to quit'` — the Apple Event
path, the same one Cmd-Q takes — ended the process before the first 250 ms poll,
and the daemon kept listening on :7777: the shell left, the node stayed. The
same request before the change left the process alive indefinitely and had to
be killed. The full-screen quit guard was verified in H6, before this change;
`prepareQuit` still runs in `before-quit`, before any window closes, so that
ordering is unchanged.

### Round 10 — one engine per state directory (2026-10-29)

#### H8 — `kin serve` refuses a second daemon (landed)

**What was wrong.** Nothing stopped two daemons from sharing `~/.kin`. H1 made
the desktop stop spawning a rival, but that is a shell heuristic in
`daemon-rival.ts`: a `kin supervise` started elsewhere, or the repo's own
`kin serve --port 7790`, still opened the same database. Two daemons on one
state directory do not fail — a node started with `--lan` binds the wildcard
while a second daemon binds `127.0.0.1`, so both can listen on one port — and
each keeps its own in-memory bus, approval flags, and relay state while both
run the same periodic loops over one database: pull-request reconcile (`runPRReconcile`), the
worker-lease reaper (`runWorkerLeaseSweep`, every `DefaultLeaseTTL / 2`) and
the approval ticker (`internal/task/approvals.go`). The visible symptom is the
one `daemon-rival.ts` documents: the console watches a daemon the phone never
talks to, and events published by the other one are simply lost.

**The fix.** `internal/daemonlock` takes an exclusive `flock` on
`<state dir>/daemon.lock`, and `ServeWith` takes it as soon as the state
directory exists — before `remote.EnsureToken` and before `store.Open`. A
refused second daemon therefore touches nothing: no database, no token, no
loops. The holder writes its pid into the file for diagnostics only; the lock
is the source of truth, so a file left behind by a killed daemon does not block
anyone, and `Close` deliberately does not unlink it — unlinking a lock file
that another process may be about to open lets two processes lock different
inodes with the same name. The kernel drops the lock when the process exits,
including SIGKILL.

The exit status carries the refusal across processes: `kin serve` exits 75
(EX_TEMPFAIL), `kin supervise` recognizes that status instead of restarting
into it three times and exits 75 itself, and the desktop sidecar turns
`code === 75` into "another kin daemon already owns this machine's state
directory" rather than "daemon exited (code=75)", and does not schedule a
restart for it — the same choice the Go supervisor makes. launchd's
`SuccessfulExit=false` does the rest: while another daemon holds the directory,
the installed node's restart fails fast and launchd retries at its 10-second
default throttle (two log lines per attempt in the node log); when that daemon
stops, the next retry takes the directory and the node comes back on its own.

**Why the state directory and not the port.** The port is not what two daemons
corrupt — the database and the loops over it are — and a daemon on another port
does exactly the same damage. The supported way to run a second instance is its
own `KIN_STATE_DIR`, which the error message names:

    kin serve: another kin daemon (pid <pid>) is already using <state>; stop it
    first, or set KIN_STATE_DIR to a separate directory

**No opt-out environment variable, and dev.sh learns to wait.**
`scripts/dev.sh` starts its scratch daemon on the default state directory on
purpose, because the dev UI needs real tasks and approvals. It does not need an
escape hatch, but the first version of this round left it with a real race, and
the review caught it: it killed the `:7777` listener and started the new
backend 150 ms later, while the daemon it killed holds its lock until the
process exits — after the listener closes and the relay stops. So the new
backend could lose the directory to the daemon that was still shutting down,
exit 75, and send dev.sh into a rebuild loop. `kill_port_listeners` now waits
for the PIDs to disappear (SIGTERM, up to two seconds, then SIGKILL),
`start_backend` uses it, and a backend that exits 75 is started again after one
second — five once three retries in a row have failed — instead of triggering a
rebuild, so a launchd node that grabs the directory in between costs one retry,
not a loop. The signal handlers now clean up and exit; a handler that only
cleans up resumes the interrupted command, which during the retry sleep would
start a daemon right after "shutting down". An opt-out would reintroduce the
split brain for exactly the workflow most likely to hit it.
Operator commands (`kin token`, `kin export`, `kin mcp`) do not take the lock;
they stay short-lived readers and writers that rely on the store's existing
`busy_timeout`. A state directory on a filesystem that cannot flock fails to
start with the flock error; SQLite on such a mount was already unsafe.

**Tests.** In `internal/daemonlock`: acquire/release/re-acquire, the file
staying after release, a stale pid file from a dead daemon not blocking, a
second *process* being refused with the holder's pid and the directory in the
message, SIGKILL freeing the lock — the holder is a re-executed test binary, so
this is a real second process, not a second descriptor in one — and the message
pinned to `remote.StateDirEnv`, the variable it tells a person to set. In
`internal/server`: `ServeWith` returns `ErrHeld` and has not created `kin.db`
or the token, and the test occupies the port so that a daemon which ignores the
lock fails to bind in about three seconds instead of starting and blocking the
package for ten minutes (which is what the first version of this test did); a
second test drives the one path that takes the lock and returns — a port that
cannot be bound — and asks for the lock afterwards, so dropping
`defer lock.Close()` fails; that test also forced a small lifetime fix, because
a startup that fails after `store.Open` used to leave the routine scheduler
ticking on a `context.Background()` against a closed store — everything
`ServeWith` starts now shares a `serveCtx` that is cancelled on return. In
`cmd/kin`: the exit-code mapping with the
literal 75 pinned on the Go side (the shell reads the number), `exitsWith`
against a real child, and a source-shape check that the `serve` and `supervise`
cases report the mapped status, that no other case does, and that the
supervisor checks for the refusal — unnegated — before its restart decision. In
the desktop: `sidecar.wiring.test.ts` pins the exit-75 reason and that a
refusal is not scheduled for a restart.

**What the review found.** One major: the `dev.sh` race described above. Nits,
all fixed here: the launchd retry cadence was overstated; the sidecar scheduled
a restart for a refusal it cannot change; the 75 literal was pinned only on the
TypeScript side; nothing tested that `ServeWith` releases the lock; the Go
source-shape check counted call sites instead of slicing per subcommand and
would have accepted a negated check; "IPv6 wildcard" is not what a `--lan` node
binds; the Round 8 deferral still said "next round"; and the refuser's message
was not pinned to `remote.StateDirEnv`.

A second pass over those fixes found no blocker or major and five nits, all
fixed here: the busy retry ran at 1 Hz forever, so it now backs off to five
seconds once three consecutive attempts have failed and resets when a backend
survives; a Ctrl-C during the retry sleep cleaned up and then resumed into
`start_backend`, so the handlers now exit 130 after cleaning up; the sidecar
comment promised "the next Start" as the recovery, which is more than the code
guarantees; the pinned restart assertion would have failed on a formatter wrap;
and the routine-scheduler lifetime above.

Red-verified by mutation, each mutant checked with `cmp` before and after:
removing the `flock`, inventing the holder pid instead of reading it,
`HeldError.Unwrap` returning nil, `Close` unlinking the file, `kin serve`
ignoring the held lock, the lock moved after `store.Open`, `os.Exit(1)` instead
of the mapped status, the supervisor's busy branch deleted, that branch moved
after the restart decision, the sidecar mapping exit 75 to an ordinary crash,
and — after the review — dropping `defer lock.Close()`, changing the 75 literal
to 74, removing the sidecar's no-restart guard, misspelling the variable in
the refuser's message, and, for the last nit, reverting `dev.sh` to the single
`trap cleanup EXIT INT TERM`, which the live check catches by starting a daemon
after the shutdown banner. All fifteen fail their check.

**Verified live** on a scratch `KIN_STATE_DIR` and two free ports: the holder
listened; a second `kin serve` exited 75 in about 150 ms and named the holder's
pid and the directory; `kin supervise` exited 75 with "another kin daemon owns
the state directory"; `kill -9` of the holder left no stale lock, a new
`kin serve` took the directory and listened, and the lock file then held the
new pid.

**Rollout note.** The invariant holds among daemons that run this code, and
nothing waits for a whole fleet to upgrade: a holder that predates the lock
simply does not stop a new daemon, exactly as before. On this machine the
rebuild's step 3 closes that gap — it copies `kin` into `~/.kin/node/` and
kickstarts the launchd job — so after the rebuild at the end of this round the
live node itself held `~/.kin/daemon.lock`: a `LOCK_EX|LOCK_NB` from outside
blocks, and the pid in the file is the `:7777` listener. A machine that installs
the node later gets this code from the start. The same rebuild ships the shell
side of the exit-status message.

### Round 11 — filters, the archived view and older pages (2026-10-29)

The S2 from §2.1's first row: the conversation list could search the whole
library but not browse it. Three gaps, one screen — a filter control, the other
side of archiving, and a way past the hundred-row page.

**The filter lives in the URL.** `?status=` and `?scope=` join `?q=`, so the
header control and the list cannot disagree, a reload keeps the filter, and a
filtered list can be linked. `normalizeStatusFilter` and `normalizeScopeFilter`
(`SessionFilters.tsx`) decide what a stale or hand-edited value means: an
unknown status is "all", an unknown scope is "active" — never a filter that
nothing can match, which would render as an empty library. The panel opens in
place rather than as a sheet because the sheet is `md:hidden`: a sheet here
would need a second desktop-only surface and two chances to disagree about what
is selected.

**Status is asked of the daemon, not applied to the loaded page.** The page is
100 rows; narrowing those answers "no running chats" about a page that merely
ended, and it is wrong, not slow. `sessionListParams` now carries the status
into the live list, the "is there more" bound and the older page, and the store
composes `status = ?` with the existing `before` bound. Imported agent sessions
carry no status, so a status filter hides them instead of showing rows that
cannot answer the question, and the paged sessions read keeps running for `?q=`
only.

**Six chips, not eight.** `queued` and `retrying` are deliberately absent: they
are moments between two of the statuses, and a filter for a state that lasts a
second is a control that is almost always empty. `canceled` is present for the
opposite reason — it is durable, and it is the one status the row dot draws
nothing for, so the chip is the only way to find a canceled run in a list that
shows a hundred rows.

**Scope is the other half of archiving.** The list hides archived projects
already; `?scope=archived` shows only them, with a Restore button in each
project's header. Restore calls `unarchiveProject` with the *stored* entry:
`archivedCwdFor` maps the bucket key back to what the sidebar saved, including
the sidebar's `__root__` sentinel for the no-project group, which otherwise
would find nothing to remove. Rows in the archived view carry no swipe actions
and no multi-select — pin and archive there would be no-ops — so `SessionRow`
returns the bare row when actions are off. Pins do not lift rows into a Pinned
bucket in the archived view either: that view exists to show projects as filed,
and the lifted rows would carry actions that are hidden.

**Load older is a button, not infinite scroll.** The list is a place people
scan; a viewport that keeps growing under the thumb loses the row being read.
Both feeds page by `before=`: Kin's tasks have no cursor, so the oldest loaded
id is the bound (`id < ?`, exclusive, and the list is id-desc); the imported
feed has a keyset cursor of its own. A page shorter than the limit is the end,
and a failed page keeps what is on screen and leaves the button in place so the
next tap asks again. Older pages live beside the live store rather than inside
it — the live store merges websocket updates into its first page, and a static
tail mixed in would make every update re-scan rows that can no longer change —
and the concatenation dedupes by id, because a task can also arrive through the
live feed. A new search term or status drops the tail and the "more" hint: a
tail that answered the previous question is not part of the new one.

**The filter tint is `/10`, not `/12`.** The first version used
`bg-kin-blue/12`; the design-token test builds the real stylesheet and found
that Tailwind emits opacity modifiers from the theme's `opacity` scale, and 12
is not in it — the class produced no CSS at all, so the "active filter" chip
would have been indistinguishable from an inactive one.

**Tests.** Console: `sessionListParams.test.ts` (status carried, empty status
dropped instead of becoming `status=`), `SessionFilters.dom.test.tsx` (closed by
default, the trigger names what is applied and says how many with a noun,
changing the status keeps the scope, a chosen status toggles off, clear hands
back both halves in one call, all nine chips present, `aria-controls` only while
open, Escape closes and returns focus, both normalizers),
`phoneSessionBuckets.test.ts` (the archived scope is the exact inverse of the
active one, empty when nothing is archived, an archived project whose chats are
all older than the loaded page still gets its heading, `__root__` finds the
no-project bucket, `archivedCwdFor` returns the stored spelling and never an
empty entry), `taskTail.test.ts` (no tail returns the live array itself, a
deleted row drops, a newer store copy wins over the page's, a row already on
the live page is not repeated), `liveResources.test.ts` (`taskSnapshot` answers
unknown / newest row / `null` after deletion), and
`sessionSearchWiring.test.ts` (three status-carrying task requests, two
status-free session requests, both URL normalizers, `before:` on both feeds,
the local status narrowing, the store reconciliation, and the generation guard
on both paged feeds). Go: `TestListTasksStatusPaging` in `internal/store`
inserts seven tasks with alternating statuses and pages the failures two at a
time, so a page that ignores the filter shows a foreign row in the middle and
one that drops the bound repeats a row the console would dedupe — the button
would look dead.

**Tooling.** `scripts/check.sh` grew `ui-test` and `ui-tsc` jobs, gated on
`ui/` paths and always on under `--all`. They were the two checks a console
change never got from this script, and the token test above is exactly the kind
of failure they catch before a commit.

**Red-verified by mutation.** Thirty mutants, each checked with `cmp` before
and after: the store dropping the status condition, making `before` inclusive,
and pointing it at newer rows; the parameter rule never carrying the status and
carrying an empty one; the normalizers passing unknown values through; the
trigger hiding the applied status and naming a panel that is not there; a
chosen status that cannot be toggled off; clear keeping the archived scope; the
canceled chip removed; Escape leaving focus inside the closed panel; the count
announced as a bare number; the archived scope showing active projects,
listing only projects with loaded rows, and dropping an empty heading;
`archivedCwdFor` matching the raw entry and returning an empty one; the live
list dropping the status; "load older" dropping the bound and appending a page
after the filter moved on, on both feeds; imported sessions paging under a
filter; the merged list not narrowed by status; and the tail keeping a deleted
row, a stale copy, or a duplicate. All thirty fail their check.

**Verified live** against the running node, through `vite dev` on a spare port:
the panel opened at 1280 and at 390 wide with every chip reachable; choosing
Failed put `?status=failed` in the URL and left only failed rows on screen;
archiving a project from the drawer made `?scope=archived` show that project
with a Restore button and no swipe actions, and Restore emptied the archived
store and put the project back in the drawer; "load older" appended the next
page, stopped rendering at the end of the library, and produced no duplicate
row ids (the one repeated label was two distinct tasks with the same title,
confirmed by id through `/api/tasks`).

**What the review found.** No blockers, five majors, eight nits — all fixed.
The majors were all about the list telling the truth about itself. (1) The
older tail lived outside the live store, so a row deleted after its page loaded
stayed tappable and opened a 404, and a run that finished stayed under a
"Running" filter; `taskSnapshot` and `mergeTaskTail` now ask the store per row
at render time (`null` drops, a newer row wins, a row already on page one is
not repeated). (2) The status was only filtered server-side, so the previous
page flashed under the new filter until the answer arrived; the merged list is
now narrowed locally as well. (3) `loadOlder` had no guard against its own
response, so a page requested under one filter could append rows under the
next; both feeds capture a request generation and drop a stale answer. (4) The
archived view listed only projects with loaded rows, but archiving is how a
project you are done with is put away — its newest chat is usually older than
the hundred-row page, exactly when Restore was needed; the view now seeds from
the stored archive list and keeps empty headings. (5) Each Restore button was
named just "Restore", so a screen reader heard the same control once per
project; the name now includes the project. The nits: multi-select stayed armed
when the archived view opened (now cleared); the chip groups had no
`role="group"`/`aria-labelledby`, the trigger no `aria-controls`, and Escape
neither closed the panel nor returned focus; the count badge was an unlabeled
number (now `aria-hidden`, with a spoken "Filters applied: 2"); `archivedCwdFor`
could return an empty archive entry, making Restore a silent no-op; `hasMoreTasks`
is still inferred from a full page, which can leave one dead button press at an
exact multiple — accepted, since the alternative is a `COUNT(*)` on every list
read for a button that corrects itself; and the design-token test keeps the
filter tint at `/10`. One fix from this pass is worth noting because the review
found it, not the live walk: the archived-scope test had passed while the
seeding bug was present, because the live walk had rows for the archived
project on page one.


### Round 12 — a project shows its conversations; a worker can be stopped (2026-10-30)

Planned against `1a8ce84b`; both slices are S2 and are verified against the
current code, not the matrix row above.

**12A Project conversations (§2.8).** `GET /api/projects/{id}/tasks` exists
(`internal/api/projects.go:453`) and no console page calls it; the client helper
`listProjectTasks` (`ui/src/api/client.ts:1381`) is unused, and the project
screen is a one-pager + pulse + artifacts only. Add a Chats tab that merges the
project's Kin tasks with imported agent sessions whose cwd is one of the
project roots (`listAgentSessions({cwd})` already filters by exact cwd), newest
first, each row naming its agent, status and relative time and opening
`/tasks/:id` or `/agent-sessions/:id`. Acceptance: at 390 wide, a project's
newest conversations are visible in two taps and open in one more; loading,
empty and load-error states are distinct; the Overview content is unchanged.

**12A — landed.** The tab is the URL. `?tab=chats` is the only tab value the
page accepts; `normalizeProjectTab` maps anything else, including a hand-edited
`?tab=files`, back to Overview, and choosing Overview deletes the parameter so
the default leaves no trace and the back button still walks the history someone
actually made. The strip is a real tablist — roving tabindex, ArrowLeft/Right,
Home/End — because it renders above a screen people keyboard through, and the
edit controls now mount only with the Overview panel they belong to. (No
`aria-controls`: only the selected panel is mounted, and a tab must not point
at an element that is not there.)

The list asks two questions, because the project holds two kinds of chat.
`listProjectTasks` returns Kin tasks the project owns; imported agent sessions
are asked per root with `listAgentSessions({cwd})`, which is an exact-cwd
match — one root would silently drop the others. `projectChatRows` keys rows by
namespace (`task:` / `session:`), so a task and an imported session that happen
to share a raw id stay two rows, dedupes the same session returned for two
roots, sorts by the task activity clock (`taskActivityAt`, not creation time),
and applies the hundred-row cap after the merge. A task falls back title →
prompt → "Untitled chat"; an imported session goes through
`displayAgentSessionTitle`, so an opaque hex title reads as agent + project
label rather than as a hash.

The panel is honest about what it does not know. Session queries settle
independently: one failed root leaves the other rows on screen with a partial
note, and only a failed task feed shows the retry box. A generation counter
makes the newest load win, so a tab switch or project change cannot be
overwritten by a slow earlier request. A reload keeps the current list visible
(skeleton only when there is nothing to keep) and announces itself with a
status line. Empty is its own state with a "New chat" link that carries
`?cwd=<first root>` — and no link at all when the project has no root, since a
chat started elsewhere would not appear in the project.

Rows carry the same signals as the rest of the console: the attention dot only
for running/approval/failed (`taskCardStatusView`), a machine icon when the
work runs on another device, relative time, and an accessible name that says
who, what and when instead of only the title.

**12A — review fixes.** The review found no blockers and two majors. Rows are
now scoped to the project they were read for (`chatsFor`): the page component
outlives a route change, so a slower read for the previous project could land
under the new project's name. A mismatch draws the skeleton, never another
project's list. The claimed race and partial-failure behavior now has
behavioral tests: the two-feed read moved to `loadProjectChats` in
`ui/src/lib/projectChats.ts`, taking the two callables, the roots and a
generation check, and returning `null` for a superseded read. Tests cover task
failure (error, no rows), one root failing (rows kept, `partial`), a read
superseded after each await, the non-Error fallback, and the all-success case.
Nits fixed: the error box is a live `alert` and the partial/refresh lines are
`status`; `aria-controls` is gone because the unselected panel is not mounted;
`projectRoots` trims once for both the fetch and the New-chat link;
`?tab=overview` and unknown values are removed from the URL on arrival; the
default hundred-row cap has a test; the wiring test now guards the loader seam
and the project scoping instead of substrings of the old inline fetch.

**12B A worker's own tokens, and stopping one worker (§2.2).** Lody's panel
shows tokens and a cancel per subagent (`subagent-task-panel.tsx:176`,
`subagent-task-state.tsx:98-110`). Kin's `WorkerTimeline` is read-only and the
only worker route is `GET /workers` (`internal/api/api.go:380`). Usage events
already carry `execution_id`/`execution_step` (`stampWorker` →
`applyExecutionMeta`), so the console can sum each worker's tokens from the same
stream it already draws. Cancellation is real: every worker is started with an
`adapter.RunHandle` whose `Cancel` stops the process
(`internal/adapter/adapter.go:17-20`), currently reachable only through
whole-task cancel. Add a per-step handle map in the engine,
`POST /api/tasks/{id}/workers/{execution_id}/{step_index}/cancel`, and a Cancel
control on a running row. A user cancel ends that step as `canceled`, leaves
the task and the other workers running, and suppresses meta-retry/provider
fallback for that step. Background count is N/A: Kin's workers are turn-scoped,
not backgrounded subagent tasks. Acceptance: a running worker can be stopped
from the panel without ending the task; its row reads Canceled while the rest
finish; every row shows its own token total.

**12B — landed.** The panel had two facts and no join. The plan table stores
the turn's execution id per step (`task_worker_steps.execution_id`), while a
worker event carried the adapter *attempt* id — a retry starts a new attempt
under the same step, so the ids never matched and every row drew empty. The
engine now stamps the turn as `run_execution_id` on every worker event
(`stampWorker`), and `workerActivity` groups on that id with the event's own id
as the fallback for events written before the field existed. `readExecution`
parses it; the row key is the plan identity, which is also what the cancel
route takes.

Tokens are summed per step from the same stream: `usage` events are
incremental and add up across a retry's attempts; a `result` event's tokens
count only when the step sent no `usage` event, mirroring the engine's ledger
rule so a finished worker is not counted twice. The nested `usage` object and
the adapters' field spellings are accepted. A row whose adapter reports
nothing prints nothing rather than "0 tokens".

`POST /api/tasks/{id}/workers/{execution_id}/{step_index}/cancel` stops one
step. `Engine.CancelWorkerStep` uses a per-step handle map registered by the
same path that registers the whole-run handle, refuses a step with no live
handle with `ErrWorkerStepNotRunning` (409), marks the step so the meta-retry
and provider-fallback paths cannot restart it, cancels the process, writes the
row canceled, posts a transcript note, and resolves the dead worker's pending
approval and question cards. The wave loop skips a canceled step's terminal
write; the task keeps running and succeeds on the remaining workers. Whole-task
cancel clears any live step handles on its way out.

The row's Stop button is a sibling of the expand button (a button inside a
button is invalid, and one tap must not do both), appears only on a running row
of a live task, and reads "Stopping…" while its request is in flight. A 409
refreshes the plan instead of toasting: the step had already settled while the
button was on screen.

Also fixed on the way: an approval decision landing as a turn finished could
move a terminal task back to running, because `Decide` read the status and then
wrote `running` unconditionally. `Store.ResumeTaskFromWait` puts the wait
states in the `UPDATE` predicate and reports `ErrConflict` when the row has
already ended; the decision path only publishes what it actually changed.

Tests: `TestCancelWorkerStepStopsOnlyThatWorker` (cancel one of two workers;
task succeeds, row canceled with no error or findings, approval resolved,
events carry the run id distinct from the attempt id) and
`TestCancelWorkerStepRefusesWhenTheSkillIsOver`; `TestStampWorkerCarriesTheRunExecutionID`;
`TestResumeTaskFromWait*` in the store; `workerActivity.test.ts` for the run-id
join, token sums across attempts, the result fallback and the silent case;
`WorkerTimeline.dom.test.tsx` for the stop control's structure, states and
per-row token display; `TaskDetailPage.test.ts` for the handler's identity and
409 rule; `TestCancelWorkerStepStatusCodes` for the route's 400/404/409 mapping
(the handler checks the task exists, so a deleted task is a 404 rather than
"that worker is not running"). `./scripts/check-openapi.sh` is clean (the
generated types include the new path).

**12 — review fixes.** The review found no blockers and three majors, all at
the edge where "stop" meets "the turn is ending". A second stop request — a
retried tap, or the same step stopped from two devices — could arrive after the
first had killed the process: it found the row already canceled, dropped the
stop mark and answered 409, and the worker's own goroutine then read the kill
as a crash and started the retry the reader had just refused. The mark now
survives the kill. A repeat request succeeds, and a row another path already
made terminal is the same answer; the mark is cleared only when `Cancel` itself
failed and the process is still alive. A plan whose every step was stopped
reported the turn succeeded with "No result was available to display"; it now
ends canceled, and a partially stopped plan appends a line to the answer saying
the result is partial (the synthesis prompt is told as well). The read-then-write
race fixed in `Decide` was still present in `AnswerUserQuestion`; it now uses
the same guarded `ResumeTaskFromWait`.

The cards a stopped worker leaves behind are matched by step number, not by
execution id: the id on an approval or question row is the adapter *attempt*,
which no run-scoped map relates back to the turn, and matching on the run id
would have left the stopped worker's own card pending (the test caught exactly
that). A card from an earlier turn names a process that has already exited, so
resolving it is right too.

Nits fixed: the unreachable 404 branch and the two dead registration wrappers
from the first pass are gone; the Chats tab clears its loading flag in a
`finally`, and a row shape the console cannot read becomes the retry box
instead of a rejected promise nobody awaits; a worker's token total is
accounted per adapter attempt, so a retry that reports only a `result` still
counts. Deferred: `RequestApproval`/`RequestUserQuestion` still write their
wait state unconditionally, so a request that lands just after a turn ends can
still park a terminal task in `waiting_*`; fixing it properly needs the insert
and the status transition in one transaction, which is its own slice.

Red verification: ten mutants — the idempotent second stop, the terminal-row
mark, the all-stopped terminal status, the partial note, the guarded question
resume, the retry refusal, per-attempt token accounting, the result/usage rule,
the chats loader's bad-row outcome, and the loading-flag `finally` — each
failed its test and the suite passed after the byte-for-byte restore.
`./scripts/check.sh --all` is green.


### Round 13 — jump to a file; the editor keeps its own ⌘F (2026-10-30)

Planned against `c417691a`. Both items close gaps the §2.6/§2.9 rows had
recorded, and the second one corrects a claim in that row rather than a
behaviour in the console.

**13A Quick-open over the checkout (§2.6, §2.9).** The files panel could browse
to a file but not go to one: the tree is lazy (500 entries per directory) and
has no filter, so a person who knows the name still walks folders. The daemon
already answers the right question — `GET /api/tasks/{id}/source/files?q=` is
what the composer's @ menu searches with (`searchTaskSourceFiles`,
`client.ts:808`; handler at `workspace_generations.go:615`). It requires a
non-empty query, caps it at 200 bytes and the answer at 50 names, reports
`truncated`, refuses control characters, asks the machine that holds the
checkout when the task runs elsewhere, and 400s when the cwd is not a git
repository.

The finder is page state, not panel state: ⌘P/Ctrl+P works with the files panel
closed, and choosing a row is what opens the panel — the reverse would make the
shortcut need the very surface it exists to skip. The search covers the source
checkout, so choosing a row also clears the selected workspace generation
(`onQuickOpenPath` → `setSelectedWorkspaceId(null)` → `onOpenWorkspacePath`):
opening a file found in the checkout inside a generation snapshot would either
miss or read a different version of it.

What the overlay says about itself: a name is required before anything is asked;
the answer is keyed by the query it answers, both in state and at render, so a
late response for a query typed past cannot replace the rows on screen; a
refusal shows the daemon's own sentence with a retry, because "not a git
repository" is the actual answer and an empty list would be a lie; a truncated
answer says it stopped early. A query past the daemon's byte cap is refused in
the overlay's own words instead of asking and painting a server complaint with a
retry that could only fail again — the field caps characters, the daemon caps
bytes, and CJK reaches the second limit first. Keyboard: the field is a combobox
with `aria-activedescendant` over a listbox (focus never leaves the input),
arrows move, Enter opens the highlighted row, Escape and Tab belong to the
front layer — see 13C for what "front" means — and opening restores focus to
whatever had it when the finder closes.

Ways in, because a shortcut is not a way in on a phone: the page shortcut, a
search button beside the panel's two lenses, and a "Find file" row in the
phone's action sheet. The sheet row follows the find-in-conversation rule
(`openFileFinderAfterSheet`) — Ionic keeps keyboard focus inside the sheet until it
is removed, so opening from the row's handler would focus a field that never
raises a keyboard. ⌘P is not claimed while focus is inside another
`role="dialog"`/`role="alertdialog"`; the finder marks its own dialog
(`data-file-quick-open`) so pressing the key again is still its own. It is also
claimed only by the pane in front: sessions stay mounted behind the tab strip,
so without the `active` gate one keypress would open a finder in every open
session, and switching tabs closes the one left open rather than saving a modal
for the return.

**13B The editor's ⌘F is not stolen (§2.6).** The matrix said
`ChatStream`'s window-level Cmd/Ctrl+F handler opened conversation find while
the editor was focused. It did not: monaco 0.52.2's standalone keybinding
service listens on the editor container and calls `preventDefault` **and**
`stopPropagation` when it dispatches a binding
(`standaloneServices.js:258-266`), so the window listener never saw the key.
The row was corrected, and the handler now also returns early on
`event.defaultPrevented` — belt and braces, and the same courtesy to any dialog
that claims the key before the window does (the Escape branch keeps its
deferred check, because the palette registers *after* this listener).

**Tests.** `FileQuickOpen.dom.test.tsx`: debounced single request for a burst,
nothing asked before a name, nothing asked past the byte cap, keyboard and tap
selection, Escape scoped to the dialog, no-match/truncated states, daemon
refusal + retry, a superseded answer never replacing current rows, a clean slate
on reopen, and `splitFilePath`.
`ChatStream.find.dom.test.tsx`: a key claimed closer to the target does not open
the bar. `fileFinderWiring.test.ts` pins the four ways in and the
dialog-marker/source-view rules that no unit can hold; `findWiring.test.ts`
updated for the finder-aware `findShortcut`.

**13C Review fixes (same-model sub-agent, 0 blockers / 2 majors).** Escape was
scoped to the event target, which is the wrong proxy for "which layer is in
front": the command palette paints above the finder without restoring focus when
it closes, and a click on the dialog's own chrome blurs the field — either left
a visible modal that ignored its only exit. Escape and Tab are now bound in the
capture phase and the front layer is decided by the focused element's containing
dialog: another dialog holding focus keeps the key, nothing above means the
finder closes. The second major was the missing focus containment — `aria-modal`
claimed inertness the DOM did not have, so Tab walked into the page behind it,
where the needs-you handler would approve or deny a card the reader could not
see. The `Sheet`/`ShareDialog` Tab trap is ported (outside → first, last →
first, first → last) with the dialog root as the no-controls fallback. Nits in
the same pass: the needs-you single letters now ignore keys from inside a
dialog; the failure sentence joined the `role="status"` region; the error message
no longer re-parses JSON that `apiFetch` already unwrapped (the test throws the
real `ApiError` shape); the generation is cleared only after the path is known to
open; `openFinderAfterSheet` became `openFileFinderAfterSheet`; phone rows got
room. Left as is: the panel's find button is 21px, in line with its 24px tab
neighbours and under the 44px touch rule — the phone's real entry is the action
sheet row.

Tests added for each fix: Escape closes from `<body>` and stays with a focused
sheet above; a claimed `defaultPrevented` is respected; Tab lands inside from
outside and wraps at both ends; focus returns to the opener; `queryTooLong` at
exactly 200 and 201 bytes; the refusal is announced; the panel's find button
lives outside `role="tablist"`. Red-verified with 23 mutants, one per claim.

### Round 14 — search what was said, and land on the line (2026-10-30)

Planned against `2fe432ee`. The §2.9 row's last S2 gap: the daemon could search
titles, prompts and file names, but not the conversation itself — the thing a
person actually remembers ("where did we decide to rotate the token?").

**14A A transcript index, not a log scan (`transcript_index.go`).** The first
cut searched `events` directly. Review killed it: streaming adapters persist one
event per delta (`claudecode`, `droid`, the Kin agent all write
`partial: true`, and `claudecode` runs with `--include-partial-messages`), so a
row scan answers `ploy the release` for an answer that says `deploy the
release`, once per chunk. It also returns rows the console draws in the progress
box or not at all, which the find bar cannot reach — a dead hit. And a query
that straddles two deltas (`"deploy the rel"` + `"ease"`) has no single row that
contains it, so no prefilter width fixes it.

So the store now keeps a derived `transcript_messages` table: one row per
message as the reader sees it. The first cut mirrored only the chat column;
review showed that the process box is just as readable (a card unfolds, and the
find bar now searches its note rows), so the index keeps every message the
projection draws. It drops only what the console never renders as prose: a blank
message, and an old kinagent tool dump, which becomes a tool step. Each row
carries the console's three questions — the stream buffer (`open`), whether it
is still a preview (`partial`), and which side of the process box it sits on
(`progress`).

The append transaction folds each event in (`indexTranscriptMessageTx`),
mirroring the projection's boundaries as well as its rows. Deltas join the open
row by message identity (speaker + role + `message_id` + block index, as in
`transcriptProjection.ts`) or by speaker when the adapter stamps neither; the
final message removes the previews it supersedes and the buffer it closes, by
the console's scan-then-buffer rule, and a blank final removes them without
drawing anything. The steps the console draws end the stream at exactly its
flush points: a host-visible `tool_use`/`tool_result`, a labelled `notice`, a
`plan`, a non-cancel `error`, a `result` (which also settles every preview of
the round), an approval or question request, a routing decision, and a labelled
workspace event. Splitting where the console does not would lose a hit; joining
where it does would answer with a sentence the find bar can never match, so the
list is copied rather than approximated. `message_key` and `stream_key` are kept
apart because a flush can split one message into two rows that the console still
knows by one key.

A `transcript_index_state` watermark makes the fold idempotent, and `Open`
replays any indexed event past it, so a database written before the index
existed fills itself in (resumable in 500-event batches, one indexed question
when there is nothing to do). The index is derived: a payload the decoder cannot
read is not searchable but never fails the append that stores it. User prompts
are stored as the console shows them — the composer's `Attached …:` block keeps
its file names and loses its local paths (`internal/attach`).

The watermark carries the task's `event_epoch` as well as the seq, because
retry and truncation delete the tail and start a new timeline that the console
filters on. Both operations now rebuild the index from the events left in their
own transaction, and the retry's fresh prompt — inserted directly, like a fork's
copied events — is folded in as it is written. Review caught the first cut
pruning only `last_seq >= fromSeq`: a preview that straddled the cut, or one a
deleted message had superseded, then described a timeline the console no longer
projects. An epoch that moves without either operation (an older build, a path
that bumps it directly) rebuilds the same way instead of trusting rows from
before the change.

`SearchTranscript` is then a plain substring query over prose — no JSON keys, no
escaped-quote second pattern, no 3x decode window — with the scope predicate on
the joined task row. A hit still carries role, snippet and the first seq; the
snippet needle is whitespace-collapsed along with the text it is cut from, so a
query spanning a run of spaces still centres on the match.

**14B The palette's Messages section and the jump.** `GET
/api/search/transcript?q=&limit=` validates like the file search (required, 200
*characters*, not bytes, so a Chinese query is not refused at 67 characters; no
control characters; bounded limit) and runs under a 3s context so one search
cannot hold the store's single connection. The ⌘K palette asks it once typing
settles (250 ms, latest answer only), shows up to 8 hits under Messages with the
snippet as the row and the conversation title as the hint, says "newest matches
only" when the daemon truncated the list, and a row opens
`/tasks/{id}?find=<query>`. The conversation opens its own find bar seeded with
the query (`ChatStream.findSeed`), reusing the existing matching and
scroll-to-match code. The page consumes the parameter (`useFindSeed`) instead of
reading it forever: the same hit picked twice is the same URL, and a parameter
that stays behind would make the second pick a no-op and reopen a closed bar on
back/forward. The seed is only consumed by the pane in front, because the others
are mounted behind the tab strip.

The bar searches the process card's note rows as well as message bubbles (a
message the projection folds into a card keeps its key), and a hit inside a
folded card unfolds it — scrolling cannot reach a row that was never drawn. The
reader can fold it back for that hit; the next hit opens it again.

**Tests.** Store: deltas coalesce and a query straddling two of them matches;
a final replaces its preview (and the preview stops answering); a blank final
drops the preview it closed; a complete note drops the streaming note it
supersedes; an identified final replaces its own row and not the message still
streaming; identified messages stay apart, and the same block from two speakers
stays apart too; an ACP-style partial-only answer is one hit, not one per chunk;
reasoning/plan/task-only/delegate/orchestrator rows are searchable, because the
card draws them; a phase-less legacy orchestrator wrap-up (`Done: …`, `完成：…`)
and its chatter are both searchable; a stamp that names only `user: false`
defaults `task` to true and is a process-box row, not chat, exactly as
`readVisibility` reads it; a tool step between two deltas splits them even when
the adapter keeps stamping the same identity; the backfill replays the same
boundaries; an upload's local path is not searchable while its file name is; a
truncation past the head still indexes the next message; host and summary rows
are; a legacy worker row is drawn in the process box and ends the host's stream;
the backfill indexes old events once and a replay does not duplicate text;
malformed payloads are skipped; string content and flat `text` are read; an
interleaved progress row ends the stream; an epoch that moves without a prune
rebuilds the kept timeline instead of dropping it. Plus the earlier scope,
limit/truncation, literal `%`, CJK, whitespace-snippet and empty-query tests.
API: shape, `[]` not `null`, refusals (blank, over-long, control/NUL, bad/
negative/zero limit), auth, cap + truncated, rune-counted cap, and a request
with no principal matching nothing (the scope is read from the request, not
assumed). Console: debounce and one request per burst, click and Enter carry the
query to the URL, a superseded answer never lands, no empty section, the
truncation note; ChatStream opens seeded and does not reopen after the reader
closes it, unfolds a process card for a note hit and folds it back on request;
the page wiring test pins the active-pane gate; the seed hook fires twice for
the same URL and leaves the URL clean. Plus the second-pass tests: a backfill
writes its watermark and a partial tail is not replayed twice
(`BackfillsAPartialTailOnce`); a task-only tool step does not split the host's
stream (`TaskOnlyToolDoesNotEndTheStream`); a stamped speakerless row speaks as
the host, so its final still finds it (`NamesTheHostForAStampedSpeakerlessRow`);
the origin is read from `source` (`ReadsTheOriginFromSource`); a dump line after
prose makes the message a step (`TreatsALateLegacyDumpAsAStep`). Red-verified
with mutants, one per claim.

**Review (second pass).** Three findings survived the first pass because the
tests could not see them. The backfill folded rows without writing its
watermark; the selector looks for a state row, not for rows, so the task was
replayed at every `Open`, and a partial tail — now the newest open stream —
joined its own copy and doubled the text. The watermark is now written in the
same transaction as each batch. The envelope read the origin from `origin`, but
the canonical field is `source` (`task.EventMeta`), so every legacy
orchestrator/worker row was classified as chat; the tag now reads `source`, and
the tests that were blind to it use it. The find seed was consumed on the
loading render, before the conversation mounts, so a palette jump to a cold
session deleted `?find=` with nowhere to hand it; the page consumes it only
once the task detail has loaded, and the wiring test pins the gate. Nits fixed:
a stamp that names only `task` is the console's explicit "not the user", so a
worker's tool step no longer splits the host's stream; a stamped speakerless row
resolves to the host agent rather than `"assistant"`; the legacy dump test is
multi-line (`/m`) and case-sensitive, like the console's; a folded-back card
reopens on the next visit; a search that runs out of its budget answers 504.

**Not done.** File *contents* are still not searchable (the finder is names). An
answer that is streaming right now is indexed as it streams, but a hit inside it
may point at a row that the final message later replaces — the find bar will
still find the words in the final. The supersede scan stops at the last user
message but not at the notices, plans and errors the console's scan stops at
(the index keeps no rows for them), so it can remove a preview the console still
draws: a lost hit, never a dead one. The same asymmetry applies to visibility:
the process-box classification is a server-side mirror of `eventMeta.ts`, and a
class the mirror gets wrong can only move a boundary, not hide text the console
draws. FTS5 over `transcript_messages` is the next step if the library outgrows
a substring scan. Two nits are deferred: a known field with the wrong JSON type
(`"text":5`) fails the whole decode, so a message the console would still draw
is not searchable — the decoder's tolerance is for unknown fields, not for
mistyped ones; and SQLite's `lower()` folds ASCII only, so cross-session search
and the find bar disagree on non-ASCII case. Both point at the same next step:
match in Go over a cheaper prefilter, or let FTS5 do the folding.

### Round 15 — a phone gives the whole screen to the diff (2026-10-30)

Planned against `8f770c92`. Closes the §2.6 S2 row. On phone widths the files
panel stacked the change list over the viewer (`WorkspacePanel.tsx` carried
`h-[40%] max-h-[46%]` on the sidebar), so a diff was read through roughly half a
screen while the list it came from held the other half. Lody's drawer is
single-pane: a list, then a full-height diff with Back.

**15A One pane at a time under `md`.** `phoneView` ("list" | "file") drives the
panel below the breakpoint. Every way into a file — the change list, the tree,
quick-open, the changed-files bar, a workspace `openPath` — goes through
`loadFile`, which flips to the file pane, including the path it refuses: the
refusal is the viewer's answer and belongs where the file would have been. The
header draws a back control only while the file pane is up, and only under
`md`; the pane that is behind carries `hidden md:flex`, so md+ still shows both
side by side and the resizer stays a desktop control. Switching task,
generation or checkout returns to the list; closing the panel unmounts it and
spends the open-file pulse, so it opens on the list again. The phone loses
nothing: the list had half a screen before, and now it has a whole one until
the reader asks for a file.

**15B Tests.** The panel's existing DOM harness (CodeViewer mocked, API stubbed)
renders the list-only state, clicks a change row and asserts the list step
aside, the back control appears and returns; a third case opens a file through
`openPath` — the changed-files bar's route — and asserts the same flip, and a
fourth opens a path outside the workspace and asserts the refusal is drawn in
the file pane, not under a list still in front. The state assertions read a
`data-phone-view` attribute rather than substring-matching classes; one token
check per pane pins the class the CSS hangs on (`hidden` on the aside, `flex`
on the viewer), so `overflow-hidden` cannot pass for `hidden`. The md+ two-pane
layout is CSS and is not asserted in jsdom.

**Review (second pass).** No blockers. Two majors, both real, both fixed and
red-verified by mutation:

- *The open-file pulse was a condition, not a command.* `loadFile` takes a new
  identity whenever the workspace view does — a generation refresh hands back a
  fresh `generations` array while it loads, which is a new `useMemo` result and
  a new callback — and the pulse effect (`[openPath, openNonce, loadFile]`)
  therefore re-ran, dragging a reader who had pressed Back straight into the
  file again, or into a file the new checkout does not have. The same churn
  made the reset effect's `setPhoneView("list")` lose the same commit. The
  pulse is now consumed once per `(path, nonce)` in a ref: a view change cannot
  replay it, and a genuinely new open bumps the nonce. A DOM case walks the
  exact scenario (open via `openPath`, Back, rerender with a new
  `currentWorkspaceId`) and asserts the list stays and the file is not read a
  second time.
- *Focus fell to `<body>` on both transitions.* Opening a file hides the row
  that had focus, and Back unmounts the control that had it; the next Tab then
  started at the top of the page behind the panel. `loadFile` now hands focus
  to the back control (a no-op at md+, where it is not drawn and the list never
  left), and Back hands it to the row that opened the file
  (`data-selected` on change and tree rows), falling back to the lens tab, and
scrolls it into view — hiding the pane had also reset the list's scroll.

Nits fixed: the page now spends the open-file pulse when the panel closes, so
reopening Files starts on the list as the section claims; the refusal and
`openPath` cases gained the assertions they were missing; the label reads "Back
to files" / "返回文件" (the aside can be the tree, not only the change list);
and the §2.6 row is updated rather than left describing the 40–46% sidebar.

**Not done.** No separate "conversation diff" pane is added: the per-turn diff
cards already live in the conversation, one tap away on a phone. The list and
the viewer keep their current scrolling; there is no swipe-between-panes
gesture, because the back control is the one affordance a phone needs and a
gesture would duplicate it.

### Round 16 — the strip and the button say which session needs you (2026-10-30)

Closes the §2.10 / §2.12 "unread dots in tabs" row. Lody's tab bar carries
unread and waiting-permission states per tab, and the phone's tab-sheet trigger
carries the same. Kin already had both models — `switcherStatus` and the
switcher sheet — but neither control said anything until it was opened, so the
only way to learn that a background session was blocked was to open the sheet.

**16A The mark model is the sheet's.** `tabMark` reuses `switcherStatus` and
drops the one state a dot cannot say: "running". A spinner on every busy tab
would make the strip a row of noise, and most tabs are busy most of the time. A
tab whose row has fallen off the loaded page still reports `waiting` from the
pending lists, which are keyed by task id and need no row — the same fallback
the sheet uses. The dot takes the sheet's colours (`kin-orange` waiting,
`kin-red` failed, `kin-green` unread), and the state also rides in the tab's
accessible name (`tabs.withState`), because a 6px circle is not an
announcement. The session in front carries no dot: its state is the screen
itself.

**16B The phone's control carries the strongest reason, not every reason.**
`attentionMark` reads the same rows the sheet will draw, so the control and the
sheet share one status model. Waiting outranks unread; the active session never counts
(the reader is looking at it); and a failure does not light the dot — a failed
session stays failed until it is retried or closed, so a dot that only cleared
when the tab went away would train the reader to stop seeing it. The failure is
still in the sheet, with its red mark. When a dot is drawn the control's label
becomes `switcher.titleMarked`, so the state is announced and not only painted.

**16C Tests.** Table cases for both helpers (a missing row, a viewed result, a
busy session, the active row, a failure), a DOM test that pins the strip's dot
colour, its accessible name and that the dot does not swallow the click, a DOM
test for the header control's dot and its unchanged name, and wiring pins for
the host-to-strip and host-to-control seams — the two places a source test can
reach that a unit cannot. After review the label rule moved next to the mark as
`switcherTriggerLabel`, so the key and the `{state}` parameter are covered by
unit cases; the page's pin only has to prove it passes the parameter through,
because a title template with no params renders "Switch session — ".

**Not done.** The strip still has no pointer drag reorder (keyboard only,
unchanged). The phone's other session surfaces — the project Chats tab — keep
the marks they already had. Running sessions are deliberately unmarked, so a
long-running background job is visible in the sheet but not on the strip.

### Round 17 — a routine is editable (2026-10-30)

The console could create a routine and afterwards only pause, resume or delete
it. Every other field was frozen at creation, although `PATCH
/api/routines/{id}` has accepted them all since the scheduler landed
(`internal/api/routines.go:36-47`). The create form is now the edit form: the
row's Edit button fills it from the routine, and the save path derives a patch.

**The patch is derived, not the form.** PATCH writes every field it receives,
and the scheduling fields are the ones that bite. Sending `recurrence` makes
the daemon recompute `next_due_at` from the rule (`routines.go:296-306`), so a
routine whose title was the only edit would move to a new next run; a rule also
carries the zone it was written in, so re-sending an untouched rule from a
machine in another zone rewrites its wall clock. `routinePatch`
(`ui/src/lib/routineEdit.ts`) compares what the reader is looking at with what
the daemon holds — rules through a zone-free shape, day sets in sorted order —
and says nothing about the schedule when the two match. An unchanged form
returns null, and the page closes without a request.

**Switching between the two schedule kinds.** Dropping a rule sends
`recurrence: ""` plus the interval and its first run — the contract the API
test already pins (`routines_test.go:306`). A new rule sends `recurrence` alone
and lets the daemon place the next run; the form's next-run field is not sent,
because an instant the rule does not own would contradict it. A one-off is the
exception: its instant is editable, so it goes in both.

**17B Review: the schedule round trip.** Two comparisons turned out to be too
strict. The form's date-time control holds a minute, but an interval routine's
`next_due_at` carries seconds (the scheduler jitters it so every routine on a
list does not start on the same tick), so re-opening a routine and saving
anything re-sent a next run a few seconds earlier each time. Instants now
compare to the minute (`sameMinute`). The title was compared after the create
path's 48-rune truncation, which would have shortened a longer title written by
another client; the patch now sends only what was typed, and never derives or
truncates a title — create still derives only when the field is blank.

**17C Review: the form is borrowed, not owned.** An edit takes over the create
form, so closing it now puts back the draft it displaced (`createDraftRef` →
`applyDraft`), rather than the reset that left the next new routine with another
routine's directory, agent, cadence and permissions. An empty next-run field
means "as soon as possible" — create could leave the instant out and let the
daemon default to now, but a patch has no default, so the client sends `now`
explicitly. An unrecognised stored rule is cleared on save instead of being
preserved forever (the form can only show it as interval mode). The one-off
guard moved from a disabled Save to a submit toast: a greyed button cannot say
what is missing, and the date-time field is often empty when the form opens.
The agent select keeps an option for a routine's own agent when that agent is
offline, instead of silently showing the first available one while the state
held the missing id. Deleting the routine being edited closes the form. The
panel is a landmark with a heading and the row's Edit button names its routine.

**17D Review: the project follows the directory.** Create resolves `project_id`
from `cwd`; PATCH wrote the new directory and left the old project, so a moved
routine's runs stayed attributed to the project the old path belonged to. The
patch resolves it the same way, and a directory with no project clears it —
what create does with an unmatched cwd. An API test moves a routine between two
projects and checks a title-only patch leaves the project alone.

**17E Second review: a rule keeps the zone it was written in.** The rule's hour
and minute are a wall clock in a named zone, and every rule written by this
console carries the writer's zone. The edit form showed that clock verbatim but
the serializer re-stamped it with the reader's zone, so a 09:00 rule written on
a phone in Asia/Shanghai and edited from a UTC desktop would have started
firing at 09:00 UTC — and changing only the weekday would have done it.
Converting the clock instead would be wrong: a repeating rule has no single
instant to convert, and the offset between two zones changes with the other
zone's DST. So the edit keeps the stored zone (`ruleTimeZone`), the serializer
takes the zone as a parameter, and the schedule hint names it rather than
claiming the times are the reader's. A rule stored with no zone at all — rows
written before the console stamped one, or by an API client that omitted it —
is fired by the daemon on its own local clock, so it stays zone-less on save
and the hint says the times are the machine's. A stored zone the platform
cannot load, an out-of-range clock, repeated days, or a one-off with no instant
now parse as "no rule", which is what the daemon's `Validate` says about them —
the row then shows as interval mode and a save clears the rule instead of
holding it in a state that never fires.

**17F Second review: smaller fixes.** PATCH trims `cwd`, refuses an empty one
(create already did), and only re-resolves the project when the directory
actually changed — an explicit `project_id` still wins, and a failed lookup is
a 500 rather than a move that keeps the old project. Clearing the title derives
one from the prompt, exactly like create, so the routine's runs are named the
same as one created with a blank title (sending `""` would have left the
daemon's "Routine" fallback). The disclosure and every row action are disabled
while a save is in flight, so pressing Save on A and then opening, closing or
deleting something else cannot make A's completion act on that instead. The
disclosure has `aria-expanded`/`aria-controls`, the scroll-into-view obeys
`prefers-reduced-motion`, the agent label is translated, and closing the form
returns focus to the disclosure in create mode too.

**Not done (nits, deferred with reason).** The shared schedule control still
edits one day of a multi-day monthly rule and shows a custom interval as a
blank select; both shapes only come from outside the console (create writes a
single day and a preset interval), and a correct multi-day editor is its own
slice. A rule the console cannot parse but the daemon can — capitalized JSON
keys, a zone ICU lacks, a future kind — is still cleared by an unrelated save;
keeping it would need the form to track whether the reader touched the schedule
controls, and today's in-tree writers all produce parseable rules. Moving into
a subdirectory of the same project clears `project_id`, because resolution is
an exact-root match — the same rule create uses. Focus after a save lands on the
disclosure, not the row's Edit button — the row may be scrolled away by then.
PATCH leaves `interval_secs` alone when a rule changes, while create derives it
from the rule; `interval_secs` is the fallback pace, so that stays the contract.

**Not done.** The form still shows no next-run preview beyond the schedule
fields' existing hint. (Per-routine history landed in Round 18.)

### Round 18 — a routine carries its own runs (2026-10-30)

**18A The filter the store already had.** `ListTasksOpts.RoutineID` has existed
since the routine-runs feed: `""` means no filter, `*` means any routine run,
and an id means that routine. `/api/tasks` never passed it through, so a client
could only read the global feed and filter after the fact — and a routine whose
last run fell off that capped page looked like it had never run. The handler now
passes `routine_id`, and a test covers the exact id, the `*` wildcard and an
unknown id. The console's `listTasks` gains `routineId`, so the request is the
one thing a unit test proves rather than a source pin.

**18B History under the open routine.** Opening a routine (create has no id yet)
asks for its ten newest runs and draws them below Save/Cancel: a translated
title, a loading line, the empty line "No runs yet.", or the rows themselves,
reusing the feed's `RunCard` so status, time, unread and mark-read look and
behave the same in both places. Marking a run read in the history clears it in
the history and the global feed at once, and still fires the unread badge event.
A failed fetch shows its error instead of the empty line — "could not ask" must
not read as "never ran". The cap is ten because the panel is a glance at what
the routine has done lately, not an archive; the global feed above remains the
place to page through everything.

**18C Keyed by routine.** The rows, the in-flight flag and the error are each
keyed by routine id. Opening B while A is still loading, or while A's fetch
fails, cannot put A's spinner, error or runs under B's name. Two fetches for
the *same* routine are ordered by a per-id sequence number: reopening a routine
while the first fetch is still out keeps the newer answer, so a run created in
between is not overwritten by the older snapshot. An empty routine id never
reaches the request, because the daemon reads `routine_id=` as "no filter" and
would show the newest tasks of any kind under one routine's name.

**18D The review's catches.** "Mark all read" sits on the same screen as the
open history, so it now clears the cached history lists too — otherwise the
feed and the history contradicted each other on one screen. The error/empty
order is pinned as an order, not as a set of strings: swapping the two branches
would show "No runs yet." for a failed fetch and every presence check would
still pass. The sequence guard is pinned per occurrence, because the try, catch
and finally guards do different jobs and one surviving copy cannot stand in for
the others. A mark write that lands while a history fetch is already out still
wins over that fetch's older snapshot — per-id marks are remembered and
"mark all" bumps an epoch — because unread only ever goes true → false and a
late snapshot would otherwise put unread rows back on a screen whose feed and
badge say read. The rows in a routine's own history drop the routine-id suffix,
which only says what the editor already says. The section is named with
`aria-labelledby` rather than an `aria-label` that repeated the visible
heading, and `GET /api/tasks` documents `routine_id`, including that empty
means no filter rather than "tasks without a routine"; the generated
`ui/src/api/generated/openapi.ts` carries the same parameter so
`npm run check:api` stays green.

**Not done.** The editor shows each routine's runs but does not refresh them
while it stays open, and has no "load more" (ten is the whole panel). A failed
fetch has no retry button; closing and reopening the routine retries. Following
a run's title leaves the page and drops an unsaved draft, which is how the page
already behaved everywhere. No next-run preview inside the form yet. Lody caps
the linked sessions under a schedule at 100; reaching that breadth here needs a
paged history view rather than the form panel.

### Round 19 — a routine can step through the day (2026-10-30)

**19A The two missing kinds.** Lody's recurrence editor offers "every few
hours" and "every few minutes" beside the clock rules; Kin had five kinds and
no way to say "every six hours" except a six-hour interval, which drifts. An
interval routine waits `interval_secs` after the previous run *finished*, so a
ten-minute run turns "every six hours" into six hours and ten minutes, and a
day of those accumulates. The daemon gains `kind=hours` and `kind=minutes` with
an `every` field. Both sides accept the same set and no more: the minute steps
are the five-minute marks (5, 10, 15, 20, 30), the hour steps are the divisors
of a day up to half of it (1, 2, 3, 4, 6, 8, 12). A step has to divide its unit,
because one that does not leaves a short gap at the boundary (every 7 minutes
from :56 is :00 four minutes later). Under five minutes is excluded on purpose:
hundreds of agent sessions a day is an interval routine's job, not the calendar
rule's. Six and twelve divide the hour but are not offered, and the daemon
refuses them too — a step the form cannot draw would otherwise be a stored rule
that opens as a blank control. The scheduler's overdue
threshold comes from the same `period` the other rules use, so a step rule is
judged by its nominal gap — 20 minutes or 8 hours — not by `interval_secs`.

**19B Alignment is the point.** `Next` walks absolute time from the caller's
wall clock and returns the first candidate whose minute or hour hand is a
multiple of the step. That is what makes "every 6 hours" mean 00:00, 06:00,
12:00 and 18:00 in the rule's own zone rather than six hours after the last
run. Walking absolute time and requiring every candidate to be strictly after
the caller is what keeps DST honest: the New York spring-forward removes 02:00,
and the 02:30 candidate simply lands on 03:00; at the fall-back the repeated
hour cannot hand back an instant in the past. That second case was the review's
blocker: rebuilding the ambiguous wall clock resolves it to its first
occurrence, so a rule asked during the second 01:30 answered 01:00 — a past
instant the scheduler re-dispatched every tick. Tests pin the alignment
(including the strictly-future case on an already-aligned minute and hour), the
rule's own zone with a UTC caller and a Shanghai rule, both DST transitions,
the nominal period, and every rejected step shape — including a fractional
`every` and one sent as a string.

**19C The console's step control.** The one "repeat" select gains the two
rules. Choosing one swaps the row underneath for a step select and nothing
else: no time of day, no first run. The step lists are exactly the daemon's
accepted sets, checked by membership rather than re-derived arithmetic on both
sides, so the form cannot offer a value the daemon refuses and a stored rule
always has an option to show. A stored rule that fails validation reads as no
rule (the form shows it as interval-only, as it already did for unreadable
rules). Serialization writes
`{kind, every, time_zone}`; the list line says "Every 6 hours"; the edit form
compares step rules by kind and step, so saving a prompt change leaves the
schedule alone, and switching between a clock rule and a step rule sends the
new rule while keeping the stored zone.

**Not done.** Still no next-run preview inside the form. A step rule always
aligns to the top of the day (00:00 for hours, :00 for minutes); there is no
"start at 07:00" offset. Lody's cron `*/N` is aligned the same way, so the
simpler model stands until a real need shows up. In a zone whose DST shift is
itself 30 minutes (Lord Howe), an hours rule can land on :30 for the rest of
that day and realigns at the next occurrence; the alternative — rebuilding the
wall clock each step — is the ambiguity that produced the fall-back bug above.
The `ROUTINE_RULE_KINDS` / `RoutineRuleKind` exports remain unused
(pre-existing).

### Round 20 — a routine remembers its model (2026-10-30)

**20A The control that did nothing.** New Chat's routine mode keeps the
composer's model picker visible, and `createRoutine` dropped the value: picking
a model there produced a routine that ran on the agent's default, a control
that looked applied and changed nothing. The Routines editor had no model
control at all. Both are the same missing field — a routine carried an agent
and a permission mode but no model, while Lody's schedule editor has all three
(`schedule-agent-controls.tsx:26`).

**20B One column, two upgrade histories.** `routines.model` is additive and
defaults to `''`, which is exactly the state every routine ran in before the
field existed: the agent's own default. The ordered migration (43) adds it to
a database that says 42; the `ensureRoutineModelSchema` reconciler adds it to a
table that already claims the current version but has no column, the same split
the recurrence and device-agent columns use. Both histories are pinned by
tests, including that the upgrade records the new `user_version` so the next
open does not migrate again. The HTTP boundary trims the id on create and on
patch; `""` is a real patch value and clears back to the agent default. The
scheduler turns a non-empty model into `CreateRequest.Model` and leaves an
empty one nil, so "no model" is the absence of a field rather than a literal
empty id the adapter would have to interpret.

**20C The console.** The Routines form gains the shared `ModelPicker` beside
permission and agent, listing the selected agent's catalog — read from all
agents, not only the available ones, because a routine keeps its agent when
that agent goes offline and the catalog it last reported is still the best list
to offer. Changing the agent clears the model, mirroring New Chat: an id from
the old catalog is a run that fails at start. The create draft snapshot and
restore carry the model, so opening an edit and closing it gives the next new
routine back its own picker. The picker is keyed on the form's identity and
agent: its internal "Custom" flag deliberately survives a value change (that is
what keeps the empty input open while a custom id is typed), so a model the
form clears would otherwise leave the control reading "Custom" with a blank
box — the exact stale-control class this round removes. The edit patch sends
`model` only when the trimmed value differs and sends `""` to clear it. New
Chat forwards its selected model into the routine it creates.

**Verification.** `./scripts/check.sh` clean; 22 mutants red — store scan,
select list, insert, update, reconciler, migration, API create/patch trims,
clearing and omission, scheduler pointer, omission and the tick path, the
console diff, the picker remount, and the page wirings. One of them was a real
gap in the first manifest: the API create test
reads the handler's response, which is the struct it just built, so an INSERT
that never wrote the model still passed. The store now has a read-back test for
insert, the reconciler repair with its own mutant, and version-42 upgrade
coverage that pins the reopened version and column — the ALTER inside that
migration is deliberately mirrored by the reconciler on the same open, so no
external test can tell the two apart; the version bump is what the migration
mutant kills. Review added the omission case (a title-only PATCH must keep the
model) and the tick-path assertion (store scan → scheduler → the task row a run
starts from), both with their own mutants.

**Not done.** No catalog validation of a stored model id beyond the picker
itself; a raw HTTP client can store any string, and the run fails at start the
way New Chat does for an unknown model. No length bound on `model` and no
`MaxBytesReader` on the routine routes — prompt and title share that exposure,
so it is a consistency change, not this field's. New Chat's host-change effect
keeps a picked model when the fallback agent reports no catalog at all
(`opts.length > 0` guard, pre-existing): narrow — it needs the chosen agent to
go offline between picking and sending — but a routine created in that window
stores the stale id, so it is a candidate for a follow-up. The project page's
quick-create is the third routine surface and still hard-codes `agent: "kin"`
with no model or permission control. A routine whose agent is later removed
keeps both the agent id and the model id. No bulk "set the model for every
routine" action.

### Round 21 — the form says when it will next run (2026-10-30)

**21A The rule existed twice, or not at all.** Create turns a repeated rule into
a first run with `Recurrence.Next`; the console never showed that answer, so the
form asked for a time of day and gave no sign of when the first run would land.
Lody's recurrence editor previews it (`schedule-recurrence-editor.tsx:132`).
Computing it in TypeScript would have been a second implementation of zones,
DST walking and step alignment, and the day the two disagreed the form would
promise a time the routine never fires at — worse than no preview. The daemon
is the only thing that should answer.

**21B One helper, one answer.** `ruleFirstRun` is now the single read of a
rule's next instant, shared by create, patch (`nextDueAfterRuleChange`) and the
new `POST /api/routines/preview`. The route parses the same recurrence string
create would store, returns `{next_due_at}`, and refuses bad JSON, a missing
rule and a rule with no future occurrence with 400. It is `holderOnly`:
parsing a rule touches no state, but the answer depends on this machine's
clock, so a guest may not ask. The first version also returned the rule's
nominal pace for the interval column; review asked what would display it, and
nothing did, so the field was dropped rather than kept as an unused part of the
contract.

**21C The console.** `previewRoutine` in the API client; `useRoutinePreview`
debounces 250 ms, treats the serialized rule as the request identity, clears
the shown instant the moment the payload changes (so the previous rule's time
never survives the debounce or a slow request), drops an answer for a rule the
form has already left, clears on an empty payload and reads null on failure.
The page builds that payload with the same zone default the edit path uses —
`ruleZone ?? localTimeZone()`, matching `schedulePatch` — so a stored rule is
previewed in its own zone, and skips `once`, whose instant is already in the
date field. The fields render one muted line under the zone hint, only for a
repeated rule that has an answer, and format it on the rule's own clock face so
it agrees with the hour/minute fields above it. Both locales carry the key.

**Verification.** `./scripts/check.sh` clean; 20 mutants red — the route, the
preview's no-future refusal, its returned instant (pinned against create's
stored value, not only by eye), malformed JSON, `ruleFirstRun` itself (create,
patch and preview all caught), create's refusal of an unfireable rule, the
hook's clearing on change, stale guard, debounce cleanup, delay and failure
state, the page's once skip and zone, the prop reaching the fields, both render
gates, the line's clock face, and the client path. The client test was added
because the endpoint name and the verbatim rule body were not otherwise pinned
by anything. Review also produced a create-agreement test, the invalid-JSON
case, and a member-403 assertion for the new route. Prettier rewrapped three
unrelated strings in the locale files; those hunks were reverted so the diff
stays on this round. The clock-face test picks its zone by rendered output, not
name: the first name-only pick (Asia/Shanghai) sat in the runner's own offset
(Asia/Singapore), so the mutant that dropped the zone survived until the test
compared strings.

**Not done.** New Chat's routine composer uses the same fields but passes no
preview — the hook is ready for that surface. No request-body limit on the
preview route, consistent with the other routine routes (R20 note). A zone-less
stored rule ("" — the daemon's own clock) is formatted on the reader's clock,
because the daemon's zone is not part of the response; the hint above already
says the times follow the daemon. The preview reflects the request's "now", so
a rule that fires inside the debounce window can briefly show the instant that
just passed; the next edit or the list's computed next due corrects it. No
caching across identical payloads. The page wiring test pins source strings, so
a reflow or rename breaks it without a behavior change — the same trade the
design-token tests make.

### Round 22 — the editor's run history keeps up (2026-10-30)

**22A A snapshot that froze.** Opening a routine fetched its ten newest runs
once. The page already subscribed to the task websocket for the global feed,
and Run now already updated that feed, but neither touched the editor's own
list, so a scheduled run that started while the editor stayed open — or a Run
now pressed on the card beside it — did not appear until the editor was
reopened. The data was already arriving; nothing folded it in.

**22B Two merges and an explicit boundary.** `foldRoutineRun` is the live
merge: a known id is replaced in place (the same run changing status keeps its
row), an unknown id is placed by its id (a run that started after the fetch
lands at the front; an old run whose read state just changed lands in its
chronological place), an unloaded routine stays unloaded (a push must not
invent a partial history the fetch would then contradict), and the list is
capped at 200 rows. The websocket handler and Run now both call it.
`appendOlderRuns` merges an older page with an id set, because a run that
started while the page was in flight can sit on both sides of the cursor, and
orders the result by id, because the live list may already hold a deeper run
that a push placed at the tail. The cursor is the oldest id the last applied
page returned — kept per routine in `historyCursor`, not read off the list: a
mark-read push for a run below the fetched window would otherwise move the
next request past every run between the two. It is the tasks route's existing
`before` ULID cursor. The route returns a bare array, so a full page is the
only "maybe more" signal: the button appears when the last page was exactly
ten and the list is below the 200-row cap, and disappears when a short or
empty page comes back. `loadOlderHistory` guards against a double click, an
empty cursor (which the daemon reads as "no filter" and would return the
newest page again) and a list already at the cap.

**Verification.** `./scripts/check.sh --all` clean (one earlier run printed
FAIL without naming a package; `go test ./...` and two full reruns were clean,
so it is recorded as a load flake); 26 mutants red — the fold's
undefined guard, chronological placement and cap, the older page's dedupe, id
ordering and cap, both read-reconciliation branches, both live folds
(websocket and Run now), the initial page size and has-more rule, both
boundary recordings and the state cursor, the cap at the button and at the
fetch, both reconciliations at the page level, the older cursor, the older
merge, the newest-wins guard, its position after the await and the writes
behind it, the older
has-more, the button gate, and openEdit's load. Review found two majors in the
first version, both in the older-page path: a page that was already in flight
when Mark all read landed appended unread rows over a read badge, and a late
older page could be appended to a list a re-open had replaced. The fixes are
`reconcileRoutineReads`, used by both fetches, and the same `historySeq`
newest-wins guard the initial load already had. A second pass found one more
major introduced by the first fix: folding an old run at the tail moved the
cursor (then derived from the list) below the fetched boundary, skipping every
run between the two on the next page; the explicit `historyCursor` state and
the id-ordered append are that fix. Nits fixed in the same pass: an old run
marked read now lands in its chronological place instead of above newer rows,
the list is bounded at 200 rows on both growth paths (and paging stops at the
cap), the button moved inside the scroll box, and the wiring test gained pins
for the branch order, the guards and their position, the boundary recordings
and the cap.

**Not done.** A push that lands while a fetch is in flight can still be lost:
the fetch snapshot may predate the run, and for a first open there is no list
to fold into. Closing it needs a per-routine buffer of updates received during
the fetch; the window is one request. "More" is inferred from a full page, so a
routine with exactly ten runs offers a button that returns nothing once. At
the 200-row cap the oldest rows are dropped — by design, but a live run on an
already-full list trims a row the reader may not have scrolled to yet. The
list has no jump-to-run or link per row, no date filter, and pages only
backwards. A live update for a routine whose editor is closed reaches the
global feed only, which is the intended split. The global feed's own Run now
prepend is still unconditional (pre-existing): if the websocket echo wins the
race with the HTTP response, the feed can hold two rows for one run until the
next full load. The new fold dedupes the editor's list, not that feed.

### Round 23 — the composer's `/` is a prompt picker (2026-10-30)

**23A A menu that promised nothing.** Typing `/` in a session's composer
opened a panel with two lines: "/ actions" and a hint about delegation. There
were no actions, no shortcuts, and Enter sent the slash to the agent — a panel
shaped like a menu and behaving like a label. Roles (the saved prompt prefixes)
already existed and the new-chat page already offered them, but mid-session
they were unreachable, which is where a saved instruction is worth the most:
the follow-up that needs "review as a security engineer" is written in the
composer, not in a new chat.

The menu now lists them. `filterRoles` narrows on the name and on the prompt's
own text, because the reader remembers "the security one" more often than what
they named it; each row is the name over the prompt's first non-empty line, so
what a pick will write is visible before the pick. A pick runs the same
`insertRole` the new-chat picker runs and writes the role's text into the
draft; the draft stays editable and the transcript shows exactly what the agent
was told. The menu opens only while the whole draft is one leading slash token,
and closes on whitespace: "/usr/bin" is a path and a space means prose. While a
row is highlighted the menu owns Enter and Tab (pick, not send — sending "/rev"
to the agent was never what the menu looked like it would do); Escape closes it
and leaves the token for the next Enter to send. With no roles saved, or no
match, the menu says so and Enter sends the token: a dead key on a daemon with
no roles would be worse than the label this replaced.

The keyup handler needed a real fix for Escape. It re-read the draft after
every key to re-evaluate the caret, and with the menu just closed by keydown,
the draft still started with `/rev` — so the menu reopened a frame later. A
menu-owned keydown now records its key through `consume()`, and that key's
keyup is not a reason to re-read the draft. Without it, a pick whose prompt is
itself a token (`/compact`) would reopen the menu on the keyup of the very
Enter that picked it. Escape also records the draft it declined: the keyup
after a caret move reads the same value, and re-reading it must not ask the
question the person already answered. A value change clears the record and
asks again; sending clears it with the rest of the draft. The mention menu had
the same latent reopen; the consumed-key rule fixes it by the same line.

A keydown with `isComposing` is now left alone entirely. A menu that owns Enter
would otherwise pick a row while an IME was still composing — and the
Enter-to-send path behind it would send half a sentence. The mention menu had
the same exposure; the guard sits above both.

**23B One read for every pane.** The session host keeps up to eight session
panes mounted, and each has a composer. Reading the roles per composer would be
up to eight settings fetches at app start for one list that only changes on
another route. `TaskSessionHost` reads them once with `useAgentRoles` and
threads the list through `TaskDetailPage` into the composer; the page takes an
optional prop, so a page rendered without the host still works and simply has
no shortcuts. The imported-session page has the same composer as its continue
box and reads the list itself, because it mounts on its own route — without it
that box's `/` menu would claim there are no saved roles. The host stays
mounted across routes, so a role saved on the settings page would not reach it
until a reload: the save dispatches `kin:roles-changed` after the write and the
hook reads again. A failed re-read leaves the list that is already on screen —
an unreachable daemon is not an empty list. The settings page's own copy now
says a role is reachable both from a new chat and from any session's `/` menu,
in both locales.

**Verification.** `./scripts/check.sh` clean (whole UI suite green, including 27
composer menu cases, seven hook cases, five filter cases and five source pins);
48 mutants red — 31 for the feature: the query trim, name-only matching, case-sensitive names, an empty query
returning nothing, returning the caller's array, the listener registration and
its removal, reading the wrong settings key, a slash token with spaces in it,
an ignored query, Enter sending instead of picking, Tab not picking, the
upward wrap, the reset on a new query, the clamp when the list shrinks, a pick
that leaves the token, a pick that leaves the menu open, a pick that does not
notify the draft owner, Escape reopening on keyup, the IME guard, the no-roles
copy, the highlight marker, Enter always picking the first row, the preview
line, the legend with no rows, the caret returning to the draft, the host's
prop, the page's prop, the imported session's read and its prop, and the save's
announcement; and eight for the review fixes: the new-chat composer's prop, the
consumed-key record, its keyup guard, the Escape dismissal itself, sending
clearing it, a replaced draft closing the menu, the read sequence, and the tip
with no rows; and nine for the second review: the emptied draft's dismissal,
the unknown list at the hook and at the menu, a stale menu on a different
external token, the echo that keeps it open, the key-repeat guard, the
modified-Enter guard, the prompt's own case folding, and the downward wrap.
Two mutants survived the first pass
and both were the tests' fault, not the code's: the name-matching mutant was
masked by a prompt that repeated the name, and the clamp had no test where the
list shrank without the query changing (a live save does exactly that). Both
gaps were closed with tests that distinguish the two paths. A third survived
the second pass for the same reason: typing `/rev` clears the dismissal at its
first keystroke, so only a single change — a paste — can land on the declined
value again; the test pastes. Two more survived while the second review's
fixes were being pinned, both again the tests': a `SECURITY` query cannot test
the prompt's case folding, because the query is lowercased before matching —
a capitalized prompt word queried in lowercase does — and clearing the draft
on Enter's keyup had been masking the submit path's own clear, so that test
now submits the form directly.

**Review.** Two same-model passes. The first found one major — the new-chat
page's composer had no `roles`, so the page that already read the list for its
Role row showed "No saved roles yet" over a non-empty list — and eight nits.
That major and seven nits are fixed in this round: the consumed-key
generalization, Escape's sticky dismissal, a stale menu closed when the draft
is replaced from outside, the read-sequence guard, the corrected settings path
in the empty copy, the footer tip gated on rows, and a wrong doc comment. The
eighth — `aria-expanded` / `aria-controls` / `aria-activedescendant` on the
textarea — is deferred: the mention menu has the same gap, so it is a shared
accessibility item rather than a regression from this change.

The second pass found no blocker or major, and verified that the two menus
cannot both match one draft: a slash token has no whitespace and a mention
token needs the start of the draft or a space before its `@`, so a draft
starting with `/` never matches the mention rule. Its five nits are all fixed:
an emptied draft now forgets Escape's dismissal, so a token pasted into an
empty box is a new question; the list is `null` until the daemon answers, and
the menu says "Saved roles are unavailable right now" rather than claiming
none exist; an external replacement to a different token closes the menu
instead of keeping a filter for text it never saw; the mention half of the same
effect follows the same close-on-change rule, with an identical echo keeping
either menu open — what the task page's saved-draft re-read needs; and a held
Enter no longer sends the prompt its first keydown just picked. Three test gaps
closed with them: the echo, a capitalized prompt word queried in lowercase, and
the downward wrap plus Shift+Enter. Four limits are recorded rather than fixed:
`kin:roles-changed` is same-document, so a role saved from the phone is
invisible to a session host that stays mounted until reload; `roles` is
optional with a `[]` default, so a fourth call site that forgets it would fall
back to the false empty state (source pins cover the present three); the
settings save re-reads settings although its response already carries the
roles; and a held ArrowDown released after Escape can still reopen the mention
menu (pre-existing, needs a chord).

**Not done.** The menu only opens when the entire draft is one slash token, so
a role cannot be inserted mid-message or into a draft that already has text —
the new-chat picker remains the only way to combine a role with text typed
first, and it writes the role at the top. No ranking: matches come back in list
order, not by relevance, and there is no fuzzy matching, no recent-use order
and no per-role availability or dependency check (Lody has the last one, with
project/machine/provider reasons). No emoji or description column, and no
built-in slash commands — `/clear` and the like still have no equivalent, which
is a separate feature from saved prompts. The menu does not say where roles are
edited beyond the one line in the empty state.

### Round 24 — a screenshot and a CSV open as themselves (2026-10-30)

**24A The file API only spoke text.** The workspace panel could open a file only
by asking for it as UTF-8: `ReadLiveFile` rejects anything that is not valid
text, and the endpoint answered 400 for a PNG. So the two files an agent most
often leaves behind for a person to look at — a screenshot it took, a CSV it
exported — opened to a refusal, and a binary opened to an error that said
nothing about what the file was. `raw=1` on both file routes now answers with
the bytes: the same route, the same scope check and the same traversal and
symlink guards, under a 4 MiB cap (`rawFileLimit`, matching the git runner's
stdout cap so a snapshot read and a live read refuse the same file at the same
size). The text read keeps its 1 MiB cap and its UTF-8 rule untouched.

The response says what the bytes are from the extension and nothing else.
Sniffing would let a workspace file call itself `text/html` and run as a page on
the daemon's origin, so the type is an allowlist: png/jpg/jpeg/gif/webp/bmp/ico/
avif are drawn inline; pdf is an attachment; everything else is
`application/octet-stream` and an attachment. SVG is deliberately absent — it is
text, the code viewer already shows it, and as a document it can carry script.
`X-Content-Type-Options: nosniff` stops the browser second-guessing the declared
type, `Cache-Control: no-store` keeps yesterday's screenshot from outliving the
file it came from, and `mime.FormatMediaType` quotes the filename where it has
to. A remote workspace answers 501 for the raw read: the bytes are on the other
machine and the worker protocol carries text, not arbitrary data.

**24A′ A download is not a preview.** The first cut made the download fallback
re-issue `raw=1`, so a refusal was saved under the file's name — a remote
workspace wrote its 501 JSON to `shot.png`, and a 5 MiB screenshot wrote a 400
JSON to `shot.png` too. `download=1` is now its own answer. A live file is
opened with `Manager.OpenLiveFile` and streamed through `http.ServeContent`
with an always-attachment disposition: no cap, because the cap exists to keep a
mislabeled archive out of the daemon's memory, not to refuse the recording the
person asked to save. Snapshot sides are read out of git into memory and keep
the 4 MiB cap; their download is still an attachment. `openLiveFile` is shared
by the capped read and the streaming open, so containment (rooted open,
regular-file check, symlink escape) is one implementation, and
`fileResponseHeaders`/`writeFileBytes` keep both answers on one set of headers.
The remote workspace answers 501 for the download as well.

**24B The viewer chooses by name.** `previewKind` classifies a file as image,
table, binary or text from its extension, with the image list kept in step with
the daemon's allowlist and Office documents (doc/docx/xls/xlsx/ppt/pptx) on the
binary side. An image is no longer read as text at all. The panel fetches bytes
with `fetchFileBytes`, which sends the token in a header — never in the URL —
and throws the daemon's `ApiError`; the blob is drawn through an object URL that
is revoked when the file changes or the panel unmounts. The wait is announced
(`role=status`), and a failure shows the daemon's own sentence (`role=alert`)
with the download beside it, which is a different route and can still succeed
where the preview could not. A binary formats the same way without a text read
at all. The download fetches `download=1`, saves the blob under the file's own
name, and a failed download reports the daemon's message on screen instead of
saving the refusal. CSV and TSV are read as text, because they are text, and
laid out by a bounded parser: quotes may wrap a field carrying the delimiter or
a newline, a doubled quote is one quote, an unclosed quote keeps what was
written, and the table stops at 200 rows by 30 columns with a caption that says
it did. A read that was itself truncated — a remote worker caps at 128 KiB — is
called out separately, because a short table that hides that lies about the
data. The first row is the header. A "Code" switch hands the file back to the
editor, which is where a writable generation can still edit it and where its
exact quoting is visible. Everything else — SVG and files with no extension
included — goes to the code viewer exactly as before.

**Verification.** `./scripts/check.sh --all` clean (whole UI suite green,
including 20 parser/kind/error-message/base-name cases, 16 panel preview cases,
two byte-URL cases and three byte-fetch cases; the backend suite green,
including 12 new Go test functions and 31 cases counting subtests). 39 mutants
red, all byte-for-byte restored: the live and source raw reads falling back to
the text reader, the base snapshot raw read asking for the final tree, nosniff
dropped, the cache header made long-lived, SVG admitted inline, unknown types
admitted inline, the remote refusal removed for both raw and download, `raw`
ignored on the workspace route, a live download served by the capped preview
reader, the source download not streamed, a download drawn inline, a snapshot
download drawn inline, a snapshot download losing to raw, a snapshot download
taking the text path, the download path accepting a directory, the preview read
using the text cap, the panel reading an image as text, the panel drawing the
editor where the image belongs, a binary file keeping the previous file's
download state, reopening an image not fetching it again, images removed from
`previewKind`, SVG added to it, quoted fields read without their quotes, the
row bound off by one, a saved file named after its whole Windows path, the
parser's truncation caption removed, a truncated read shown as a complete
table, the download route asking for a preview, a failed download with nothing
to say, the saved file named for its path, a failed image not announced, the
byte fetch returning an empty body, the byte fetch forgetting the token, a page
answered with 200 saved as the file, a text error page answered with 200 saved
as the file, a final snapshot download losing to raw, and the byte URL asking
the text route.
Two fixtures had to be fixed before they could catch anything: the snapshot
test first committed one image and read both sides from it, so a mutant that
answered the base side with the final tree passed, and the traversal case
pointed at a file that did not exist beside the root, so a naive join would
have found nothing. The fixtures now edit the image between the two commits and
put the leaked file in the root's real parent.

The first review found two majors the implementation then fixed: a download
fallback that saved the daemon's refusal under the file's name (fixed by the
`download=1` streaming route and fetch-based saving, which reports the refusal
instead), and a table that dropped the read's truncation flag (fixed by
`tableIncomplete`). The second review found no blockers and one further major —
the download button's busy/error state survived a switch between two binary
files — fixed by keying the previews by path and fetch generation, with a
two-binary regression test. A third review found no blockers and no majors; its
nits were fixed in the same pass — the 200 guard widened from `text/html` to all
of `text/*` and `application/problem+json`, `rawFileLimit` defined from the git
runner's stdout cap instead of restating its number, the changed-files bar
reusing `fileBaseName`, the OpenAPI document finally naming `raw`, `download`
and `side` on the workspace file route (with its generated types), a fresh
`Response` per case in the byte-fetch test, and a final-side `raw=1&download=1`
assertion. Two nits were left as notes: the image allowlist is duplicated
between Go and TypeScript with tests on both sides rather than generated from
one source, and `DownloadButton` still calls `setState` after unmount, which
React ignores and which does not stop the save the person asked for. Each
review ran on the same model as the implementation; every fix was red-verified
with `./scripts/mutants.py`.

**Review.** REVIEWED — three same-model passes. Pass 1: no blockers, two majors
(the download fallback saving refusals; the table dropping the read's
truncation), both fixed. Pass 2: no blockers, one major (a binary file
inheriting the previous file's download state), fixed with keyed previews and
the fetch nonce; `web/dist/index.html` confirmed as a landing step. Pass 3: no
blockers, no majors; eight nits, six fixed and two noted. The remote 501 is
still an English sentence from the daemon, restated as residual risk.

**Not done.** Office documents are a download, not a rendered preview, and a PDF
opens in the browser's own viewer only after the download the attachment
disposition asks for. An unknown binary extension still goes through the text
read and shows its refusal instead of offering the download; the list of binary
extensions is a heuristic, and `.dat` was deliberately left on the text side
because it is as often text as not. The table has no sorting, filtering, column
sizing or type inference, and a quoted field that starts after leading spaces is
read as unquoted (RFC 4180 does not allow those spaces either). Images cannot be
zoomed or panned, and there is no "open in a new tab". The download is fetched
into a blob before it is saved, which browsers back with disk but which is not
the streaming path a native download link takes, and the raw cap is a constant,
not a setting. A workspace on another machine still cannot preview or download
an image at all (501), because the worker protocol carries text only.

### Round 25 — the file panel finds its workspace (2026-10-30)

**25A Every generation route answered "workspace not found".** Found while
walking Round 24 on the desktop shell: opening the files panel for a task with
an active generation showed the words `workspace not found` where the file list
belongs, at both widths, and Round 24's image and table never got a chance to
run there because the requests behind them had already 404'd.

The cause was a contract mismatch, not a missing row. A generation id is
`<taskULID>:g<N>`, and the console builds API paths with `encodeURIComponent` —
correct encoding for a path segment, and it turns the colon into `%3A`. chi v5
matches routes against the request's escaped path, so `chi.URLParam` hands the
handler the matched text with its escapes intact, and the handler passed
`01ABC…%3Ag1` to `Store.GetWorkspace`, which knows only `01ABC…:g1`. All four
generation-scoped routes were affected — tree, file read, file write, diff —
which is the whole generation lens of the panel, and with it Round 24's
`raw=1` preview and `download=1` save inside a generation. Source-root tasks
were untouched: `/source/...` carries no workspace id, and a task without a
generation opens straight to the source view, which is why the panel looked
healthy on probe tasks and in every test that mocked the client.

One helper, `workspaceIDParam`, decodes the parameter with `url.PathUnescape`
and falls back to the raw value when it is not a valid escape sequence.
`PathUnescape` and not `QueryUnescape`: the former leaves `+` alone, the latter
would turn it into a space. An id that arrives still encoded twice (`%253A`)
decodes twice and names the same row; ids are generated and never contain a
literal `%`, so the leniency cannot reach a row the client did not mean. The
decoded value only ever selects a database row — every filesystem path still
comes from the row's own columns and keeps its `os.OpenRoot` containment — so a
hostile `%2F..%2F` id can only fail to match.

The fix is on the server on purpose. Percent-encoding a path segment is what a
standards-compliant client does; accepting it is the server's job, and doing it
here covers the Hub proxy and any future client that encodes the same way.

**Verification.** `TestWorkspaceRoutesResolveAPercentEncodedID` drives the real
router with `%3A` ids through tree, file read, diff and file write, asserts the
diff carries its live change list, and pins the cross-task ownership check; it
failed on all four positive cases before the fix and passes after. 5 mutants
red before and after the test rewrite — the helper stops decoding, and each of
the four handlers stops using it. `./scripts/check.sh --all` ran clean on the
code before the test rewrite; the rewrite itself (test file only, plus one
comment) passed a full `./scripts/check.sh` afterwards. Live on the rebuilt
node: the escaped tree answered 200 with the file list and the diff 200; the
panel opened on `工作区 1 活跃` with its three changes, and a PNG drew inline and
a CSV laid out as a table through the generation's `raw=1` route at 1280 and at
390. The demo files were removed from the generation worktree afterwards.

**Review.** REVIEWED — one same-model pass plus a confirmation. No blockers and
no majors. Four nits, all fixed: the double-decode leniency is now documented in
the helper rather than gated on `RawPath` (gating would 404 an over-encoded id
the store can still resolve); `requireGitBin` now gates only the diff subtest,
so tree/file/write stay covered on a machine without git; the diff subtest
leaves one untracked file and asserts the live view with exactly one change
instead of a bare 200; and a cross-task subtest pins the ownership check. The
confirmation pass re-ran the focused test and a per-route mutation with
`-overlay` and found nothing new. It also caught a stale index — the staged
test was pre-rewrite — which was restaged before the commit.

**Not done.** A released-and-pruned generation still answers "workspace not
found": true, but flat — the panel could say the generation was released and
offer the source view. The decode is a per-route helper, not a router-wide rule;
every other path parameter is a ULID or a hex token that cannot carry an
encodable character, and a blanket decode would hide the next id that grows a
`:` rather than name it. The over-encoded `%253A` form is accepted rather than
refused, as noted above.

### Round 26 — the phone list can delete (2026-10-30)

**26A The list could not delete a conversation.** A session could be deleted
from inside the session, but the phone list — where old chats are scanned and
discarded — offered only pin and archive behind a swipe. The row now slides
open on three 76px chips (pin/unpin, archive, delete), and the delete runs the
same `DELETE /api/tasks/{id}` plus `task_deleted` broadcast every other delete
uses, through one `useSessionDeletion` hook: the canonical `task.deleteConfirm`
/ `task.deleted` copy, and a row that disappears from the list, from the session
scroll memory, from its unsent follow-up draft, and from the pin preference.

The long-press selection that already carried pin and archive gains delete too.
One confirm for N rows, then `Promise.allSettled`: only fulfilled ids are
forgotten, failures stay selected (rebuilding a selection to retry is the
destructive action that did nothing), and the toast separates deleted from
failed (`sessions.deletedCount` / `sessions.deleteFailedCount`). A re-entry ref
refuses a second batch while one is in flight; row taps are locked and the chip
is disabled until it lands; an epoch bump on `[query, status]` and on exiting
the selection means a slow batch cannot resurrect a selection the person has
since filtered away, and selected ids with no surviving row are pruned.

**26B Every tap inside a swipe row landed on the wrapper.** Found by clicking
it, not by reading it: a real browser click on a revealed chip and on a normal
row both did nothing, while every DOM test passed. `setPointerCapture` on
`pointerdown` retargets the following `pointerup` — and, per the pointer-events
specification, the `click` derived from it — to the capturing wrapper, so row
navigation and every action chip were dead inside the wrapper (touch pointers
capture implicitly, so this was true on the phone, not just in Playwright).
Pre-existing since the wrapper landed. jsdom does not retarget clicks, which is
why four class-and-handler tests never saw it.

Capture now starts only once a drag actually moves past the tolerance, which is
the only gesture that needs moves after the pointer leaves the row; the
click-swallow is armed only for a released drag or a fired long press, and a
fresh `pointerdown` clears it. Four gesture tests pin the behaviour: a tap
leaves the click to the inner button and captures nothing, a drag captures on
its first move, a drag-ending click and a long-press-ending click are both
swallowed. Each has a mutant that turns it red.

**Verification.** `./scripts/check.sh` clean on every step (10 jobs). 17
mutants, all red, each file restored byte for byte. Vitest: the hook (8 cases,
partial and total failure included), the chips, the gestures, and source-wiring
assertions for the page-level contract. Live on the rebuilt node at 390×844:
the row reveals three 76px chips at `translateX(-228px)`; a real Playwright
click on the delete chip accepts the confirm, the row leaves, the `会话已删除`
toast shows, and `GET /api/tasks/<id>` answers 404; a batch of two reports a
deleted count; a real row tap navigates to `/tasks/<id>` after 26B; the toolbar
fits at 390 (icon-only) and 1280 (labeled). The first live attempt clicked
nothing because the hidden desktop close button carries the same title in
`关闭 <title>` and came first in the DOM — the phone row needs `aria-label^=`.

**Review.** REVIEWED — the first pass found 3 majors (a fully failed batch lost
the selection it needed for a retry; no in-flight guard on the batch; the
console embed not rebuilt) and 13 nits. All majors and nits 1–4, 8, 9 and 13
fixed and red-verified. The second pass reported no blocker or major and 6
nits: 1–4 fixed in the same pass; 5 (a progress cue during a long batch) and 6
(`会话`/`对话` terminology) deferred with rationale.

**Not done.** The archived view shows no row actions: pin would move a row into
a list it is not in, and archive would be a no-op. Delete on a running task
cancels it first (server behaviour, pre-existing); the confirm says history
cannot be recovered but not that a live run stops, and a destructive-copy
change was out of scope. Keyboard focus after a deleted row falls to `body`.
`DELETE /api/tasks/{id}` is operator-only, so a pairing-token console would get
403. The list tab says 会话 while the product elsewhere says 对话.
