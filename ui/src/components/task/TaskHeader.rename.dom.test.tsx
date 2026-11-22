// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../../api/client";
import { setLocalTaskTitle } from "../../lib/taskTitles";
import TaskHeader, { type TaskHeaderProps } from "./TaskHeader";

/**
 * R-rename-cross-surface / TASTE 2: one conversation has one name.
 *
 * A rename is written to the shared local-title store by the list's row menu
 * (KIN-MANAGE-001). The header is the surface the person lands on next, so it
 * must draw that name — at both widths — and it must repaint when the rename
 * happens while it is already mounted. The sibling shape is `SessionList`'s:
 * subscribe once, re-read the map, draw from state.
 */

const task: Task = {
  id: "task-1",
  title: "Old name",
  agent: "kin",
  cwd: "/tmp/example",
  prompt: "Old name",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  created_at: 1_700_000_000_000,
  event_epoch: 0,
};

function setup(phone = false) {
  const props: TaskHeaderProps = {
    task,
    hostAgentName: "Kin",
    hostAgentAvatar: { initials: "K", className: "bg-kin-blue text-kin-on-brand" },
    project: "openkin",
    terminal: false,
    degraded: false,
    filesOpen: false,
    panelOpen: false,
    prOpen: false,
    archiving: false,
    deleting: false,
    stopping: false,
    onToggleWorkspace: vi.fn(),
    onTogglePr: vi.fn(),
    onShare: vi.fn(),
    onToggleArchive: vi.fn(),
    onDelete: vi.fn(),
    onStop: vi.fn(),
    onBack: vi.fn(),
    onOpenActions: vi.fn(),
    onShowList: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <TaskHeader {...props} phone={phone} />
    </MemoryRouter>,
  );
}

describe("TaskHeader and local renames", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("draws the locally renamed title instead of the task title at both widths", () => {
    // The rename happened earlier (the list's row menu), so the header mounts
    // with the store already carrying it. Reading only `task.title` is the bug.
    setLocalTaskTitle("task-1", "New name");

    // One bar renders per width; each draws the one name.
    for (const phone of [false, true]) {
      const view = setup(phone);
      expect(screen.queryByText("Old name")).toBeNull();
      expect(screen.getAllByText("New name")).toHaveLength(1);
      view.unmount();
    }
  });

  it("updates when another surface renames the same conversation", () => {
    for (const phone of [false, true]) {
      const view = setup(phone);
      expect(screen.getAllByText("Old name")).toHaveLength(1);

      // Another mounted surface (the sidebar's row menu) writes the rename; the
      // header gets no new props and is not remounted. Only the store changes.
      act(() => {
        setLocalTaskTitle("task-1", "Renamed elsewhere");
      });

      expect(screen.queryByText("Old name")).toBeNull();
      expect(screen.getAllByText("Renamed elsewhere")).toHaveLength(1);
      view.unmount();
      setLocalTaskTitle("task-1", "");
    }
  });
});
