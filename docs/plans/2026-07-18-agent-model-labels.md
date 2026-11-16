# Agent Model Labels Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show the effective model as unobtrusive secondary text beside the main Agent avatar and each visible sub-Agent progress entry.

**Architecture:** Normalize the selected model into every persisted Agent event at the task-engine boundary, where the task or delegated worker model is known. The chat projection carries that model as structured metadata and renders it below the Agent name; empty or unavailable models render no placeholder. Adapter-reported model values remain authoritative when present, while the task selection supplies a stable fallback.

**Tech Stack:** Go task engine and tests, React 18, strict TypeScript, Tailwind CSS, Vite.

---

### Task 1: Normalize model metadata on Agent events

**Files:**
- Modify: `internal/task/engine.go`
- Modify: `internal/task/orchestrate.go`
- Test: `internal/task/orchestrate_test.go`

**Step 1: Write the failing test**

Add table-driven coverage showing that event stamping adds the selected model, preserves a non-empty adapter-reported model, and omits an empty model.

**Step 2: Run the focused test to verify it fails**

Run: `go test ./internal/task -run 'TestStamp(Agent|Worker)Model'`

Expected: FAIL because event stamping does not yet accept or normalize model metadata.

**Step 3: Implement the minimal event normalization**

Pass the task model to the single-Agent run loop and each effective delegated-worker model to worker forwarding. Extend the shared event stamper to set `model` only when the event lacks a non-empty model of its own.

**Step 4: Run the focused test to verify it passes**

Run: `go test ./internal/task -run 'TestStamp(Agent|Worker)Model'`

Expected: PASS.

### Task 2: Project and render model labels in chat

**Files:**
- Modify: `ui/src/components/chat/ChatStream.tsx`
- Modify: `ui/src/pages/TaskDetailPage.tsx`

**Step 1: Add model metadata to the chat projection**

Carry `model` on messages, progress steps, progress containers, and Agent turns. Resolve event model values defensively from strings and use the task model as the main-Agent fallback.

**Step 2: Render the approved secondary label**

Under the main Agent name and each sub-Agent name in expanded progress rows, render a truncated, low-contrast monospace model label. Do not reserve space when no model is known. Keep streaming/thinking status aligned beside the two-line identity block.

**Step 3: Verify strict TypeScript and the production bundle**

Run: `cd ui && npm run build`

Expected: TypeScript succeeds and Vite regenerates `web/dist/`.

### Task 3: Verify and commit

**Files:**
- Review: all modified source, test, plan, and generated `web/dist/` files

**Step 1: Run backend verification**

Run: `gofmt -w internal/task/engine.go internal/task/orchestrate.go internal/task/orchestrate_test.go`

Run: `go test ./...`

Run: `go vet ./...`

Expected: all checks pass.

**Step 2: Inspect representative layouts**

Open a task containing a main Agent and delegated worker events at desktop and narrow widths. Confirm long model IDs truncate without moving avatars, unknown models leave no blank line, and the label remains visually secondary.

**Step 3: Review and commit explicit paths**

Review `git diff --check`, `git diff --stat`, and the full diff. Stage only the plan, task engine/test changes, UI source, and regenerated `web/dist/`, then commit with `feat(chat): show agent models`.
