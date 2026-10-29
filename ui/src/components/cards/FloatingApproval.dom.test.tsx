// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import { t } from "../../i18n";
import FloatingApproval from "./FloatingApproval";

/**
 * The floating approval card. What is pinned here is the part that is a
 * decision rather than layout: which approval it shows (the one that has
 * waited longest, so a queue cannot starve), that answering it answers *that*
 * one, and that it says how many are behind it.
 */
function approval(id: string, taskId: string, createdAt: number): Approval {
  return {
    id,
    task_id: taskId,
    kind: "tool",
    payload: { tool: "write_file", input: { path: "/tmp/a.txt" } },
    decision: "pending",
    created_at: createdAt,
  };
}

/** A page's bottom band, laid out between `top` and the bottom of the screen. */
function band(top: number): HTMLDivElement {
  const chrome = document.createElement("div");
  chrome.setAttribute("data-kin-bottom-chrome", "");
  chrome.getBoundingClientRect = () =>
    ({ top, bottom: window.innerHeight, left: 0, right: 390 }) as DOMRect;
  return chrome;
}

/** A band that is in the document but not laid out, as a hidden pane's is. */
function hiddenBand(): HTMLDivElement {
  const chrome = document.createElement("div");
  chrome.setAttribute("data-kin-bottom-chrome", "");
  chrome.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
  return chrome;
}

function setup(overrides: Partial<React.ComponentProps<typeof FloatingApproval>> = {}) {
  const onDecide = vi.fn();
  const onOpenTask = vi.fn();
  const props = {
    approvals: [approval("newer", "task-2", 200), approval("oldest", "task-1", 100)],
    titleFor: (taskId: string) => (taskId === "task-1" ? "Fix the tests" : "Write the docs"),
    busy: {},
    onDecide,
    onOpenTask,
    raised: true,
    screenKey: "/sessions",
    expectsBottomChrome: true,
    ...overrides,
  };
  const view = render(<FloatingApproval {...props} />);
  return { ...view, props, onDecide, onOpenTask };
}

describe("FloatingApproval", () => {
  it("renders nothing when nothing is waiting", () => {
    const { container } = setup({ approvals: [] });
    expect(container.innerHTML).toBe("");
  });

  it("shows the approval that has waited longest, not the newest", () => {
    setup();
    // The title button is the oldest approval's task, even though the newer one
    // is first in the list the resource publishes.
    expect(screen.getByRole("button", { name: "Fix the tests" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write the docs" })).toBeNull();
  });

  it("counts the approvals behind the one it shows", () => {
    setup();
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("answers the approval on screen", () => {
    const { onDecide } = setup();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.approve")) }));
    expect(onDecide).toHaveBeenCalledWith("oldest", "approved");
  });

  it("denies the approval on screen", () => {
    const { onDecide } = setup();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.deny")) }));
    expect(onDecide).toHaveBeenCalledWith("oldest", "denied");
  });

  it("opens the task the approval belongs to", () => {
    const { onOpenTask } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Fix the tests" }));
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
  });

  it("falls back to a generic name when the task is not loaded", () => {
    setup({ titleFor: () => "" });
    expect(screen.getByRole("button", { name: t("approval.floatingFallback") })).toBeTruthy();
  });

  it("names a task the shell's list cannot, from the approval's own row", () => {
    setup({
      approvals: [{ ...approval("oldest", "task-1", 100), task_title: "Joined by the API" }],
      titleFor: () => "",
    });
    expect(screen.getByRole("button", { name: "Joined by the API" })).toBeTruthy();
  });

  it("prefers the live task list to the title joined when the list was read", () => {
    // The list follows a rename; the joined title is whatever it was when the
    // pending list was fetched.
    setup({
      approvals: [{ ...approval("oldest", "task-1", 100), task_title: "Old name" }],
      titleFor: () => "Fix the tests",
    });
    expect(screen.getByRole("button", { name: "Fix the tests" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Old name" })).toBeNull();
  });

  it("shows one approval, so two cards never answer the same decision", () => {
    setup();
    expect(screen.getAllByRole("button", { name: new RegExp(t("chat.approve")) })).toHaveLength(1);
  });

  it("moves focus to the next decision after one is answered", () => {
    // Answering unmounts the card that held focus; a keyboard user would be
    // dropped to the document body mid-queue with nothing to tab from.
    const { props, rerender } = setup();
    const approve = screen.getByRole("button", { name: new RegExp(t("chat.approve")) });
    approve.focus();
    fireEvent.click(approve);

    rerender(<FloatingApproval {...props} approvals={[approval("newer", "task-2", 200)]} />);

    const next = screen.getByRole("button", { name: new RegExp(t("chat.approve")) });
    expect(document.activeElement).toBe(next);
    expect(next.className).toContain("kin-btn-approve");
  });

  it("lands on the same choice after a deny", () => {
    // A reader denying one request is one reflexive Enter away from approving
    // the next if focus always went to Approve.
    const { props, rerender } = setup();
    const deny = screen.getByRole("button", { name: new RegExp(t("chat.deny")) });
    deny.focus();
    fireEvent.click(deny);

    rerender(<FloatingApproval {...props} approvals={[approval("newer", "task-2", 200)]} />);

    const next = screen.getByRole("button", { name: new RegExp(t("chat.deny")) });
    expect(document.activeElement).toBe(next);
    expect(next.className).toContain("kin-btn-deny");
  });

  it("does not pull focus later when the decision failed", () => {
    // A failed decision leaves the same card up. The armed focus intent must
    // not survive it: minutes later an approval expiring out of the queue
    // changes which one is current, and focus would be yanked out of wherever
    // the reader had moved on to.
    const { props, rerender } = setup();
    const approve = screen.getByRole("button", { name: new RegExp(t("chat.approve")) });
    approve.focus();
    fireEvent.click(approve);

    // What the hook does: mark busy, then clear it when the daemon refuses.
    rerender(<FloatingApproval {...props} busy={{ oldest: "approved" }} />);
    rerender(<FloatingApproval {...props} busy={{}} />);

    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    try {
      elsewhere.focus();
      rerender(<FloatingApproval {...props} approvals={[approval("newer", "task-2", 200)]} />);
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it("does not advertise keys it does not handle", () => {
    // `a`/`d` decide the transcript's or the inbox's ringed approval. On a card
    // floating over another screen the letters would promise a key that
    // answers something else.
    setup();
    expect(screen.getByRole("button", { name: t("chat.approve") })).toBeTruthy();
    expect(screen.getByRole("button", { name: t("chat.deny") })).toBeTruthy();
  });

  it("sits above the page's own bottom furniture when the page marks it", () => {
    // A conversation pins a composer (and the strip above it) to the bottom,
    // and its height changes with attachments. The card measures that band
    // rather than guessing, so it never covers the input.
    const chrome = band(600);
    document.body.appendChild(chrome);
    try {
      const { container } = setup({ screenKey: "/tasks/task-1" });
      const aside = container.querySelector("aside");
      expect(aside?.style.bottom).toBe(`${window.innerHeight - 600 + 8}px`);
    } finally {
      chrome.remove();
    }
  });

  it("measures the draft screen's composer as well as a conversation's", () => {
    // `/new` is the landing route and pins the same composer band; it is not a
    // conversation, so a rule keyed on the task route alone would cover it.
    const chrome = band(640);
    document.body.appendChild(chrome);
    try {
      const { container } = setup({ screenKey: "/new" });
      expect(container.querySelector("aside")?.style.bottom).toBe(
        `${window.innerHeight - 640 + 8}px`,
      );
    } finally {
      chrome.remove();
    }
  });

  it("re-measures when the page draws its composer after the card", async () => {
    // The bug this pins: a conversation mounts the shell first and the
    // composer once the task has loaded, so an offset measured at mount found
    // nothing and the card sat on top of the input for the rest of the visit.
    const { container } = setup({ screenKey: "/tasks/task-1" });
    expect(container.querySelector("aside")?.style.bottom).toBe("");
    const chrome = band(500);
    document.body.appendChild(chrome);
    try {
      await waitFor(() =>
        expect(container.querySelector("aside")?.style.bottom).toBe(
          `${window.innerHeight - 500 + 8}px`,
        ),
      );
    } finally {
      chrome.remove();
    }
  });

  it("does not measure a band that is not laid out", () => {
    // `TaskSessionHost` keeps visited conversations mounted and hides them with
    // `display:none`. A hidden pane's band has no box, and an offset measured
    // against zero would put the card off the top of the screen; the card must
    // keep its dock-clearing fallback instead of believing that measurement.
    const chrome = hiddenBand();
    document.body.appendChild(chrome);
    try {
      const { container } = setup({ screenKey: "/tasks/task-1" });
      const aside = container.querySelector("aside");
      expect(aside?.style.bottom).toBe("");
      expect(aside?.className).toContain("bottom-[calc(9.25rem");
    } finally {
      chrome.remove();
    }
  });

  it("re-measures on a new route rather than keeping the last screen's offset", async () => {
    const first = band(600);
    document.body.appendChild(first);
    try {
      const { container, props, rerender } = setup({ screenKey: "/tasks/task-1" });
      expect(container.querySelector("aside")?.style.bottom).toBe(
        `${window.innerHeight - 600 + 8}px`,
      );

      first.remove();
      const second = band(520);
      document.body.appendChild(second);
      try {
        rerender(<FloatingApproval {...props} screenKey="/tasks/task-2" />);
        await waitFor(() =>
          expect(container.querySelector("aside")?.style.bottom).toBe(
            `${window.innerHeight - 520 + 8}px`,
          ),
        );
      } finally {
        second.remove();
      }
    } finally {
      first.remove();
    }
  });

  it("drops the measured offset on a route without a composer", () => {
    const chrome = band(600);
    document.body.appendChild(chrome);
    try {
      const { container, props, rerender } = setup({
        screenKey: "/tasks/task-1",
        expectsBottomChrome: true,
      });
      expect(container.querySelector("aside")?.style.bottom).not.toBe("");

      rerender(<FloatingApproval {...props} screenKey="/inbox" expectsBottomChrome={false} />);
      expect(container.querySelector("aside")?.style.bottom).toBe("");
    } finally {
      chrome.remove();
    }
  });

  it("does not go looking for a band on a route that has none", async () => {
    // The inbox has a dock but no composer. A band that some other mounted
    // screen leaves in the document must not be measured from here.
    const chrome = band(600);
    document.body.appendChild(chrome);
    try {
      const { container } = setup({ screenKey: "/inbox", expectsBottomChrome: false });
      await waitFor(() => expect(container.querySelector("aside")).not.toBeNull());
      expect(container.querySelector("aside")?.style.bottom).toBe("");
    } finally {
      chrome.remove();
    }
  });

  it("clears the dock when the page marks nothing", () => {
    const { container } = setup({ screenKey: "/inbox", expectsBottomChrome: false, raised: true });
    const aside = container.querySelector("aside");
    expect(aside?.style.bottom).toBe("");
    expect(aside?.className).toContain("bottom-[calc(9.25rem");
    expect(aside?.className).toContain("md:bottom-6");
  });

  it("clears only the dock's own height when the dock is not on screen", () => {
    const { container } = setup({
      screenKey: "/inbox",
      expectsBottomChrome: false,
      raised: false,
    });
    expect(container.querySelector("aside")?.className).toContain("bottom-[calc(5.5rem");
  });

  it("stops watching a measured band when it unmounts", () => {
    const disconnected = vi.fn();
    class Observer {
      observe() {}
      disconnect() {
        disconnected();
      }
    }
    vi.stubGlobal("ResizeObserver", Observer);
    const chrome = band(600);
    document.body.appendChild(chrome);
    try {
      const { unmount } = setup({ screenKey: "/tasks/task-1" });
      unmount();
      expect(disconnected).toHaveBeenCalled();
    } finally {
      chrome.remove();
      vi.unstubAllGlobals();
    }
  });

  it("stops waiting for a band that never arrived when it unmounts", () => {
    // The cold-load path watches the document for the band. Leaving the route
    // before the composer ever mounts must not leave that observer behind.
    const disconnected = vi.fn();
    class Observer {
      observe() {}
      disconnect() {
        disconnected();
      }
    }
    vi.stubGlobal("MutationObserver", Observer);
    try {
      const { unmount } = setup({ screenKey: "/tasks/task-1" });
      unmount();
      expect(disconnected).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
