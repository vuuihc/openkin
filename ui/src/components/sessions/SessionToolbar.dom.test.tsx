// @vitest-environment jsdom
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import SessionToolbar, {
  SessionSelectionBar,
  type SessionSelectionBarProps,
  type SessionToolbarProps,
} from "./SessionToolbar";

/**
 * The list's search field, filter control and selection bar moved out of
 * `SessionList` unchanged. These tests pin the new boundary: the accessible
 * names the list already had, that every selection action forwards its
 * callback and refuses an empty selection, and that the 44px touch targets
 * survived the move.
 */

function toolbarProps(overrides: Partial<SessionToolbarProps> = {}): SessionToolbarProps {
  return {
    query: "",
    pendingQuery: false,
    searchRef: createRef<HTMLInputElement>(),
    onQueryChange: vi.fn(),
    onSearchKeyDown: vi.fn(),
    status: "",
    scope: "active",
    attention: "",
    needsYouCount: 0,
    runningCount: 0,
    sortMode: "active",
    onFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    ...overrides,
  };
}

function selectionProps(
  overrides: Partial<SessionSelectionBarProps> = {},
): SessionSelectionBarProps {
  return {
    selectedCount: 0,
    selectableCount: 0,
    selectionBusy: false,
    deletingSelection: false,
    scope: "active",
    allPinned: false,
    onSelectAll: vi.fn(),
    onPin: vi.fn(),
    onArchiveOrRestore: vi.fn(),
    onDelete: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
});

describe("SessionToolbar", () => {
  it("renders the search field, filters and selection bar", () => {
    render(
      <>
        <SessionToolbar {...toolbarProps({ query: "build" })} />
        <SessionSelectionBar {...selectionProps({ selectedCount: 2, selectableCount: 5 })} />
      </>,
    );

    const search = screen.getByRole("searchbox", { name: /Search sessions/ });
    expect((search as HTMLInputElement).value).toBe("build");
    expect(button(/Filter/)).toBeTruthy();
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select all" })).toBeTruthy();
  });

  it("omits the search field on the phone shell while keeping the filters", () => {
    render(<SessionToolbar {...toolbarProps({ search: false })} />);

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(button(/Filter/)).toBeTruthy();
  });

  it("passes the attention view and both live counts through to the filter control", () => {
    // The toolbar draws the chips; the list owns the URL and the numbers. A
    // prop that stops here would leave the pressed chip and its counts wrong
    // without failing any pure rule.
    render(
      <SessionToolbar
        {...toolbarProps({ attention: "needs", needsYouCount: 3, runningCount: 2 })}
      />,
    );

    const chips = screen.getByRole("group", { name: "Conversation view" });
    const needs = within(chips).getByRole("button", { name: "Needs you" });
    expect(needs.getAttribute("aria-pressed")).toBe("true");
    expect(needs.textContent).toContain("3");
    expect(
      within(chips).getByRole("button", { name: "Running" }).textContent,
    ).toContain("2");
  });
});

describe("SessionSelectionBar", () => {
  it("selection actions call their handlers and disable at zero", async () => {
    const props = selectionProps({ selectedCount: 2, selectableCount: 5 });
    const { rerender } = render(<SessionSelectionBar {...props} />);

    await userEvent.click(button("Pin"));
    await userEvent.click(button("Archive"));
    await userEvent.click(button("Delete"));
    await userEvent.click(button("Cancel"));

    expect(props.onPin).toHaveBeenCalledTimes(1);
    expect(props.onArchiveOrRestore).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onExit).toHaveBeenCalledTimes(1);

    // Nothing selected: a batch action would be a no-op, so each refuses.
    rerender(<SessionSelectionBar {...props} selectedCount={0} />);
    expect(button("Pin").disabled).toBe(true);
    expect(button("Archive").disabled).toBe(true);
    expect(button("Delete").disabled).toBe(true);
    // Leaving selection mode stays possible with nothing selected.
    expect(button("Cancel").disabled).toBe(false);
  });

  it("offers restore instead of pin and archive in the archived scope", async () => {
    const props = selectionProps({ selectedCount: 1, selectableCount: 1, scope: "archived" });
    render(<SessionSelectionBar {...props} />);

    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    await userEvent.click(button("Restore"));
    expect(props.onArchiveOrRestore).toHaveBeenCalledTimes(1);
  });

  it("labels the pin action by whether the whole selection is already pinned", () => {
    const { rerender } = render(
      <SessionSelectionBar
        {...selectionProps({ selectedCount: 2, selectableCount: 2, allPinned: true })}
      />,
    );
    expect(button("Unpin")).toBeTruthy();

    rerender(
      <SessionSelectionBar
        {...selectionProps({ selectedCount: 2, selectableCount: 2, allPinned: false })}
      />,
    );
    expect(button("Pin")).toBeTruthy();
  });

  it("selection actions keep 44px touch targets", () => {
    render(<SessionSelectionBar {...selectionProps({ selectedCount: 1, selectableCount: 3 })} />);

    const actions = screen.getAllByRole("button");
    expect(actions.length).toBeGreaterThanOrEqual(4);
    for (const action of actions) {
      expect(action.className).toContain("min-h-11");
    }
  });
});
