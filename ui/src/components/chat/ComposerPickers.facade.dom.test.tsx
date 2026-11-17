// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { resetLayerDismissers } from "../../lib/backStack";
import BranchPicker from "./BranchPicker";
import { DispatchSelector } from "./DispatchSelector";
import PermissionModePicker from "./PermissionModePicker";

/**
 * RSI R-picker-triggers: the composer row's last three hand-built chips join
 * the facade.
 *
 * The model picker and the folder chip already sit on `Button`; the permission,
 * dispatch and branch chips each drew their own border, height and focus
 * treatment — a thin ring here, nothing there — so one row read as three
 * consoles. These tests pin the shared shape from outside the components: the
 * facade's class, the facade's focus ring, the popup wiring the chip already
 * had, and the touch floor that follows the pointer rather than the viewport.
 */

vi.mock("../../api/client", () => ({
  getRoutingOptions: vi.fn(async () => ({
    agents: [],
    providers: [],
    teams: [{ id: "core", name: "Core", enabled: true }],
    defaults: {
      enabled: false,
      default_team: "",
      objective: "balanced",
      max_attempts_per_step: 0,
      terminal_limit_policy: "",
      manual_fallback: false,
    },
  })),
  getRoutingPreview: vi.fn(async () => ({ blocked: false, phases: [] })),
  listGitBranches: vi.fn(async () => ({
    cwd: "/work/alpha",
    is_git: true,
    current: "main",
    dirty: true,
    branches: [
      { name: "main", current: true },
      { name: "feature/x", current: false },
    ],
  })),
  checkoutGitBranch: vi.fn(async () => undefined),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

/** The console's viewport and pointer, as one answer. jsdom has neither. */
function setMedia({ coarse = false, wide = true }: { coarse?: boolean; wide?: boolean } = {}) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: wide ? 1280 : 390 });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: coarse")
      ? coarse
      : query === "(min-width: 768px)"
        ? wide
        : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** A facade control: the shared class, the shared ring, the same element kind. */
function expectFacade(el: HTMLElement) {
  expect(el.tagName).toBe("BUTTON");
  expect(el.className).toContain("kin-btn");
  expect(el.className).toContain("focus-visible:outline-kin-focus-ring");
}

function renderPermission() {
  render(<PermissionModePicker value="default" compact onChange={vi.fn()} />);
  return screen.getByRole("button", { name: /^Permissions/ }) as HTMLButtonElement;
}

function renderDispatch(value = {}) {
  render(<DispatchSelector value={value} onChange={vi.fn()} />);
  return screen.getByRole("button", { name: "Dispatch" }) as HTMLButtonElement;
}

beforeEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
  setMedia();
  resetLayerDismissers();
});

describe("the composer pickers' triggers on the facade", () => {
  it("permission-trigger-is-facade", async () => {
    const chip = renderPermission();
    expectFacade(chip);
    // The chip's own shape and colours stay; only the treatment moved.
    expect(chip.className).toContain("text-kin-secondary");
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("menu", { name: "Permissions" })).toBeTruthy();
  });

  it("dispatch-trigger-is-facade", async () => {
    const chip = renderDispatch();
    expectFacade(chip);
    expect(chip.textContent).toBe("Dispatch");
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("dialog", { name: "Dispatch settings" })).toBeTruthy();
  });

  it("dispatch-trigger-touch-floor", () => {
    // A finger gets the 44px floor at every width; the facade's own
    // `sm:min-h-0` would undo it at an iPad's width, so the caller's floor
    // carries `!`. A mouse keeps the 28px chip, which needs `!` for the same
    // reason on the other side.
    setMedia({ coarse: true });
    const coarseChip = renderDispatch();
    expect(coarseChip.className).toContain("min-h-11!");
    expect(coarseChip.className).toContain("min-w-11");
    expect(coarseChip.className).not.toContain("min-h-7");

    cleanup();
    setMedia({ coarse: false });
    const fineChip = renderDispatch();
    expect(fineChip.className).toContain("min-h-7!");
    expect(fineChip.className).not.toContain("min-h-11!");
  });

  it("dispatch-preview-toggle-is-facade", async () => {
    // A team set is what reveals the show/hide link.
    render(<DispatchSelector value={{ mode: "auto", team: "t1" }} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^Auto/ }));
    const toggle = await screen.findByRole("button", { name: /Show preview/ });

    expectFacade(toggle);
    expect(toggle.className).toContain("text-kin-blue-ink");
    expect(toggle.className).toContain("hover:underline");
  });

  it("branch-trigger-is-facade", async () => {
    render(<BranchPicker cwd="/work/alpha" compact />);
    const chip = (await screen.findByRole("button", {
      name: "Branch: main",
    })) as HTMLButtonElement;

    expectFacade(chip);
    expect(chip.getAttribute("aria-haspopup")).toBe("listbox");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    // The dirty dot is part of the chip, not a second control beside it.
    expect(chip.querySelector(".bg-kin-orange")).toBeTruthy();

    await userEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("listbox", { name: "Git branches" })).toBeTruthy();
    await waitFor(() =>
      expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2),
    );
  });

  it("no-unannotated-raw-buttons", () => {
    // The ratchet for this slice: the two triggers and the preview toggle are
    // facade controls, and the two raw buttons that remain are option hit
    // areas — each names itself and its reason on the line above.
    const files = [
      "src/components/chat/PermissionModePicker.tsx",
      "src/components/chat/DispatchSelector.tsx",
      "src/components/chat/BranchPicker.tsx",
    ];
    let raw = 0;
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("<button")) return;
        raw += 1;
        const above = lines.slice(Math.max(0, index - 2), index).join("\n");
        expect(
          above,
          `raw <button at ${file}:${index + 1} needs an eslint-disable-next-line kin/no-raw-button`,
        ).toContain("eslint-disable-next-line kin/no-raw-button");
      });
    }
    expect(raw).toBe(2);
  });
});
