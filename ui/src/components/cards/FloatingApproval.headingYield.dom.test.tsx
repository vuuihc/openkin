// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import { t } from "../../i18n";
import FloatingApproval from "./FloatingApproval";

/**
 * R-phone-heading-yield: the waiting strip over a project heading.
 *
 * On a 390×844 phone the floating 等待处理 strip came to rest over the
 * conversation list's project heading. A real touch on the heading's centre
 * landed on the strip's title span and pushed `/tasks/<waiting>` while the
 * heading's `aria-expanded` stayed false. The list scrolls, so the heading was
 * reachable — the defect was that the strip yielded to a conversation row
 * (`[data-session-row]`) and not to the heading sitting in the same list.
 *
 * The heading therefore carries the shared `data-kin-hit-row` marker, and the
 * strip's raised selector yields to it exactly as it already yields to a row.
 * jsdom has no layout, so every box below is stubbed by attribute, copying
 * `FloatingApproval.overlap.dom.test.tsx`; what is pinned is the decision.
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

type Box = { top: number; bottom: number; left: number; right: number };

const EMPTY: Box = { top: 0, bottom: 0, left: 0, right: 0 };

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

/**
 * The phone's measured geometry (dogfood 2026-11-26 18:00): the strip is
 * 366×52 at (12,610) and the project heading below it is 312×44 at (62,599).
 * On a phone tab root the card is never mounted (`raised`), so the floating
 * surface and the strip are the same box.
 */
const PHONE_SURFACE: Box = { top: 610, bottom: 662, left: 12, right: 378 };
const HEADING_UNDER_STRIP: Box = { top: 599, bottom: 643, left: 62, right: 374 };
const HEADING_CLEAR: Box = { top: 700, bottom: 744, left: 62, right: 374 };

/**
 * The wide screen, from `FloatingApproval.overlap.dom.test.tsx`: the card is
 * 24rem in the right column and the strip sits above it. Removing the card
 * moves the strip down to the composer's edge, so the collapsed pill — not the
 * expanded one — is what a heading under it has to survive.
 */
const WIDE_CARD: Box = { top: 442, bottom: 692, left: 692, right: 1076 };
const WIDE_STRIP: Box = { top: 410, bottom: 442, left: 692, right: 900 };
const WIDE_COLLAPSED_STRIP: Box = { top: 640, bottom: 692, left: 692, right: 900 };
const WIDE_HEADING: Box = { top: 610, bottom: 654, left: 700, right: 900 };

const geometry = {
  card: PHONE_SURFACE,
  strip: PHONE_SURFACE,
  collapsedStrip: PHONE_SURFACE,
  rows: [] as Box[],
  band: { top: 760, bottom: 844, left: 0, right: 390 } as Box,
};

/**
 * Geometry by attribute, installed before mount: the component measures in a
 * layout effect during `render`. The floating surface is the `aside`; the
 * strip is its own `role='status'` box, drawn above the card or — once the
 * card yields — alone at the composer's edge. A `data-kin-hit-row` element is
 * the heading in this suite, keyed by document order.
 */
function stubGeometry(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === "ASIDE" && this.hasAttribute("aria-label")) return domRect(geometry.card);
    if (this.getAttribute("role") === "status") {
      const collapsed = !document.querySelector("[data-kin-approval-card]");
      return domRect(collapsed ? geometry.collapsedStrip : geometry.strip);
    }
    if (this.hasAttribute("data-kin-hit-row")) {
      const rows = Array.from(document.querySelectorAll("[data-kin-hit-row]"));
      return domRect(geometry.rows[rows.indexOf(this)] ?? EMPTY);
    }
    if (this.hasAttribute("data-kin-bottom-chrome")) return domRect(geometry.band);
    return domRect(EMPTY);
  });
}

function setupProps(overrides: Partial<React.ComponentProps<typeof FloatingApproval>> = {}) {
  const onDecide = vi.fn();
  const onOpenTask = vi.fn();
  const props = {
    approvals: [approval("oldest", "task-1", 100)],
    titleFor: () => "Fix the tests",
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

function viewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

let band: HTMLDivElement;

beforeEach(() => {
  viewport(390, 844);
  geometry.card = PHONE_SURFACE;
  geometry.strip = PHONE_SURFACE;
  geometry.collapsedStrip = PHONE_SURFACE;
  geometry.rows = [];
  geometry.band = { top: 760, bottom: 844, left: 0, right: 390 };
  stubGeometry();
  band = document.createElement("div");
  band.setAttribute("data-kin-bottom-chrome", "");
  document.body.appendChild(band);
});

afterEach(() => {
  band.remove();
  vi.restoreAllMocks();
  viewport(1024, 768);
});

/** The heading the list draws, as the strip measures it. */
const heading = () => <div data-kin-hit-row="" />;

describe("FloatingApproval over a project heading", () => {
  it("R-phone-heading-yield: the strip yields to a project heading on the phone list", () => {
    // The measured state: the heading's centre is inside the strip's box, so
    // the whole visible surface goes. The arrival region survives, sr-only and
    // outside the `aside`, because a waiting approval must still be announced.
    geometry.rows = [HEADING_UNDER_STRIP];
    const { props } = setupProps({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    const view = render(
      <>
        {heading()}
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("aside > [role='status']")).toBeNull();
    expect(view.container.querySelector("aside")).toBeNull();
    expect(screen.queryByRole("button", { name: /Fix the tests/ })).toBeNull();
    const live = view.container.querySelector("[role='status']");
    expect(live).not.toBeNull();
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.classList.contains("sr-only")).toBe(true);
    expect(live?.textContent).toContain(t("approval.floatingLabel"));
    expect(live?.textContent).toContain("Fix the tests");
  });

  it("R-phone-heading-yield: the strip stays when the heading is clear of it", () => {
    // The control: a heading above the strip changes nothing. The pill is the
    // way into the waiting conversation and must keep working.
    geometry.rows = [HEADING_CLEAR];
    const { props, onOpenTask } = setupProps({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    const view = render(
      <>
        {heading()}
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("aside > [role='status']")).not.toBeNull();
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    fireEvent.click(control);
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
  });

  it("R-phone-heading-yield: a wide screen keeps the strip over the same box", () => {
    // The yield is the phone list's rule, where the list is the screen. On a
    // wide screen the list is a column beside the conversation, and a heading
    // sharing the pill's x-band is not what the pill floats over.
    viewport(1100, 760);
    geometry.card = WIDE_CARD;
    geometry.strip = WIDE_STRIP;
    geometry.collapsedStrip = WIDE_COLLAPSED_STRIP;
    geometry.rows = [WIDE_HEADING];
    geometry.band = { top: 700, bottom: 760, left: 0, right: 1100 };
    const { props } = setupProps({
      raised: false,
      expectsBottomChrome: true,
      screenKey: "/tasks/task-1",
    });
    const view = render(
      <>
        {heading()}
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("aside > [role='status']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
  });
});
