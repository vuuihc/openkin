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
4. **Tests as the contract.** Add or update tests with behavior changes.
   Reproduce bugs with a failing test when practical; only then fix.
5. **Verify, do not assume.** Run the narrowest relevant checks while iterating,
   then the full applicable suite before handoff. Report any check that could
   not run, with residual risk.
6. **Commit when a unit of work is done.** After a feature, fix, or module is
   complete and its checks pass, create an atomic Git commit immediately—do not
   wait for a reminder. Do not commit known-failing work unless the user
   explicitly requests a checkpoint.
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
2. Break work into the smallest independently verifiable modules. Keep API,
   storage, UI, and documentation changes consistent with one another.
3. Prefer focused changes over broad cleanup. Do not add speculative
   abstractions or dependencies.
4. Add or update tests with behavior changes. Reproduce bugs with a failing
   test when practical.
5. Run the narrowest relevant checks while iterating, then the full applicable
   verification before completion.
6. After a module is complete and its checks pass, automatically create an
   atomic Git commit with a clear Conventional Commit message; do not wait for
   a separate reminder. Do not commit known failing work unless the user
   explicitly requests a checkpoint.

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

## Git discipline

- **Done means committed:** when a coherent unit of work is finished and
  verified, commit it in the same session with a clear message.
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
