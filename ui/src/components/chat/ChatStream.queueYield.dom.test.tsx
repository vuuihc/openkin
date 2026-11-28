// @vitest-environment jsdom
// R-queue-reorder-yield. The 2026-11-28 13 dogfood finding: at 390 with
// another conversation's approval waiting, the floating 等待处理 strip and the
// 需要权限 card paint over a queued message's order controls. A real CDP touch
// on 上移 left the daemon at `[甲 1, 乙 2]`; the same arrow reordered the
// queue whenever the surface was not over it. The pill was never marked as a
// hit row, so `FloatingApproval`'s existing yield — the rule AGENTS.md §18
// writes down and `UserQuestionCard` already follows — could not see it.
//
// jsdom has no layout, so every box is stubbed by attribute. What these tests
// pin is the decision (which surface is painted), not the drawing.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, TaskEvent } from "../../api/client";
import { setLocale, t } from "../../i18n";
import FloatingApproval from "../cards/FloatingApproval";
import ChatStream from "./ChatStream";

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
 * The filed phone: 390×844, the floating surface at (12,353)–(378,622) with
 * its strip at the same top, and the composer band from y=630. The queued
 * message's pill — the cluster holding its place, arrows, pencil and × — is
 * reported at 44×44 per arrow around y=484, inside the card's box.
 */
const PHONE_CARD: Box = { top: 353, bottom: 622, left: 12, right: 378 };
const PHONE_STRIP: Box = { top: 353, bottom: 405, left: 12, right: 286 };
const PHONE_BAND: Box = { top: 630, bottom: 844, left: 0, right: 390 };
const PHONE_PILL_UNDER_CARD: Box = { top: 460, bottom: 528, left: 150, right: 300 };

/** The wide screen the card must keep floating over: 1100×760. */
const WIDE_CARD: Box = { top: 442, bottom: 692, left: 692, right: 1076 };
const WIDE_STRIP: Box = { top: 410, bottom: 442, left: 692, right: 900 };
const WIDE_BAND: Box = { top: 700, bottom: 760, left: 0, right: 1100 };
const WIDE_PILL_CLEAR: Box = { top: 120, bottom: 188, left: 60, right: 260 };

const geometry = {
  card: PHONE_CARD,
  strip: PHONE_STRIP,
  collapsedStrip: null as Box | null,
  /** One box per `[data-kin-hit-row]`, in document order. */
  rows: [] as Box[],
  band: PHONE_BAND,
};

function stubGeometry(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === "ASIDE" && this.hasAttribute("aria-label")) return domRect(geometry.card);
    if (this.getAttribute("role") === "status") {
      const collapsed = !document.querySelector("[data-kin-approval-card]");
      return domRect(
        collapsed && geometry.collapsedStrip ? geometry.collapsedStrip : geometry.strip,
      );
    }
    if (this.hasAttribute("data-kin-hit-row")) {
      const rows = Array.from(document.querySelectorAll("[data-kin-hit-row]"));
      return domRect(geometry.rows[rows.indexOf(this)] ?? EMPTY);
    }
    if (this.hasAttribute("data-kin-bottom-chrome")) return domRect(geometry.band);
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

function messageEvent(seq: number, text: string): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: 0,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "user", content: [{ type: "text", text }] },
  } as unknown as TaskEvent;
}

/** The filed state: two follow-ups waiting behind a running turn. */
const queued = [messageEvent(2, "first thought"), messageEvent(3, "second thought")];
const queuedSeqs = new Set([2, 3]);
const queuedPositions = new Map([
  [2, 1],
  [3, 2],
]);

function queuedTranscript() {
  return (
    <ChatStream
      events={queued}
      hostSpeaker="kin"
      queuedSeqs={queuedSeqs}
      queuePositions={queuedPositions}
      queueLength={2}
      onUnqueue={vi.fn()}
      onMoveQueued={vi.fn()}
    />
  );
}

function floatingApproval() {
  return (
    <FloatingApproval
      approvals={[approval("waiting", "task-2", 100)]}
      titleFor={() => "Another conversation"}
      busy={{}}
      onDecide={vi.fn()}
      onOpenTask={vi.fn()}
      raised={false}
      screenKey="/tasks/task-1"
      expectsBottomChrome
    />
  );
}

const approveButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.approve")) });
const decisionCard = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-kin-approval-card]");

let band: HTMLDivElement;

beforeEach(() => {
  setLocale("en");
  viewport(390, 844);
  geometry.card = PHONE_CARD;
  geometry.strip = PHONE_STRIP;
  geometry.collapsedStrip = null;
  geometry.rows = [];
  geometry.band = PHONE_BAND;
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

describe("the queued pill as a hit row", () => {
  it("R-queue-reorder-yield: marks the queued pill as a hit row", () => {
    // It is the cluster that has to yield, not the bubble the text is painted
    // in.
    render(queuedTranscript());

    // The first place offers only 下移 and the last only 上移; each pill has
    // to be found from the arrow it holds.
    const down = screen.getByRole("button", {
      name: t("chat.moveQueuedDownNamed", { text: "first thought" }),
    });
    const up = screen.getByRole("button", {
      name: t("chat.moveQueuedUpNamed", { text: "second thought" }),
    });
    const pill = up.closest("[data-kin-hit-row]");

    expect(pill, "the pill carries the shared hit-row marker").not.toBeNull();
    // Both pills are marked, and the marker is the cluster rather than the row
    // or the bubble: the arrows and the × sit inside it, the message does not.
    expect(down.closest("[data-kin-hit-row]")).not.toBeNull();
    expect(down.closest("[data-kin-hit-row]")).not.toBe(pill);
    expect(pill!.contains(up)).toBe(true);
    expect(
      pill!.contains(
        screen.getByRole("button", {
          name: t("chat.withdrawNamed", { text: "second thought" }),
        }),
      ),
    ).toBe(true);
    // The marker is on the pill, not on the bubble: the message text stays
    // outside it, so the card is told about the controls and nothing more.
    expect(pill!.contains(screen.getByText("second thought"))).toBe(false);
  });
});

describe("FloatingApproval over a queued order control", () => {
  it("R-queue-reorder-yield: the card yields to the queued pill", () => {
    // The filed phone state: the decision card's box sits on the second
    // queued message's pill. The card must not paint — the strip stays as the
    // pushed conversation's only pending-approval entry.
    geometry.rows = [PHONE_PILL_UNDER_CARD];
    const view = render(
      <>
        {queuedTranscript()}
        {floatingApproval()}
      </>,
    );

    expect(decisionCard(view)).toBeNull();
    expect(approveButton()).toBeNull();
    expect(view.container.querySelector("aside > [role='status']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Another conversation/ })).toBeTruthy();
  });

  it("R-queue-reorder-yield: the card still floats over a long transcript at 1100", () => {
    // Wide-screen non-regression: a pill sharing the card's x-band but not its
    // box is not covered, so the decision surface stays. Yielding at 768+ to a
    // row that only shares a column was rejected on 2026-11-24.
    viewport(1100, 760);
    geometry.card = WIDE_CARD;
    geometry.strip = WIDE_STRIP;
    geometry.band = WIDE_BAND;
    geometry.rows = [WIDE_PILL_CLEAR];
    const view = render(
      <>
        {queuedTranscript()}
        {floatingApproval()}
      </>,
    );

    expect(decisionCard(view)).not.toBeNull();
    expect(approveButton()).toBeTruthy();
  });

  it("R-queue-reorder-yield: a real tap on the pill's arrow still moves the queue", () => {
    // The marker must not change what the control does: the click reaches the
    // row's own handler with the message's seq and direction.
    const onMoveQueued = vi.fn();
    render(
      <ChatStream
        events={queued}
        hostSpeaker="kin"
        queuedSeqs={queuedSeqs}
        queuePositions={queuedPositions}
        queueLength={2}
        onUnqueue={vi.fn()}
        onMoveQueued={onMoveQueued}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: t("chat.moveQueuedUpNamed", { text: "second thought" }),
      }),
    );
    expect(onMoveQueued).toHaveBeenCalledWith(3, -1);
  });
});
