// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskUsage, Upload } from "../../api/client";
import type { AgentRole } from "../../lib/agentRoles";
import { t } from "../../i18n";
import TaskComposerDock, { type TaskComposerDockProps } from "./TaskComposerDock";

// The dock is markup over the page's values: the two directory/branch chips ask
// their machine on mount, which is not the subject here. Answering with empty
// results keeps them rendered without a network.
vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    recentCwds: () => Promise.resolve([]),
    listGitBranches: () => Promise.resolve({ cwd: "/tmp/example", is_git: false, branches: [] }),
  };
});

/**
 * The conversation's bottom band, extracted from `TaskDetailPage`.
 *
 * What is pinned here is the contract the extraction must not blur: the page
 * owns every value and handler, this component only draws them, and only the
 * active pane marks the bottom chrome the shell measures. A queued message and
 * a settled session ask for different things in the same composer, and neither
 * waits-on-you strip exists unless something is waiting.
 */

const task: Task = {
  id: "task-1",
  title: "Fix the dock",
  agent: "kin",
  cwd: "/tmp/example",
  prompt: "Fix the dock",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  created_at: 1_700_000_000_000,
  event_epoch: 0,
};

function setup(overrides: Partial<TaskComposerDockProps> = {}) {
  const props: TaskComposerDockProps = {
    active: true,
    task,
    terminal: false,
    detailLoaded: true,
    agents: [],
    agentRoles: [] as readonly AgentRole[],
    hostAgentName: "Kin",
    hostAgentAvatar: { initials: "K", className: "bg-kin-accent" },
    sending: false,
    stopping: false,
    initialValue: "",
    initialAttachments: [] as Upload[],
    focusSignal: 0,
    fileSearch: undefined,
    onValueChange: vi.fn(),
    onAttachmentsChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    composerModel: "",
    onComposerModelChange: vi.fn(),
    composerPermissionMode: "default",
    onComposerPermissionChange: vi.fn(),
    taskAgentModels: [],
    taskAgentModelSource: "none",
    taskAgentModelStatus: "default_only",
    taskPermissionModes: [],
    transcriptModel: "claude-sonnet-5-5",
    usage: null as TaskUsage | null,
    usageLoading: false,
    machine: null,
    waitingCount: 0,
    onRevealFirstPending: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TaskComposerDock {...props} />) };
}

describe("TaskComposerDock", () => {
  it("waits: renders the waiting strip with the count and calls onRevealFirstPending", () => {
    const onRevealFirstPending = vi.fn();
    setup({ waitingCount: 2, onRevealFirstPending });

    const button = screen.getByRole("button", {
      name: t("task.waitingOnYou", { count: "2" }),
    });
    fireEvent.click(button);
    expect(onRevealFirstPending).toHaveBeenCalledTimes(1);
  });

  it("waits: renders no waiting strip when nothing is waiting", () => {
    setup({ waitingCount: 0 });

    expect(
      screen.queryByRole("button", { name: t("task.waitingOnYou", { count: "0" }) }),
    ).toBeNull();
  });

  it("composer: a running session asks for a queued message; a settled one names the host agent", () => {
    const running = setup({ terminal: false });
    expect(screen.getByPlaceholderText(t("composer.queuedWhileRunning"))).toBeTruthy();
    running.unmount();

    setup({ terminal: true });
    expect(
      screen.getByPlaceholderText(t("composer.followUpPlaceholder", { name: "Kin" })),
    ).toBeTruthy();
  });

  it("discloses what the session is — folder, repository, branch, machine — inside the run settings", async () => {
    const user = userEvent.setup();
    setup({
      task: { ...task, workspace_repo: "owner/repo" },
      machine: { text: "node-1", known: true },
    });

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`^${t("runConfig.open")}${t("common.labelSeparator")}`),
      }),
    );
    const panel = await screen.findByRole("dialog", { name: t("runConfig.title") });

    for (const label of [
      t("runConfig.agent"),
      t("newChat.rowCwd"),
      t("pr.repoLabel"),
      t("newChat.rowBranch"),
      t("newChat.rowMachine"),
    ]) {
      // A label and the row's own control can name the same concept (the
      // folder picker shows the folder); one or more is the row being there.
      expect(within(panel).getAllByText(label).length).toBeGreaterThan(0);
    }
    // The machine row exists only when the session runs somewhere else.
    expect(within(panel).getByText(t("machine.runsOn", { name: "node-1" }))).toBeTruthy();
  });

  it("draws no machine row for a session on this machine", async () => {
    const user = userEvent.setup();
    setup({ machine: null });

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`^${t("runConfig.open")}${t("common.labelSeparator")}`),
      }),
    );
    const panel = await screen.findByRole("dialog", { name: t("runConfig.title") });

    expect(within(panel).queryByText(t("newChat.rowMachine"))).toBeNull();
  });

  it("contract: only the active pane marks the bottom chrome", () => {
    const active = setup({ active: true });
    expect(active.container.querySelector("[data-kin-bottom-chrome]")).not.toBeNull();
    active.unmount();

    const hidden = setup({ active: false });
    expect(hidden.container.querySelector("[data-kin-bottom-chrome]")).toBeNull();
  });

  it("offers one compact run-settings entry on the composer card at every width", () => {
    const { container } = setup();
    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    // One entry is the whole run surface: the chip names the agent, model and
    // mode, and the sheet or panel behind it owns every setting. The strip of
    // chips that repeated the same settings at `md` up is gone, so nothing
    // else on the card reads as a second way to change them.
    const prefix = `${t("runConfig.open")}${t("common.labelSeparator")}`;
    const entries = Array.from(form!.querySelectorAll("[aria-label]")).filter((el) =>
      (el.getAttribute("aria-label") ?? "").startsWith(prefix),
    );
    expect(entries).toHaveLength(1);
    expect(form!.contains(entries[0])).toBe(true);

    const strips = Array.from(form!.querySelectorAll("div")).filter(
      (el) => el.classList.contains("hidden") && el.classList.contains("md:flex"),
    );
    expect(strips).toHaveLength(0);
  });

  it("drops the run settings when the pane is not the one on screen", () => {
    // The panel is a layer over the page, not part of the pane. A closed door
    // in a hidden pane could otherwise stay open over the visible one.
    const { container } = setup({ active: false });
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    const prefix = `${t("runConfig.open")}${t("common.labelSeparator")}`;
    const entries = Array.from(form!.querySelectorAll("[aria-label]")).filter((el) =>
      (el.getAttribute("aria-label") ?? "").startsWith(prefix),
    );
    expect(entries).toHaveLength(0);
  });
});
