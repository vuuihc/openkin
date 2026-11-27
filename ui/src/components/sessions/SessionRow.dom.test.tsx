// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSession, Task } from "../../api/client";
import type { PhoneSessionRow } from "../../lib/phoneSessionBuckets";
import { setLocale } from "../../i18n";
import SessionRow, { type SessionRowProps } from "./SessionRow";

/**
 * The conversation row is the one renderer both the phone page and the Mac
 * sidebar use. These tests pin the contract at its boundary: the accessible
 * name it announces, what a click does in each mode, that a row's actions are
 * one discoverable trigger (the shared menu on the Mac, the console sheet on a
 * touch page) rather than a row of hover-only icons, that the phone's swipe
 * strip stays a second path to the same handlers, and that selection and
 * imported rows expose neither.
 *
 * KIN-MANAGE-001, step 3: a completed hold opens this row's own action sheet
 * instead of entering multi-select. Step 5: Rename is the menu's first action
 * and edits the row's own title in place, on both surfaces.
 */

const NOW = new Date("2026-11-15T12:00:00Z").getTime();

function task(id: string, archivedAt?: number, status = "succeeded"): Task {
  return {
    id,
    title: id,
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status,
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
    ...(archivedAt ? { archived_at: archivedAt } : {}),
  } as Task;
}

function taskRow(overrides: Partial<PhoneSessionRow> = {}): PhoneSessionRow {
  return {
    key: "task:row-1",
    at: NOW - 2 * 60 * 1000,
    title: "Fix the build",
    agentId: "claude-code",
    status: "succeeded",
    remote: true,
    task: task("row-1"),
    ...overrides,
  };
}

function importedRow(): PhoneSessionRow {
  const session = {
    id: "session-1",
    agent_id: "claude-code",
    external_ref: "session-1",
    title: "Imported chat",
    cwd: "/work/alpha",
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 1,
    linked: false,
  } as AgentSession;
  return {
    key: "session:session-1",
    at: NOW - 60_000,
    title: "Imported chat",
    agentId: "claude-code",
    remote: false,
    session,
  };
}

function props(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    row: taskRow(),
    deviceLabel: "",
    query: "",
    now: NOW,
    viewedIds: new Set(),
    pending: { approvals: 0, questions: 0, total: 0 },
    active: false,
    onOpen: vi.fn(),
    shell: "page",
    coarse: false,
    selectionMode: false,
    selectionLocked: false,
    selected: false,
    onToggleSelect: vi.fn(),
    onStartSelection: vi.fn(),
    onExitSelection: vi.fn(),
    swipeOpen: false,
    onSwipeOpenChange: vi.fn(),
    pinned: false,
    onPin: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    scope: "active",
    ...overrides,
  };
}

/**
 * The row's own button, found by its data attribute rather than by name: the
 * click and selection contract below belongs to this element, not to whichever
 * other control in the row happens to carry the conversation's title.
 */
function rowButton(): HTMLElement {
  const node = document.querySelector<HTMLElement>("[data-session-row]");
  if (!node) throw new Error("the session row button did not render");
  return node;
}

/** The one control that opens a row's actions, whichever surface it lives on. */
function rowActionsTrigger(container: HTMLElement): HTMLElement {
  const triggers = container.querySelectorAll<HTMLElement>("[data-row-actions]");
  expect(triggers).toHaveLength(1);
  return triggers[0]!;
}

/** SwipeReveal reports drags through native pointer events; jsdom has no
 *  PointerEvent constructor, and React listens for the native type. */
function pointer(node: Element, type: string, clientX: number, clientY = 20) {
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

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  // The action sheet owns one history entry; start each test from a clean one.
  window.history.replaceState({ idx: 0 }, "", "/sessions");
});

describe("SessionRow", () => {
  it("renders the title, one metadata line and the status, naming a pinned row's machine", () => {
    const { container } = render(<SessionRow {...props({ deviceLabel: "Studio" })} />);

    expect(screen.getByText("Fix the build")).toBeTruthy();
    // KIN-CONTINUE-001: a pinned row sits outside the device heading, so it
    // names its machine in the metadata line; under a heading the slot is
    // empty and nothing is repeated.
    expect(container.querySelector("[data-session-meta]")?.textContent).toBe(
      "Claude Code · 2 minutes ago · Done · Studio",
    );
    // The status dot is the succeeded, not-yet-viewed marker.
    expect(container.querySelector(".bg-kin-green")).not.toBeNull();
    // aria-label is the row's own sentence: title, agent, when, status, device.
    expect(
      screen.getByRole("button", {
        name: "Fix the build · Claude Code · 2 minutes ago · Done · Studio",
      }),
    ).toBeTruthy();
  });

  it("names every status that draws a dot, so no state is colour alone", () => {
    // The UX review found a failed row drawing only its red dot: the state was
    // in colour and nowhere in words. Every tone that paints a dot must also
    // name itself, on the line and in the row's sentence.
    const failedRun = {
      ...task("row-1", undefined, "failed"),
      routine_id: "routine-1",
    } as Task;
    const cases: { label: string; row: PhoneSessionRow; dot?: string; word: string }[] = [
      {
        label: "failed",
        row: taskRow({ task: task("row-1", undefined, "failed") }),
        dot: "bg-kin-red",
        word: "Failed",
      },
      // A failed run is a failure first: the dot is red, so the word is too.
      {
        label: "failed routine run",
        row: taskRow({ task: failedRun }),
        dot: "bg-kin-red",
        word: "Failed",
      },
      {
        label: "waiting for approval",
        row: taskRow({ task: task("row-1", undefined, "waiting_approval") }),
        dot: "bg-kin-orange",
        word: "Awaiting approval",
      },
      {
        label: "waiting for you",
        row: taskRow({ task: task("row-1", undefined, "waiting_input") }),
        dot: "bg-kin-blue",
        word: "Awaiting you",
      },
      {
        label: "canceled",
        row: taskRow({ task: task("row-1", undefined, "canceled") }),
        word: "Canceled",
      },
    ];

    for (const { label, row, dot, word } of cases) {
      const view = render(<SessionRow {...props({ row })} />);
      const shell = rowButton();
      const painted = shell.querySelector<HTMLElement>(":scope > span > span[aria-hidden]");
      if (dot) expect(painted?.className, label).toContain(dot);
      else expect(painted, label).toBeNull();
      expect(view.container.querySelector("[data-session-status]")?.textContent, label).toContain(
        word,
      );
      expect(shell.getAttribute("aria-label"), label).toContain(word);
      view.unmount();
    }
  });

  it("keeps 待批准 N on a row whose only wait is approvals", () => {
    setLocale("zh");
    const { container } = render(
      <SessionRow {...props({ pending: { approvals: 2, questions: 0, total: 2 } })} />,
    );

    expect(container.querySelector("[data-session-status]")?.textContent).toContain("待批准 2");
    expect(container.textContent).not.toContain("待回答");
  });

  it("says 待回答 N on a row whose only wait is questions", () => {
    // The gap: a questions-only row used to claim an approval that did not
    // exist, so the one screen that answers "where is something waiting on me"
    // named the wrong kind of wait.
    setLocale("zh");
    const { container } = render(
      <SessionRow {...props({ pending: { approvals: 0, questions: 2, total: 2 } })} />,
    );

    expect(container.querySelector("[data-session-status]")?.textContent).toContain("待回答 2");
    expect(rowButton().getAttribute("aria-label")).not.toContain("待批准");
  });

  it("uses the neutral count when both kinds wait", () => {
    setLocale("zh");
    const { container } = render(
      <SessionRow {...props({ pending: { approvals: 1, questions: 2, total: 3 } })} />,
    );

    expect(container.querySelector("[data-session-status]")?.textContent).toContain("3 项待你处理");
  });

  it("says the question wording in English too", () => {
    const { container } = render(
      <SessionRow {...props({ pending: { approvals: 0, questions: 2, total: 2 } })} />,
    );

    expect(container.querySelector("[data-session-status]")?.textContent).toContain(
      "2 awaiting your answer",
    );
  });

  it("falls back to the task status when nothing waits", () => {
    // The new waiting branches must not swallow the status a waiting task
    // already names when its pending items are gone.
    setLocale("zh");
    const { container } = render(
      <SessionRow
        {...props({
          row: taskRow({ task: task("row-1", undefined, "waiting_approval") }),
          pending: { approvals: 0, questions: 0, total: 0 },
        })}
      />,
    );

    expect(container.querySelector("[data-session-status]")?.textContent).toContain("待审批");
  });

  it("opens the conversation on click and closes an already-open swipe instead when appropriate", async () => {
    const onOpen = vi.fn();
    const onSwipeOpenChange = vi.fn();
    const base = props({ onOpen, onSwipeOpenChange, coarse: true, shell: "page" });
    const { rerender } = render(<SessionRow {...base} />);

    await userEvent.click(rowButton());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSwipeOpenChange).not.toHaveBeenCalled();

    // While the row is swiped open, the next tap closes it instead of leaving.
    rerender(<SessionRow {...base} swipeOpen />);
    await userEvent.click(rowButton());
    expect(onSwipeOpenChange).toHaveBeenCalledWith(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("selection mode toggles only selectable unlocked rows and exposes the selected state", async () => {
    const onToggleSelect = vi.fn();
    const onOpen = vi.fn();
    const base = props({ selectionMode: true, onToggleSelect, onOpen });
    const { rerender } = render(<SessionRow {...base} />);

    const row = rowButton();
    expect(row.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(row);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    rerender(<SessionRow {...base} selected />);
    expect(rowButton().getAttribute("aria-pressed")).toBe("true");

    // A locked selection (a batch write in flight) accepts no more toggles.
    rerender(<SessionRow {...base} selectionLocked />);
    const locked = rowButton();
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(locked);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);

    // An imported row has no task, so the toolbar can never act on it.
    rerender(<SessionRow {...base} row={importedRow()} />);
    await userEvent.click(rowButton());
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Shift Enter enters selection through onStartSelection and never opens the thread", () => {
    const onToggleSelect = vi.fn();
    const onStartSelection = vi.fn();
    const onOpen = vi.fn();
    const { rerender } = render(
      <SessionRow {...props({ onToggleSelect, onStartSelection, onOpen })} />,
    );

    fireEvent.keyDown(rowButton(), { key: "Enter", shiftKey: true });

    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    // Already in the mode, the same shortcut toggles this row.
    rerender(
      <SessionRow {...props({ onToggleSelect, onStartSelection, onOpen, selectionMode: true })} />,
    );
    fireEvent.keyDown(rowButton(), { key: "Enter", shiftKey: true });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    // A locked selection refuses the shortcut for the same reason a click is refused.
    rerender(
      <SessionRow
        {...props({ onToggleSelect, onStartSelection, onOpen, selectionLocked: true })}
      />,
    );
    fireEvent.keyDown(rowButton(), { key: "Enter", shiftKey: true });
    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the shared menu from one trigger on a sidebar row and forwards pin archive delete", async () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onPin, onArchive, onDelete })} />,
    );

    // One discoverable control for the row's actions, not three hover-only ones.
    const trigger = rowActionsTrigger(container);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // "More" is the name every row's trigger shares; the conversation it acts
    // on is the description, so the control is still identifiable by voice.
    expect(trigger.getAttribute("aria-label")).toBe("More");
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Fix the build");

    const openMenu = async () => {
      await userEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      return screen.getByRole("menu");
    };

    const first = await openMenu();
    // Rename leads, then the way into multi-select, then the row's own edits.
    expect(
      within(first)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Select", "Pin", "Archive", "Delete"]);
    await userEvent.click(within(first).getByRole("menuitem", { name: "Pin" }));
    expect(onPin).toHaveBeenCalledTimes(1);
    // Choosing a row runs it once and puts the menu away again.
    expect(screen.queryByRole("menu")).toBeNull();

    const second = await openMenu();
    await userEvent.click(within(second).getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    const third = await openMenu();
    await userEvent.click(within(third).getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers restore and delete, not pin and archive, in the archived menu", async () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          row: taskRow({ task: task("row-1", 99) }),
          scope: "archived",
          onPin,
          onArchive,
          onRestore,
          onDelete,
        })}
      />,
    );

    const trigger = rowActionsTrigger(container);
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    // A genuinely archived row is selectable (the archive view's batch action
    // is Restore), so it keeps its own Restore/Delete and gains the same door in.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Select", "Restore", "Delete"]);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onPin).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("closes the menu on Escape and returns focus to the trigger", async () => {
    const { container } = render(<SessionRow {...props({ shell: "sidebar", coarse: false })} />);
    const trigger = rowActionsTrigger(container);

    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens the console action sheet from the row trigger on a touch page", async () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(<SessionRow {...props({ shell: "page", coarse: true, onArchive, onDelete })} />);

    const trigger = document.querySelector<HTMLElement>("[data-row-actions]");
    if (!trigger) throw new Error("the touch row did not render an actions trigger");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    await userEvent.click(trigger);

    // The sheet is the console's own list, titled with the conversation it acts on.
    const sheet = screen.getByRole("dialog", { name: "Fix the build" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    // The row runs from the sheet's close, so wait for the teardown rather than
    // assuming the sheet is gone the instant its row was tapped.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers Rename, Select and the row's edits in order on a touch page", async () => {
    const onStartSelection = vi.fn();
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(
      <SessionRow
        {...props({ shell: "page", coarse: true, onStartSelection, onPin, onArchive, onDelete })}
      />,
    );

    const trigger = document.querySelector<HTMLElement>("[data-row-actions]");
    if (!trigger) throw new Error("the touch row did not render an actions trigger");
    await userEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Fix the build" });
    // The same order as the Mac menu: Rename, the gesture-free way into
    // multi-select, then the row's own edits.
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Select", "Pin", "Archive", "Delete", "Cancel"]);

    await userEvent.click(within(sheet).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(onStartSelection).toHaveBeenCalledTimes(1));
    expect(onPin).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a long press on a touch row opens the row's action sheet instead of selecting", () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      const onStartSelection = vi.fn();
      render(<SessionRow {...props({ shell: "page", coarse: true, onOpen, onStartSelection })} />);
      const row = rowButton();

      // A finger resting on the row: the sheet opens while that finger is
      // still down, with the same list the trailing trigger opens.
      pointer(row, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });

      const sheet = screen.getByRole("dialog", { name: "Fix the build" });
      expect(
        within(sheet)
          .getAllByRole("button")
          .map((item) => item.textContent),
      ).toEqual(["Rename", "Select", "Pin", "Archive", "Delete", "Cancel"]);
      expect(onOpen).not.toHaveBeenCalled();
      expect(onStartSelection).not.toHaveBeenCalled();

      // The scrim mounted under the finger that is still holding the row. The
      // lift that follows belongs to that scrim and must not take the sheet
      // away before the person can choose from it.
      const scrim = document.querySelector<HTMLElement>("[data-kin-sheet] .kin-scrim-enter");
      if (!scrim) throw new Error("the sheet mounted without its scrim");
      pointer(scrim, "pointerup", 200);
      expect(screen.getByRole("dialog", { name: "Fix the build" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a long press never enters multi-select", () => {
    vi.useFakeTimers();
    try {
      render(<SessionRow {...props({ shell: "page", coarse: true })} />);
      const row = rowButton();
      pointer(row, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });

      // The hold has one meaning: this row's own actions. Selection is entered
      // from the sheet's Select or from Shift+Enter, never as a side effect.
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(document.querySelector("[data-selection-toolbar]")).toBeNull();
      expect(rowButton().getAttribute("aria-pressed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dragging row exposes data-dragging and its offset", () => {
    const { container } = render(
      <SessionRow
        {...props({
          shell: "page",
          coarse: true,
          reorder: { onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn() },
          dragging: true,
          dragOffsetY: 36,
        })}
      />,
    );

    const lifted = container.querySelector<HTMLElement>("[data-dragging]");
    if (!lifted) throw new Error("a dragging row did not mark itself");
    // The row follows the finger as a lift, not a screen transition.
    expect(lifted.style.transform).toBe("translateY(36px)");
    expect(lifted.className).toContain("shadow-e2");
    expect(lifted.contains(rowButton())).toBe(true);
  });

  it("the trailing trigger still opens the row actions", async () => {
    // The hold belongs to the reorder now; the one visible way into the sheet
    // is still the trailing trigger, unchanged.
    const onArchive = vi.fn();
    render(
      <SessionRow
        {...props({
          shell: "page",
          coarse: true,
          onArchive,
          reorder: { onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn() },
        })}
      />,
    );

    const trigger = document.querySelector<HTMLElement>("[data-row-actions]");
    if (!trigger) throw new Error("the touch row did not render an actions trigger");
    await userEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Fix the build" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape closes a long-press sheet and returns focus to the row", () => {
    vi.useFakeTimers();
    try {
      render(<SessionRow {...props({ shell: "page", coarse: true })} />);
      const row = rowButton();
      row.focus();
      pointer(row, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByRole("dialog", { name: "Fix the build" })).toBeTruthy();

      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("dialog")).toBeNull();
      // Sheet remembers the element that was focused when it opened; no
      // second focus mechanism is invented for the gesture.
      expect((document.activeElement as HTMLElement | null)?.getAttribute("data-session-row")).toBe(
        "row-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the same ordered actions in the Mac sidebar menu", async () => {
    const onStartSelection = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onStartSelection })} />,
    );

    await userEvent.click(rowActionsTrigger(container));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Select", "Pin", "Archive", "Delete"]);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Select" }));
    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a running conversation says Running in the Mac menu and still offers Archive and Delete", async () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          row: taskRow({ task: task("row-1", undefined, "running") }),
          onArchive,
          onDelete,
        })}
      />,
    );

    await userEvent.click(rowActionsTrigger(container));
    const menu = screen.getByRole("menu");
    // A status line leads, and it is part of the one list both surfaces share.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Running", "Rename", "Select", "Pin", "Archive", "Delete"]);

    const running = within(menu).getByRole("menuitem", { name: "Running" });
    expect(running.getAttribute("aria-disabled")).toBe("true");
    // Choosing it is not a choice: the menu stays up and nothing runs.
    await userEvent.click(running);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    // The row's real actions keep working exactly as they do on a settled row.
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a running conversation says Running in the phone action sheet without blocking its edits", async () => {
    const onArchive = vi.fn();
    render(
      <SessionRow
        {...props({
          shell: "page",
          coarse: true,
          row: taskRow({ task: task("row-1", undefined, "running") }),
          onArchive,
        })}
      />,
    );

    const trigger = document.querySelector<HTMLElement>("[data-row-actions]");
    if (!trigger) throw new Error("the touch row did not render an actions trigger");
    await userEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Fix the build" });
    const running = within(sheet).getByRole("button", { name: "Running" });
    // The sheet draws a native disabled button; the line reads as information,
    // not as a control the person can choose.
    expect(running.tagName).toBe("BUTTON");
    expect((running as HTMLButtonElement).disabled).toBe(true);

    for (const name of ["Rename", "Archive", "Delete"]) {
      expect((within(sheet).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }

    await userEvent.click(within(sheet).getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a conversation waiting on the person does not say Running", async () => {
    // A chat that is waiting on the person is already asking for them, and the
    // row's dot says so: it is not working on its own.
    for (const status of ["waiting_approval", "waiting_input"]) {
      const mac = render(
        <SessionRow
          {...props({
            shell: "sidebar",
            coarse: false,
            row: taskRow({ task: task("row-1", undefined, status) }),
          })}
        />,
      );
      await userEvent.click(rowActionsTrigger(mac.container));
      expect(
        within(screen.getByRole("menu"))
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Rename", "Select", "Pin", "Archive", "Delete"]);
      mac.unmount();

      const phone = render(
        <SessionRow
          {...props({
            shell: "page",
            coarse: true,
            row: taskRow({ task: task("row-1", undefined, status) }),
          })}
        />,
      );
      const trigger = document.querySelector<HTMLElement>("[data-row-actions]");
      if (!trigger) throw new Error("the touch row did not render an actions trigger");
      await userEvent.click(trigger);
      const sheet = screen.getByRole("dialog", { name: "Fix the build" });
      expect(
        within(sheet)
          .getAllByRole("button")
          .map((item) => item.textContent),
      ).toEqual(["Rename", "Select", "Pin", "Archive", "Delete", "Cancel"]);
      phone.unmount();
    }
  });

  it("a queued or retrying conversation says Running", async () => {
    // The same tone the row's dot already draws: the conversation is still
    // being worked on, however it is spelled internally.
    for (const status of ["queued", "retrying"]) {
      const view = render(
        <SessionRow
          {...props({
            shell: "sidebar",
            coarse: false,
            row: taskRow({ task: task("row-1", undefined, status) }),
          })}
        />,
      );
      await userEvent.click(rowActionsTrigger(view.container));
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]?.textContent).toBe(
        "Running",
      );
      view.unmount();
    }
  });

  it("an archived conversation that is still running says Running", async () => {
    // Archiving does not stop a run, so an archived conversation whose task is
    // still going keeps the warning above the actions that follow it.
    const { container } = render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          row: taskRow({ task: task("row-1", 99, "running") }),
          scope: "archived",
        })}
      />,
    );

    await userEvent.click(rowActionsTrigger(container));
    expect(
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Running", "Select", "Restore", "Delete"]);
  });

  it("while selecting, the row menu holds only Exit selection", async () => {
    const onExitSelection = vi.fn();
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          selectionMode: true,
          selected: true,
          onExitSelection,
          onPin,
          onArchive,
          onDelete,
        })}
      />,
    );

    // The same one trigger, still named the same way, is the way back out.
    const trigger = rowActionsTrigger(container);
    expect(trigger.getAttribute("aria-label")).toBe("More");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Exit selection"]);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Exit selection" }));
    expect(onExitSelection).toHaveBeenCalledTimes(1);
    expect(onPin).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps Exit selection available while the selection is locked", async () => {
    // A batch write in flight disables the bar's actions but never the way out.
    const onExitSelection = vi.fn();
    const { container } = render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          selectionMode: true,
          selectionLocked: true,
          onExitSelection,
        })}
      />,
    );

    await userEvent.click(rowActionsTrigger(container));
    const exit = screen.getByRole("menuitem", { name: "Exit selection" });
    expect(exit.getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(exit);
    expect(onExitSelection).toHaveBeenCalledTimes(1);
  });

  it("offers no menu on a row that cannot be selected", async () => {
    const { container, rerender } = render(
      <SessionRow
        {...props({ shell: "sidebar", coarse: false, selectionMode: true, row: importedRow() })}
      />,
    );
    // An imported row has no task, so the toolbar can never act on it and the
    // row gains no exit trigger either.
    expect(container.querySelector("[data-row-actions]")).toBeNull();

    // A live chat listed under an archived project is put back by the project's
    // own Restore, so it is not selectable and carries no menu.
    rerender(
      <SessionRow
        {...props({ shell: "sidebar", coarse: false, selectionMode: true, scope: "archived" })}
      />,
    );
    expect(container.querySelector("[data-row-actions]")).toBeNull();

    // Outside selection the archive view's own list stays Restore + Delete; the
    // row is selectable, so the way into the mode joins the front of it.
    rerender(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          scope: "archived",
          row: taskRow({ task: task("row-1", 99) }),
        })}
      />,
    );
    await userEvent.click(rowActionsTrigger(container));
    expect(
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Select", "Restore", "Delete"]);
  });

  it("keeps the trigger in selection mode only where the row can be selected", () => {
    const { container, rerender } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, selectionMode: true })} />,
    );
    // A selectable row keeps its trigger while selecting: it is the way out.
    expect(container.querySelector("[data-row-actions]")).not.toBeNull();

    rerender(<SessionRow {...props({ shell: "sidebar", coarse: false, row: importedRow() })} />);
    expect(container.querySelector("[data-row-actions]")).toBeNull();

    rerender(
      <SessionRow
        {...props({ shell: "page", coarse: true, selectionMode: true, row: importedRow() })}
      />,
    );
    expect(container.querySelector("[data-row-actions]")).toBeNull();

    // A live chat listed under an archived project is put back by the
    // project's own Restore, so its row carries no actions at all.
    rerender(<SessionRow {...props({ shell: "sidebar", coarse: false, scope: "archived" })} />);
    expect(container.querySelector("[data-row-actions]")).toBeNull();
  });

  it("does not bring back a surface that was open when the row lost its actions", async () => {
    const base = props({ shell: "sidebar", coarse: false });
    const { container, rerender } = render(<SessionRow {...base} />);

    await userEvent.click(rowActionsTrigger(container));
    expect(screen.getByRole("menu")).toBeTruthy();

    // An imported row has no actions; the menu goes with the trigger and its
    // open state must not survive to pop the menu back open later.
    rerender(<SessionRow {...base} row={importedRow()} />);
    expect(screen.queryByRole("menu")).toBeNull();

    rerender(<SessionRow {...base} />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rowActionsTrigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the row menu when multi-select replaces its actions", async () => {
    const base = props({ shell: "sidebar", coarse: false });
    const { container, rerender } = render(<SessionRow {...base} />);

    await userEvent.click(rowActionsTrigger(container));
    expect(screen.getByRole("menu")).toBeTruthy();

    // The trigger stays as the exit, but a menu opened for Pin/Archive/Delete
    // must not silently become the selection menu under the reader.
    rerender(<SessionRow {...base} selectionMode />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rowActionsTrigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("touch rows use SessionRowActions with the existing active or archived width, forward swipe open, and open their own sheet on a long press", async () => {
    const active = props({ shell: "page", coarse: true, swipeOpen: true });
    const { rerender } = render(<SessionRow {...active} />);
    const pin = screen.getByRole("button", { name: "Pin" });
    // Three 76px chips: the strip the row slides over in the list.
    expect(pin.parentElement!.style.width).toBe("228px");
    // While the strip is in front, the trailing trigger steps out of the way
    // instead of sliding along beside the chips as a fourth one.
    expect(document.querySelector("[data-row-actions]")!.className).toContain("invisible");
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    rerender(
      <SessionRow {...active} row={taskRow({ task: task("row-1", 99) })} scope="archived" />,
    );
    const restore = screen.getByRole("button", { name: "Restore" });
    // Two 76px chips: the archive view uncovers restore + delete only.
    expect(restore.parentElement!.style.width).toBe("152px");

    // A leftward drag past half the strip asks the parent to commit it open.
    vi.useFakeTimers();
    try {
      const onOpenChange = vi.fn();
      rerender(
        <SessionRow
          {...props({ shell: "page", coarse: true, onSwipeOpenChange: onOpenChange })}
          swipeOpen={false}
        />,
      );
      const row = rowButton();
      // Past half of the 228px active strip, so the drag commits it open.
      pointer(row, "pointerdown", 200);
      pointer(row, "pointermove", 40);
      pointer(row, "pointerup", 40);
      expect(onOpenChange).toHaveBeenCalledWith(true);

      // Holding the row is the sheet's own second door: the same list the
      // trailing trigger opens, not an invisible way into multi-select.
      pointer(row, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByRole("dialog", { name: "Fix the build" })).toBeTruthy();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();

      // A press that starts on the trailing trigger is a press on that control,
      // not the row's long press: holding "More" must not open the row's sheet
      // from underneath the finger.
      const trigger = document.querySelector("[data-row-actions]")!;
      pointer(trigger, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      pointer(trigger, "pointerup", 200);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selection mode and imported rows without a task do not expose swipe actions", () => {
    const { rerender } = render(
      <SessionRow
        {...props({ shell: "page", coarse: true, selectionMode: true, swipeOpen: true })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    rerender(<SessionRow {...props({ shell: "sidebar", coarse: false, row: importedRow() })} />);
    expect(screen.getByRole("button", { name: /Imported chat/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("reorder-hint-is-a-tooltip-not-the-accessible-name", () => {
    const { rerender } = render(<SessionRow {...props({ reorderHint: true })} />);

    expect(rowButton().getAttribute("title")).toBe("Alt+↑/↓ moves this chat");
    // The hint is sighted-only guidance; the row's sentence must not grow it.
    expect(rowButton().getAttribute("aria-label")).not.toContain("Alt");

    rerender(<SessionRow {...props()} />);
    expect(rowButton().hasAttribute("title")).toBe(false);
  });

  /** Open the row's actions and choose Rename on either surface, returning the
   *  field the row turned into. The sheet runs its row from its close
   *  teardown, so both paths wait for the field rather than assume it. */
  async function chooseRename(
    container: HTMLElement,
    surface: "menu" | "sheet",
  ): Promise<HTMLInputElement> {
    await userEvent.click(rowActionsTrigger(container));
    const opened =
      surface === "menu"
        ? screen.getByRole("menu")
        : screen.getByRole("dialog", { name: "Fix the build" });
    await userEvent.click(
      within(opened).getByRole(surface === "menu" ? "menuitem" : "button", { name: "Rename" }),
    );
    return waitFor(() => screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement);
  }

  it("choosing Rename edits the title in place with it selected", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onOpen })} />,
    );

    const field = await chooseRename(container, "menu");

    expect(field.value).toBe("Fix the build");
    expect(document.activeElement).toBe(field);
    // The whole current title is selected, so typing replaces it.
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("Fix the build".length);
    // The edit is the row, not a screen: nothing navigates, no surface stays up.
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Enter saves the trimmed title and returns focus to the row", async () => {
    const onRename = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onRename })} />,
    );
    const field = await chooseRename(container, "menu");

    fireEvent.change(field, { target: { value: "  Ship the build  " } });
    await userEvent.keyboard("{Enter}");

    expect(onRename).toHaveBeenCalledWith("Ship the build");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(rowButton());
  });

  it("Escape cancels the edit without calling onRename", async () => {
    const onRename = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onRename })} />,
    );
    const field = await chooseRename(container, "menu");

    fireEvent.change(field, { target: { value: "Something else" } });
    await userEvent.keyboard("{Escape}");

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(rowButton());
    // The row still carries the title it had before the edit.
    expect(rowButton().textContent).toContain("Fix the build");
  });

  it("a blank title cannot be saved", async () => {
    const onRename = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onRename })} />,
    );
    const field = await chooseRename(container, "menu");

    fireEvent.change(field, { target: { value: "   " } });
    await userEvent.keyboard("{Enter}");

    expect(onRename).not.toHaveBeenCalled();
    // The field stays open and keeps focus so the person can finish typing.
    const shown = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    expect(shown).toBe(document.activeElement);
    // And it says why nothing was saved, rather than looking like a no-op.
    expect(shown.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a title to save")).toBeTruthy();
    // Typing again is an answer to that message, so it goes away.
    fireEvent.change(shown, { target: { value: "Ship it" } });
    expect(screen.queryByText("Enter a title to save")).toBeNull();
  });

  it("hides the row's tail and the actions trigger while the title is edited", async () => {
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, deviceLabel: "Studio" })} />,
    );
    expect(container.querySelector("[data-session-meta]")?.textContent).toBe(
      "Claude Code · 2 minutes ago · Done · Studio",
    );

    const field = await chooseRename(container, "menu");

    // In a 248px sidebar the metadata line and the trigger beside the field
    // left only a few characters of the name visible.
    expect(container.querySelector("[data-session-meta]")).toBeNull();
    expect(container.querySelector("[data-row-actions]")).toBeNull();
    expect(field.className).toContain("px-1.5");
  });

  it("offers touch-sized Save and Cancel beside the phone's edit field", async () => {
    const onRename = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "page", coarse: true, onRename })} />,
    );
    const field = await chooseRename(container, "sheet");

    // A soft keyboard has no Enter or Escape, so the touch surface draws both
    // controls at the same 44px target the row's own actions keep.
    const save = within(rowButton()).getByRole("button", { name: "Save" });
    const cancel = within(rowButton()).getByRole("button", { name: "Cancel" });
    for (const control of [save, cancel]) {
      expect(control.className).toContain("h-11");
      expect(control.className).toContain("w-11");
    }
    // The trailing trigger is gone while editing: it cannot take the draft.
    expect(container.querySelector("[data-row-actions]")).toBeNull();

    fireEvent.change(field, { target: { value: "  Ship it  " } });
    await userEvent.click(save);

    // The tap confirms the edit instead of blurring the field away first.
    expect(onRename).toHaveBeenCalledWith("Ship it");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(rowButton());
  });

  it("Cancel leaves the phone's edit without saving", async () => {
    const onRename = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "page", coarse: true, onRename })} />,
    );
    const field = await chooseRename(container, "sheet");
    fireEvent.change(field, { target: { value: "Never mind" } });

    await userEvent.click(within(rowButton()).getByRole("button", { name: "Cancel" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    // The row still carries the title it had before the edit.
    expect(rowButton().textContent).toContain("Fix the build");
  });

  it("Tab from the field reaches the phone's Save and commits on Enter", async () => {
    const onRename = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "page", coarse: true, onRename })} />,
    );
    const field = await chooseRename(container, "sheet");
    fireEvent.change(field, { target: { value: "Ship it" } });

    await userEvent.tab();

    // The field and the Save/Cancel pair are one editor: moving focus between
    // them must not cancel the edit and unmount the control keyboard focus is
    // travelling to (TASTE 11).
    const save = within(rowButton()).getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(save);

    await userEvent.keyboard("{Enter}");

    expect(onRename).toHaveBeenCalledWith("Ship it");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the rename field is not inside the row's button", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onOpen })} />,
    );
    const field = await chooseRename(container, "menu");

    // HTML cannot nest an input inside a button, and the row's own click must
    // not fire while editing: the shell is a plain row until the edit ends.
    expect(field.closest("button")).toBeNull();
    expect(rowButton().tagName).toBe("DIV");
    expect(rowButton().hasAttribute("aria-label")).toBe(false);

    await userEvent.click(rowButton());
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the Mac menu and the phone sheet offer the same action ids", async () => {
    const mac = render(<SessionRow {...props({ shell: "sidebar", coarse: false })} />);
    await userEvent.click(rowActionsTrigger(mac.container));
    const menuLabels = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    mac.unmount();

    render(<SessionRow {...props({ shell: "page", coarse: true })} />);
    const trigger = document.querySelector<HTMLElement>("[data-row-actions]");
    if (!trigger) throw new Error("the touch row did not render an actions trigger");
    await userEvent.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Fix the build" });
    const sheetLabels = within(sheet)
      .getAllByRole("button")
      .map((item) => item.textContent);

    // One action list feeds both surfaces (TASTE 3 and 4): same rows, same
    // order, same labels. Cancel is the sheet's own close, not a row.
    expect(menuLabels).toEqual(["Rename", "Select", "Pin", "Archive", "Delete"]);
    expect(sheetLabels.slice(0, 5)).toEqual(menuLabels);
    expect(sheetLabels[5]).toBe("Cancel");

    // The phone's door reaches the same in-place field.
    await userEvent.click(within(sheet).getByRole("button", { name: "Rename" }));
    const field = await waitFor(
      () => screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement,
    );
    expect(field.value).toBe("Fix the build");
  });

  it("offers no Rename on an archived row or an imported row", async () => {
    const { container, rerender } = render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          row: taskRow({ task: task("row-1", 99) }),
          scope: "archived",
        })}
      />,
    );

    await userEvent.click(rowActionsTrigger(container));
    const archivedLabels = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    // The archived menu is restore + delete; a name is not a way back.
    expect(archivedLabels).toEqual(["Select", "Restore", "Delete"]);
    await userEvent.keyboard("{Escape}");

    // An imported session has no task id, so it has no local title to edit —
    // and its row carries no action surface at all.
    rerender(<SessionRow {...props({ shell: "sidebar", coarse: false, row: importedRow() })} />);
    expect(container.querySelector("[data-row-actions]")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
