// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The conversation shape: a pushed screen with a composer band. The decision
// card — Approve/Deny, focus hand-back, the opaque base under it — belongs to
// that surface; a phone tab root gets the compact strip instead, so those
// tests opt into `raised` explicitly.
function setup(overrides: Partial<React.ComponentProps<typeof FloatingApproval>> = {}) {
  const onDecide = vi.fn();
  const onOpenTask = vi.fn();
  const props = {
    approvals: [approval("newer", "task-2", 200), approval("oldest", "task-1", 100)],
    titleFor: (taskId: string) => (taskId === "task-1" ? "Fix the tests" : "Write the docs"),
    busy: {},
    onDecide,
    onOpenTask,
    raised: false,
    screenKey: "/tasks/task-1",
    expectsBottomChrome: true,
    ...overrides,
  };
  const view = render(<FloatingApproval {...props} />);
  return { ...view, props, onDecide, onOpenTask };
}

describe("FloatingApproval over a session row", () => {
  type Box = { top: number; bottom: number; left: number; right: number };

  // The phone the defect was filed on: 390×844 with a safe-area inset.
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 844,
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 768,
    });
  });

  function domRect(box: Box): DOMRect {
    return {
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => box,
    } as DOMRect;
  }

  /** A conversation row the reader can tap, at the box the report measured. */
  function sessionRow(box: Box): HTMLDivElement {
    const row = document.createElement("div");
    row.setAttribute("data-session-row", "imported");
    row.getBoundingClientRect = () => domRect(box);
    document.body.appendChild(row);
    return row;
  }

  // The dogfood reading at 390×844: the list at max scroll, the strip at
  // y 610–662, and the last row's centre (y 630) inside it.
  const STRIP: Box = { top: 610, bottom: 662, left: 12, right: 378 };
  const ROW_UNDER_STRIP: Box = { top: 596, bottom: 640, left: 12, right: 378 };
  const EMPTY: Box = { top: 0, bottom: 0, left: 0, right: 0 };

  /**
   * jsdom has no layout, so the surface and the pill are given the boxes the
   * report measured after mount, then the route changes to re-run the
   * measurement in the layout effect.
   */
  function remeasure(
    container: HTMLElement,
    props: React.ComponentProps<typeof FloatingApproval>,
    rerender: (ui: React.ReactElement) => void,
    strip: Box = STRIP,
  ): void {
    const aside = container.querySelector("aside") as HTMLElement | null;
    expect(aside).not.toBeNull();
    aside!.getBoundingClientRect = () => domRect(strip);
    const status = aside!.querySelector("[role='status']") as HTMLElement;
    status.getBoundingClientRect = () => domRect(strip);
    rerender(<FloatingApproval {...props} screenKey="/sessions?remeasure" />);
  }

  it("yields the pill at a phone tab root when a row is under it", () => {
    // The reported state: the pill came to rest over the last conversation
    // row, its title hidden under it, and the row's centre hit-tested to the
    // pill's title span — the list's own entry ate the tap meant for the row.
    const row = sessionRow(ROW_UNDER_STRIP);
    try {
      const { container, props, rerender } = setup({
        raised: true,
        expectsBottomChrome: false,
        screenKey: "/sessions",
      });
      // The pill is the surface on this route…
      expect(container.querySelector("aside")).not.toBeNull();

      remeasure(container, props, rerender);

      // …but a row under it is the entry, so the whole visible surface yields:
      // no pill, no decision card, no hit target over the row.
      expect(container.querySelector("aside")).toBeNull();
      expect(container.querySelector("[data-kin-approval-card]")).toBeNull();
      expect(screen.queryByRole("button", { name: /Fix the tests/ })).toBeNull();
      // The arrival region survives: an approval landing while the reader is
      // on the list is still announced, sr-only and outside the surface.
      const live = container.querySelector("[role='status']");
      expect(live).not.toBeNull();
      expect(live?.getAttribute("aria-live")).toBe("polite");
      expect(live?.classList.contains("sr-only")).toBe(true);
      expect(live?.textContent).toContain(t("approval.floatingLabel"));
      expect(live?.textContent).toContain("Fix the tests");
    } finally {
      row.remove();
    }
  });

  it("keeps the pill at a tab root when no row is under it", () => {
    // The control: `/routines` and `/settings` have no conversation list, so
    // the pill is their only entry and must stay.
    const { container } = setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/routines",
    });
    expect(container.querySelector("aside")).not.toBeNull();
    expect(container.querySelector("aside > [role='status']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
  });

  it("ignores rows in a hidden pane", () => {
    // A cached conversation keeps its rows mounted behind `display:none`. A
    // row with no box is not painted, and counting it would hide the pill
    // forever once a second conversation had been opened.
    const row = sessionRow(EMPTY);
    try {
      const { container, props, rerender } = setup({
        raised: true,
        expectsBottomChrome: false,
        screenKey: "/sessions",
      });
      remeasure(container, props, rerender);
      expect(container.querySelector("aside")).not.toBeNull();
      expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
    } finally {
      row.remove();
    }
  });

  it("brings the pill back when the row scrolls clear", async () => {
    // Yielding is a measurement, not a latch: the list scrolls, and once no
    // row is under the pill it is the way in again.
    const row = sessionRow(ROW_UNDER_STRIP);
    try {
      const { container, props, rerender } = setup({
        raised: true,
        expectsBottomChrome: false,
        screenKey: "/sessions",
      });
      remeasure(container, props, rerender);
      expect(container.querySelector("aside")).toBeNull();

      row.getBoundingClientRect = () => domRect({ top: 100, bottom: 144, left: 12, right: 378 });
      fireEvent(window, new Event("resize"));

      await waitFor(() => expect(container.querySelector("aside")).not.toBeNull());
      expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
    } finally {
      row.remove();
    }
  });
});

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

  it("keeps a phone tab root to the waiting strip, so every row stays tappable", () => {
    // The full card over the conversation list covered rows: a tap on the
    // seeded row at y≈416 landed on the panel's button instead of the row.
    // On the four phone tab roots the floating approval is one strip.
    const { container } = setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    expect(container.querySelector("aside")).not.toBeNull();
    // The strip's own live region (the facade's Button carries an internal
    // one for its busy state, so this is the aside's direct child).
    const strip = container.querySelector("aside > [role='status']");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("aria-live")).toBe("polite");
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    expect(control.textContent).toContain("Fix the tests");
    expect(control.textContent).toContain("+1");
    // No decision surface: neither the card's buttons nor its body.
    expect(screen.queryByRole("button", { name: new RegExp(t("chat.approve")) })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(t("chat.deny")) })).toBeNull();
    expect(container.querySelector("[class*='animate-slideIn']")).toBeNull();
  });

  it("still gives a pushed conversation the full decision card", () => {
    // The compact state must not leak into a conversation: that is where the
    // diff is explained and where answering in place is the point.
    const chrome = band(600);
    document.body.appendChild(chrome);
    try {
      const { onDecide } = setup({
        raised: false,
        screenKey: "/tasks/task-1",
        expectsBottomChrome: true,
      });
      expect(screen.getByRole("button", { name: new RegExp(t("chat.approve")) })).toBeTruthy();
      expect(screen.getByRole("button", { name: new RegExp(t("chat.deny")) })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.approve")) }));
      expect(onDecide).toHaveBeenCalledWith("oldest", "approved");
    } finally {
      chrome.remove();
    }
  });

  it("gives the waiting strip a 44px tap target", () => {
    const { container } = setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    const controls = container.querySelectorAll("aside button");
    // One target, not three: the label, the task and the count all live inside
    // it, so a thumb cannot land on a non-interactive fragment.
    expect(controls).toHaveLength(1);
    const control = controls[0] as HTMLElement;
    expect(control.className).toContain("min-h-11");
    expect(control.textContent).toContain(t("approval.floatingLabel"));
    expect(control.textContent).toContain("Fix the tests");
    expect(control.textContent).toContain("+1");
    // Its accessible name says what it opens and how many are behind it.
    const name = control.getAttribute("aria-label") ?? "";
    expect(name).toContain(t("approval.floatingLabel"));
    expect(name).toContain("Fix the tests");
    expect(name).toContain(t("approval.moreWaiting", { n: 1 }));
    expect(container.querySelectorAll("aside a")).toHaveLength(0);
  });

  it("keeps the +N count in the strip when more than one is waiting", () => {
    setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
      approvals: [
        approval("newest", "task-3", 300),
        approval("newer", "task-2", 200),
        approval("oldest", "task-1", 100),
      ],
    });
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    expect(control.textContent).toContain("+2");
    expect(control.getAttribute("aria-label")).toContain(t("approval.moreWaiting", { n: 2 }));
  });

  it("puts an opaque surface under the card, so list rows cannot show through", () => {
    // The card's own surface is a translucent orange tint — right on a solid
    // transcript pane, unreadable floating over the list, where row text bled
    // through the gradient. The wrapper is the opaque base.
    const { container } = setup();
    const surfaces = Array.from(container.querySelectorAll("aside > div.pointer-events-auto"));
    const cardSurface = surfaces.find((el) => el.querySelector("[class*='animate-slideIn']"));
    expect(cardSurface?.className).toContain("bg-kin-panel");
    // The waiting-count chip floats over the same rows.
    const chip = container.querySelector("aside > [role='status']");
    expect(chip?.className).toContain("bg-kin-panel");
    expect(chip?.className).not.toContain("kin-glass");
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
    // The hand-back is a class selector over the surface: the facade variant
    // has to keep carrying the exact class the effect queries.
    expect(next.className).toContain("kin-btn-approve");
    expect(next.className).toContain("kin-btn");
    expect(document.querySelector("aside")?.querySelector(".kin-btn-approve")).toBe(next);
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
    expect(next.className).toContain("kin-btn");
    expect(document.querySelector("aside")?.querySelector(".kin-btn-deny")).toBe(next);
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
    // `a`/`d` decide the transcript's ringed approval. On a card
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
      // A pushed conversation's fallback, not the tab root's: it clears the
      // composer band it could not measure.
      expect(aside?.className).toContain("bottom-[calc(5.5rem");
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

      rerender(<FloatingApproval {...props} screenKey="/sessions" expectsBottomChrome={false} />);
      expect(container.querySelector("aside")?.style.bottom).toBe("");
    } finally {
      chrome.remove();
    }
  });

  it("does not go looking for a band on a route that has none", async () => {
    // The list has a dock but no composer. A band that some other mounted
    // screen leaves in the document must not be measured from here.
    const chrome = band(600);
    document.body.appendChild(chrome);
    try {
      const { container } = setup({ screenKey: "/sessions", expectsBottomChrome: false });
      await waitFor(() => expect(container.querySelector("aside")).not.toBeNull());
      expect(container.querySelector("aside")?.style.bottom).toBe("");
    } finally {
      chrome.remove();
    }
  });

  it("clears the dock when the page marks nothing", () => {
    const { container } = setup({
      screenKey: "/sessions",
      expectsBottomChrome: false,
      raised: true,
    });
    const aside = container.querySelector("aside");
    expect(aside?.style.bottom).toBe("");
    expect(aside?.className).toContain("bottom-[calc(9.25rem");
    expect(aside?.className).toContain("md:bottom-6");
  });

  it("clears only the dock's own height when the dock is not on screen", () => {
    const { container } = setup({
      screenKey: "/sessions",
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
