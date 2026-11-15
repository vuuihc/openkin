# ASTRYX-PLAN — the UX unification as lane-sized slices

Source of truth for *what* is built: `docs/plans/2026-11-14-ux-unification.md` (Batches A–E, Goal 2), `docs/plans/2026-11-09-astryx-spike.md`, `docs/product/stories/KIN-CONTINUE-003.md` + `ux-unification-story-map.md` (all on `origin/main`; no unpushed local-main docs are needed).
Source of truth for *what to run next*: `rsi/astryx-slices.json` (54 slices + the in-flight Q3a), scheduled by `rsi/runtime/slices.py ready`. A slice is done when its id shows up in `state/merged.log` (the merge lane writes it).
Ethan's directive (2026-11-15): this programme is the top priority; bug-fix pacing is parked (P0 only). KIN-CONTINUE-003 stays treated as signed (DECISIONS 2026-11-15).

## Facts from the code (2026-11-15)
- Astryx is **not** a dependency yet. `ui/` is React 18.3, Tailwind 3.4, Vite 6, Vitest 4. Spike: React 19 builds (1 real type error), Astryx 0.7.11 + StyleX builds, +84 kB raw / +25 kB gzip, theme maps in ~20 lines.
- Only structural blocker: Tailwind 3 preflight is unlayered and strips Astryx's `@layer` styles → upgrade to Tailwind 4 with an explicit layer order. Cost is in the test tooling (`tokens.test.ts`, `tailwind.test.ts` use the v3 API) and in auditing unlayered rules in `index.css`.
- Scale: 95 non-test TSX, 299 raw `<button>` in 68 files, 5 shared controls. Giants: TaskDetailPage 2380, SessionList 2020, AgentsPage 1998, RoutinesPage 1911, ChatStream 1608, ProjectDetailPage 1430, Composer 1174, RunConfigSheet 1032.
- Q3a (PR #59, in flight) already gives Kin-owned `Button`/`Popover` with the final API; F5a/F5b re-base them on Astryx instead of keeping two systems.

## Strategy
1. **Direct merges to main, no integration branch, no feature flag.** Every slice is behaviour-preserving or red-test-first and passes the full gate + independent review + CI. A long-lived branch would only add a giant conflict at the end and starve the merge lane's gate; the facade means call sites migrate one file-group at a time while old and new controls coexist.
2. **Facade first, then call sites.** Kin owns the component API; Astryx is the implementation behind it (the plan forbids a parallel hand-built system).
3. **Decompose the giants while the foundation lands.** T*/L*/R*/P1/E4a are pure extractions with no Astryx dependency, so lanes are never idle during the serial F1→F2→F3 chain. Slices that touch the same file are chained by `deps`, and every slice declares its paths; `lanes.py claim` refuses overlap.
4. **Navigation logic is independent of Astryx** (N1–N4: area table, routes/redirects, phone stacks, `operations` settings tab) and runs next to the foundation.
5. Gates unchanged (gate.sh, review by a different model, CI, ratchet). Ratchet counts may only go down; a facade slice that must add its own raw element updates the baseline deliberately. Size per slice ~45 min, ≲ 800 changed lines (cap 1000).

## Phases, slices, dependencies
Sizes: M ≈ 30 min / ≤ 500 lines, L ≈ 45 min / ≤ 800 lines.

| Phase | Slices (deps) | Notes |
|---|---|---|
| **0 Foundation** (serial) | F1 Tailwind 4 + layer order + token test port (—) → F2 React 19 (F1) → F3 Astryx dep + Provider + full token map + 44px/reduced-motion (F2) → F4 gallery (F3) | critical path; only one F slice at a time (lockfile). MANDATE exception for package.json recorded |
| **1 Facade** (parallel after F3) | F5a Button/TextInput/Textarea/Field (F3,Q3a) · F5b Menu/Popover (F3,Q3a) · F5c Dialog/BottomSheet (F3) · F5e Tabs/Tooltip/Toast (F3) → F5d Select/SearchSelect/SheetSelect (F5b,F5c) | one concern per file group, docs per component |
| **1′ Independent** (starts now) | N1 area model → N2 routes/redirects/notification targets, N3 phone stacks, → N4 `operations` settings tab (N2) · T1→T2→T3 TaskDetail extraction · L1→L2 SessionList extraction · R1→R2 Routines extraction · P1 ProjectDetail extraction · E4a Agents body → settings (N4) | zero visible change; fills lanes during Phase 0 |
| **2 Shell** | S1 Mac four-area nav (N2,F5b) · S2 phone four tabs + per-area stacks (N3,F5c) → S3 transitions + reduced motion (S1,S2) | first visible Astryx-era change |
| **3 Conversation** (Batch C) | C1a/C1b pickers (F5b,F5d) · C1c RunConfigSheet (F5c,F5d) → C1d Composer bottom row (C1a,C1c) → C2 NewChatPage (C1d,S2) · C3a TaskDetail header/panels (T2,F5*) → C3b conversation host (T3,C1d) · C4a ChatStream controls · C4b approval cards · C5a rows (L1) · C5b scope filter (L2,F5e,N1) → C5c sessions page (C5a,C5b,S2) · W1 workspace · W2 terminal/publish/share | the dogfood path; Composer bottom row lands at C1d |
| **4 Projects & routines** (Batch D) | P2 projects collection (P1,N2,S1,S2,F5a) · P3 ProjectDetail facade (P1) · R3 routine list/runs (R2) · R4 routine editor (R1,F5d) | |
| **5 Settings & agents** (Batch E) | E1 settings page (N4,F5a,F5d) → E2 sections, E3 routing · E4b→E4c agent operations (E4a) · E5 agent session/approvals/tray · E6 account/connect | |
| **6 Close-out** (Goal 2) | G1 lint-ban legacy primitives + lower baseline (C3b,C5c,E4c,R4,P3,W2) · G2 docs (S3) · G3 journeys J1–J7 smoke at 390/1100/1280 (S3,C2,C5c) → G4 bundle/inventory report + acceptance note (G1,G3) | Ethan's single acceptance walk-through |

Counts: F 9 · N 4 · S 3 · X (extractions) 9 · C 14 · D 4 · E 7 · G 4 = **54 slices**.
Critical path: F1→F2→F3→F5b→F5d→C1a→C1d→C2/C3b→G3→G4 (≈ 10 sequential merges). Max useful width after F3 ≈ 6–8 ready slices, so 3 lanes stay busy.

## Throughput and ETA (honest)
Measured 2026-11-15 with 2 lanes: ≈ 5–40 min worker run + merge lane ≈ 10 min gate (serialised) + 5–10 min review + 5 min CI; slices needing one rework take ~1.5–2 h from claim to merge; 1 merge per ~1–1.5 h overall so far, improving as the merge lane warms up.
At 3 lanes and ~1.5–2 merges/hour (best realistic): 54 slices ≈ **27–36 h** of wall clock, plus ~10 % for sendbacks. At the observed 1 merge/h it is ≈ 54 h. Estimate for the visible milestones (from now, in order): Mac+phone shell (S1/S2) ≈ 10–14 h; Composer bottom row (C1d) ≈ 12–16 h; conversation path (C3b/C5c) ≈ 20–26 h; everything ≈ 30–40 h. Levers: a pipelined second review worker, larger L slices, relaxing review to delta-only after the first pass.

## Rules that stay
Red lines and merge gate in MANDATE stand. Not in this programme: Go API/DB/agent protocol changes, new product features, theme/brand/font change. A needed change of those → ADR + `needs-ceo.md`, never a silent merge. Desktop is not rebuilt by the loop; Ethan runs `scripts/desktop-rebuild.sh` to see merged work.
