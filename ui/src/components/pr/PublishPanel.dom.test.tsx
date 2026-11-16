// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import PublishPanel from "./PublishPanel";

/**
 * W2: the publish sheet's controls on the shared button facade.
 *
 * The one visible rule this slice changes is TASTE 6 on a refusal: when the
 * machine says the checkout is on its default branch, the escape tap is the next
 * action and the publish tap steps back to a bordered peer. Everything else —
 * the labels, the disabled condition, Escape — is the contract it was.
 */
vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
  publishTaskPullRequest: vi.fn(),
  createTaskBranch: vi.fn(),
}));

import { createTaskBranch, publishTaskPullRequest, type PublishReport } from "../../api/client";

const mocked = {
  publishTaskPullRequest: vi.mocked(publishTaskPullRequest),
  createTaskBranch: vi.mocked(createTaskBranch),
};

const draft = { title: "Fix the thing", body: "What changed, and why." };

function setup(props: Partial<Parameters<typeof PublishPanel>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <PublishPanel
      taskId="task-1"
      machine={{ text: "node-1", known: true }}
      repo="example/kin"
      branch="kin/task/task-1/g1"
      draft={draft}
      onClose={onClose}
      {...props}
    />,
  );
  return { ...view, onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PublishPanel", () => {
  it("offers exactly one filled primary on the publish sheet", async () => {
    mocked.publishTaskPullRequest.mockResolvedValue({
      blocked: "default_branch",
      branch: "main",
      pushed: false,
      reason: "the checkout is on main",
    } as PublishReport);
    const { container } = setup();

    fireEvent.click(screen.getByRole("button", { name: t("publish.action") }));

    const escape = await screen.findByRole("button", { name: t("publish.escape") });
    expect(escape.className).toContain("kin-btn-primary");
    expect(container.querySelectorAll(".kin-btn-primary")).toHaveLength(1);
  });

  it("keeps the publish label and disabled state while the words are refused", async () => {
    mocked.publishTaskPullRequest.mockResolvedValue({ pushed: false } as PublishReport);
    const empty = setup({ draft: { title: "   ", body: "" } });
    const refused = screen.getByRole("button", {
      name: t("publish.action"),
    }) as HTMLButtonElement;
    expect(refused.disabled).toBe(true);
    empty.unmount();

    setup({ draft: { title: "  Fix the thing  ", body: "What changed, and why." } });
    const publish = screen.getByRole("button", { name: t("publish.action") }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);

    fireEvent.click(publish);
    await waitFor(() => expect(mocked.publishTaskPullRequest).toHaveBeenCalledTimes(1));
    expect(mocked.publishTaskPullRequest).toHaveBeenCalledWith("task-1", {
      title: "Fix the thing",
      body: "What changed, and why.",
    });
  });

  it("closes on Escape through the close control", () => {
    const { onClose } = setup();

    expect(screen.getByRole("button", { name: t("publish.close") })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
