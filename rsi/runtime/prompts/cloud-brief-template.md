# Cloud brief template (director fills every <...>; the file must be fully self-contained: the cloud agent has NO access to this Mac, the rsi/ folder, or any state dir)

# <ITEM ID>: <slice title>   (slug: <slug>)

## Repo and branch
- Repo: https://github.com/vuuihc/openkin (public). Base: `main` (fetch first). Work on branch `rsi/<slug>` (create it from current origin/main).
- Open the PR to `vuuihc/openkin`, base `main`, head `rsi/<slug>`. Do NOT merge it, do NOT force-push, do NOT push to main, do NOT touch other branches. An automated merge lane gates, reviews (another model) and squash-merges; it may push sync-merge commits or rework requests to your branch, so keep it pushable.
- The PR body MUST contain: a line `RSI item: <ITEM ID>`; sections Summary / What the user sees now / Tests (names + results) / Risk; and `Screenshots:` with image links for 390x844, 820x1180 and 1100x760 before/after, OR `Screenshots: none: <reason nothing is visible>`.
- If the deliverable is a sentence rather than behaviour (a `GOAL`, an ADR, a `PLAN`, a `README` or a story contract), the PR body names the exact `path:line` the sentence asserts and carries one `Claim check:` line at column 0 with a command, plus its real output under `Claim output:`. Run the same rule yourself before you finish — save the body to `/tmp/body.md`, then:
  ```
  git diff --no-renames --raw origin/main...HEAD | awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}' > /tmp/changed
  python3 rsi/runtime/claim_check.py . /tmp/body.md /tmp/changed
  ```
  Do not finish until it prints `CLAIM_OK`, `CLAIM_NA` (code-only diff) or `CLAIM_WAIVED`. A missing, false or unverifiable claim is not delivery: the NAS ingest now holds the job before any PR exists, and the merge lane sends it back. On a docs row the claim command is a source pin (`rg -n '<sentence fragment>' <path>`), never a test suite — a browser-bound or flaky suite fails the claim for the wrong reason.

## Goal (user terms)
<2-4 sentences>

## Read first (in the repo)
AGENTS.md, docs/product/TASTE.md, docs/product/IA.md, docs/plans/2026-11-14-ux-unification.md, rsi/ASTRYX-PLAN.md (slice context), <sibling files that already do it right>.

## Files you may change (this is the footprint other agents are kept away from; stay inside it)
<paths>   (plus the generated `web/dist/index.html` if you run the UI build; nothing else)

## Acceptance (write these tests FIRST, see them fail, then make them pass)
<test names / behaviours>

## Constraints
- Target ≤800 changed lines, hard cap 1000 — measure with `bash rsi/runtime/diff-size.sh .` (the same count the merge lane enforces: excludes lockfiles and web/dist/index.html). Split rather than exceed; say what remains in the PR body.
- **Format only the files you changed**: `./rsi/runtime/format-changed.sh --write` (then `--check`). That script exists on `main`; there is no `scripts/format-changed.sh`. Never run a repo-wide `prettier --write .` or `gofmt -w ./...`: it turns a 600-line slice into a 1,500-line diff and the PR is sent back for churn, not for scope. Check `git diff --numstat origin/main | awk '$1+$2>0'` before pushing — the file count should match the slice's footprint.
- No new dependencies, no ui/package.json / go.mod / migrations / auth changes (unless the item id is F1-F3). No secrets, no personal paths/emails in code, tests, docs or the PR (public repo).
- UI inventory ratchet: `python3 scripts/check-ui-inventory.py` must not grow; a facade/primitive slice that must add its own raw `<button>`/portal/dialog runs `--update` and says so in the PR body. Migration slices should lower the baseline in the same PR.
- Run before pushing: the focused suites that exist on the machine you are on — `cd ui && npx vitest run <your tests> src/design/tokens.test.ts`, plus `cd ui && npm run build` (commit the regenerated web/dist/index.html only) when `ui/` changed; add `go test` for the packages you touched only where a Go toolchain exists. The Mac merge gate runs the full `check.sh` and an independent review after you push; the NAS worker container has no Go toolchain, so `go test` and `check.sh` are not expected there. Say in the PR body which commands you ran.
- Conventional Commits. Match existing style; follow TASTE rules (one-line list rows, no cards-in-cards, focus ring via the design token).

## Done means
PR open against vuuihc/openkin main, CI started, the PR body complete as above. Then stop.
