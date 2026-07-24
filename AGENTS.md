# Kin Development Guide

These instructions apply to the entire repository. A more deeply nested
`AGENTS.md` may add or override rules for its subtree.

## Project orientation

- Kin is a Go daemon and CLI with a React/TypeScript console and an Electron
  desktop shell.
- Backend code lives under `cmd/` and `internal/`; console source lives under
  `ui/`; the embedded production console is generated into `web/dist/`.
- Read `PRINCIPLE.md`, `SYSTEM_DESIGN.md`, and relevant ADRs before changing
  product boundaries or persistence models.
- Preserve unrelated working-tree changes. Never reset, overwrite, or silently
  reformat work that is outside the assigned task.
- Prefer existing repo scripts under `scripts/` and Makefile targets over
  inventing ad-hoc shell pipelines. Check `scripts/` and `Makefile` before
  rebuilding, packaging, or restarting local tooling.

## Agent best practices

Industry habits that keep agent-driven changes reviewable and recoverable:

1. **Orient before editing.** Read nearby code, tests, types, and call sites.
   Prefer searching the repo over inventing APIs, paths, or patterns.
2. **Plan, then implement.** For multi-file or cross-layer work, state a short
   plan (goal, files, risks, verification) before writing code. Adjust the plan
   when reality diverges.
3. **Smallest reversible step.** Ship one independently verifiable concern at a
   time (API, storage, UI, docs stay consistent within that concern). Avoid
   speculative abstractions and drive-by cleanups.
3a. **Prompt before product machinery.** For application-layer behavior
   (coaching, wrap-up, memory tidying, cover suggestions), prefer a reviewable
   prompt or in-session flow over hard-coded APIs, tables, state machines, and
   dedicated UI. Hard-code only permission/safety boundaries, durable sources of
   truth, stream/task protocols, and contracts a model cannot reliably guarantee.
   If a feature needs all of schema + REST + special UI to do what a prompt could
   do, stop and simplify. See `PRINCIPLE.md` §5.5 and the technical decision filter.
4. **Tests as the contract.** Add or update tests with behavior changes.
   Reproduce bugs with a failing test when practical; only then fix.
5. **Verify, do not assume.** Run the narrowest relevant checks while iterating,
   then the full applicable suite before handoff. Report any check that could
   not run, with residual risk.
6. **Worktree, gate, then land.** Develop features in a dedicated worktree
   when practical. After checks pass, run the Feature completion gate
   (advanced-model review and fixes, commit, merge to `main`, remove the
   worktree, desktop rebuild)—do not wait for a reminder. Do not commit
   known-failing work unless the user explicitly requests a checkpoint.
7. **Clear commit messages.** Use Conventional Commits that explain *why*, not
   only *what* changed. Prefer:
   - `feat(scope): …` / `fix(scope): …` / `refactor(scope): …` /
     `test(scope): …` / `docs(scope): …` / `chore(scope): …`
   - Subject ≤ ~72 chars, imperative mood (`add`, `fix`, `extract`).
   - Body when non-obvious: motivation, user-visible effect, follow-ups, or
     risks. One logical change per commit; split mixed concerns.
8. **Self-review the diff.** Before committing or declaring done, re-read the
   staged change: correctness, edge cases, secrets, unrelated noise, and
   missing tests or i18n.
9. **Leave the tree intentional.** Prefer a clean working tree at handoff. If
   anything remains uncommitted, list it and why.
10. **Escalate uncertainty.** Ask before destructive ops, public API breaks,
    schema resets, dependency-wide upgrades, network publication, or anything
    that affects external systems. If stuck after a few honest attempts, stop
    and summarize what failed.

## Development workflow

1. Inspect `git status`, nearby code, tests, and repository instructions before
   editing.
2. **Prefer a dedicated Git worktree for development.** For feature work (and
   non-trivial fixes), create or attach to an isolated worktree/branch instead
   of editing the primary `main` checkout directly. Keep unrelated in-progress
   work out of the feature tree. Tiny docs-only or single-file chores may stay
   on the current checkout when a worktree would add more friction than value.
3. Break work into the smallest independently verifiable modules. Keep API,
   storage, UI, and documentation changes consistent with one another.
4. Prefer focused changes over broad cleanup. Do not add speculative
   abstractions or dependencies. Do not hard-code application workflows that a
   prompt + existing agent loop can express more simply (see Agent best
   practices §3a and PRINCIPLE §5.5).
5. Add or update tests with behavior changes. Reproduce bugs with a failing
   test when practical.
6. Run the narrowest relevant checks while iterating, then the full applicable
   verification before completion.
7. After a feature/module is complete and its checks pass, run the **Feature
   completion gate** (high-model `@codex`/`@claude` review → fix until no
   blocker/major issues → commit → merge into `main` → remove the feature
   worktree → `./scripts/desktop-rebuild.sh`). Do not skip review or leave
   finished work only on a side branch. Do not commit known failing work unless
   the user explicitly requests a checkpoint.

## Go conventions

- Follow standard Go style and run `gofmt` on every changed `.go` file.
- Keep packages cohesive and dependencies directed inward. Prefer existing
  interfaces and helpers over parallel implementations.
- Pass `context.Context` through blocking or remote work and honor
  cancellation. Wrap errors with useful operation context and preserve causes.
- Treat filesystem paths, uploaded content, provider responses, and agent
  output as untrusted input. Validate bounds and containment at boundaries.
- Add table-driven unit tests where they improve coverage and readability.

## UI conventions

- Keep TypeScript strict and avoid `any` unless an external boundary makes it
  unavoidable and the value is narrowed immediately.
- Reuse existing components, design tokens, API helpers, and Zustand state
  patterns before introducing new ones.
- All user-visible text must use the i18n layer. Update both English and Chinese
  locale files in the same change.
- Preserve keyboard operation, visible focus, semantic controls, loading,
  empty, error, and disconnected states.
- A UI source change that affects the shipped console must regenerate and
  commit `web/dist/` after `npm run build` succeeds.

## Storage and API changes

- Schema changes require an ordered migration, upgrade coverage, and tests for
  both empty and populated databases.
- Preserve backward-compatible reads when practical; document intentional breaks
  in the change and any ADR.
- Keep HTTP handlers thin: parse and validate input, call domain logic, map
  errors to stable status codes and response shapes.
- Prefer additive API evolution. Version or explicitly document breaking
  response and event contract changes.

## Verification

Run the checks that match the blast radius of the change:

```bash
# Go — package under edit
go test ./internal/<package>/...

# Go — broader backend / race when concurrency is involved
go test ./...
go test -race ./internal/<package>/...
go vet ./...

# Console
cd ui
npm run build

# Whole repository convenience target
make test
```

- Use a focused `go test ./internal/<package> -run <TestName>` during iteration,
  but do not substitute it for the relevant full suite at handoff.
- For visible UI changes, inspect the built interface at representative desktop
  and narrow widths when browser tooling is available.
- Report any check that could not run, including the reason and residual risk.

## Desktop rebuild

When the user asks to rebuild desktop, or after a UI / daemon change needs a
fresh Electron shell:

- **Always use the repo script.** Run `./scripts/desktop-rebuild.sh` or
  `make desktop-rebuild` from the primary checkout. Do **not** hand-roll the
  sequence (UI embed → `kin` binary → kill daemon/Electron → relaunch) as
  separate ad-hoc commands when this script exists.
- The script already: builds Vite UI into `web/dist`, builds `./kin` with the
  new embed, stops anything on `:7777`, stops this repo's Kin/Electron, then
  launches desktop (`npm run dev`).
- Use `make desktop-dev` only when you intentionally want backend + Electron
  without a full UI re-embed cycle (see Makefile comments).
- Use `make desktop-dist` only for packaged `.dmg` under
  `desktop/dist-electron/`.
- Report script failures and residual risk; do not silently fall back to a
  partial manual rebuild unless the script is broken and you are fixing it.

## Feature completion gate

After a **feature or user-visible change set** is implemented and its relevant
checks pass, do **not** stop at self-review. Finish with this gate in order:

1. **High-model automated review.** Invoke a sub-agent with an advanced model
   (`@codex` or `@claude`, preferring the highest available tier such as
   Codex high / Claude Opus-class) to review the full diff and nearby call
   sites. Ask for correctness, regressions, security, missing tests, API/UI
   contract drift, and residual risk. Prefer a structured severity report
   (`blocker` / `major` / `nit`).
2. **Fix review findings.** Address every `blocker` and `major` item. Re-run
   the relevant tests/build. Request another review pass after material fixes.
   Repeat until the latest review reports **no blocker or major issues**.
   Nits may be fixed in the same pass or deferred with an explicit note in the
   commit body / handoff.
3. **Commit.** Create atomic Conventional Commit(s) for the reviewed work (and
   `web/dist/` when the shipped console changed). Do not commit known-failing
   work. Prefer committing **inside the feature worktree** on its branch.
4. **Merge into `main`.** From the primary repository checkout, integrate the
   finished branch into `main` (fast-forward preferred; merge commit when
   needed). Do not leave a completed feature only on a side branch. Push to
   `origin` only when the user or release process requires it; local `main`
   must still contain the merge.
5. **Remove the feature worktree.** After the merge is on `main` and the
   working tree is clean of needed changes, delete the development worktree
   (`git worktree remove <path>`, then delete the feature branch if it is fully
   merged and no longer needed). Do not leave orphaned worktrees or merged
   task branches cluttering the machine. If removal fails (dirty tree, lock,
   path in use), stop, report the blocker, and do not force-delete uncommitted
   work.
6. **Repackage desktop.** Run `./scripts/desktop-rebuild.sh` (or
   `make desktop-rebuild`) from the primary checkout so the Electron shell
   picks up the new UI embed and `kin` binary. Do not substitute a hand-rolled
   UI/kin/Electron pipeline for this script. Report rebuild failures and
   residual risk if the script cannot run in the current environment.

Scope notes:

- Apply this gate to coherent feature/fix deliveries, not to every tiny
  exploratory edit mid-iteration.
- **Default isolation:** start feature work in a worktree; land on `main` only
  through the merge step above; always tear down that worktree after a
  successful merge.
- Docs-only or pure chore changes may skip worktree creation and desktop
  rebuild when no binary or UI embed changed; still commit (and merge to
  `main` when that was the goal).
- If sub-agent review is unavailable, say so explicitly, fall back to a
  thorough self-review checklist, and list residual risk—do not silently skip
  the rest of the gate (commit / merge / worktree removal / rebuild).

## Git discipline

- **Done means reviewed, committed, merged, cleaned up, and rebuilt:** when a
  coherent feature is finished and verified, complete the Feature completion
  gate in the same session (high-model review, fix majors, commit, merge to
  `main`, remove the feature worktree, `./scripts/desktop-rebuild.sh` when
  binary/UI changed).
- Use atomic Conventional Commit messages such as `feat(api): ...`,
  `fix(provider): ...`, `test(task): ...`, and `docs: ...`. Subject in
  imperative mood; add a body for non-obvious motivation or tradeoffs.
- One logical change per commit. Do not mix unrelated refactors with feature
  work; do not squash away useful history just to look tidy.
- Stage explicit paths or reviewed hunks. Never use a broad add when caches,
  credentials, logs, databases, or unrelated user files may be present.
- Commit generated `web/dist/` only with the source change that produced it or
  as an immediately adjacent `build(web)` commit.
- Do not amend commits created by another person or agent. Do not rebase shared
  branches, force-push, or push to a remote unless explicitly requested.
- Prefer developing on a dedicated worktree/branch rather than dirtying the
  primary `main` checkout. Merge finished feature/task branches into local
  `main` as part of the Feature completion gate, then remove that worktree
  (and the merged branch when appropriate). Push to `origin` only when
  explicitly requested or required by the release process.
- After a UI or daemon change lands on `main`, run `./scripts/desktop-rebuild.sh`
  (or `make desktop-rebuild`) from the primary checkout so desktop picks up the
  new embed and binary. Prefer this script over any manual rebuild steps.
- End with a clean working tree when all visible files are in scope. Otherwise,
  list every intentional uncommitted or ignored exception.

## Documentation and safety

- Keep English and Chinese top-level documentation aligned when changing shared
  product behavior.
- Record durable architecture decisions in `docs/adr/` and executable plans in
  `docs/plans/`; keep temporary run logs under ignored paths.
- Never commit secrets, access tokens, personal data, local databases, build
  caches, or tool transcripts. Redact sensitive values from tests and examples.
- Ask before destructive operations, dependency-wide upgrades, public API
  breaks, schema resets, network publication, or actions that affect external
  systems.
