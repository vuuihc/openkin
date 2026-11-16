# Markdown Preview Theme Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the workspace Markdown preview use Kin's active light, dark, or system theme with readable foreground/background contrast.

**Architecture:** Keep the shared `Markdown` renderer on the existing `--kin-*` text tokens. Remove the workspace viewer's hard-coded dark surface and loading overlay so the surrounding surface resolves from the same active theme tokens.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vite

---

## Design decision

The regression comes from mixing two independent palettes: `Markdown.tsx` uses
theme-aware text tokens, while `WorkspacePanel.tsx` forces its viewer background
to `#111214`. In light mode this produces dark text on a dark background. The
smallest coherent fix is to make the viewer and its loading state consume
`--kin-bg`, preserving all existing Markdown typography and semantic colors.

Rejected alternatives:

- Add separate light/dark Markdown styles: duplicates tokens and can drift from
  the main application theme.
- Import a third-party Markdown theme: adds a dependency and changes typography
  beyond the reported contrast bug.

## Task 1: Theme the workspace viewer surface

**Files:**

- Modify: `ui/src/components/workspace/WorkspacePanel.tsx`
- Modify: `ui/src/components/workspace/CodeViewer.tsx`

**Step 1: Confirm the regression**

Inspect the current markup and verify that the viewer and loading overlay use
`bg-[#111214]`.

**Step 2: Apply the minimal implementation**

Replace both hard-coded dark backgrounds with `bg-[var(--kin-bg)]`. Keep the
existing `text-kin-*` foreground classes because they already resolve through
the active theme.

**Step 3: Run focused verification**

Run:

```bash
cd ui
npm run build
npm test
```

Expected: TypeScript, Vite, and Vitest complete successfully.

**Step 4: Inspect both themes**

Open the workspace Markdown preview at a representative desktop width, switch
between light and dark themes, and confirm readable headings, body text, links,
inline code, code blocks, blockquotes, and tables.

## Task 2: Complete the repository gate

**Files:**

- Review: the complete Git diff and nearby workspace/Markdown call sites

**Step 1: Request high-model review**

Ask an advanced sub-agent to report blocker, major, and nit findings for
correctness, regressions, accessibility, tests, and theme contract drift.

**Step 2: Fix material findings and re-run verification**

Resolve all blocker and major findings, then repeat review if the diff changes
materially.

**Step 3: Commit and land**

Stage only the plan and reviewed source changes, then commit:

```bash
git commit -m "fix(ui): follow theme in Markdown preview"
```

Merge the task branch into local `main`, remove this worktree and merged branch,
then run `./scripts/desktop-rebuild.sh` from the primary checkout.
