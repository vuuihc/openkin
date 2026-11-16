// @vitest-environment jsdom
import { useRef, useState } from "react";
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
};

/** A caller-owned trigger plus the controlled menu, as a call site will use it. */
function Host({ items, onOpenChange = vi.fn(), startOpen = false }: HostProps) {
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
      />
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
});

describe("the menu facade", () => {
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
