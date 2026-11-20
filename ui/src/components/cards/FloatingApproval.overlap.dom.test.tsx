// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import type { RoundEvidence } from "../../lib/roundEvidence";
import RoundEvidenceCard from "../chat/RoundEvidenceCard";
import FloatingApproval, { rectsOverlap } from "./FloatingApproval";

/**
 * The floating approval card over a conversation's own content.
 *
 * The decision card is 24rem wide and pinned above the composer, in the same
 * right-hand area a transcript's round evidence card draws its file rows. At
 * 1100 it covered the `notes.md` row: `elementFromPoint` on the row's centre
 * returned the approval `aside`, and the tap that should have opened the diff
 * answered the approval instead. The evidence card is open by default, so this
 * is the ordinary state of a conversation that just changed a file.
 *
 * The rule, copied from the phone tab roots and from an open panel: when the
 * card would cover a row the reader can click, only the strip stays. It still
 * names the blocked task and opens it. Once the rows are gone — the evidence
 * card folded, the reader scrolled past — the card comes back.
 *
 * jsdom has no layout, so every box below is stubbed by attribute. What the
 * test pins is the decision, not the drawing.
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

const PATH = "notes.md";

const evidence: RoundEvidence = {
  files: [{ path: PATH, action: "edit", tool: "edit", seq: 2, additions: 1, deletions: 1 }],
  totalFiles: 1,
  additions: 1,
  deletions: 1,
  hasStats: true,
  events: [
    {
      task_id: "task-evidence",
      event_epoch: 0,
      seq: 2,
      ts: 2,
      type: "tool_use",
      payload: {
        speaker: "kin",
        name: "edit",
        input: { path: PATH, old_string: "const a = 1;", new_string: "const a = 2;" },
      },
    } as TaskEvent,
  ],
  source: "tools",
};

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
 * Where things are on a 1100×760 screen. The conversation's composer band
 * starts at y=700; the floating card sits above it, 384px wide in the right
 * column (`md:right-6`, `md:w-[24rem]`); the evidence card's file row is a
 * full-width transcript row, so its right half is under the card.
 */
const CARD: Box = { top: 442, bottom: 692, left: 692, right: 1076 };
const ROW_UNDER_CARD: Box = { top: 600, bottom: 632, left: 300, right: 900 };
const ROW_CLEAR_OF_CARD: Box = { top: 200, bottom: 232, left: 300, right: 900 };

const geometry = { card: CARD, rows: [ROW_UNDER_CARD] as Box[] };

/**
 * Geometry by attribute, installed before mount: the component measures in a
 * layout effect during `render`, which is earlier than a test can reach the
 * elements it created. The floating surface is the `aside` (the strip and the
 * card together — the card pushes the strip up into a row's centre too).
 */
function stubGeometry(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === "ASIDE" && this.hasAttribute("aria-label")) return domRect(geometry.card);
    if (this.hasAttribute("data-kin-hit-row")) {
      const rows = Array.from(document.querySelectorAll("[data-kin-hit-row]"));
      return domRect(geometry.rows[rows.indexOf(this)] ?? EMPTY);
    }
    if (this.hasAttribute("data-kin-bottom-chrome")) {
      return domRect({ top: 700, bottom: 760, left: 0, right: 1100 });
    }
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

const approveButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.approve")) });
const denyButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.deny")) });

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
  viewport(1100, 760);
  geometry.card = CARD;
  geometry.rows = [ROW_UNDER_CARD];
  stubGeometry();
  // The conversation's composer band, on screen: the card measures its offset
  // from it, and the strip-only render reconstructs the card's box from the
  // same offset once the card itself is gone.
  band = document.createElement("div");
  band.setAttribute("data-kin-bottom-chrome", "");
  document.body.appendChild(band);
});

afterEach(() => {
  band.remove();
  vi.restoreAllMocks();
  viewport(1024, 768);
});

describe("FloatingApproval over a changed-file row", () => {
  it("keeps the strip when the card would cover a changed-file row", () => {
    const { props, onOpenTask } = setupProps();
    const view = render(
      <>
        <RoundEvidenceCard evidence={evidence} />
        <FloatingApproval {...props} />
      </>,
    );

    // No decision surface over the row…
    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();
    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();

    // …but the strip still names the blocked task and is the way into it.
    expect(view.container.querySelector("aside > [role='status']")).not.toBeNull();
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    expect(control.getAttribute("aria-label")).toContain(t("approval.floatingLabel"));
    fireEvent.click(control);
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
  });

  it("shows the card when no changed-file row is under it", () => {
    geometry.rows = [ROW_CLEAR_OF_CARD];
    const { props } = setupProps();
    render(
      <>
        <RoundEvidenceCard evidence={evidence} />
        <FloatingApproval {...props} />
      </>,
    );

    expect(approveButton()).toBeTruthy();
    expect(denyButton()).toBeTruthy();
  });

  it("ignores rows in a hidden conversation pane", () => {
    // `TaskSessionHost` keeps visited conversations mounted with
    // `display:none`; their rows have no box at all. A card cannot cover a row
    // that is not painted, and treating a mounted row as visible would keep the
    // strip forever once a second conversation was opened.
    geometry.rows = [EMPTY];
    const { props } = setupProps();
    render(
      <>
        <RoundEvidenceCard evidence={evidence} />
        <FloatingApproval {...props} />
      </>,
    );

    expect(approveButton()).toBeTruthy();
    expect(denyButton()).toBeTruthy();
  });

  it("shows the card again when the evidence card is collapsed", async () => {
    const { props } = setupProps();
    const view = render(
      <>
        <RoundEvidenceCard evidence={evidence} />
        <FloatingApproval {...props} />
      </>,
    );
    expect(approveButton()).toBeNull();

    // Watch what the reader sees, not internals: each change of the card's
    // presence is one transition. Start from where the reader is — strip only.
    const presence: boolean[] = [
      Boolean(view.container.querySelector("[data-kin-approval-card]")),
    ];
    const observer = new MutationObserver(() => {
      const now = Boolean(view.container.querySelector("[data-kin-approval-card]"));
      if (presence[presence.length - 1] !== now) presence.push(now);
    });
    observer.observe(view.container, { childList: true, subtree: true });

    // Fold the evidence card: its rows go, so nothing is under the card any more.
    const header = view.container.querySelector<HTMLElement>("button[aria-expanded]");
    expect(header).not.toBeNull();
    fireEvent.click(header!);

    await waitFor(() => expect(approveButton()).toBeTruthy());

    // Two more measurements of the now-empty area must not put the strip back:
    // the strip itself is not a row, and re-measuring the collapsed card must
    // not count as a fresh overlap.
    fireEvent(window, new Event("resize"));
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(presence).toEqual([false, true]));
    expect(approveButton()).toBeTruthy();
    observer.disconnect();
  });
});

describe("rectsOverlap", () => {
  const box = (top: number, bottom: number, left: number, right: number): Box => ({
    top,
    bottom,
    left,
    right,
  });
  const withSize = (b: Box) => domRect(b);

  it.each([
    ["overlapping", box(100, 200, 100, 200), box(150, 250, 150, 250), true],
    ["row entirely inside the card", box(0, 500, 0, 500), box(100, 200, 100, 200), true],
    ["disjoint horizontally", box(100, 200, 0, 100), box(100, 200, 200, 300), false],
    ["disjoint vertically", box(100, 200, 0, 200), box(300, 400, 0, 200), false],
    ["touching edges only", box(100, 200, 0, 100), box(200, 300, 100, 200), false],
    ["zero-width row", box(100, 200, 100, 100), box(150, 250, 0, 500), false],
    ["zero-height card", box(100, 100, 0, 500), box(150, 250, 100, 200), false],
  ])("%s", (_name, a, b, expected) => {
    expect(rectsOverlap(withSize(a), withSize(b))).toBe(expected);
  });

  it("is symmetric", () => {
    expect(rectsOverlap(domRect(CARD), domRect(ROW_UNDER_CARD))).toBe(true);
    expect(rectsOverlap(domRect(ROW_UNDER_CARD), domRect(CARD))).toBe(true);
  });
});
