// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import { t } from "../../i18n";
import PanelSurface from "../layout/PanelSurface";
import FloatingApproval from "./FloatingApproval";

/**
 * One topmost surface per screen.
 *
 * A panel is what the reader opened; the floating approval is what arrived. At
 * 390 a panel is full-bleed, so the decision card painted over it covered the
 * file body *and* the panel's own approval area — two answer surfaces for one
 * decision, and the one underneath unreadable. While a visible panel is open
 * the floating approval keeps the strip it already gives a phone tab root: the
 * approval stays noticeable and one tap from its task, but the card is not
 * mounted at all. Closing the panel brings the card back exactly as before.
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
  return { props, onDecide, onOpenTask };
}

function panel(hidden = false): ReactNode {
  return (
    <PanelSurface label="Files" hidden={hidden}>
      file body
    </PanelSurface>
  );
}

/** A page band — the conversation's composer — laid out from `top` down. */
function composerBand(top: number): HTMLDivElement {
  const chrome = document.createElement("div");
  chrome.setAttribute("data-kin-bottom-chrome", "");
  chrome.getBoundingClientRect = () =>
    ({ top, bottom: 768, left: 0, right: 390, width: 390, height: 768 - top }) as DOMRect;
  return chrome;
}

/** The panel's own docked furniture — the comment box or the comments tray. */
function DockedRegion({ top }: { top: number }) {
  return (
    <section
      aria-label="Comment"
      ref={(element) => {
        if (!element) return;
        element.getBoundingClientRect = () =>
          ({ top, bottom: 768, left: 0, right: 390, width: 390, height: 768 - top }) as DOMRect;
      }}
    />
  );
}

/**
 * A phone-width viewport. The strip only treats a panel as covering the
 * conversation below `lg`; jsdom is 1024 wide by default.
 */
function viewport(width: number, height = 768): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
  return () => {
    if (original) Object.defineProperty(window, "innerWidth", original);
    else delete (window as unknown as { innerWidth?: number }).innerWidth;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 768,
    });
  };
}

const approveButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.approve")) });
const denyButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.deny")) });

describe("FloatingApproval with a panel open", () => {
  it("an open panel leaves only the strip, never the decision card", () => {
    const { props } = setup();
    render(
      <>
        {panel()}
        <FloatingApproval {...props} />
      </>,
    );

    // The strip: one live region, the task link, the queue behind it.
    const strip = document.querySelector("aside > [role='status']");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();

    // …and no decision surface painted over the panel body.
    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();
  });

  it("closing the panel brings the decision card back", () => {
    const { props, onDecide } = setup();
    const view = render(
      <>
        {panel()}
        <FloatingApproval {...props} />
      </>,
    );
    expect(approveButton()).toBeNull();

    view.rerender(<FloatingApproval {...props} />);

    expect(approveButton()).toBeTruthy();
    expect(denyButton()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.approve")) }));
    // The queue still answers the approval that has waited longest.
    expect(onDecide).toHaveBeenCalledWith("oldest", "approved");
  });

  it("two panels share one presence", () => {
    const { props } = setup();
    const view = render(
      <>
        <PanelSurface key="files" label="Files">
          file body
        </PanelSurface>
        <PanelSurface key="pr" label="Pull request">
          pr body
        </PanelSurface>
        <FloatingApproval {...props} />
      </>,
    );
    expect(approveButton()).toBeNull();

    // Closing one panel leaves the other on the screen, so the card stays away.
    view.rerender(
      <>
        <PanelSurface key="files" label="Files">
          file body
        </PanelSurface>
        <FloatingApproval {...props} />
      </>,
    );

    expect(approveButton()).toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
  });

  it("a hidden panel does not suppress the card", () => {
    // The terminal stays mounted once opened and is hidden when it closes: a
    // surface that is not painted cannot be covered.
    const { props } = setup();
    render(
      <>
        {panel(true)}
        <FloatingApproval {...props} />
      </>,
    );

    expect(approveButton()).toBeTruthy();
    expect(denyButton()).toBeTruthy();
  });

  it("a phone tab root is unchanged", () => {
    // The `raised` path already kept the strip; with no panel open it must
    // still be the whole surface, not a card.
    const { props } = setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    render(<FloatingApproval {...props} />);

    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    expect(control.textContent).toContain("+1");
  });

  it("keeps the strip's label, task and count 8px apart", () => {
    // Astryx wraps the button's children in its own label span, so a `gap` on
    // the button separated nothing and every strip-only screen read
    // `等待处理[seed] …` with no space. The row inside the button carries it.
    const { props } = setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    render(<FloatingApproval {...props} />);

    const control = screen.getByRole("button", { name: /Fix the tests/ });
    const row = control.querySelector("span.gap-2");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("flex");
    expect(row?.className).toContain("items-center");
    // One row holds all three parts, so the gap is between them.
    expect(screen.getByText(t("approval.floatingLabel")).parentElement).toBe(row);
    expect(screen.getByText("Fix the tests").parentElement).toBe(row);
    expect(screen.getByText("+1").parentElement).toBe(row);
  });

  it("moves the strip clear of the column panel's 380px", () => {
    // At 1100 the pill used to sit inside the panel column, over the diff
    // comment box and the comments tray header.
    const restore = viewport(1100);
    const chrome = composerBand(600);
    document.body.appendChild(chrome);
    try {
      const { props } = setup();
      const view = render(
        <>
          <PanelSurface label="Files" shape="column">
            file body
          </PanelSurface>
          <FloatingApproval {...props} />
        </>,
      );

      const aside = view.container.querySelector("aside");
      expect(aside?.className).toContain("lg:right-[calc(380px+1.5rem)]");
      // The conversation — and its composer — is still on screen beside the
      // column, so the strip still clears that band.
      expect((aside as HTMLElement).style.bottom).toBe("176px");
    } finally {
      chrome.remove();
      restore();
    }
  });

  it("does not offset for an overlay panel, which covers the conversation", () => {
    const chrome = composerBand(600);
    document.body.appendChild(chrome);
    try {
      const { props } = setup();
      const view = render(
        <>
          {panel()}
          <FloatingApproval {...props} />
        </>,
      );
      expect(view.container.querySelector("aside")?.className).not.toContain(
        "lg:right-[calc(380px+1.5rem)]",
      );
    } finally {
      chrome.remove();
    }
  });

  it("clears the panel's own comment box instead of the covered composer", () => {
    // A full-bleed panel hides the conversation, so the composer's box is not
    // what is on screen: measuring it parked the pill over the quoted diff
    // line in the comment box. The strip clears the panel's docked furniture.
    const restore = viewport(390, 844);
    const chrome = composerBand(600);
    document.body.appendChild(chrome);
    try {
      const { props } = setup();
      const view = render(
        <>
          <PanelSurface label="Files">
            <DockedRegion top={620} />
          </PanelSurface>
          <FloatingApproval {...props} />
        </>,
      );

      const aside = view.container.querySelector("aside") as HTMLElement;
      // 844 - 620 + 8: above the comment box, not above the covered composer
      // (which would be 844 - 600 + 8 = 252px).
      expect(aside.style.bottom).toBe("232px");
    } finally {
      chrome.remove();
      restore();
    }
  });

  it("keeps the fixed offset when a covering panel docks nothing", () => {
    const restore = viewport(390, 844);
    try {
      const { props } = setup();
      const view = render(
        <>
          {panel()}
          <FloatingApproval {...props} />
        </>,
      );
      // No measurement: the CSS fallback above the phone's bottom edge stands,
      // clear of everything the panel paints.
      expect((view.container.querySelector("aside") as HTMLElement).style.bottom).toBe("");
    } finally {
      restore();
    }
  });
});
