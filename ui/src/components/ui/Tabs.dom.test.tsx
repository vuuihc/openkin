// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AstryxProvider } from "../../design/AstryxProvider";
import { setLocale } from "../../i18n";
import Tabs, { type TabItem } from "./Tabs";
/**
 * F5e: the Tabs facade the four hand-written strips will migrate onto. One tab
 * stop, wrapping arrows, Home/End, Delete with a focus handoff, Alt+Arrow
 * reorder, an announced status mark, and an inert disabled tab.
 */
const BASE: TabItem[] = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
];
const renderUI = (ui: ReactNode) => render(<AstryxProvider>{ui}</AstryxProvider>);
const tabs = () => screen.getAllByRole("tab") as HTMLElement[];
// Partial match: a mark adds words to the tab's name.
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });
type HostProps = {
  initialValue?: string;
  initialItems?: TabItem[];
  variant?: "tabs" | "segmented";
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onMove?: (id: string, delta: -1 | 1) => void;
  reorder?: boolean;
};
function Host({
  initialValue = "one",
  initialItems = BASE,
  variant,
  onSelect,
  onClose,
  onMove,
  reorder = false,
}: HostProps) {
  const [items, setItems] = useState(initialItems);
  const [value, setValue] = useState(initialValue);
  return (
    <Tabs
      items={items}
      value={value}
      variant={variant}
      ariaLabel="Open sessions"
      onChange={(id) => {
        setValue(id);
        onSelect?.(id);
      }}
      onClose={
        onClose
          ? (id) => {
              onClose(id);
              setItems((current) => current.filter((item) => item.id !== id));
            }
          : undefined
      }
      onMove={
        onMove
          ? (id, delta) => {
              onMove(id, delta);
              if (!reorder) return;
              setItems((current) => {
                const index = current.findIndex((item) => item.id === id);
                const moved = current[index];
                if (index < 0 || !moved) return current;
                const next = current.filter((item) => item.id !== id);
                const target = (((index + delta) % next.length) + next.length) % next.length;
                next.splice(target, 0, moved);
                return next;
              });
            }
          : undefined
      }
    />
  );
}
beforeEach(() => {
  setLocale("en");
});
describe("the shared tab strip", () => {
  it("renders a tablist with the selected tab and exactly one tab stop", () => {
    renderUI(<Host />);
    expect(screen.getByRole("tablist", { name: "Open sessions" })).toBeTruthy();
    const rows = tabs();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    const stops = rows.filter((row) => row.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(rows[0]);
  });
  it("arrow keys move selection and wrap; Home and End jump to the ends", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUI(<Host initialValue="one" onSelect={onSelect} />);
    tabs()[0]?.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(tab("Three").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(tab("Three")));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(document.activeElement).toBe(tab("One")));
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(tab("Three")));
    await user.keyboard("{Home}");
    await waitFor(() => expect(tab("One").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(tab("One")));
  });
  it("Delete closes the focused closeable tab and focus moves to its neighbour", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderUI(
      <Host
        initialValue="two"
        initialItems={BASE.map((item) => ({ ...item, closeable: true }))}
        onClose={onClose}
      />,
    );
    tab("Two").focus();
    await user.keyboard("{Delete}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("two");
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Two" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tab("Three")));
  });
  it("Alt+Arrow reorders without moving focus away", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderUI(<Host initialValue="one" onMove={onMove} reorder />);
    tab("One").focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("one", 1);
    await waitFor(() => expect(document.activeElement).toBe(tab("One")));
  });
  it("a mark is part of the tab's accessible name", () => {
    const waiting: TabItem = {
      id: "one",
      label: "Build the parser",
      // The dot carries its state in words (TASTE 18).
      mark: <span role="img" aria-label="waiting" className="h-1.5 w-1.5 rounded-full" />,
    };
    renderUI(<Host initialItems={[waiting, ...BASE.slice(1)]} />);
    // Both the visible label and the dot's words are in the name.
    const marked = tab("Build the parser");
    expect(marked).toBe(tab("waiting"));
  });
  it("the segmented variant uses the same value and onChange contract", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUI(<Host variant="segmented" initialValue="two" onSelect={onSelect} />);
    const rows = tabs();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(tab("Two").getAttribute("aria-selected")).toBe("true");
    await user.click(tab("Three"));
    expect(onSelect).toHaveBeenCalledWith("three");
    await waitFor(() => expect(tab("Three").getAttribute("aria-selected")).toBe("true"));
  });
  it("a disabled tab is skipped by the keyboard and cannot be selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderUI(
      <Host
        initialValue="one"
        initialItems={[BASE[0]!, { ...BASE[1]!, disabled: true }, BASE[2]!]}
        onSelect={onSelect}
      />,
    );
    expect(tab("Two").getAttribute("aria-disabled")).toBe("true");
    expect(tab("Two").tabIndex).toBe(-1);
    tabs()[0]?.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(tab("Three").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(tab("Three")));
    onSelect.mockClear();
    fireEvent.click(tab("Two"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(tab("Three").getAttribute("aria-selected")).toBe("true");
  });
});
