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
 * instead of entering multi-select.
 */

const NOW = new Date("2026-11-15T12:00:00Z").getTime();

function task(id: string, archivedAt?: number): Task {
  return {
    id,
    title: id,
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status: "succeeded",
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
    pendingCount: 0,
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
  it("renders the conversation title agent status device and relative time without changing the accessible label", () => {
    const { container } = render(<SessionRow {...props({ deviceLabel: "Studio" })} />);

    expect(screen.getByText("Fix the build")).toBeTruthy();
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("2 minutes ago")).toBeTruthy();
    // The status dot is the succeeded, not-yet-viewed marker.
    expect(container.querySelector(".bg-kin-green")).not.toBeNull();
    // aria-label is the row's own sentence: title, agent, when, status, device.
    expect(
      screen.getByRole("button", {
        name: "Fix the build · Claude Code · 2 minutes ago · completed · Studio",
      }),
    ).toBeTruthy();
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
    // Select is the visible door into multi-select, ahead of the row's own edits.
    expect(
      within(first)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Select", "Pin", "Archive", "Delete"]);
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

  it("offers Select as the row menu's first action on a touch page", async () => {
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
    // The gesture-free way in, ahead of the row's own edits.
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["Select", "Pin", "Archive", "Delete", "Cancel"]);

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
      ).toEqual(["Select", "Pin", "Archive", "Delete", "Cancel"]);
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

  it("offers Select in the Mac sidebar menu too", async () => {
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
    ).toEqual(["Select", "Pin", "Archive", "Delete"]);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Select" }));
    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
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
});
