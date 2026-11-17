// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import PullRequestPanel from "./PullRequestPanel";

/**
 * The read-only pull-request panel.
 *
 * What it guarantees is honesty about a cached answer: a number is shown with
 * its age, a refresh replaces it, a failed refresh leaves the last answer
 * standing with the error beside it, and a branch nobody has looked at gets one
 * implicit query — the only read the panel makes without being asked.
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
  getTaskPullRequest: vi.fn(),
  refreshTaskPullRequest: vi.fn(),
}));

import {
  getTaskPullRequest,
  refreshTaskPullRequest,
  type PullRequestObservation,
  type TaskPullRequestSnapshot,
} from "../../api/client";

const mocked = {
  getTaskPullRequest: vi.mocked(getTaskPullRequest),
  refreshTaskPullRequest: vi.mocked(refreshTaskPullRequest),
};

const branch = "kin/task/task-1/g1";
const repo = "github.com/example/kin";
const seenAt = Date.now() - 60_000;

function observation(over: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    repo,
    head_branch: branch,
    task_id: "task-1",
    number: 123,
    url: "https://github.com/example/kin/pull/123",
    title: "Restore the pull request panel",
    state: "open",
    base_branch: "main",
    ci_state: "success",
    ci_summary: JSON.stringify({ total: 3, passed: 3, failed: 0, pending: 0, failing: [] }),
    observed_at: seenAt,
    attempted_at: seenAt,
    ...over,
  };
}

function snapshot(over: Partial<TaskPullRequestSnapshot> = {}): TaskPullRequestSnapshot {
  return {
    repo,
    branch,
    gh: { available: true },
    observations: [observation()],
    ...over,
  };
}

function setup(props: Partial<Parameters<typeof PullRequestPanel>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(<PullRequestPanel taskId="task-1" onClose={onClose} {...props} />);
  return { ...view, onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PullRequestPanel", () => {
  it("shows the pull request number, state and checks", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    setup();

    expect(await screen.findByText("#123")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://github.com/example/kin/pull/123",
    );
    expect(screen.getByText(t("pr.stateOpen"))).toBeTruthy();
    // The daemon's own counts, not a generic "checks passed".
    expect(screen.getByText(t("pr.ciSuccess", { total: "3" }))).toBeTruthy();
  });

  it("a refresh replaces the card with the newer answer", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    mocked.refreshTaskPullRequest.mockResolvedValue(
      snapshot({ observations: [observation({ state: "merged" })] }),
    );
    setup();
    await screen.findByText("#123");

    fireEvent.click(screen.getByRole("button", { name: t("pr.refresh") }));

    expect(await screen.findByText(t("pr.stateMerged"))).toBeTruthy();
    expect(mocked.refreshTaskPullRequest).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh keeps the last answer", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    mocked.refreshTaskPullRequest.mockRejectedValue(new Error("rate limited"));
    setup();
    await screen.findByText("#123");

    fireEvent.click(screen.getByRole("button", { name: t("pr.refresh") }));

    // The error is beside the card, not instead of it: the number is what the
    // reader opened the panel to find.
    expect(await screen.findByText("rate limited")).toBeTruthy();
    expect(screen.getByText("#123")).toBeTruthy();
  });

  it("a failed first read shows the error and no card", async () => {
    mocked.getTaskPullRequest.mockRejectedValue(new Error("GitHub is not reachable"));
    setup();

    expect(await screen.findByText("GitHub is not reachable")).toBeTruthy();
    expect(screen.queryByText("#123")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("asks once for a branch that was never checked", async () => {
    // The branch has a checkout but no row: no background pass will ever ask
    // about it, so opening the panel is the one chance to.
    mocked.getTaskPullRequest.mockResolvedValue(snapshot({ observations: [] }));
    mocked.refreshTaskPullRequest.mockResolvedValue(snapshot());
    setup();

    await waitFor(() => expect(mocked.refreshTaskPullRequest).toHaveBeenCalledTimes(1));
    expect(mocked.refreshTaskPullRequest).toHaveBeenCalledWith("task-1");
    expect(await screen.findByText("#123")).toBeTruthy();
    // The answer lands and the effect does not ask a second time.
    expect(mocked.refreshTaskPullRequest).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a branch that already has an answer", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    setup();

    await screen.findByText("#123");
    expect(mocked.refreshTaskPullRequest).not.toHaveBeenCalled();
  });

  it("Escape closes the panel", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const { onClose } = setup();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
