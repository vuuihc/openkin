// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import PlacePicker, { type Place } from "./PlacePicker";

/**
 * KIN-START-001: the place row under the card.
 *
 * One machine and one directory on it, chosen together. The panel groups
 * projects by machine and doubles as a directory field, because a machine that
 * has never been used here has no saved project to pick.
 */

const SELF: Machine = {
  id: "desktop-self",
  label: "This Mac",
  isSelf: true,
  online: true,
  roots: [],
  agents: [],
};
const STUDIO: Machine = {
  id: "device-studio",
  label: "Studio",
  isSelf: false,
  online: true,
  roots: ["/srv/gamma", "/srv/delta"],
  agents: [],
};
const NAS: Machine = {
  id: "device-nas",
  label: "NAS",
  isSelf: false,
  online: false,
  roots: ["/volume/work"],
  agents: [],
};

function setWideScreen(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query.includes("min-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function Harness({
  initial = { machineId: "", cwd: "/work/alpha" },
  ...props
}: {
  initial?: Place;
  machines?: Machine[];
  dirs?: string[];
  loading?: boolean;
  failed?: boolean;
  onRefresh?: () => void;
  onChange?: (place: Place) => void;
}) {
  const [place, setPlace] = useState<Place>(initial);
  return (
    <PlacePicker
      machines={props.machines ?? [SELF, STUDIO, NAS]}
      value={place}
      dirs={props.dirs ?? ["/work/alpha", "/work/beta"]}
      loading={props.loading}
      failed={props.failed}
      onRefresh={props.onRefresh}
      onChange={(next) => {
        props.onChange?.(next);
        setPlace(next);
      }}
    />
  );
}

function trigger() {
  return screen.getByRole("button", { name: /^Device & project/ });
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  // The shared layer portals a render after `open`, once its anchor is
  // measured, so the panel is found rather than read synchronously.
  return screen.findByRole("dialog", { name: "Device & project" });
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  setWideScreen(true);
});

describe("the place row (KIN-START-001)", () => {
  it("names the machine and the project on the row", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-label")).toBe("Device & project: This machine · alpha");
  });

  it("groups projects by machine and marks the chosen one", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);

    expect(within(panel).getByRole("group", { name: "This machine · online" })).toBeTruthy();
    expect(within(panel).getByRole("group", { name: "Studio · online" })).toBeTruthy();
    expect(within(panel).getByRole("group", { name: "NAS · offline" })).toBeTruthy();
    expect(within(panel).getByRole("option", { name: /alpha/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(within(panel).getByRole("option", { name: /gamma/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("reports both the machine and its directory when another machine's project is picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const panel = await open(user);
    await user.click(within(panel).getByRole("option", { name: /gamma/ }));

    expect(onChange).toHaveBeenCalledWith({ machineId: "device-studio", cwd: "/srv/gamma" });
    expect(screen.queryByRole("dialog", { name: "Device & project" })).toBeNull();
    await waitFor(() =>
      expect(trigger().getAttribute("aria-label")).toBe("Device & project: Studio · gamma"),
    );
  });

  it("offers a typed directory for the machine the row names", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const panel = await open(user);
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });

    await user.type(search, "/work/new");
    await user.click(within(panel).getByRole("option", { name: "Use directory /work/new" }));

    expect(onChange).toHaveBeenCalledWith({ machineId: "", cwd: "/work/new" });
  });

  it("leaves the place alone on a bare Enter in the empty field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const panel = await open(user);
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });
    await waitFor(() => expect(document.activeElement).toBe(search));

    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Device & project" })).toBeTruthy();
  });

  it("takes a directory with Enter from the field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const panel = await open(user);
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });

    await user.type(search, "/work/new{Enter}");
    expect(onChange).toHaveBeenCalledWith({ machineId: "", cwd: "/work/new" });
  });

  it("filters the groups and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });

    await user.type(search, "beta");
    expect(within(panel).queryByRole("option", { name: /alpha/ })).toBeNull();
    expect(within(panel).getByRole("option", { name: /beta/ })).toBeTruthy();
    expect(within(panel).queryByRole("group", { name: "Studio · online" })).toBeNull();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(within(panel).getByText("Nothing matches that.")).toBeTruthy();
  });

  it("still offers an offline machine, so the page can explain why Start is off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const panel = await open(user);
    await user.click(within(panel).getByRole("option", { name: /volume\/work/ }));
    expect(onChange).toHaveBeenCalledWith({ machineId: "device-nas", cwd: "/volume/work" });
  });

  it("closes on Escape and gives focus back to the row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);
    // Wait for the field to take focus, then land the Escape on the row: only
    // the panel's own handler can answer it, as a reader who tabs back would.
    // Without the wait, focus is still on the trigger and the assertion below
    // would pass with the focus restore deleted.
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Device & project" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps the row disabled while the machine list has not arrived", () => {
    render(<Harness machines={[]} loading />);
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    expect(trigger().textContent).toContain("Finding machines…");
  });

  it("offers a retry when the machine list failed", () => {
    const onRefresh = vi.fn();
    render(<Harness machines={[SELF]} failed onRefresh={onRefresh} />);
    expect(screen.getByText(/machine list could not be read/i)).toBeTruthy();
    screen.getByRole("button", { name: "Check again" }).click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("opens the same panel as a sheet on a phone", async () => {
    setWideScreen(false);
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });
    expect(search).toBeTruthy();
    // The sheet focuses its panel on open at 0 ms; this field must still win,
    // or the phone opens a search nobody can type into.
    await waitFor(() => expect(document.activeElement).toBe(search));
    // A sheet is content, not a layer: rows are plain buttons here, so the
    // sheet's own Escape handling is not fooled by a listbox inside it.
    expect(within(panel).getByRole("button", { name: /alpha/ })).toBeTruthy();
    // The key legend belongs to the desktop panel; a sheet must not teach Esc.
    expect(within(panel).queryByText(/Esc close/)).toBeNull();
  });

  it("also closes from the search field with Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);
    // Wait for the field to hold focus: the window handler only answers an
    // Escape whose focus is inside the panel, which is where the field is.
    const search = within(panel).getByRole("searchbox", { name: "Search machines or projects…" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Device & project" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("closes the phone sheet on Escape with the option list inside", async () => {
    setWideScreen(false);
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Device & project" })).toBeNull();
  });

  it("at 1100 the place panel is the shared layer, portaled out of the new-chat card", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);

    // One body portal, measured from the viewport — the same layer every other
    // popover in the console uses, not a panel positioned inside this card.
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain("fixed");
    expect(panel.className).toContain("rounded-xl");
    // The panel's search header and rows draw their own padding; the base
    // padding would inset its hairline dividers by 6px on each side.
    expect(panel.className).not.toContain("p-1.5");
  });

  it("at 390 the phone sheet is still the surface", async () => {
    setWideScreen(false);
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await open(user);

    expect(document.querySelector("[data-kin-sheet]")).toBeTruthy();
    // The dialog is the sheet's own panel, not a popover portaled to <body>.
    expect(panel.parentElement?.hasAttribute("data-kin-sheet")).toBe(true);
    expect(panel.parentElement).not.toBe(document.body);
  });

  it("moves with the arrows, picks with Enter, and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    let panel = await open(user);
    const search = () =>
      within(panel).getByRole("searchbox", { name: "Search machines or projects…" });
    await waitFor(() => expect(document.activeElement).toBe(search()));

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const options = within(panel).getAllByRole("option");
    expect(document.activeElement).toBe(options[1]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Device & project" })).toBeNull();
    expect(document.activeElement).toBe(trigger());

    panel = await open(user);
    await waitFor(() => expect(document.activeElement).toBe(search()));
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith({ machineId: "", cwd: "/work/beta" });
  });

  it("does not make the panel a child of the trigger's own row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const row = trigger().parentElement as HTMLElement;
    const panel = await open(user);

    // TASTE 14, machine-checkable proxy: the panel is a layer over the page,
    // so opening it cannot push the row it hangs from (jsdom has no heights;
    // the 1100 screenshot is the visual proof).
    expect(row.contains(panel)).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });
});
