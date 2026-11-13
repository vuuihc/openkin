// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import RoutinesPage from "./RoutinesPage";
import { canLeaveScreen, resetLeaveGuard } from "../lib/leaveGuard";
import { setLocale } from "../i18n";
import type { Routine } from "../api/client";

/**
 * D4: an edited routine is a draft.
 *
 * The Routines page's form used to close from its own Cancel/toggle without
 * asking, and the shell's Back, edge swipe and ⌘N had no guard to consult
 * either. These tests drive the real page: the real `closeForm`, the real
 * `useLeaveGuard` registration in the component, and the same
 * `canLeaveScreen()` the shell calls.
 */

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: vi.fn(() => true),
    listRoutines: vi.fn(),
    listRoutineRuns: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    previewRoutine: vi.fn(async () => ({ next_due_at: 0 })),
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      {
        id: "desktop-hub",
        label: "hub",
        isSelf: true,
        online: true,
        roots: ["/work/alpha"],
        agents: [{ id: "kin", name: "Kin", installed: true, available: true }],
      },
    ],
    agents: [{ id: "kin", name: "Kin", installed: true, available: true }],
    loading: false,
    failed: false,
  }),
}));

import { listRoutines } from "../api/client";

const routine = {
  id: "routine-1",
  cwd: "/work/alpha",
  agent: "kin",
  permission_mode: "ask",
  prompt: "Review new PRs",
  interval_secs: 86400,
  enabled: true,
  next_due_at: 4,
  consec_failures: 0,
  created_at: 1,
  updated_at: 2,
  title: "Morning review",
  missed_run_policy: "coalesce",
  lane: "main",
} as unknown as Routine;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  resetLeaveGuard();
  setLocale("en");
  localStorage.clear();
  vi.mocked(listRoutines).mockReset().mockResolvedValue({
    routines: [routine],
    has_more: false,
  });
});

function page() {
  return render(
    <MemoryRouter>
      <RoutinesPage />
    </MemoryRouter>,
  );
}

describe("the routines form's leave guard", () => {
  it("asks before the form's own Cancel discards a typed create draft", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "New routine" }));

    const prompt = screen.getByPlaceholderText(/Review new PRs since yesterday/);
    await user.type(prompt, "Check the queue");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await user.click(within(document.getElementById("routine-form")!).getByRole("button", { name: "Cancel" }));
      expect(confirm).toHaveBeenCalledWith("Discard unsaved routine changes?");
      expect((screen.getByPlaceholderText(/Review new PRs since yesterday/) as HTMLTextAreaElement).value).toBe(
        "Check the queue",
      );

      // The shell's Back/edge/⌘N path asks the same registered guard.
      expect(canLeaveScreen()).toBe(false);

      confirm.mockReturnValue(true);
      expect(canLeaveScreen()).toBe(true);
      await user.click(within(document.getElementById("routine-form")!).getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByPlaceholderText(/Review new PRs since yesterday/)).toBeNull(),
      );
    } finally {
      confirm.mockRestore();
    }
  });

  it("asks before closing an edit that changed an existing routine", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: /^Edit Morning review/ }));

    const title = screen.getByDisplayValue("Morning review");
    await user.clear(title);
    await user.type(title, "Changed title");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      expect(canLeaveScreen()).toBe(false);

      await user.click(within(document.getElementById("routine-form")!).getByRole("button", { name: "Cancel" }));
      expect(confirm).toHaveBeenCalledWith("Discard unsaved routine changes?");
      expect(screen.getByDisplayValue("Changed title")).toBeTruthy();

      confirm.mockReturnValue(true);
      await user.click(within(document.getElementById("routine-form")!).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByDisplayValue("Changed title")).toBeNull());
    } finally {
      confirm.mockRestore();
    }
  });
});
