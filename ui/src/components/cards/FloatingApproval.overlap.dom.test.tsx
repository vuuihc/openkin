// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, TaskEvent, UserQuestion } from "../../api/client";
import { t } from "../../i18n";
import type { RoundEvidence } from "../../lib/roundEvidence";
import RoundEvidenceCard from "../chat/RoundEvidenceCard";
import Markdown from "../Markdown";
import FloatingApproval, { rectsOverlap } from "./FloatingApproval";
import UserQuestionCard from "./UserQuestionCard";

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
const STRIP: Box = { top: 410, bottom: 442, left: 692, right: 900 };
const ROW_UNDER_CARD: Box = { top: 600, bottom: 632, left: 300, right: 900 };
const ROW_CLEAR_OF_CARD: Box = { top: 200, bottom: 232, left: 300, right: 900 };
/** A visible markdown table cell in the transcript's right-hand column. */
const CELL_UNDER_CARD: Box = { top: 600, bottom: 632, left: 700, right: 900 };
/** Tall enough to be under the strip *and* the card, as the report measured. */
const CELL_UNDER_STRIP: Box = { top: 400, bottom: 632, left: 700, right: 900 };
const CELL_CLEAR: Box = { top: 200, bottom: 232, left: 300, right: 600 };

/**
 * The filed phone (390×844, safe area applied to the fixed offsets): the
 * floating surface is 366×269 at (12,353) and its strip 274×52 at the same
 * top. A question card's `其他` row sits at 349–409, under both. When the card
 * yields, the pill is bottom-anchored above the composer band (y=630) at
 * 570–622, clear of the field.
 */
const PHONE_CARD: Box = { top: 353, bottom: 622, left: 12, right: 378 };
const PHONE_STRIP: Box = { top: 353, bottom: 405, left: 12, right: 286 };
const PHONE_COLLAPSED_STRIP: Box = { top: 570, bottom: 622, left: 12, right: 286 };
const PHONE_BAND: Box = { top: 630, bottom: 844, left: 0, right: 390 };
const PHONE_ANSWER_ROW: Box = { top: 349, bottom: 409, left: 31, right: 359 };

const questionCard: UserQuestion = {
  id: "question-1",
  task_id: "task-1",
  payload: {
    question: "Which release path?",
    options: [
      { label: "Alpha", description: "The first way" },
      { label: "Beta", description: "The second way" },
    ],
  },
  status: "pending",
  created_at: 1_700_000_000_000,
};

const geometry = {
  card: CARD,
  strip: STRIP,
  collapsedStrip: null as Box | null,
  rows: [ROW_UNDER_CARD] as Box[],
  cells: [] as Box[],
  /** Where the page's own bottom band sits, for the phone's measurements. */
  band: { top: 700, bottom: 760, left: 0, right: 1100 } as Box,
  /** A plain paragraph the reader is reading: it marks nothing. */
  prose: EMPTY as Box,
};

/**
 * Geometry by attribute, installed before mount: the component measures in a
 * layout effect during `render`, which is earlier than a test can reach the
 * elements it created. The floating surface is the `aside` (the strip and the
 * card together — the card pushes the strip up into a row's centre too). The
 * strip is its own box: the reader's complaint is that the pill itself landed
 * on a cell centre when the card had already given way.
 */
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
    if (this.hasAttribute("data-kin-reading")) {
      const cells = Array.from(document.querySelectorAll("[data-kin-reading]"));
      return domRect(geometry.cells[cells.indexOf(this)] ?? EMPTY);
    }
    if (this.hasAttribute("data-kin-prose")) {
      return domRect(geometry.prose);
    }
    if (this.hasAttribute("data-kin-bottom-chrome")) {
      return domRect(geometry.band);
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
  geometry.strip = STRIP;
  geometry.collapsedStrip = null;
  geometry.rows = [ROW_UNDER_CARD];
  geometry.cells = [];
  geometry.band = { top: 700, bottom: 760, left: 0, right: 1100 };
  geometry.prose = EMPTY;
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
    const presence: boolean[] = [Boolean(view.container.querySelector("[data-kin-approval-card]"))];
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

  it("brings the next approval's card back after the one on the strip is answered", async () => {
    // Answering the oldest of a queue from the task page or the tray swaps the
    // current approval while the strip is showing. The card that was measured
    // is gone, and a box remembered for it says nothing about the next one:
    // left in place, it kept the strip mounted for an approval whose card was
    // never measured, until a reload.
    const { props } = setupProps({
      approvals: [approval("oldest", "task-1", 100), approval("second", "task-2", 200)],
    });
    const view = render(
      <>
        <RoundEvidenceCard evidence={evidence} />
        <FloatingApproval {...props} />
      </>,
    );
    // The row keeps the decision card off the screen; the strip is the surface
    // and the queue is counted.
    expect(approveButton()).toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();

    // The oldest is answered elsewhere; only the second approval is left. The
    // row is still under the strip, so the card stays off — but it has to be
    // the *second* approval's card that is held back, measured afresh.
    view.rerender(
      <>
        <RoundEvidenceCard evidence={evidence} />
        <FloatingApproval {...props} approvals={[approval("second", "task-2", 200)]} />
      </>,
    );
    expect(approveButton()).toBeNull();

    // Fold the evidence card: the row goes, and the second approval's own card
    // must be what comes back instead of the strip forever.
    const header = view.container.querySelector<HTMLElement>("button[aria-expanded]");
    expect(header).not.toBeNull();
    fireEvent.click(header!);
    await waitFor(() => expect(approveButton()).toBeTruthy());
    expect(denyButton()).toBeTruthy();
  });
});

describe("FloatingApproval over reading content", () => {
  const readingCell = () => <div data-kin-reading="" />;

  it("keeps the decision card off a reading table cell", () => {
    // The reported state: an approval waits in another conversation while the
    // reader is at a long answer's table. The card floats over the table's
    // right-hand columns, so the cell centres under it answer the card.
    geometry.rows = [];
    geometry.cells = [CELL_UNDER_CARD];
    const { props } = setupProps();
    const view = render(
      <>
        {readingCell()}
        <FloatingApproval {...props} />
      </>,
    );

    // The decision surface gives way exactly as it does for a changed-file
    // row…
    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();
    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();
    // …and the strip is still the way into the waiting conversation.
    expect(view.container.querySelector("aside > [role='status']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
  });

  it("keeps the strip off a reading cell", () => {
    // The pill is the top of the same floating column. When its own box — not
    // only the card's — sits on a cell, no part of the surface may stay: a
    // strip-only render still eats the cell centre.
    geometry.rows = [];
    geometry.cells = [CELL_UNDER_STRIP];
    const { props } = setupProps();
    const view = render(
      <>
        {readingCell()}
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("aside")).toBeNull();
    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Fix the tests/ })).toBeNull();
    // The visible surface is gone, but its live region is not: an approval
    // arriving while the reader is on a table still has to be announced, and
    // this status is the app's only arrival channel. It stays sr-only and
    // outside the `aside`, so the strip measurement has no box to find.
    const live = view.container.querySelector("[role='status']");
    expect(live).not.toBeNull();
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.classList.contains("sr-only")).toBe(true);
    expect(live?.textContent).toContain("Fix the tests");
    expect(live?.closest("aside")).toBeNull();
  });

  it("settles a tablet strip that moves down when the card yields, then returns on scroll", async () => {
    viewport(820, 1180);
    geometry.rows = [];
    geometry.card = { ...CARD, left: 412, right: 796 };
    geometry.strip = { ...STRIP, left: 412, right: 620 };
    // Removing the card moves the strip down to the composer's edge. Only
    // that collapsed strip overlaps this cell; using the expanded top while
    // hidden flips hidden on every layout effect until React throws #185.
    geometry.collapsedStrip = { top: 660, bottom: 692, left: 412, right: 620 };
    geometry.cells = [{ top: 650, bottom: 690, left: 500, right: 700 }];
    const { props } = setupProps();
    const view = render(
      <>
        {readingCell()}
        <FloatingApproval {...props} />
      </>,
    );
    expect(view.container.querySelector("aside")).toBeNull();
    expect(screen.getByRole("status").classList.contains("sr-only")).toBe(true);

    geometry.cells = [CELL_CLEAR];
    fireEvent.scroll(document);
    await waitFor(() => expect(denyButton()).toBeTruthy());
  });

  it("announces an approval that arrives while the surface is hidden", () => {
    // The reported state: the reader is on a table cell when another
    // conversation's approval lands. Nothing visible may mount, but the queue
    // behind the pill must reach assistive tech — a silent arrival means the
    // agent stays stopped until someone happens to look.
    geometry.rows = [];
    geometry.cells = [CELL_UNDER_STRIP];
    const { props } = setupProps();
    const view = render(
      <>
        {readingCell()}
        <FloatingApproval {...props} />
      </>,
    );
    const live = () => view.container.querySelector("[role='status']");
    expect(live()?.textContent).not.toContain(t("approval.moreWaiting", { n: 1 }));

    view.rerender(
      <>
        {readingCell()}
        <FloatingApproval
          {...props}
          approvals={[approval("oldest", "task-1", 100), approval("second", "task-2", 200)]}
        />
      </>,
    );

    expect(view.container.querySelector("aside")).toBeNull();
    expect(live()?.textContent).toContain(t("approval.moreWaiting", { n: 1 }));
  });

  it("brings the surface back when the reading cell scrolls clear", async () => {
    // The measurement is not a latch: scroll the table away and the approval
    // returns, because the reader is no longer reading under it.
    geometry.rows = [];
    geometry.cells = [CELL_UNDER_STRIP];
    const { props } = setupProps();
    const view = render(
      <>
        {readingCell()}
        <FloatingApproval {...props} />
      </>,
    );
    expect(view.container.querySelector("aside")).toBeNull();

    geometry.cells = [CELL_CLEAR];
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(approveButton()).toBeTruthy());
    expect(view.container.querySelector("[data-kin-approval-card]")).not.toBeNull();
    expect(view.container.querySelector("[role='status']")).not.toBeNull();
  });

  it("still yields only the card to an evidence row", () => {
    // The reading rule extends the changed-file rule; it must not replace it.
    // A row under the card keeps the existing shape: strip stays, card goes.
    geometry.rows = [ROW_UNDER_CARD];
    geometry.cells = [CELL_CLEAR];
    const { props } = setupProps();
    const view = render(
      <>
        <div data-kin-hit-row="" />
        {readingCell()}
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();
    expect(view.container.querySelector("aside > [role='status']")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
  });

  it("marks every markdown table cell as reading content", () => {
    // The producer half: without the marker the overlap rule has nothing to
    // find, and the review is a rule that can never fire.
    const view = render(
      <Markdown
        text={[
          "| New activity | Table measure |",
          "| --- | --- |",
          "| Acceptance | 390 and 1100 only |",
        ].join("\n")}
      />,
    );
    const cells = Array.from(view.container.querySelectorAll("th, td"));
    expect(cells.length).toBe(4);
    for (const cell of cells) {
      expect(cell.hasAttribute("data-kin-reading")).toBe(true);
    }
  });
});

describe("FloatingApproval over a question card's custom answer", () => {
  const answerCard = () => <UserQuestionCard question={questionCard} onAnswer={vi.fn()} />;

  beforeEach(() => {
    // The filed phone: a pushed conversation with a composer band at y=630.
    viewport(390, 844);
    geometry.card = PHONE_CARD;
    geometry.strip = PHONE_STRIP;
    geometry.collapsedStrip = PHONE_COLLAPSED_STRIP;
    geometry.band = PHONE_BAND;
    geometry.rows = [PHONE_ANSWER_ROW];
    geometry.cells = [];
  });

  it("keeps the strip off a question card's custom answer field", () => {
    const { props } = setupProps();
    const view = render(
      <>
        {answerCard()}
        <FloatingApproval {...props} />
      </>,
    );

    // The decision surface gives way exactly as it does for a changed-file
    // row: the field is under the expanded box, so only the pill stays.
    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();
    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();

    // …and the pill's own box is clear of the field, so a finger tap at the
    // field's centre reaches the input instead of the strip's task name.
    const strip = view.container.querySelector("aside > [role='status']");
    expect(strip).not.toBeNull();
    expect(rectsOverlap(strip!.getBoundingClientRect(), domRect(PHONE_ANSWER_ROW))).toBe(false);
  });

  it("does not hide the strip when only the question card's field is under it", () => {
    // The strip is a pushed conversation's one pending-approval entry
    // (`rsi/DECISIONS.md:172`): the card yields, the surface does not
    // disappear. At the first measurement the field is under the expanded
    // strip's own box, so a rule that hid the strip on a hit row would take
    // that entry away entirely.
    const { props, onOpenTask } = setupProps();
    const view = render(
      <>
        {answerCard()}
        <FloatingApproval {...props} />
      </>,
    );

    const strip = view.container.querySelector("aside > [role='status']");
    expect(strip).not.toBeNull();
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    expect(control.getAttribute("aria-label")).toContain(t("approval.floatingLabel"));
    fireEvent.click(control);
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
  });

  it("yields the card to the question card's footer on a tablet too", () => {
    // The 820 gate reading: the expanded card sat on the second question
    // card's custom-answer field and clipped the bottom of its 提交 button.
    // The marker is unscoped, so the card gives way at 820 exactly as it does
    // at 390 — one contract, every width.
    viewport(820, 1180);
    geometry.card = { top: 725, bottom: 994, left: 412, right: 796 };
    geometry.strip = { top: 725, bottom: 777, left: 412, right: 686 };
    geometry.collapsedStrip = { top: 942, bottom: 994, left: 412, right: 686 };
    geometry.band = { top: 1002, bottom: 1180, left: 0, right: 820 };
    // The answer row and the submit row, both under the expanded card.
    geometry.rows = [
      { top: 671, bottom: 736, left: 411, right: 777 },
      { top: 748, bottom: 792, left: 411, right: 777 },
    ];
    const { props } = setupProps();
    const view = render(
      <>
        {answerCard()}
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("[data-kin-approval-card]")).toBeNull();
    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();

    // The strip stays mounted and, at its collapsed offset, clears both rows:
    // the field's centre and the 提交 button are the reader's again.
    const strip = view.container.querySelector("aside > [role='status']");
    expect(strip).not.toBeNull();
    for (const row of geometry.rows) {
      expect(rectsOverlap(strip!.getBoundingClientRect(), domRect(row))).toBe(false);
    }
  });

  it("leaves prose under the card alone", () => {
    // The 2026-11-22 decision accepts the card covering prose: only controls
    // and reading content yield. Extending the marker must not widen the rule.
    geometry.rows = [];
    geometry.prose = { top: 500, bottom: 580, left: 40, right: 350 };
    const { props } = setupProps();
    const view = render(
      <>
        <p data-kin-prose="">A paragraph the reader is reading.</p>
        <FloatingApproval {...props} />
      </>,
    );

    expect(view.container.querySelector("[data-kin-approval-card]")).not.toBeNull();
    expect(approveButton()).toBeTruthy();
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
