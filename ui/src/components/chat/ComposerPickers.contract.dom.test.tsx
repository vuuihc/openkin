// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import type { PermissionMode } from "../../lib/permissionMode";
import { DispatchSelector, type DispatchSelection } from "./DispatchSelector";
import ModelPicker from "./ModelPicker";
import PermissionModePicker from "./PermissionModePicker";

/**
 * C1a: the composer's three pickers are one layer contract, not three
 * lookalikes.
 *
 * The model picker already sat on the shared `Popover` layer; the Mac
 * permission menu and the dispatch panel each hand-rolled a body portal,
 * viewport anchoring, outside-click/Escape dismissal and their own focus move.
 * They drifted: the permission menu had no wrap, Home/End or typeahead, and the
 * dispatch panel closed on the first Escape even when a picker opened inside it
 * was the layer the reader was in.
 *
 * These tests pin the shared contract from outside the components: one layer
 * per picker, portaled out of the composer row; one Escape per layer, deepest
 * first; and a choice firing its callback once and closing its own layer.
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
}));

const MODELS = [{ id: "opus", label: "Opus" }];

type Spies = {
  permission: (mode: PermissionMode) => void;
  model: (id: string) => void;
  dispatch: (selection: DispatchSelection) => void;
};

/** The three pickers in the composer's `overflow-x-auto` control row. */
function ComposerPickers({ spies }: { spies: Spies }) {
  const [permission, setPermission] = useState<PermissionMode>("default");
  const [model, setModel] = useState("");
  const [dispatch, setDispatch] = useState<DispatchSelection>({});
  return (
    <div data-testid="composer-row" className="flex items-center overflow-x-auto">
      <ModelPicker
        compact
        value={model}
        models={MODELS}
        onChange={(id) => {
          spies.model(id);
          setModel(id);
        }}
      />
      <PermissionModePicker
        compact
        value={permission}
        onChange={(mode) => {
          spies.permission(mode);
          setPermission(mode);
        }}
      />
      <DispatchSelector
        value={dispatch}
        onChange={(selection) => {
          spies.dispatch(selection);
          setDispatch(selection);
        }}
      />
    </div>
  );
}

function setup() {
  const spies: Spies = { permission: vi.fn(), model: vi.fn(), dispatch: vi.fn() };
  render(<ComposerPickers spies={spies} />);
  return spies;
}

/** The console's Mac viewport, so the permission picker takes its menu path. */
function viewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Every open floating layer, in document order. */
const layers = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
const composerRow = () => screen.getByTestId("composer-row");
/** The model picker's desktop trigger (the phone one is a sheet). */
const modelTrigger = () =>
  document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]') as HTMLButtonElement;
const permissionTrigger = () =>
  screen.getByRole("button", { name: /^Permissions/ }) as HTMLButtonElement;
const dispatchTrigger = () => screen.getByRole("button", { name: "Dispatch" }) as HTMLButtonElement;

beforeEach(() => {
  setLocale("en");
  viewport(1280);
});

describe("the composer pickers' shared layer contract", () => {
  it("the model, permission and dispatch pickers each open exactly one layer, portaled out of the composer row", async () => {
    setup();

    // The model picker was already on the facade; it stays the reference.
    await userEvent.click(modelTrigger());
    await waitFor(() => expect(layers()).toHaveLength(1));
    expect(layers()[0].parentElement).toBe(document.body);
    expect(composerRow().contains(layers()[0])).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(layers()).toHaveLength(0);

    // The permission menu is the shared `Menu` on the same layer: one dialog
    // holding one menu, not a second portal with its own listeners.
    await userEvent.click(permissionTrigger());
    await waitFor(() => expect(layers()).toHaveLength(1));
    expect(screen.getByRole("menu", { name: "Permissions" })).toBeTruthy();
    expect(layers()[0].parentElement).toBe(document.body);
    expect(composerRow().contains(layers()[0])).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(layers()).toHaveLength(0);

    await userEvent.click(dispatchTrigger());
    expect(await screen.findByRole("dialog", { name: "Dispatch settings" })).toBeTruthy();
    expect(layers()).toHaveLength(1);
    expect(layers()[0].parentElement).toBe(document.body);
    expect(composerRow().contains(layers()[0])).toBe(false);
  });

  it("Escape closes only the topmost layer: a select opened inside the dispatch panel closes first, the panel stays", async () => {
    setup();
    await userEvent.click(dispatchTrigger());
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });

    // The team field is a `SearchSelect`; its panel is a layer opened from
    // inside the dispatch panel, not a second root.
    const teamTrigger = panel.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!;
    await userEvent.click(teamTrigger);
    await waitFor(() => expect(layers()).toHaveLength(2));
    const fieldLayer = layers().find((layer) => layer !== panel)!;

    await userEvent.keyboard("{Escape}");
    expect(fieldLayer.isConnected).toBe(false);
    expect(panel.isConnected).toBe(true);
    expect(document.activeElement).toBe(teamTrigger);

    // The second press belongs to the panel now, and returns to its chip.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Dispatch settings" })).toBeNull();
    expect(layers()).toHaveLength(0);
    expect(document.activeElement).toBe(dispatchTrigger());
  });

  it("choosing a mode, a model or a dispatch field fires its callback once and closes the layer", async () => {
    const spies = setup();

    await userEvent.click(modelTrigger());
    await userEvent.click(await screen.findByRole("option", { name: /Opus/ }));
    expect(spies.model).toHaveBeenCalledTimes(1);
    expect(spies.model).toHaveBeenCalledWith("opus");
    expect(layers()).toHaveLength(0);

    await userEvent.click(permissionTrigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^YOLO/ }));
    expect(spies.permission).toHaveBeenCalledTimes(1);
    expect(spies.permission).toHaveBeenCalledWith("yolo");
    expect(layers()).toHaveLength(0);

    await userEvent.click(dispatchTrigger());
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });
    await userEvent.click(panel.querySelector<HTMLElement>('[aria-haspopup="listbox"]')!);
    await userEvent.click(await screen.findByRole("option", { name: /Core/ }));

    expect(spies.dispatch).toHaveBeenCalledTimes(1);
    expect(spies.dispatch).toHaveBeenCalledWith({
      mode: "auto",
      team: "core",
      objective: undefined,
    });
    // The field's own layer closed; the panel it was opened from is still up.
    expect(screen.getByRole("dialog", { name: "Dispatch settings" })).toBe(panel);
    expect(layers()).toHaveLength(1);
  });
});
