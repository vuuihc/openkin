// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";

/**
 * C1b: the branch chip in the composer footer.
 *
 * The list used to own its own body portal, viewport measurement, outside /
 * Escape listeners and a 20 ms focus timer, which made it behave subtly
 * differently from every other panel in the console. It now opens on the
 * shared `Popover` layer; these tests pin the layer contract (one portal, one
 * Escape, focus in and back) and the branch behaviour that must not drift.
 */
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  listGitBranches: vi.fn(),
  checkoutGitBranch: vi.fn(),
}));

import {
  ApiError,
  checkoutGitBranch,
  listGitBranches,
  type GitBranchStatus,
} from "../../api/client";
import BranchPicker from "./BranchPicker";

const mockedList = vi.mocked(listGitBranches);
const mockedCheckout = vi.mocked(checkoutGitBranch);

function status(overrides: Partial<GitBranchStatus> = {}): GitBranchStatus {
  return {
    cwd: "/work/alpha",
    is_git: true,
    current: "main",
    branches: [
      { name: "main", current: true },
      { name: "feature/x", current: false },
      { name: "release", current: false },
    ],
    ...overrides,
  };
}

async function openList() {
  const user = userEvent.setup();
  render(<BranchPicker cwd="/work/alpha" />);
  const chip = await screen.findByRole("button", { name: "main" });
  await user.click(chip);
  const list = await screen.findByRole("listbox", { name: "Git branches" });
  return { user, chip, list };
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  mockedList.mockReset();
  mockedCheckout.mockReset();
  mockedList.mockResolvedValue(status());
  useAppStore.setState({ pushToast: vi.fn() });
});

describe("the branch list on the shared popover layer (C1b)", () => {
  it("opens on the shared layer, portaled out of the composer strip", async () => {
    const { list } = await openList();

    const panel = list.closest('[role="dialog"]') as HTMLElement | null;
    expect(panel).toBeTruthy();
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.className).toContain("fixed");
  });

  it("narrows the rows as the filter is typed", async () => {
    const { user, list } = await openList();
    const filter = within(list).getByRole("textbox");

    await user.type(filter, "feature");

    expect(within(list).getByRole("option", { name: /feature\/x/ })).toBeTruthy();
    expect(within(list).queryByRole("option", { name: /main/ })).toBeNull();
    expect(within(list).queryByRole("option", { name: /release/ })).toBeNull();
  });

  it("checks the chosen branch out once and closes the list", async () => {
    const { user, list } = await openList();

    await user.click(within(list).getByRole("option", { name: /feature\/x/ }));

    expect(mockedCheckout).toHaveBeenCalledTimes(1);
    expect(mockedCheckout).toHaveBeenCalledWith("/work/alpha", "feature/x", undefined);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("closes on Escape and returns focus to the chip", async () => {
    const { user, chip, list } = await openList();
    // The layer focuses the filter once it has measured the panel; a real
    // reader presses Escape from inside it.
    const filter = within(list).getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(filter));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("shows the dirty-checkout refusal and does not switch", async () => {
    mockedCheckout.mockRejectedValue(
      new ApiError(409, JSON.stringify({ error: "working tree has changes" })),
    );
    const { user, list } = await openList();

    await user.click(within(list).getByRole("option", { name: /feature\/x/ }));

    expect(mockedCheckout).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().pushToast).toHaveBeenCalledWith(
      "Working tree is dirty — commit or stash before switching",
      "error",
    );
    // The refusal leaves the list open on the branch it refused to leave.
    expect(screen.getByRole("listbox", { name: "Git branches" })).toBeTruthy();
  });
});
