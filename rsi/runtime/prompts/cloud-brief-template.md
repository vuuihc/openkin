# Cloud brief template (director fills every <...>; the file must be fully self-contained: the cloud agent has NO access to this Mac, the rsi/ folder, or any state dir)

# <ITEM ID>: <slice title>   (slug: <slug>)

## Repo and branch
- Repo: https://github.com/vuuihc/openkin (public). Base: `main` (fetch first). Work on branch `rsi/<slug>` (create it from current origin/main).
- Open the PR to `vuuihc/openkin`, base `main`, head `rsi/<slug>`. Do NOT merge it, do NOT force-push, do NOT push to main, do NOT touch other branches. An automated merge lane gates, reviews (another model) and squash-merges; it may push sync-merge commits or rework requests to your branch, so keep it pushable.
- The PR body MUST contain: a line `RSI item: <ITEM ID>`; sections Summary / What the user sees now / Tests (names + results) / Risk; and `Screenshots:` with image links for 390x844 and 1100x760 before/after, OR `Screenshots: none: <reason nothing is visible>`.

## Goal (user terms)
<2-4 sentences>

## Read first (in the repo)
AGENTS.md, docs/product/TASTE.md, docs/product/IA.md, docs/plans/2026-11-14-ux-unification.md, rsi/ASTRYX-PLAN.md (slice context), <sibling files that already do it right>.

## Files you may change (this is the footprint other agents are kept away from; stay inside it)
<paths>   (plus the generated `web/dist/index.html` if you run the UI build; nothing else)

## Acceptance (write these tests FIRST, see them fail, then make them pass)
<test names / behaviours>

## Constraints
- <=800 changed lines excluding lockfile and web/dist/index.html. Split rather than exceed; say what remains in the PR body.
- **Format only the files you changed**: `./rsi/runtime/format-changed.sh --write` (then `--check`). That script exists on `main`; there is no `scripts/format-changed.sh`. Never run a repo-wide `prettier --write .` or `gofmt -w ./...`: it turns a 600-line slice into a 1,500-line diff and the PR is sent back for churn, not for scope. Check `git diff --numstat origin/main | awk '$1+$2>0'` before pushing — the file count should match the slice's footprint.
- No new dependencies, no ui/package.json / go.mod / migrations / auth changes (unless the item id is F1-F3). No secrets, no personal paths/emails in code, tests, docs or the PR (public repo).
- UI inventory ratchet: `python3 scripts/check-ui-inventory.py` must not grow; a facade/primitive slice that must add its own raw `<button>`/portal/dialog runs `--update` and says so in the PR body. Migration slices should lower the baseline in the same PR.
- Run before pushing: `cd ui && npx vitest run <your tests> src/design/tokens.test.ts`, `./scripts/check.sh`, `cd ui && npm run build` (commit the regenerated web/dist/index.html only).
- Conventional Commits. Match existing style; follow TASTE rules (one-line list rows, no cards-in-cards, focus ring via the design token).

## Done means
PR open against vuuihc/openkin main, CI started, the PR body complete as above. Then stop.
