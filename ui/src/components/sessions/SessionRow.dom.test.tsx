// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSession, Task } from "../../api/client";
import type { PhoneSessionRow } from "../../lib/phoneSessionBuckets";
import { setLocale } from "../../i18n";
import SessionRow, { type SessionRowProps } from "./SessionRow";

/**
 * The conversation row is the one renderer both the phone page and the Mac
 * sidebar use. It moved out of `SessionList` unchanged, so these tests pin the
 * contract at the new boundary: the accessible name it announces, what a click
 * does in each mode, which actions each container uncovers, and that selection
 * and imported rows expose no swipe strip.
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
    onLongPress: vi.fn(),
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

function rowButton(name: RegExp | string): HTMLElement {
  return screen.getByRole("button", { name });
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

    await userEvent.click(rowButton(/Fix the build/));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSwipeOpenChange).not.toHaveBeenCalled();

    // While the row is swiped open, the next tap closes it instead of leaving.
    rerender(<SessionRow {...base} swipeOpen />);
    await userEvent.click(rowButton(/Fix the build/));
    expect(onSwipeOpenChange).toHaveBeenCalledWith(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("selection mode toggles only selectable unlocked rows and exposes the selected state", async () => {
    const onToggleSelect = vi.fn();
    const onOpen = vi.fn();
    const base = props({ selectionMode: true, onToggleSelect, onOpen });
    const { rerender } = render(<SessionRow {...base} />);

    const row = rowButton(/Fix the build/);
    expect(row.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(row);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    rerender(<SessionRow {...base} selected />);
    expect(rowButton(/Fix the build/).getAttribute("aria-pressed")).toBe("true");

    // A locked selection (a batch write in flight) accepts no more toggles.
    rerender(<SessionRow {...base} selectionLocked />);
    const locked = rowButton(/Fix the build/);
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(locked);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);

    // An imported row has no task, so the toolbar can never act on it.
    rerender(<SessionRow {...base} row={importedRow()} />);
    await userEvent.click(rowButton(/Imported chat/));
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

    fireEvent.keyDown(rowButton(/Fix the build/), { key: "Enter", shiftKey: true });

    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    // Already in the mode, the same shortcut toggles this row.
    rerender(
      <SessionRow
        {...props({ onToggleSelect, onStartSelection, onOpen, selectionMode: true })}
      />,
    );
    fireEvent.keyDown(rowButton(/Fix the build/), { key: "Enter", shiftKey: true });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    // A locked selection refuses the shortcut for the same reason a click is refused.
    rerender(
      <SessionRow
        {...props({ onToggleSelect, onStartSelection, onOpen, selectionLocked: true })}
      />,
    );
    fireEvent.keyDown(rowButton(/Fix the build/), { key: "Enter", shiftKey: true });
    expect(onStartSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("desktop sidebar shows pin archive and delete actions and forwards each callback", async () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(
      <SessionRow {...props({ shell: "sidebar", coarse: false, onPin, onArchive, onDelete })} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Pin" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("archived rows show restore and delete rather than pin and archive", async () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    render(
      <SessionRow
        {...props({
          shell: "sidebar",
          coarse: false,
          row: taskRow({ task: task("row-1", 99) }),
          scope: "archived",
          onRestore,
          onDelete,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("touch rows use SessionRowActions with the existing active or archived width and forward swipe open and long-press callbacks", async () => {
    const active = props({ shell: "page", coarse: true, swipeOpen: true });
    const { rerender } = render(<SessionRow {...active} />);
    const pin = screen.getByRole("button", { name: "Pin" });
    // Three 76px chips: the strip the row slides over in the list.
    expect(pin.parentElement!.style.width).toBe("228px");
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
      const onLongPress = vi.fn();
      rerender(
        <SessionRow
          {...props({ shell: "page", coarse: true, onSwipeOpenChange: onOpenChange, onLongPress })}
          swipeOpen={false}
        />,
      );
      const row = rowButton(/Fix the build/);
      // Past half of the 228px active strip, so the drag commits it open.
      pointer(row, "pointerdown", 200);
      pointer(row, "pointermove", 40);
      pointer(row, "pointerup", 40);
      expect(onOpenChange).toHaveBeenCalledWith(true);

      // Holding the row is the second way into multi-select.
      pointer(row, "pointerdown", 200);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(onLongPress).toHaveBeenCalledTimes(1);
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
});
