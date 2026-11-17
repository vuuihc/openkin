// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../../api/client";
import { setLocalTaskTitle } from "../../lib/taskTitles";
import RunningTaskCard from "./RunningTaskCard";

/**
 * R-rename-cross-surface: the approvals strip draws the same conversation the
 * list and the header draw, so it draws the same name (TASTE 2). The card is
 * long-lived — the page polls while approvals are pending — so a rename has to
 * reach it without a reload.
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

describe("RunningTaskCard and local renames", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("draws the locally renamed title", () => {
    setLocalTaskTitle("task-1", "New name");
    render(<RunningTaskCard task={task} />);

    expect(screen.queryByText("Old name")).toBeNull();
    expect(screen.getByText("New name")).toBeTruthy();
  });

  it("repaints when the conversation is renamed while the card is mounted", () => {
    render(<RunningTaskCard task={task} />);
    act(() => {
      setLocalTaskTitle("task-1", "Renamed elsewhere");
    });

    expect(screen.getByText("Renamed elsewhere")).toBeTruthy();
  });
});
