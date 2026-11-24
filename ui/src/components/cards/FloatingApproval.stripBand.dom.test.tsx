// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import FloatingApproval from "./FloatingApproval";

/**
 * The band the visible 等待处理 strip occupies, published for the page that
 * has to scroll clear of it.
 *
 * At 390 the strip is fixed above the phone footer, and `/routines` scrolls
 * under both. The pane cannot know where the strip sits — it is measured here,
 * by the surface that draws it — so the surface publishes its band as CSS
 * custom properties and `index.css` spends it as padding. jsdom has no layout
 * and no media query, so the boxes below are stubbed by attribute; what the
 * test pins is that the numbers the component already measures are the ones it
 * publishes, and that it clears them the moment nothing is painted.
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

/** The phone reading: a 390×844 screen, the pill at y610 standing 52px tall. */
const STRIP: Box = { top: 610, bottom: 662, left: 12, right: 278 };
/** A markdown table cell tall enough to sit under the pill. */
const CELL_UNDER_STRIP: Box = { top: 600, bottom: 700, left: 0, right: 390 };

const geometry = {
  strip: STRIP,
  cells: [] as Box[],
};

function stubGeometry(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    // On a phone tab root the aside is the strip: no decision card is mounted.
    if (this.tagName === "ASIDE" && this.hasAttribute("aria-label")) return domRect(geometry.strip);
    if (this.getAttribute("role") === "status") return domRect(geometry.strip);
    if (this.hasAttribute("data-kin-reading")) {
      const cells = Array.from(document.querySelectorAll("[data-kin-reading]"));
      return domRect(geometry.cells[cells.indexOf(this)] ?? EMPTY);
    }
    return domRect(EMPTY);
  });
}

function viewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

function props() {
  return {
    approvals: [approval("oldest", "task-1", 100)],
    titleFor: () => "Fix the tests",
    busy: {},
    onDecide: vi.fn(),
    onOpenTask: vi.fn(),
    // The phone tab root: the strip is the whole surface, measured as the aside.
    raised: true,
    screenKey: "/routines",
    expectsBottomChrome: false,
  };
}

const bandHeight = () =>
  document.documentElement.style.getPropertyValue("--approval-strip-height");
const bandBottom = () =>
  document.documentElement.style.getPropertyValue("--approval-strip-bottom");

beforeEach(() => {
  viewport(390, 844);
  geometry.strip = STRIP;
  geometry.cells = [];
  stubGeometry();
});

afterEach(() => {
  vi.restoreAllMocks();
  viewport(1024, 768);
  document.documentElement.style.removeProperty("--approval-strip-height");
  document.documentElement.style.removeProperty("--approval-strip-bottom");
});

describe("FloatingApproval publishes the strip's band", () => {
  it("publishes the strip's measured band while it is mounted", () => {
    render(<FloatingApproval {...props()} />);

    // The height the pill draws, and its bottom edge's distance from the
    // viewport's — the same two numbers `measureOverlap` reads. 844 − 662 = 182.
    expect(bandHeight()).toBe("52px");
    expect(bandBottom()).toBe("182px");
  });

  it("clears the band when the strip is hidden or unmounted", async () => {
    const first = render(<FloatingApproval {...props()} />);
    expect(bandHeight()).toBe("52px");

    // Unmounted: nothing is painted, so nothing is reserved.
    first.unmount();
    expect(bandHeight()).toBe("");
    expect(bandBottom()).toBe("");

    // Hidden: the pill yields to a reading cell and only the sr-only live
    // region is left. A stale band would keep a page padded for a strip the
    // reader cannot see.
    geometry.cells = [CELL_UNDER_STRIP];
    render(
      <>
        <div data-kin-reading="" />
        <FloatingApproval {...props()} />
      </>,
    );
    await waitFor(() => expect(document.querySelector("aside")).toBeNull());
    expect(bandHeight()).toBe("");
    expect(bandBottom()).toBe("");
  });
});
