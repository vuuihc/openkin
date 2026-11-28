// @vitest-environment jsdom
// R-phone-strip-scroll. The 2026-11-28 13 dogfood re-test of `gap-log:40`
// recorded that a swipe starting on the 等待处理 strip scrolls nothing: the
// strip is `position: fixed`, so the browser's hit test for the gesture lands
// on it and the transcript (or the settings pane) painted underneath never
// sees a scroll. On a 390 phone the pill is exactly where a thumb starts.
//
// jsdom has no layout and no hit testing, so the stack under the finger is
// stubbed by attribute and the scroll container's box is stubbed with
// `scrollHeight`/`clientHeight`. What these tests pin is the decision — which
// element a pan or a wheel is forwarded to, and which gestures stay a tap.
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import FloatingApproval from "./FloatingApproval";

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

function props(onOpenTask = vi.fn()) {
  return {
    approvals: [approval("waiting", "task-2", 100)],
    titleFor: () => "Another conversation",
    busy: {},
    onDecide: vi.fn(),
    onOpenTask,
    raised: false,
    screenKey: "/tasks/task-1",
    expectsBottomChrome: true,
  };
}

/**
 * A mouse event carries the coordinates React reads; jsdom has no
 * `PointerEvent` constructor, and React listens for the native type either
 * way. `pointerType` stays undefined, which the strip reads as a finger.
 */
function pointer(node: Element, type: string, clientX: number, clientY: number) {
  fireEvent(
    node,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
    }),
  );
}

/** The transcript stand-in: 600px of a 2000px document, scrolled by hand. */
function transcriptStandIn(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  el.style.height = "600px";
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
  document.body.appendChild(el);
  return el;
}

/** The stack a browser's hit test would report at the gesture's first point. */
function stubUnder(...stack: Element[]): void {
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => stack,
  });
}

function scene(onOpenTask = vi.fn()) {
  const transcript = transcriptStandIn();
  const view = render(<FloatingApproval {...props(onOpenTask)} />);
  const strip = view.container.querySelector<HTMLElement>("[role='status']")!;
  stubUnder(strip, document.body, transcript);
  return { transcript, strip, view, onOpenTask };
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).elementsFromPoint;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("FloatingApproval forwards a gesture that starts on the strip", () => {
  it("KIN-MOBILE-001 F2: a vertical drag that starts on the waiting strip scrolls the conversation underneath", () => {
    const { transcript, strip, view, onOpenTask } = scene();

    // A thumb on the pill, dragging up 120px: the transcript under it moves
    // down by the same distance, exactly as a swipe that starts above it does.
    pointer(strip, "pointerdown", 100, 700);
    pointer(strip, "pointermove", 100, 660);
    pointer(strip, "pointermove", 100, 620);
    pointer(strip, "pointermove", 100, 580);
    pointer(strip, "pointerup", 100, 580);

    expect(transcript.scrollTop).toBe(120);

    // A drag is not a tap. The browser still sends the click that ends the
    // gesture, and it must not open the task the reader was scrolling past.
    fireEvent.click(view.container.querySelector("[role='status'] button")!);
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 F2: a wheel over the strip scrolls the conversation underneath", () => {
    const { transcript, strip } = scene();

    fireEvent.wheel(strip, { deltaY: 120, clientX: 100, clientY: 700 });

    expect(transcript.scrollTop).toBe(120);
  });

  it("KIN-MOBILE-001 F2: a tap on the strip still opens its task", () => {
    // Control: the fix must not turn the approval action into a dead target.
    const onOpenTask = vi.fn();
    const { strip, view } = scene(onOpenTask);

    pointer(strip, "pointerdown", 100, 700);
    pointer(strip, "pointermove", 100, 695);
    pointer(strip, "pointerup", 100, 695);
    fireEvent.click(view.container.querySelector("[role='status'] button")!);

    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 F2: a horizontal drag on the strip does not scroll the conversation", () => {
    // Control: 等待处理 never starts a tab swipe, and it must not become one.
    const { transcript, strip } = scene();

    pointer(strip, "pointerdown", 100, 700);
    pointer(strip, "pointermove", 130, 703);
    pointer(strip, "pointermove", 160, 706);
    pointer(strip, "pointerup", 160, 706);

    expect(transcript.scrollTop).toBe(0);
  });

  it("KIN-MOBILE-001 F2: the strip still yields to the queued row (queue reorder yield)", () => {
    // Re-asserts the contract the new gesture path must not regress (the
    // queued-row yield): a decision card that would cover a queued row is not
    // mounted at all.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.tagName === "ASIDE") return domRect({ top: 353, bottom: 622, left: 12, right: 378 });
      if (this.getAttribute("role") === "status")
        return domRect({ top: 353, bottom: 405, left: 12, right: 286 });
      if (this.hasAttribute("data-kin-hit-row"))
        return domRect({ top: 460, bottom: 528, left: 150, right: 300 });
      return domRect(EMPTY);
    });
    const row = document.createElement("div");
    row.setAttribute("data-kin-hit-row", "");
    document.body.appendChild(row);

    const view = render(<FloatingApproval {...props()} />);

    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();
    // The strip is still the surface that names the blocked task.
    expect(view.container.querySelector("[role='status']")).not.toBeNull();
  });
});
