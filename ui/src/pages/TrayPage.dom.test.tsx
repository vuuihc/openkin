// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Approval, Task } from "../api/client";
import { DEFAULT_LOCALE, setLocale } from "../i18n";

/**
 * The tray is the one surface a reader meets without the rest of the console:
 * a 360×480 popover. It used to be the one surface that never went through the
 * i18n layer, so a Chinese reader got English there and the empty state called
 * a conversation a "task" — a word the product does not use for one.
 */

const fixtures = vi.hoisted(() => ({
  approvals: [] as unknown[],
  tasks: [] as unknown[],
  wsStatus: "connected",
  busy: {} as Record<string, "approved" | "denied">,
}));

const decide = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../api/useLiveResources", () => ({
  usePendingResources: () => ({
    data: { approvals: fixtures.approvals, questions: [] },
    loaded: true,
    error: null,
  }),
  useTaskList: () => ({ data: fixtures.tasks, loaded: true, error: null }),
}));

vi.mock("../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: fixtures.busy, decide }),
}));

vi.mock("../store/appStore", () => ({
  useAppStore: (selector: (state: { wsStatus: string }) => unknown) =>
    selector({ wsStatus: fixtures.wsStatus }),
}));

import TrayPage from "./TrayPage";

function approval(): Approval {
  return {
    id: "a1",
    payload: { tool_name: "Bash", input: { command: "ls" } },
    task_agent: "claude-code",
    task_title: "conversation one",
  } as unknown as Approval;
}

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    prompt: "hello",
    agent: "claude-code",
    status: "running",
    created_at: Date.now() - 5000,
    ...partial,
  } as unknown as Task;
}

beforeEach(() => {
  setLocale("zh");
  fixtures.approvals = [];
  fixtures.tasks = [];
  fixtures.wsStatus = "connected";
  fixtures.busy = {};
  decide.mockClear();
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe("the tray", () => {
  it("renders every tray control in the reader's language", () => {
    fixtures.approvals = [approval()];
    fixtures.tasks = [
      task({ id: "t1", title: "conversation one", status: "running" }),
      task({ id: "t2", title: "conversation two", status: "succeeded" }),
    ];
    const first = render(<TrayPage />);

    expect(screen.getByText("需要你 · 1")).toBeTruthy();
    expect(screen.getByText("进行中 · 1")).toBeTruthy();
    expect(screen.getByText("今天完成")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Kin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新对话" })).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
    // TASTE 2: a conversation is a conversation, never a "task".
    expect(document.body.textContent).not.toMatch(/\btasks?\b/i);

    act(() => setLocale("en"));

    expect(screen.getByText("Needs you · 1")).toBeTruthy();
    expect(screen.getByText("Running · 1")).toBeTruthy();
    expect(screen.getByText("Done today")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Kin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Chat" })).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\btasks?\b/i);
    first.unmount();

    // The empty state is the copy that used to say "No active tasks".
    fixtures.approvals = [];
    fixtures.tasks = [];
    const second = render(<TrayPage />);
    expect(screen.getByText("No active conversations")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\btasks?\b/i);

    act(() => setLocale("zh"));
    expect(screen.getByText("没有进行中的对话")).toBeTruthy();
    second.unmount();

    // The connection state is copy too, not a bare ws status.
    fixtures.wsStatus = "connecting";
    const third = render(<TrayPage />);
    expect(screen.getByText("连接中")).toBeTruthy();

    act(() => setLocale("en"));
    expect(screen.getByText("connecting")).toBeTruthy();
    third.unmount();

    fixtures.wsStatus = "offline";
    render(<TrayPage />);
    expect(screen.getByText("offline")).toBeTruthy();
  });

  it("keeps approve, deny and the footer actions wired", async () => {
    setLocale("en");
    fixtures.approvals = [approval()];
    // openMain assigns `location.href` after posting, and jsdom has no
    // navigation to implement; the virtual console's report is noise here.
    const quietConsole = vi.spyOn(console, "error").mockImplementation(() => {});
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    render(<TrayPage />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("a1", "approved");

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenLastCalledWith("a1", "denied");

    // The footer still asks the main window to open these two paths.
    await userEvent.click(screen.getByRole("button", { name: "Open Kin" }));
    expect(post).toHaveBeenCalledWith({ type: "kin-tray-open", path: "/" }, "*");
    await userEvent.click(screen.getByRole("button", { name: "New Chat" }));
    expect(post).toHaveBeenLastCalledWith({ type: "kin-tray-open", path: "/new" }, "*");

    post.mockRestore();
    quietConsole.mockRestore();
  });

  it("puts approve and deny on the facade's decision weights", async () => {
    setLocale("en");
    fixtures.approvals = [approval()];
    const idle = render(<TrayPage />);

    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    const deny = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
    expect(approve.className).toContain("kin-btn");
    expect(approve.className).toContain("kin-btn-approve");
    expect(deny.className).toContain("kin-btn");
    expect(deny.className).toContain("kin-btn-deny");
    // Both decisions stay the pair's two equal halves.
    expect(approve.className).toContain("flex-1");
    expect(deny.className).toContain("flex-1");

    // The busy glyph still replaces the label while the decision is in flight.
    idle.unmount();
    fixtures.busy = { a1: "approved" };
    render(<TrayPage />);
    const busyApprove = screen.getByRole("button", { name: "…" }) as HTMLButtonElement;
    expect(busyApprove.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);
  });

  it("puts the tray footer on the shared button facade", () => {
    setLocale("en");
    render(<TrayPage />);

    const open = screen.getByRole("button", { name: "Open Kin" });
    expect(open.className).toContain("kin-btn");
    expect(open.className).toContain("kin-btn-primary");

    const create = screen.getByRole("button", { name: "New Chat" });
    expect(create.className).toContain("kin-btn");
    expect(create.className).toContain("kin-btn-secondary");
  });
});
