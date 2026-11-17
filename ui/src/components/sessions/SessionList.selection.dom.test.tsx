// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * Multi-select has to stay escapable in a 248px sidebar.
 *
 * The toolbar's batch actions and its Cancel are one row of 44px targets plus
 * a count label; the viewport `sm:` breakpoint used to decide that from the
 * window width, so an iPad's wide viewport made the 248px sidebar render the
 * desktop labels and clip the exit. These tests pin the exit itself: Escape
 * and Cancel clear the mode and hand focus back to the row that started it,
 * while batch work and unrelated refreshes must not move the keyboard.
 *
 * jsdom has no layout engine. The geometry boundary below assigns widths the
 * way a browser would (44px target floor, a text control's rough intrinsic
 * width) and lays the toolbar's direct children out in flex lines. It proves
 * the markup does not ask for more inline space than the container has; it
 * cannot prove a real browser paints it that way. A Chromium measurement at
 * 248px and 390px is recorded alongside the change for that.
 *
 * KIN-MANAGE-001, step 3: the row menu is the only pointer door into
 * selection; Escape still returns focus to the row that started it.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    listAgentSessionsPage: vi.fn(async () => ({
      items: [] as AgentSession[],
      next_cursor: undefined,
    })),
    listTasks: vi.fn(async () => []),
    listProjects: vi.fn(async () => [] as Project[]),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

function viewport(pointer: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? pointer === "coarse" : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string): Task {
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
  } as Task;
}

function mount(shell: "sidebar" | "page" = "sidebar") {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell={shell} />
    </MemoryRouter>,
  );
}

function row(id: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(id) });
}

function toolbar(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-selection-toolbar]");
  if (!el) throw new Error("selection toolbar is not mounted");
  return el;
}

/** One row's `⋯` trigger, found through the title it is described by. */
function rowActions(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-row-actions][aria-describedby="session-row-title-${id}"]`,
  );
  if (!el) throw new Error(`row ${id} has no actions trigger`);
  return el;
}

/** The batch action buttons are icon-only; their names come from aria-label. */
const ACTION_NAMES = ["Pin", "Archive", "Delete"] as const;

// --- geometry boundary -----------------------------------------------------

const ICON_TARGET = 44;
const CONTROL_GAP = 6;
const TOOLBAR_PAD = 20;
const TOOLBAR_GAP = 8;

function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[⺀-鿿]/.test(ch) ? 12 : 6.6;
  return Math.ceil(width);
}

function intrinsicWidth(el: HTMLElement): number {
  if (el.tagName === "BUTTON") {
    const text = (el.textContent ?? "").trim();
    const icon = el.querySelector("svg") ? 14 + 6 : 0;
    if (!text) return Math.max(ICON_TARGET, icon);
    return Math.max(ICON_TARGET, 20 + icon + textWidth(text));
  }
  // The count/select-all label: checkbox + gap + text.
  return (
    (el.querySelector('input[type="checkbox"]') ? 20 + 8 : 0) + textWidth(el.textContent ?? "")
  );
}

function groupWidth(el: HTMLElement): number {
  if (el.children.length === 0) return intrinsicWidth(el);
  const widths = Array.from(el.children).map((child) => groupWidth(child as HTMLElement));
  return widths.reduce((sum, w) => sum + w, 0) + CONTROL_GAP * (widths.length - 1);
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Lay the toolbar out with a container of `available` inline pixels. Direct
 * children are flex items; a `flex-wrap` toolbar starts a new line when the
 * next item would pass the edge. Returns the toolbar's scrollWidth and every
 * modeled control rect.
 */
function layout(el: HTMLElement, available: number) {
  const wraps = el.className.includes("flex-wrap");
  const items = Array.from(el.children) as HTMLElement[];
  const lines: { width: number; items: { el: HTMLElement; width: number }[] }[] = [
    { width: 0, items: [] },
  ];
  for (const item of items) {
    const width = groupWidth(item);
    const line = lines[lines.length - 1];
    const next = line.items.length === 0 ? width : line.width + TOOLBAR_GAP + width;
    if (wraps && next > available && line.items.length > 0) {
      lines.push({ width, items: [{ el: item, width }] });
    } else {
      line.width = next;
      line.items.push({ el: item, width });
    }
  }
  const rects = new Map<HTMLElement, Rect>();
  let y = 0;
  for (const line of lines) {
    let x = 0;
    for (const item of line.items) {
      rects.set(item.el, { x, y, width: item.width, height: ICON_TARGET });
      x += item.width + CONTROL_GAP;
    }
    y += ICON_TARGET;
  }
  return {
    scrollWidth: Math.max(available, ...lines.map((line) => line.width)),
    rects,
  };
}

function modeledRect(el: HTMLElement, available: number): Rect {
  const result = layout(toolbar(), available);
  for (const [node, rect] of result.rects) {
    if (node === el || node.contains(el)) {
      if (node === el) return rect;
      // A control inside a group: place it along the group's own row.
      let x = rect.x;
      for (const child of Array.from(node.children) as HTMLElement[]) {
        const width = groupWidth(child);
        if (child === el || child.contains(el)) {
          if (child === el) return { x, y: rect.y, width, height: ICON_TARGET };
          const inner = modeledRect(child, available);
          return { ...inner, x, y: rect.y };
        }
        x += width + CONTROL_GAP;
      }
      return rect;
    }
  }
  throw new Error("control is not inside the selection toolbar");
}

function expectToolbarFits(available: number) {
  const bar = toolbar();
  const result = layout(bar, available);
  expect(result.scrollWidth).toBeLessThanOrEqual(available);

  const cancel = screen.getByRole("button", { name: "Cancel" });
  const rect = modeledRect(cancel, available);
  expect(rect.width).toBeGreaterThanOrEqual(ICON_TARGET);
  expect(rect.height).toBeGreaterThanOrEqual(ICON_TARGET);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(available);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [task("alpha-1"), task("alpha-2"), task("alpha-3")];
  viewport("coarse");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the selection toolbar at the width it actually has", () => {
  it("keeps cancel and every batch action inside the narrow selection toolbar", async () => {
    mount("sidebar");
    fireEvent.keyDown(row("alpha-1"), { key: "Enter", shiftKey: true });

    const bar = toolbar();
    expect(bar).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select all" })).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    for (const name of ACTION_NAMES) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("title")).toBe("Cancel");

    // The sidebar body is 248px wide; the toolbar's own padding is inside it.
    expectToolbarFits(248 - TOOLBAR_PAD);
  });

  it("keeps the same controls inside a 390px page", () => {
    mount("page");
    act(() => {
      fireEvent.keyDown(row("alpha-1"), { key: "Enter", shiftKey: true });
    });

    expect(screen.getByRole("checkbox", { name: "Select all" })).toBeTruthy();
    for (const name of [...ACTION_NAMES, "Cancel"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expectToolbarFits(390 - TOOLBAR_PAD);
  });
});

describe("leaving multi-select", () => {
  it("exits with Escape back to the row that entered selection", async () => {
    const user = userEvent.setup();
    mount("sidebar");

    // Selection starts from the row's visible menu (or Shift+Enter); the hold
    // itself opens this row's actions and leaves the list alone.
    await user.click(rowActions("alpha-1"));
    await user.click(
      within(screen.getByRole("dialog", { name: "alpha-1" })).getByRole("button", {
        name: "Select",
      }),
    );
    await waitFor(() => expect(toolbar()).toBeTruthy());
    expect(row("alpha-1").getAttribute("aria-pressed")).toBe("true");

    const focused = row("alpha-1");
    focused.focus();
    fireEvent.keyDown(focused, { key: "Escape" });

    expect(document.querySelector("[data-selection-toolbar]")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
    // fireEvent flushes effects, so the one-shot restore has already run.
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute("data-session-row")).toBe(
        "alpha-1",
      ),
    );
    expect(row("alpha-1").getAttribute("aria-pressed")).toBeNull();
  });

  it("restores focus once, not again on the next list update", async () => {
    const user = userEvent.setup();
    const view = mount("sidebar");
    row("alpha-1").focus();
    fireEvent.keyDown(row("alpha-1"), { key: "Enter", shiftKey: true });
    expect(toolbar()).toBeTruthy();
    // Entering replaces the row element; the commit effect puts the keyboard
    // back on the same row, or Escape would have nothing inside the list to
    // travel through (a real browser drops focus to <body> without it).
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-session-row")).toBe(
      "alpha-1",
    );

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute("data-session-row")).toBe(
        "alpha-1",
      ),
    );

    // The restore is one-shot: a later render must not pull focus back.
    const search = screen.getByRole("searchbox");
    search.focus();
    fixtures.tasks = [task("alpha-1"), task("alpha-2"), task("alpha-3"), task("alpha-4")];
    view.rerender(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionList shell="sidebar" />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(search);
  });

  it("cancels from the visible toolbar and restores focus once", async () => {
    const user = userEvent.setup();
    mount("sidebar");
    row("alpha-2").focus();
    fireEvent.keyDown(row("alpha-2"), { key: "Enter", shiftKey: true });

    const cancel = screen.getByRole("button", { name: "Cancel" });
    // Not reachable only by scrolling: the geometry boundary keeps it on a
    // line inside the 228px content box.
    expectToolbarFits(248 - TOOLBAR_PAD);
    await user.click(cancel);

    await waitFor(() => expect(document.querySelector("[data-selection-toolbar]")).toBeNull());
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute("data-session-row")).toBe(
        "alpha-2",
      ),
    );
  });

  it("does not steal focus after a batch operation or unrelated list update", async () => {
    const user = userEvent.setup();
    const view = mount("sidebar");
    row("alpha-1").focus();
    fireEvent.keyDown(row("alpha-1"), { key: "Enter", shiftKey: true });

    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(document.querySelector("[data-selection-toolbar]")).toBeNull());
    expect(
      (document.activeElement as HTMLElement | null)?.hasAttribute("data-session-row") ?? false,
    ).toBe(false);

    // Re-enter, then change the count through select-all and let the list
    // change underneath it. Neither is a user exit, so focus must stay on the
    // checkbox the person just used.
    row("alpha-2").focus();
    fireEvent.keyDown(row("alpha-2"), { key: "Enter", shiftKey: true });
    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    await user.click(selectAll);
    expect(screen.getByText("3 selected")).toBeTruthy();
    fixtures.tasks = [task("alpha-2"), task("alpha-3"), task("alpha-4")];
    view.rerender(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionList shell="sidebar" />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-selection-toolbar]")).not.toBeNull();
    expect(document.activeElement).toBe(selectAll);
  });
});

describe("the row menu is the visible door", () => {
  it("enters selection from the row menu", async () => {
    const user = userEvent.setup();
    mount("sidebar");

    await user.click(rowActions("alpha-2"));
    const sheet = screen.getByRole("dialog", { name: "alpha-2" });
    // Select leads the row's own edits; batch actions stay on the toolbar.
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["Select", "Pin", "Archive", "Delete", "Cancel"]);
    await user.click(within(sheet).getByRole("button", { name: "Select" }));

    await waitFor(() => expect(toolbar()).toBeTruthy());
    expect(row("alpha-2").getAttribute("aria-pressed")).toBe("true");
    expect(row("alpha-1").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("1 selected")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the row menu is the only pointer door into selection", async () => {
    vi.useFakeTimers();
    mount("sidebar");
    const initiating = row("alpha-1");

    fireEvent.pointerDown(initiating, { pointerType: "touch", clientX: 12, clientY: 12 });
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // The hold opened this row's own menu; it did not change the list's mode.
    const sheet = screen.getByRole("dialog", { name: "alpha-1" });
    expect(document.querySelector("[data-selection-toolbar]")).toBeNull();
    expect(row("alpha-1").getAttribute("aria-pressed")).toBeNull();

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(within(sheet).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(toolbar()).toBeTruthy());
    expect(row("alpha-1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("exits from the row menu back to the row", async () => {
    const user = userEvent.setup();
    const view = mount("sidebar");

    await user.click(rowActions("alpha-1"));
    await user.click(
      within(screen.getByRole("dialog", { name: "alpha-1" })).getByRole("button", {
        name: "Select",
      }),
    );
    await waitFor(() => expect(toolbar()).toBeTruthy());

    // The same trigger, now holding exactly the one way out.
    await user.click(rowActions("alpha-1"));
    const sheet = screen.getByRole("dialog", { name: "alpha-1" });
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["Exit selection", "Cancel"]);
    await user.click(within(sheet).getByRole("button", { name: "Exit selection" }));

    await waitFor(() => expect(document.querySelector("[data-selection-toolbar]")).toBeNull());
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute("data-session-row")).toBe(
        "alpha-1",
      ),
    );

    // The restore is one-shot: a later list update must not pull focus back.
    const search = screen.getByRole("searchbox");
    search.focus();
    fixtures.tasks = [task("alpha-1"), task("alpha-2"), task("alpha-3"), task("alpha-4")];
    view.rerender(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionList shell="sidebar" />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(search);
  });
});

describe("existing selection entry and movement", () => {
  it("keeps Shift+Enter entry and arrow navigation behavior", async () => {
    const user = userEvent.setup();
    mount("sidebar");

    const first = row("alpha-1");
    first.focus();
    fireEvent.keyDown(first, { key: "Enter", shiftKey: true });
    expect(toolbar()).toBeTruthy();
    expect(row("alpha-1").getAttribute("aria-pressed")).toBe("true");

    // Ordinary Enter in selection mode toggles the row instead of opening it:
    // the second row becomes selected and the list stays on screen.
    row("alpha-2").focus();
    await user.keyboard("{Enter}");
    expect(row("alpha-2").getAttribute("aria-pressed")).toBe("true");
    expect(toolbar()).toBeTruthy();

    // ↑/↓ still move between rows.
    row("alpha-1").focus();
    await user.keyboard("{ArrowDown}");
    expect((document.activeElement as HTMLElement).getAttribute("data-session-row")).toBe(
      "alpha-2",
    );
    await user.keyboard("{ArrowUp}");
    expect((document.activeElement as HTMLElement).getAttribute("data-session-row")).toBe(
      "alpha-1",
    );
  });

  it("enters selection from Shift+Enter on a row that was not in selection mode", () => {
    mount("sidebar");
    fireEvent.keyDown(row("alpha-3"), { key: "Enter", shiftKey: true });

    expect(toolbar()).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(row("alpha-3").getAttribute("aria-pressed")).toBe("true");
    expect(row("alpha-1").getAttribute("aria-pressed")).toBe("false");
  });
});
