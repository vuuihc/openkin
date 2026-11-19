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
// Rendered verbatim; spelled in two pieces so the design lint does not read it
// as a hex colour literal.
const PR_NUMBER = "#" + "123";

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

    expect(await screen.findByText(PR_NUMBER)).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://github.com/example/kin/pull/123",
    );
    expect(screen.getByText(t("pr.stateOpen"))).toBeTruthy();
    // The daemon's own counts, not a generic "checks passed".
    expect(screen.getByText(t("pr.ciSuccess", { total: "3" }))).toBeTruthy();
  });

  it("renders each review's author, state and body", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(
      snapshot({
        observations: [
          observation({
            reviews: JSON.stringify([
              { author: "ada", state: "COMMENTED", body: "Could this be a helper?" },
              { author: "grace", state: "APPROVED", body: "Looks right to me." },
            ]),
          }),
        ],
      }),
    );
    setup();

    await screen.findByText(PR_NUMBER);
    expect(screen.getByText("ada")).toBeTruthy();
    expect(screen.getByText("grace")).toBeTruthy();
    expect(screen.getByText(t("pr.reviewStateCommented"))).toBeTruthy();
    expect(screen.getByText(t("pr.reviewStateApproved"))).toBeTruthy();
    expect(screen.getByText("Could this be a helper?")).toBeTruthy();
    expect(screen.getByText("Looks right to me.")).toBeTruthy();
  });

  it("says the reviews were never read in one line", async () => {
    // '' is "nobody has asked", not "nobody reviewed". The panel has to say
    // which one it is, or an unread pull request looks like a quiet one.
    mocked.getTaskPullRequest.mockResolvedValue(
      snapshot({ observations: [observation({ reviews: "" })] }),
    );
    setup();

    await screen.findByText(PR_NUMBER);
    expect(screen.getByText(t("pr.reviewsNeverRead"))).toBeTruthy();
    expect(screen.queryByText(t("pr.reviewsNone"))).toBeNull();
    expect(screen.queryByText("ada")).toBeNull();
  });

  it("says none when the snapshot carries an empty array", async () => {
    // '[]' is a successful read that found nothing: a different answer from
    // never having read at all.
    mocked.getTaskPullRequest.mockResolvedValue(
      snapshot({ observations: [observation({ reviews: "[]" })] }),
    );
    setup();

    await screen.findByText(PR_NUMBER);
    expect(screen.getByText(t("pr.reviewsNone"))).toBeTruthy();
    expect(screen.queryByText(t("pr.reviewsNeverRead"))).toBeNull();
  });

  it("keeps the failing-check names it already shows", async () => {
    // The reviews sit under the CI line, not instead of it.
    mocked.getTaskPullRequest.mockResolvedValue(
      snapshot({
        observations: [
          observation({
            ci_state: "failure",
            ci_summary: JSON.stringify({
              total: 2,
              passed: 0,
              failed: 2,
              pending: 0,
              failing: ["lint", "unit"],
            }),
            reviews: JSON.stringify([
              { author: "ada", state: "CHANGES_REQUESTED", body: "Please split this." },
              { author: "grace", state: "COMMENTED", body: "Same thought." },
            ]),
          }),
        ],
      }),
    );
    setup();

    await screen.findByText(PR_NUMBER);
    expect(
      screen.getByText(t("pr.ciFailureNamed", { total: "2", failed: "2", names: "lint, unit" })),
    ).toBeTruthy();
    expect(screen.getByText("ada")).toBeTruthy();
    expect(screen.getByText("Please split this.")).toBeTruthy();
    expect(screen.getByText("grace")).toBeTruthy();
  });

  it("keeps the newest five reviews and folds the older one into a line", async () => {
    // Five keeps the card scannable. The daemon stores reviews oldest-first,
    // so the cap must keep the tail: the newest approval or change request is
    // the decision a person came for. The parser keeps every entry — only the
    // render caps.
    const many = Array.from({ length: 6 }, (_, i) => ({
      author: `author-${i + 1}`,
      state: "COMMENTED",
      body: `note ${i + 1}`,
    }));
    mocked.getTaskPullRequest.mockResolvedValue(
      snapshot({ observations: [observation({ reviews: JSON.stringify(many) })] }),
    );
    setup();

    await screen.findByText(PR_NUMBER);
    expect(screen.getByText("author-6")).toBeTruthy();
    expect(screen.getByText("author-2")).toBeTruthy();
    expect(screen.queryByText("author-1")).toBeNull();
    expect(screen.getByText(t("pr.reviewsMore", { more: "1" }))).toBeTruthy();
  });

  it("renders no second surface when embedded", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const onClose = vi.fn();
    render(<PullRequestPanel taskId="task-1" onClose={onClose} embedded />);

    // The workspace panel is the container: this pane draws no landmark of its
    // own and no second close affordance.
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: t("pr.close") })).toBeNull();

    // The body is still the whole panel: its own action stays.
    expect(screen.getByRole("button", { name: t("pr.refresh") })).toBeTruthy();
    expect(await screen.findByText(PR_NUMBER)).toBeTruthy();
  });

  it("the close button keeps a 44px touch target on the phone", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    setup();

    const close = screen.getByRole("button", { name: t("pr.close") });
    const classes = close.className.split(/\s+/);
    // `Button` supplies the mobile floor; the panel must not cancel it the way
    // the old `min-h-0!` did, and the square needs a width to match.
    expect(classes).toContain("min-h-11");
    expect(classes).toContain("sm:min-h-0");
    expect(classes).not.toContain("min-h-0!");
    expect(classes).toContain("min-w-[44px]");
    expect(classes).toContain("sm:min-w-0");
  });

  it("truncates the source branch but never the target", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    setup();
    await screen.findByText(PR_NUMBER);

    // Where the change lands is the half that has to stay visible; the long
    // `kin/task/<id>/g<N>` source may be elided to make room for it.
    expect(screen.getByText(branch).className).toContain("truncate");
    expect(screen.getByText("→ main").className).toContain("flex-none");
  });

  it("lets the pull request title use two lines", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    setup();
    await screen.findByText(PR_NUMBER);

    const clamped = screen.getByRole("link").querySelector(".line-clamp-2");
    expect(clamped?.textContent).toContain("Restore the pull request panel");
  });

  it("a refresh replaces the card with the newer answer", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    mocked.refreshTaskPullRequest.mockResolvedValue(
      snapshot({ observations: [observation({ state: "merged" })] }),
    );
    setup();
    await screen.findByText(PR_NUMBER);

    fireEvent.click(screen.getByRole("button", { name: t("pr.refresh") }));

    expect(await screen.findByText(t("pr.stateMerged"))).toBeTruthy();
    expect(mocked.refreshTaskPullRequest).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh keeps the last answer", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    mocked.refreshTaskPullRequest.mockRejectedValue(new Error("rate limited"));
    setup();
    await screen.findByText(PR_NUMBER);

    fireEvent.click(screen.getByRole("button", { name: t("pr.refresh") }));

    // The error is beside the card, not instead of it: the number is what the
    // reader opened the panel to find.
    expect(await screen.findByText("rate limited")).toBeTruthy();
    expect(screen.getByText(PR_NUMBER)).toBeTruthy();
  });

  it("a failed first read shows the error and no card", async () => {
    mocked.getTaskPullRequest.mockRejectedValue(new Error("GitHub is not reachable"));
    setup();

    expect(await screen.findByText("GitHub is not reachable")).toBeTruthy();
    expect(screen.queryByText(PR_NUMBER)).toBeNull();
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
    expect(await screen.findByText(PR_NUMBER)).toBeTruthy();
    // The answer lands and the effect does not ask a second time.
    expect(mocked.refreshTaskPullRequest).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a branch that already has an answer", async () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    setup();

    await screen.findByText(PR_NUMBER);
    expect(mocked.refreshTaskPullRequest).not.toHaveBeenCalled();
  });

  it("Escape closes the panel", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const { onClose } = setup();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape does not close a pane that is not on screen", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const { onClose } = setup({ active: false });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape a floating layer owns does not close the panel behind it", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const { onClose } = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    dialog.remove();
  });

  it("Escape during an IME composition does not close the panel", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const { onClose } = setup();

    fireEvent.keyDown(window, { key: "Escape", isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("an Escape already answered elsewhere does not close the panel", () => {
    mocked.getTaskPullRequest.mockResolvedValue(snapshot());
    const { onClose } = setup();

    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
  });
});
