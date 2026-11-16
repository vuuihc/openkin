// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("desktop strip: names the host agent and shows the machine line only when a machine is passed", () => {
    const withoutMachine = setup({ machine: null });
    expect(screen.getAllByText("Kin").length).toBeGreaterThan(0);
    expect(screen.queryByText(t("machine.runsOn", { name: "node-1" }))).toBeNull();
    withoutMachine.unmount();

    setup({ machine: { text: "node-1", known: true } });
    expect(screen.getAllByText("Kin").length).toBeGreaterThan(0);
    expect(screen.getByText(t("machine.runsOn", { name: "node-1" }))).toBeTruthy();
  });

  it("contract: only the active pane marks the bottom chrome", () => {
    const active = setup({ active: true });
    expect(active.container.querySelector("[data-kin-bottom-chrome]")).not.toBeNull();
    active.unmount();

    const hidden = setup({ active: false });
    expect(hidden.container.querySelector("[data-kin-bottom-chrome]")).toBeNull();
  });

  it("keeps the desktop run strip inside the composer card", () => {
    const { container } = setup();
    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    // Both desktop controls — the mode and the model — are on the composer's
    // own card, not on a second row below it. Containment is the assertion,
    // not visibility: jsdom ignores the media query that hides one face or the
    // other, and both faces have to exist for either width to work.
    const permissions = screen.getAllByRole("button", {
      name: new RegExp(`^${t("permission.label")}${t("common.labelSeparator")}`),
    });
    const models = screen.getAllByRole("button", {
      name: new RegExp(`^${t("modelPicker.label")}${t("common.labelSeparator")}`),
    });
    expect(permissions.length).toBeGreaterThan(0);
    expect(models.length).toBeGreaterThan(0);
    for (const control of [...permissions, ...models]) {
      expect(form!.contains(control)).toBe(true);
    }

    // The strip's `hidden md:flex` wrapper is the shape that used to float
    // under the card. Exactly one exists, and it is inside the form.
    const strips = Array.from(form!.querySelectorAll("div")).filter(
      (el) => el.classList.contains("hidden") && el.classList.contains("md:flex"),
    );
    expect(strips).toHaveLength(1);
    expect(form!.contains(strips[0])).toBe(true);
  });

  it("offers one run-config entry on the phone", () => {
    const { container } = setup();
    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    // The phone's single settings entry is the run-config face. The strip is
    // the same settings at another width; a second button named after the run
    // settings would be two entries for one choice in the same card.
    const prefix = `${t("runConfig.open")}${t("common.labelSeparator")}`;
    const entries = Array.from(form!.querySelectorAll("[aria-label]")).filter((el) =>
      (el.getAttribute("aria-label") ?? "").startsWith(prefix),
    );
    expect(entries).toHaveLength(1);
  });
});
