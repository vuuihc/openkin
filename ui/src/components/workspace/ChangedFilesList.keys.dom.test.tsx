// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChangedFile } from "../../lib/changedFiles";
import ChangedFilesList from "./ChangedFilesList";

// jsdom has no layout: the list scrolls the selected row into view.
Element.prototype.scrollIntoView = vi.fn();

function changed(path: string, seq: number): ChangedFile {
  return { path, action: "write", tool: "claude-code", seq };
}

const files = [changed("src/a.ts", 1), changed("src/b.ts", 2), changed("src/c.ts", 3)];

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-workspace-row]"));
}

async function focusRow(row: HTMLElement) {
  await act(async () => {
    row.focus();
  });
}

function renderList(selectedPath: string | null = null) {
  const onSelect = vi.fn();
  const view = render(
    <ChangedFilesList files={files} selectedPath={selectedPath} onSelect={onSelect} />,
  );
  return { ...view, onSelect };
}

describe("KIN-RESULT-001: keyboard navigation over the changed files", () => {
  it("the changed-files list is a single tab stop", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <>
        <button type="button">before</button>
        <ChangedFilesList files={files} selectedPath={null} onSelect={onSelect} />
        <button type="button">after</button>
      </>,
    );

    const listRows = rows();
    expect(listRows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    // One Tab leaves the list entirely, and Shift+Tab comes back to the row
    // that had focus rather than to the first row.
    await focusRow(listRows[0]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "after" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(listRows[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ArrowDown and ArrowUp move focus between changed files", async () => {
    const user = userEvent.setup();
    renderList();

    await focusRow(rows()[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    // The ends hold: neither key wraps around.
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]);

    await focusRow(rows()[2]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[2]);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("Home and End jump to the first and last changed file", async () => {
    const user = userEvent.setup();
    renderList();

    await focusRow(rows()[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(rows()[2]);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, -1, 0]);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1]);
  });

  it("Enter opens the focused changed file", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderList();

    await focusRow(rows()[1]);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("src/b.ts");
  });

  it("the arrow keys do not scroll the page", async () => {
    renderList();
    const row = rows()[0];

    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      await focusRow(row);
      expect(fireEvent.keyDown(row, { key })).toBe(false);
    }
    expect(fireEvent.keyDown(row, { key: "a" })).toBe(true);
  });

  it("focusing the list keeps the selected row as the tab stop", () => {
    renderList("src/b.ts");
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
  });
});
