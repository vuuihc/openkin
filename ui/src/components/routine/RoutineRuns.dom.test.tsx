// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Routine, Task } from "../../api/client";
import { t } from "../../i18n";
import { RunCard, RunHistoryPanel } from "./RoutineRuns";

/**
 * One routine's run records. The panel mounts twice on the routines page (the
 * phone row and the desktop aside) and the feed reuses the same card, so these
 * tests pin the props that decide what a reader sees: an unread run, the way
 * out to its conversation, a machine with no older page, and an empty history.
 */

function routine(id = "routine-1", title = "Morning review"): Routine {
  return {
    id,
    cwd: "/tmp/kin",
    agent: "codex",
    model: "",
    permission_mode: "default",
    prompt: "check things",
    interval_secs: 86400,
    enabled: true,
    next_due_at: Date.now() + 60_000,
    consec_failures: 0,
    created_at: Date.now(),
    title,
    missed_run_policy: "skip",
    lane: "default",
    recurrence: "",
  };
}

function run(id = "run-1234", overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: "Daily report",
    agent: "codex",
    cwd: "/tmp/kin",
    prompt: "check things",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: Date.now(),
    event_epoch: 0,
    routine_id: "routine-1",
    routine_unread: true,
    routine_noteworthy: true,
    ...overrides,
  };
}

function setupPanel(
  props: Partial<Parameters<typeof RunHistoryPanel>[0]> = {},
): ReturnType<typeof render> & { onMarkRead: ReturnType<typeof vi.fn> } {
  const onMarkRead = vi.fn();
  const utils = render(
    <MemoryRouter>
      <RunHistoryPanel
        routine={routine()}
        runs={[run()]}
        loading={false}
        hasMore={false}
        loadingOlder={false}
        remote={false}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        onMarkRead={onMarkRead}
        tr={t}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...utils, onMarkRead };
}

describe("RunHistoryPanel", () => {
  it("renders an unread run with a mark-read button that reports its id", () => {
    const { onMarkRead } = setupPanel();
    fireEvent.click(screen.getByRole("button", { name: t("routines.markRead") }));
    expect(onMarkRead).toHaveBeenCalledWith("run-1234");
  });

  it("hides the older-page button for a remote machine", () => {
    // A remote feed comes from the relay and carries no cursor the console
    // could page, so offering the button would ask for a page nobody has.
    setupPanel({ hasMore: true, remote: true });
    expect(screen.queryByRole("button", { name: t("routines.historyLoadOlder") })).toBeNull();
    setupPanel({ hasMore: true, remote: false });
    expect(
      screen.getAllByRole("button", { name: t("routines.historyLoadOlder") }).length,
    ).toBeGreaterThan(0);
  });

  it("reads empty history differently for a local and a remote machine", () => {
    expect(t("routines.historyEmpty")).not.toBe(t("routines.historyEmptyRemote"));
    setupPanel({ runs: [] });
    expect(screen.getByText(t("routines.historyEmpty"))).toBeTruthy();
    setupPanel({ runs: [], remote: true });
    expect(screen.getByText(t("routines.historyEmptyRemote"))).toBeTruthy();
  });

  it("keeps loading, error and empty in that order", () => {
    // A failed fetch must not read as "this routine has never run", and a
    // loading state must not flash the empty line underneath it.
    setupPanel({ loading: true, error: "boom", runs: [] });
    expect(screen.getByText(t("routines.historyLoading"))).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
    expect(screen.queryByText(t("routines.historyEmpty"))).toBeNull();
    setupPanel({ error: "boom", runs: [] });
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.queryByText(t("routines.historyEmpty"))).toBeNull();
    setupPanel({ runs: [] });
    expect(screen.getByText(t("routines.historyEmpty"))).toBeTruthy();
  });
});

describe("RunCard", () => {
  it("falls back to the short run id when a run has no title", () => {
    render(
      <MemoryRouter>
        <ul>
          <RunCard run={run("run-abcdef123456", { title: "" })} onMarkRead={vi.fn()} tr={t} />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "run-abcd" })).toBeTruthy();
  });
});
