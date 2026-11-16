// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../../api/client";
import { setLocale } from "../../i18n";
import MachineBrowser from "./MachineBrowser";

/**
 * C1b2: the folder browser on the console's shared modal surfaces. The old
 * overlay owned its scrim, Escape listener, focus timer and `role="dialog"`;
 * this pins the contract it now shares — a named `Dialog` on a Mac, the phone
 * `Sheet` below it, one owner for Escape and focus return, and facade buttons
 * with their 44px phone floor.
 */

const api = vi.hoisted(() => ({
  machineDirs: vi.fn(),
  machineRepoBranches: vi.fn(),
  prepareMachineRepo: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    machineDirs: api.machineDirs,
    machineRepoBranches: api.machineRepoBranches,
    prepareMachineRepo: api.prepareMachineRepo,
  };
});

/* The same stubs the Dialog facade's harness uses: jsdom has no showModal()
 * and no top layer, and no `CSS` global for Astryx's title id. */
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
if (typeof globalThis.CSS === "undefined") {
  (globalThis as { CSS?: Pick<typeof CSS, "escape"> }).CSS = {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
  };
}

const ROOTS = ["/work", "/other"];

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

type Listing = {
  path: string;
  roots: string[];
  parent: string;
  entries: string[];
  truncated: boolean;
};

function listing(path: string): Listing {
  if (path === "") {
    return { path: "", roots: ROOTS, parent: "", entries: [], truncated: false };
  }
  return { path, roots: ROOTS, parent: "/", entries: ["alpha"], truncated: false };
}

function setup(wide: boolean, props: Partial<ComponentProps<typeof MachineBrowser>> = {}) {
  viewport(wide);
  const onPick = vi.fn();
  const onClose = vi.fn();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open browser
        </button>
        <MachineBrowser
          open={open}
          onPick={onPick}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          {...props}
        />
      </>
    );
  }
  const view = render(<Host />);
  return { onPick, onClose, ...view };
}

async function openBrowser() {
  await userEvent.click(screen.getByRole("button", { name: "Open browser" }));
}

beforeEach(() => {
  setLocale("en");
  api.machineDirs.mockReset();
  api.machineRepoBranches.mockReset();
  api.prepareMachineRepo.mockReset();
  api.machineDirs.mockImplementation((_device: string | undefined, path: string) =>
    Promise.resolve(listing(path)),
  );
});

describe("the machine browser", () => {
  it("at Mac widths the browser is a dialog named Browse", async () => {
    setup(true, { initialPath: "/start" });
    await openBrowser();

    const modal = screen.getByRole("dialog", { name: "Where to work" });
    expect(modal.tagName).toBe("DIALOG");
    expect(await within(modal).findByText("alpha")).toBeTruthy();
  });

  it("at phone widths the browser is the sheet", async () => {
    setup(false, { initialPath: "/start" });
    await openBrowser();

    const modal = screen.getByRole("dialog", { name: "Where to work" });
    expect(modal.tagName).toBe("DIV");
    expect(document.querySelector("dialog")).toBeNull();
    expect(within(modal).getByRole("button", { name: "Folder" })).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Repository" })).toBeTruthy();
    expect(await within(modal).findByText("alpha")).toBeTruthy();
  });

  it("Escape asks to close exactly once and focus comes back to the opener", async () => {
    const { onClose } = setup(true, { initialPath: "/start" });
    const opener = screen.getByRole("button", { name: "Open browser" });
    await userEvent.click(opener);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));

    onClose.mockClear();
    await userEvent.keyboard("{Escape}");

    // The layer owns Escape; no second document listener answers the same key.
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("Use this folder stays disabled while the listing is in doubt", async () => {
    let resolve!: (value: Listing) => void;
    const pending = new Promise<Listing>((done) => {
      resolve = done;
    });
    api.machineDirs.mockImplementation((_device: string | undefined, path: string) =>
      path === "" ? Promise.resolve(listing("")) : pending,
    );

    const first = setup(true, { initialPath: "/start" });
    await openBrowser();

    const use = screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);

    resolve({ ...listing("/walked"), entries: ["alpha"] });
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.click(use);
    expect(first.onPick).toHaveBeenCalledWith("/walked");

    first.unmount();

    // A failed listing leaves `path` unconfirmed, so it is still not pickable.
    api.machineDirs.mockImplementation((_device: string | undefined, path: string) =>
      path === ""
        ? Promise.resolve(listing(""))
        : Promise.reject(new ApiError(404, "no such directory")),
    );
    setup(true, { initialPath: "/start" });
    await openBrowser();

    const failed = screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement;
    await waitFor(() => expect(failed.disabled).toBe(true));
    expect(screen.getByText("Could not read that folder")).toBeTruthy();
  });

  it("the repo tab still asks the machine for branches and fetches one", async () => {
    api.machineRepoBranches.mockResolvedValue({
      clone_url: "https://example.com/owner/repo.git",
      default_branch: "main",
      branches: ["main", "dev"],
      truncated: false,
    });
    api.prepareMachineRepo.mockResolvedValue({ path: "/work/repo" });

    const { onPick } = setup(true, { initialPath: "/start" });
    await openBrowser();
    await userEvent.click(screen.getByRole("button", { name: "Repository" }));

    await userEvent.type(screen.getByPlaceholderText("owner/repo"), "owner/repo");
    await userEvent.click(screen.getByRole("button", { name: "Find branches" }));

    expect(api.machineRepoBranches).toHaveBeenCalledWith(undefined, "owner/repo");
    // `SearchSelect` draws two faces; either one carrying the default is arrival.
    await waitFor(() => expect(screen.getAllByText("main · default").length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: "Fetch onto this machine" }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/work/repo"));
  });

  it("the tab strip and rows are facade controls", async () => {
    setup(true, { initialPath: "/work" });
    await openBrowser();

    for (const name of ["Folder", "Repository"]) {
      expect(screen.getByRole("button", { name }).className).toContain("kin-btn");
    }

    const row = await screen.findByRole("button", { name: "alpha" });
    expect(row.className).toContain("kin-btn");
    expect(row.className).toContain("min-h-11");
    expect(row.className).toContain("sm:min-h-0");

    // Current tint and the roots/parent rows' labels and hints are unchanged.
    const current = screen.getByRole("button", { name: "/work, This machine works in" });
    expect(current.className).toContain("bg-kin-blue/15");
    const parent = screen.getByRole("button", { name: ".., Up one level" });
    expect(parent.textContent).toContain("..");
    expect(parent.textContent).toContain("Up one level");
  });

  it("an empty listing still says so and a truncated one keeps its count", async () => {
    api.machineDirs.mockImplementation((_device: string | undefined, path: string) =>
      Promise.resolve(
        path === ""
          ? { path: "", roots: [], parent: "", entries: [], truncated: false }
          : { path, roots: [], parent: "", entries: [], truncated: true },
      ),
    );

    setup(true, { initialPath: "/empty" });
    await openBrowser();

    expect(await screen.findByText("No folders inside")).toBeTruthy();
    expect(screen.getByText("Showing the first 0")).toBeTruthy();
  });
});
