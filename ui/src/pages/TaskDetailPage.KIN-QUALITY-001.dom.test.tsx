// @vitest-environment jsdom
// KIN-QUALITY-001: one reading surface at 820. jsdom proves structure and
// wiring; pixels are the `reading` walk at 390/820/1100.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../i18n";
import {
  cleanupPage,
  conversationColumn,
  desktopBar,
  renderPage,
  reportColumnWidth,
  resetPage,
} from "./TaskDetailPage.KIN-QUALITY-001.harness";
beforeEach(() => {
  resetPage();
  setLocale("en");
  localStorage.clear();
});
afterEach(cleanupPage);
describe("TaskDetailPage KIN-QUALITY-001", () => {
  it("the reading surface adds no usage or changed-files bar above the transcript", async () => {
    const { container } = renderPage();
    // The old block was a `min-[1600px]:hidden` flex-none bar. Deleted, not hidden.
    expect(container.querySelector('div[class~="min-[1600px]:hidden"]')).toBeNull();
    const transcript = screen.getByRole("region", { name: t("task.transcript") });
    const column = conversationColumn(container);
    const bar = desktopBar(container);
    const wrapper = transcript.parentElement as HTMLElement;
    const children = [...column.children];
    expect(children.slice(children.indexOf(bar) + 1, children.indexOf(wrapper))).toEqual([]);
    await waitFor(() =>
      expect(screen.getByTestId("chat-stream").textContent).toContain("one composer"),
    );
  });
  it("a markdown table scrolls inside its own container with a natural column width", () => {
    renderPage();
    const table = screen.getByRole("table");
    expect(table.parentElement!.className).toContain("overflow-x-auto");
    // `w-full` squeezed the first column to one character per line.
    expect(table.className.split(/\s+/)).toContain("min-w-max");
    expect(table.className.split(/\s+/)).not.toContain("w-full");
    expect(table.querySelectorAll("th").length).toBeGreaterThanOrEqual(3);
    expect(table.querySelectorAll("tbody tr td").length).toBeGreaterThanOrEqual(12);
  });
  it("one composer, with the usage entry in its footer and changed files in the header", async () => {
    const { container } = renderPage();
    expect(screen.getAllByTestId("composer")).toHaveLength(1);
    const dock = container.querySelector("[data-kin-bottom-chrome]") as HTMLElement;
    await waitFor(() => {
      expect(
        within(dock).getByRole("button", { name: new RegExp(t("usage.taskSummary")) }),
      ).toBeTruthy();
    });
    const files = within(desktopBar(container)).getByRole("button", {
      name: t("workspace.filesCount", { count: 2 }),
    });
    expect(files.textContent).toContain("2");
  });
  it("the compact header's actions trigger opens the existing session action sheet with the verbs intact", async () => {
    const { container } = renderPage();
    reportColumnWidth(520);
    // Compact by measured column width, not by viewport: 820 keeps the split.
    fireEvent.click(
      within(desktopBar(container)).getByRole("button", { name: t("task.sessionActions") }),
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    const dialog = screen.getByRole("dialog");
    for (const label of [
      t("task.sessionActions"),
      t("task.share"),
      t("workspace.title"),
      t("pr.title"),
      t("task.archiveSession"),
      t("task.deleteSession"),
    ]) {
      expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0);
    }
    // One sheet, not a fifth popover: the tablet reuses the phone's.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog.closest("[data-kin-sheet]")?.className).not.toContain("md:hidden");
  });
  it("a passive open makes no GitHub request and reads no secure-store secret", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const storage = vi.spyOn(Storage.prototype, "getItem");
    renderPage();
    expect(fetchSpy).not.toHaveBeenCalled();
    const secretReads = storage.mock.calls
      .map(([key]) => String(key))
      .filter((key) => /token|secret|credential|github/i.test(key));
    expect(secretReads).toEqual([]);
  });
});
