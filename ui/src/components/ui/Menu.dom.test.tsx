// @vitest-environment jsdom
import { useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { overlayOwnsKeyboard } from "../../lib/overlayOwnsKeyboard";
import Popover from "./Popover";
import Menu, { type MenuItem } from "./Menu";

/**
 * F5b: the controlled menu facade every picker will consume.
 *
 * The contract the call sites need is small: one open/close value owned by the
 * caller, arrow keys that move by one and wrap, typeahead, exactly one layer
 * dismissed per Escape with focus returning to the trigger, `menuitemradio`
 * for checked rows, disabled rows that can neither focus nor fire, and a layer
 * that owns the keyboard while it is visible (TASTE 16).
 *
 * `Archive` sits between two enabled rows so "skip disabled" and "wrap" are
 * exercised by the same traversal.
 */

/**
 * jsdom has no `matchMedia`, and the menu's touch floor follows the pointer
 * rather than a width, so every case that is about the floor declares the
 * pointer it runs on. The fallback stays fine, which is what the rest of this
 * file (and the desktop console) gets.
 */
function setPointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? coarse : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/**
 * Whole class tokens, never substrings: `max-sm:min-w-11` must not satisfy
 * `min-w-11`, or the width rule this slice removes would keep the test green.
 */
function classes(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

const onSelectSpies = () =>
  ({
    rename: vi.fn(),
    duplicate: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
  }) as const;

type Spies = ReturnType<typeof onSelectSpies>;

function itemsFor(spies: Spies): MenuItem[] {
  return [
    { id: "rename", label: "Rename", onSelect: spies.rename },
    { id: "duplicate", label: "Duplicate", onSelect: spies.duplicate },
    { id: "archive", label: "Archive", disabled: true, onSelect: spies.archive },
    { id: "delete", label: "Delete", onSelect: spies.delete },
  ];
}

type HostProps = {
  items: MenuItem[];
  onOpenChange?: (open: boolean) => void;
  startOpen?: boolean;
  width?: number;
};

/** A caller-owned trigger plus the controlled menu, as a call site will use it. */
function Host({ items, onOpenChange = vi.fn(), startOpen = false, width }: HostProps) {
  const [open, setOpen] = useState(startOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Only a change the menu asks for is reported: the trigger's own click is
  // the caller opening it, and counting that would make "Escape closes once"
  // indistinguishable from "opening once, closing once".
  const fromMenu = (next: boolean) => {
    onOpenChange(next);
    setOpen(next);
  };
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Actions
      </button>
      <button type="button">Outside</button>
      <Menu
        open={open}
        onOpenChange={fromMenu}
        triggerRef={triggerRef}
        label="Actions"
        items={items}
        width={width}
      />
    </div>
  );
}

/** A caller-owned trigger plus the menu with the search slot, as the model row uses it. */
function SearchHost({
  items,
  onChange = vi.fn(),
  onOpenChange = vi.fn(),
  footer,
  initialFocusId,
  startOpen = false,
}: {
  items: MenuItem[];
  onChange?: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  footer?: ReactNode;
  initialFocusId?: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [value, setValue] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fromMenu = (next: boolean) => {
    onOpenChange(next);
    setOpen(next);
  };
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Actions
      </button>
      <button type="button">Outside</button>
      <Menu
        open={open}
        onOpenChange={fromMenu}
        triggerRef={triggerRef}
        label="Actions"
        items={items}
        initialFocusId={initialFocusId}
        search={{
          value,
          onChange: (next) => {
            onChange(next);
            setValue(next);
          },
          label: "Search actions",
          placeholder: "Search actions",
          clearLabel: "Clear",
        }}
        footer={footer}
      />
    </div>
  );
}

/** The searching menu opened from inside another popover's panel. */
function NestedSearchHost({
  items,
  onMenuOpenChange,
}: {
  items: MenuItem[];
  onMenuOpenChange: (open: boolean) => void;
}) {
  const [containerOpen, setContainerOpen] = useState(false);
  const containerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={containerRef} type="button" onClick={() => setContainerOpen(true)}>
        Container trigger
      </button>
      <Popover
        open={containerOpen}
        onOpenChange={setContainerOpen}
        triggerRef={containerRef}
        label="Container"
      >
        <SearchHost items={items} onOpenChange={onMenuOpenChange} />
      </Popover>
    </div>
  );
}

/** The menu opened from inside another popover's panel. */
function NestedHost({
  items,
  onMenuOpenChange,
}: {
  items: MenuItem[];
  onMenuOpenChange: (open: boolean) => void;
}) {
  const [containerOpen, setContainerOpen] = useState(false);
  const containerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={containerRef} type="button" onClick={() => setContainerOpen(true)}>
        Container trigger
      </button>
      <Popover
        open={containerOpen}
        onOpenChange={setContainerOpen}
        triggerRef={containerRef}
        label="Container"
      >
        <Host items={items} onOpenChange={onMenuOpenChange} />
      </Popover>
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: "Actions" });
const focusedText = () => document.activeElement?.textContent;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the menu facade", () => {
  it("a described row draws the description under the label and keeps it in the accessible name", () => {
    const choose = vi.fn();
    const description = "Skip permission prompts — trusted envs only";
    const items: MenuItem[] = [
      { id: "yolo", label: "YOLO", description, checked: true, onSelect: choose },
    ];
    render(<Host items={items} startOpen />);

    // The name a reader hears in a menu is the row's own text, not a tooltip:
    // an `aria-describedby` would carry the consequence outside the name.
    const row = screen.getByRole("menuitemradio", { name: /YOLO.*Skip permission prompts/ });
    expect(row.getAttribute("aria-describedby")).toBeNull();

    // Under the label, inside the same row, in the muted caption ink.
    const line = screen.getByText(description);
    expect(row.contains(line)).toBe(true);
    expect(line.className).toContain("text-kin-muted");
    expect(row.textContent?.indexOf("YOLO")).toBeLessThan(row.textContent!.indexOf(description));
    expect(choose).not.toHaveBeenCalled();
  });

  it("width overrides the default panel width", () => {
    const spies = onSelectSpies();
    const { unmount } = render(<Host items={itemsFor(spies)} startOpen />);
    expect(screen.getByRole("dialog", { name: "Actions" }).style.width).toBe("240px");
    unmount();

    // The permission menu's consequence lines need the wider panel; every
    // other caller keeps the 240px default by saying nothing.
    render(<Host items={itemsFor(spies)} startOpen width={288} />);
    expect(screen.getByRole("dialog", { name: "Actions" }).style.width).toBe("288px");
  });

  it("opens as a menu and moves focus to the first enabled item", async () => {
    const spies = onSelectSpies();
    render(<Host items={itemsFor(spies)} />);

    await userEvent.click(trigger());

    const menu = screen.getByRole("menu", { name: "Actions" });
    expect(menu).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("arrow keys move by one and wrap, skipping disabled rows", async () => {
    const spies = onSelectSpies();
    render(<Host items={itemsFor(spies)} startOpen />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );

    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toBe("Duplicate");

    // Archive is disabled, so Down lands on Delete instead of stopping there.
    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toBe("Delete");

    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toBe("Rename");

    // Up runs the list the other way and wraps past the disabled row too.
    await userEvent.keyboard("{ArrowUp}");
    expect(focusedText()).toBe("Delete");

    await userEvent.keyboard("{ArrowUp}");
    expect(focusedText()).toBe("Duplicate");
  });

  it("typeahead selects by the first letters of a row label", async () => {
    const spies = onSelectSpies();
    render(<Host items={itemsFor(spies)} startOpen />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );

    await userEvent.keyboard("du");

    expect(focusedText()).toBe("Duplicate");
    expect(spies.rename).not.toHaveBeenCalled();
  });

  it("Escape closes exactly this menu and returns focus to the trigger", async () => {
    const spies = onSelectSpies();
    const onMenuOpenChange = vi.fn();
    render(<NestedHost items={itemsFor(spies)} onMenuOpenChange={onMenuOpenChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Container trigger" }));
    await userEvent.click(trigger());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );

    await userEvent.keyboard("{Escape}");

    // One press: the menu goes, the popover it was opened from stays.
    expect(onMenuOpenChange).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Container" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger());
  });

  it("Enter selects the focused row once and closes", async () => {
    const spies = onSelectSpies();
    const onOpenChange = vi.fn();
    render(<Host items={itemsFor(spies)} onOpenChange={onOpenChange} startOpen />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );

    await userEvent.keyboard("{Enter}");

    expect(spies.rename).toHaveBeenCalledTimes(1);
    expect(spies.duplicate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
  });

  it("an IME composition does not select or close", async () => {
    const spies = onSelectSpies();
    render(<Host items={itemsFor(spies)} startOpen />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );

    const row = screen.getByRole("menuitem", { name: "Rename" });
    fireEvent.keyDown(row, { key: "Enter", isComposing: true });
    // Older IMEs report the composition through the 229 sentinel instead.
    fireEvent.keyDown(row, { key: "Enter", keyCode: 229 });

    expect(spies.rename).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();

    fireEvent.keyDown(row, { key: "Escape", isComposing: true });
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
  });

  it("checked rows expose menuitemradio with aria-checked", () => {
    const choose = vi.fn();
    const items: MenuItem[] = [
      { id: "ask", label: "Always ask", checked: true, onSelect: choose },
      { id: "never", label: "Never ask", checked: false, onSelect: choose },
      { id: "plain", label: "Something else", onSelect: choose },
    ];
    render(<Host items={items} startOpen />);

    const checked = screen.getByRole("menuitemradio", { name: "Always ask" });
    const unchecked = screen.getByRole("menuitemradio", { name: "Never ask" });
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(unchecked.getAttribute("aria-checked")).toBe("false");
    // A row that is not a choice keeps the plain menuitem role.
    expect(screen.getByRole("menuitem", { name: "Something else" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "Something else" })).toBeNull();
  });

  it("an open menu makes overlayOwnsKeyboard true and a closed one false", async () => {
    const spies = onSelectSpies();
    render(<Host items={itemsFor(spies)} />);

    expect(overlayOwnsKeyboard()).toBe(false);

    await userEvent.click(trigger());
    expect(overlayOwnsKeyboard()).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(overlayOwnsKeyboard()).toBe(false);
  });

  it("disabled rows cannot be clicked", async () => {
    const spies = onSelectSpies();
    render(<Host items={itemsFor(spies)} startOpen />);
    const archive = screen.getByRole("menuitem", { name: "Archive" });
    expect(archive.getAttribute("aria-disabled")).toBe("true");

    await userEvent.click(archive);

    expect(spies.archive).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
  });

  it("keeps roving focus and tabIndex on an item whose id is empty string", async () => {
    const onSelect = vi.fn();
    const items: MenuItem[] = [
      { id: "reviewer", label: "Reviewer", onSelect: vi.fn() },
      { id: "", label: "No role", onSelect },
      { id: "writer", label: "Writer", onSelect: vi.fn() },
    ];
    render(<Host items={items} startOpen />);
    const reviewer = screen.getByRole("menuitem", { name: "Reviewer" });
    const noRole = screen.getByRole("menuitem", { name: "No role" });
    await waitFor(() => expect(document.activeElement).toBe(reviewer));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(noRole);
    expect(noRole.tabIndex).toBe(0);
    expect(reviewer.tabIndex).toBe(-1);

    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toBe("Writer");

    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(noRole);

    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

/**
 * The search slot: a field the caller owns and filters with, above rows the
 * caller already filtered. What the menu adds is the keyboard contract between
 * the two — the field is where a long list starts, Down enters the rows, Up
 * from the first row comes back, and letters never reach the row typeahead.
 */
describe("the menu's search slot", () => {
  const searchField = () => screen.getByLabelText("Search actions");

  it("pins a search field above the rows", async () => {
    const spies = onSelectSpies();
    render(<SearchHost items={itemsFor(spies)} startOpen />);

    const search = searchField();
    // The slot has a stable handle: callers and tests reach it by marker, not
    // by guessing the primitive's classes.
    expect(search.closest("[data-menu-search]")).toBeTruthy();

    const firstRow = screen.getByRole("menuitem", { name: "Rename" });
    // Above every row, inside the one panel that holds the menu.
    expect(
      search.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const panel = search.closest('[role="dialog"]');
    expect(panel).toBeTruthy();
    expect(panel!.contains(screen.getByRole("menu", { name: "Actions" }))).toBe(true);
    expect(panel!.contains(firstRow)).toBe(true);
  });

  it("typing in the search field never runs typeahead or moves the row focus", async () => {
    const onChange = vi.fn();
    const items: MenuItem[] = [
      { id: "rename", label: "Rename", onSelect: vi.fn() },
      { id: "build", label: "Build", onSelect: vi.fn() },
    ];
    render(<SearchHost items={items} onChange={onChange} startOpen />);
    const search = searchField();
    await waitFor(() => expect(document.activeElement).toBe(search));

    await userEvent.keyboard("b");

    expect(onChange).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(search);
    // Typeahead would have jumped to "Build"; the roving row stayed put.
    expect(screen.getByRole("menuitem", { name: "Rename" }).tabIndex).toBe(0);
    expect(screen.getByRole("menuitem", { name: "Build" }).tabIndex).toBe(-1);
  });

  it("ArrowDown leaves the search field for the current row and ArrowUp returns", async () => {
    const spies = onSelectSpies();
    render(<SearchHost items={itemsFor(spies)} initialFocusId="duplicate" startOpen />);
    const search = searchField();
    await waitFor(() => expect(document.activeElement).toBe(search));

    await userEvent.keyboard("{ArrowDown}");
    // Down starts on the caller's current choice, not the top of the list.
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));

    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    // Up from the first row comes back to the field Down left, so the pair is
    // a round trip instead of a one-way fall into the list.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(search);
  });

  it("Enter in the search field chooses the first enabled row the caller kept", async () => {
    const spies = onSelectSpies();
    // The caller filtered the rows; Menu does not. A disabled row at the top
    // still cannot be what Enter takes.
    const items: MenuItem[] = [
      { id: "archive", label: "Archive", disabled: true, onSelect: spies.archive },
      { id: "delete", label: "Delete", onSelect: spies.delete },
    ];
    render(<SearchHost items={items} startOpen />);
    const search = searchField();
    await waitFor(() => expect(document.activeElement).toBe(search));

    await userEvent.keyboard("{Enter}");

    expect(spies.archive).not.toHaveBeenCalled();
    expect(spies.delete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
  });

  it("an IME composition in the search field neither chooses nor moves", async () => {
    const spies = onSelectSpies();
    render(<SearchHost items={itemsFor(spies)} startOpen />);
    const search = searchField();
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    // Older IMEs report the composition through the 229 sentinel instead.
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });

    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();

    // The candidate list owns the arrows too: focus stays in the field.
    fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true });
    expect(document.activeElement).toBe(search);
  });

  it("Escape in the search field closes exactly this menu and returns focus to the trigger", async () => {
    const onMenuOpenChange = vi.fn();
    render(
      <NestedSearchHost items={itemsFor(onSelectSpies())} onMenuOpenChange={onMenuOpenChange} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Container trigger" }));
    await userEvent.click(trigger());
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    await userEvent.keyboard("{Escape}");

    // One press: the menu goes, the popover it was opened from stays.
    expect(onMenuOpenChange).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Container" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger());
  });

  it("a footer renders inside the panel below the rows", async () => {
    render(
      <SearchHost items={itemsFor(onSelectSpies())} footer={<div>Footer content</div>} startOpen />,
    );

    const footer = screen.getByText("Footer content");
    const menu = screen.getByRole("menu", { name: "Actions" });
    const rows = screen.getAllByRole("menuitem");
    const lastRow = rows[rows.length - 1]!;

    // Below the rows, outside the menu role, inside the same panel: the footer
    // is a row's editor, not another command in the list.
    expect(menu.contains(footer)).toBe(false);
    expect(lastRow.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const panel = footer.closest('[role="dialog"]');
    expect(panel).toBeTruthy();
    expect(panel!.contains(menu)).toBe(true);
  });
});

describe("the menu's touch floor", () => {
  // TASTE 11: an iPad in portrait is ≥768px wide and still a thumb. The floor
  // follows the pointer, not a width breakpoint that stopped applying at 640.
  // `min-h-11` / `min-w-11` are asserted as whole tokens: the phone-width
  // utility this slice removes (`max-sm:min-w-11`) would satisfy a substring
  // check while leaving the iPad target at 28px.

  it("gives the menu's search clear a 44×44 target on a coarse pointer", async () => {
    setPointer(true);
    render(<SearchHost items={itemsFor(onSelectSpies())} startOpen />);

    await userEvent.type(screen.getByLabelText("Search actions"), "ren");
    const clear = classes(screen.getByRole("button", { name: "Clear" }));

    // The shared Button's own `min-h-11` is cancelled by `sm:min-h-0` above
    // 640px, so the coarse shape is an explicit 44px box, the same one the run
    // settings sheet's close control uses.
    expect(clear).toContain("h-11");
    expect(clear).toContain("w-11");
    expect(clear).not.toContain("h-7");
    expect(clear).not.toContain("w-7");
  });

  it("keeps the menu's search clear compact on a fine pointer", async () => {
    setPointer(false);
    render(<SearchHost items={itemsFor(onSelectSpies())} startOpen />);

    await userEvent.type(screen.getByLabelText("Search actions"), "ren");
    const clear = classes(screen.getByRole("button", { name: "Clear" }));

    expect(clear).toContain("h-7");
    expect(clear).toContain("w-7");
    expect(clear).not.toContain("h-11");
    expect(clear).not.toContain("w-11");
  });

  it("gives every menu row a 44px floor on a coarse pointer", () => {
    setPointer(true);
    render(<Host items={itemsFor(onSelectSpies())} startOpen />);

    const rows = screen.getAllByRole("menuitem");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(classes(row)).toContain("min-h-11");
      expect(classes(row)).not.toContain("min-h-9");
    }
  });

  it("keeps the menu rows' 36px face on a fine pointer", () => {
    setPointer(false);
    render(<Host items={itemsFor(onSelectSpies())} startOpen />);

    for (const row of screen.getAllByRole("menuitem")) {
      expect(classes(row)).toContain("min-h-9");
      expect(classes(row)).not.toContain("min-h-11");
    }
  });
});
