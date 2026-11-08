// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import SearchSelect, { type SearchSelectOption } from "./SearchSelect";

/**
 * The picker exists because a gateway catalog is longer than a menu: the model
 * list on a real machine is 47 rows. Two things therefore have to hold — the
 * filter finds a row by anything the row shows, and the two surfaces (an
 * anchored popover under a mouse, the console's `Sheet` on a phone) agree about
 * what is selected.
 *
 * There is one more, less visible: the phone's list must not be a
 * `[role="listbox"]`. `Sheet` reads any listbox inside its panel as a popover
 * opened on top of it and refuses to close on Escape, so a nested listbox would
 * leave the sheet as the one sheet in the console that Escape cannot dismiss.
 * That is why this test asserts the *absence* of the role on the phone.
 */

const OPTIONS: SearchSelectOption[] = [
  { id: "", label: "Default" },
  // The gateway is in `detail` only: the id carries the bare model, so a test
  // that searched for "volcengine" would not pass on the id alone.
  { id: "deepseek-v4-flash[1m]", label: "DeepSeek V4 Flash", detail: "volcengine-gw" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
];

/** The two triggers are both in the DOM; only their surface differs. */
const desktopTrigger = () =>
  document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]') as HTMLButtonElement;
const phoneTrigger = () =>
  document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]') as HTMLButtonElement;

const rowNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((row) => row.textContent);

function setup(
  value = "",
  onChange = vi.fn(),
  props: Partial<Parameters<typeof SearchSelect>[0]> = {},
) {
  render(
    <SearchSelect
      label="Model"
      value={value}
      options={OPTIONS}
      onChange={onChange}
      searchable
      searchPlaceholder="Search models"
      emptyLabel="No matching models"
      {...props}
    />,
  );
  return { onChange };
}

function setViewport(width: number, height = 768) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

beforeEach(() => {
  setLocale("en");
  setViewport(1024);
});

// KIN-CONTINUE-001, step 5: a grouped catalog (a gateway's providers) puts the
// heading in the listbox as a group's name and the group's options inside it.
// A heading drawn as a sibling <div> leaves every option with no group to
// report, and some screen readers drop the list's semantics entirely.
const CATALOG: SearchSelectOption[] = [
  { id: "a", label: "Alpha", group: "Provider A" },
  { id: "b", label: "Beta", group: "Provider A" },
  { id: "c", label: "Gamma", group: "Provider B" },
  { id: "d", label: "Delta" },
];

describe("desktop surface", () => {
  it("lists every option and filters on label, id and detail", async () => {
    setup("deepseek-v4-flash[1m]");
    await userEvent.click(desktopTrigger());

    const list = screen.getByRole("listbox", { name: "Model" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    // The trigger names the panel it opens while it is open.
    expect(desktopTrigger().getAttribute("aria-controls")).toBe(list.id);
    // The live region exists before it has anything to say — a region added in
    // the same commit as its text is not reliably announced.
    expect(screen.getByRole("status").textContent).toBe("");

    const search = screen.getByRole("combobox");
    // Matches only `detail` — neither the label nor the id contains the word.
    await userEvent.type(search, "volcengine");
    expect(rowNames(list)).toEqual(["DeepSeek V4 Flash · volcengine-gw"]);

    // Matches only the id — the label says "DeepSeek V4 Flash".
    await userEvent.clear(search);
    await userEvent.type(search, "deepseek-v4");
    expect(rowNames(list)).toEqual(["DeepSeek V4 Flash · volcengine-gw"]);

    await userEvent.clear(search);
    await userEvent.type(search, "opus");
    expect(rowNames(list)).toEqual(["Opus 5.5"]);

    await userEvent.clear(search);
    await userEvent.type(search, "nothing-here");
    expect(within(list).queryAllByRole("option")).toEqual([]);
    // The empty message lives outside the listbox: a listbox may only contain
    // options, and a status is what announces that the filter found nothing.
    expect(screen.getByRole("status").textContent).toBe("No matching models");
  });

  it("puts each option inside the group its heading names", async () => {
    setup("", vi.fn(), { options: CATALOG });
    await userEvent.click(desktopTrigger());

    const list = screen.getByRole("listbox", { name: "Model" });
    const groupOf = (name: string) =>
      within(list).getByRole("option", { name }).closest('[role="group"]') as HTMLElement | null;

    // Same group object, not two headings that happen to read alike.
    expect(groupOf("Alpha")).toBe(groupOf("Beta"));
    expect(groupOf("Alpha")?.getAttribute("aria-label")).toBe("Provider A");
    expect(groupOf("Gamma")?.getAttribute("aria-label")).toBe("Provider B");
    // An option with no heading is still inside the listbox's own wrapper; it
    // is not left outside every group for a reader to fall out of.
    expect(groupOf("Delta")).toBeTruthy();
    expect(groupOf("Delta")?.getAttribute("aria-label")).toBeNull();
  });

  it("marks the current value, reports the pick, and keeps focus on the trigger", async () => {
    const { onChange } = setup("claude-opus-5-5");
    await userEvent.click(desktopTrigger());

    const list = screen.getByRole("listbox");
    const current = within(list).getByRole("option", { name: /Opus 5\.5/ });
    expect(current.getAttribute("aria-selected")).toBe("true");

    await userEvent.click(within(list).getByRole("option", { name: "Default" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("listbox")).toBeNull();
    // The row that had focus is gone; focus must land back on the chip, not on
    // <body>, or the next Tab starts at the top of the page.
    expect(document.activeElement).toBe(desktopTrigger());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    setup();
    await userEvent.click(desktopTrigger());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(desktopTrigger());
  });

  it("moves through the list with the arrow keys and picks with Enter", async () => {
    const { onChange } = setup("claude-opus-5-5");
    await userEvent.click(desktopTrigger());

    const search = screen.getByRole("combobox");
    const rows = () =>
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((row) => row.textContent);
    expect(rows()).toHaveLength(3);
    // Opening focuses the filter, so the first keystroke filters rather than
    // jumping into the list.
    expect(document.activeElement).toBe(search);

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Default");

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("DeepSeek V4 Flash · volcengine-gw");

    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("Opus 5.5");

    await userEvent.keyboard("{Home}");
    expect(document.activeElement?.textContent).toBe("Default");

    // Out of the top of the list and back into the field that filters it.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(search);

    // ArrowUp in the field lands on the last row, so End/Home are not the only
    // way to reach a long catalog's tail.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("Opus 5.5");
    // Clamped at the tail rather than wrapping to the top: the list does not
    // move under a held key.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Opus 5.5");

    await userEvent.keyboard("{Home}");
    expect(document.activeElement?.textContent).toBe("Default");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(desktopTrigger());
  });

  it("closes when Tab leaves the panel", async () => {
    setup();
    await userEvent.click(desktopTrigger());
    expect(screen.getByRole("listbox")).toBeTruthy();

    // Options are not tab stops (47 of them would be a maze), so the next stop
    // is behind the panel; leaving it open there would show a list that no
    // longer belongs to the focus.
    await userEvent.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("survives the blur WebKit fires before a row click", async () => {
    const { onChange } = setup();
    await userEvent.click(desktopTrigger());

    // WebKit does not focus a button on click, so the field above blurs with
    // `relatedTarget === null` before the row's own mousedown arrives. Reading
    // that as "focus left the panel" removed the row between mousedown and
    // click: every mouse pick in Safari closed the list and selected nothing.
    fireEvent.focusOut(screen.getByRole("combobox"), { relatedTarget: null });
    expect(screen.getByRole("listbox")).toBeTruthy();

    await userEvent.click(screen.getByRole("option", { name: "Opus 5.5" }));
    expect(onChange).toHaveBeenCalledWith("claude-opus-5-5");
  });

  it("takes the first match when Enter is pressed in the filter", async () => {
    const { onChange } = setup();
    await userEvent.click(desktopTrigger());

    await userEvent.type(screen.getByRole("combobox"), "opus");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("claude-opus-5-5");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

// #3: the panel is placed by the same `useAnchoredPanel` as the dispatch and
// permission panels, so it clamps to the same 8px edge and flips on the same
// rule at a phone and a desktop width. jsdom reports a zero rect, so the
// stable contract here is the width, the viewport clamp and "one side, not
// both" — the same limit the dispatch panel's test states.
describe("the panel's placement", () => {
  it.each([
    ["390px", 390],
    ["1280px", 1280],
  ])("stays inside a %s viewport on one side of the trigger", async (_name, width) => {
    setViewport(width);
    setup();
    await userEvent.click(desktopTrigger());

    const panel = document.querySelector<HTMLElement>("[data-search-panel]");
    expect(panel).toBeTruthy();
    expect(panel!.style.width).toBe("288px");
    const left = Number.parseFloat(panel!.style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 288).toBeLessThanOrEqual(width - 8);
    expect(Boolean(panel!.style.top) !== Boolean(panel!.style.bottom)).toBe(true);
    expect(Number.parseFloat(panel!.style.maxHeight)).toBeGreaterThan(0);
  });
});

describe("phone surface", () => {
  it("opens the console sheet, selects, and keeps no nested listbox", async () => {
    const { onChange } = setup("claude-opus-5-5");
    await userEvent.click(phoneTrigger());

    const dialog = screen.getByRole("dialog", { name: "Model" });
    expect(dialog.querySelector('[role="listbox"]')).toBeNull();
    expect(dialog.querySelector('[role="option"]')).toBeNull();

    // The row still names the current value for assistive tech.
    const current = within(dialog).getByRole("button", { name: "Opus 5.5" });
    expect(current.getAttribute("aria-current")).toBe("true");

    // The phone's filter is a plain search field, not a combobox — there is no
    // listbox for it to control.
    await userEvent.type(within(dialog).getByRole("searchbox"), "default");
    await userEvent.click(within(dialog).getByRole("button", { name: "Default" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape — the reason the list carries no listbox role", async () => {
    setup();
    await userEvent.click(phoneTrigger());
    expect(screen.getByRole("dialog", { name: "Model" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("short lists", () => {
  it("omits the filter when the list cannot grow", async () => {
    setup("", vi.fn(), { searchable: false });
    await userEvent.click(desktopTrigger());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
