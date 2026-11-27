// @vitest-environment jsdom
// KIN-START-001: the run card names host, model and permission while its extra
// rows stay inside the one settings surface.
import { useState } from "react";
import { createPortal } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale, t } from "../../i18n";
import type { AgentInfo } from "../../api/client";
import { RoutineToggle } from "../../pages/NewChatPage";
import RunConfigControl, { type RunConfigControlProps } from "./RunConfigSheet";

const MODELS = [
  { id: "opus", label: "Opus", tier: "flagship" },
  { id: "sonnet", label: "Sonnet" },
];

/** A catalog longer than six rows is what makes the model layer grow a field. */
const MANY_MODELS = Array.from({ length: 8 }, (_, index) => ({
  id: `m${index}`,
  label: `Model ${index}`,
}));

function setup(overrides: Partial<RunConfigControlProps> = {}) {
  const onModelChange = vi.fn();
  const onPermissionChange = vi.fn();
  const props: RunConfigControlProps = {
    agentName: "Claude Code",
    agentAvatar: { initials: "C", className: "bg-kin-agent-claude" },
    model: "sonnet",
    models: MODELS,
    onModelChange,
    permission: "default",
    permissionModes: ["default", "accept_edits", "yolo"],
    onPermissionChange,
    ...overrides,
  };
  // The control is controlled by its parent in the app; a static prop here
  // would keep the custom field showing the old value while the user types,
  // which is not a state the real composer can be in.
  function Harness() {
    const [model, setModel] = useState(props.model);
    const [permission, setPermission] = useState<string>(props.permission);
    return (
      <RunConfigControl
        {...props}
        model={model}
        permission={permission}
        onModelChange={(id) => {
          onModelChange(id);
          setModel(id);
        }}
        onPermissionChange={(mode) => {
          onPermissionChange(mode);
          setPermission(mode);
        }}
      />
    );
  }
  const view = render(<Harness />);
  return { onModelChange, onPermissionChange, unmount: view.unmount };
}

async function openSheet() {
  await userEvent.click(screen.getByRole("button", { name: /^Run settings/ }));
  return screen.getByRole("dialog", { name: "Run settings" });
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

/**
 * The control picks its container from `min-width: 768px`. jsdom has no
 * `matchMedia`, and `useMinWidth`'s fallback is the desktop shape, so a test
 * that says nothing about the width would silently run against the panel.
 * Each group states which width it is about.
 *
 * `coarse` is the other half: the touch floor follows the pointer, so an iPad
 * is 768px wide (the panel) and still a thumb (44px targets).
 */
function setWideScreen(wide: boolean, coarse = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: coarse")
      ? coarse
      : wide && query.includes("min-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** A value the reader must be able to finish: wrapped, never ellipsized. */
function assertWraps(element: HTMLElement) {
  expect(element.className).toContain("break-words");
  expect(element.className).not.toContain("truncate");
}

beforeEach(() => {
  setLocale("en");
  setViewport(390, 844);
  setWideScreen(false);
});

describe("RunConfigControl", () => {
  it("names the agent, the model and the mode on the face", () => {
    setup();
    const face = screen.getByRole("button", { name: /^Run settings/ });
    expect(face.textContent).toContain("Claude Code");
    expect(face.textContent).toContain("Sonnet");
    expect(face.textContent).toContain("Ask");
  });

  it("puts the run-config face on the shared Button", async () => {
    setup();
    const face = screen.getByRole("button", { name: /^Run settings/ });
    // Quiet weight: the face sits on the composer's surface and takes a fill
    // only on hover, the same as every other quiet affordance there.
    expect(face.className).toContain("kin-btn");
    expect(face.className).not.toContain("kin-btn-primary");
    expect(face.getAttribute("aria-haspopup")).toBe("dialog");

    await userEvent.click(face);
    expect(face.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
  });

  it("keeps the face on one line, ellipsizing the model but never its name", () => {
    // The face rides the composer's control row, whose height is fixed: a
    // long model id wrapped to four lines and made the settings the tallest
    // part of a phone composer. It now ellipsizes, and the full value is
    // still announced (the accessible name) and still readable in full in
    // the sheet — see "shows the full current values ... inside the sheet".
    const agentName = "An agent name that has no business fitting on one line";
    const modelLabel = "A-model-label-long-enough-that-it-cannot-fit-on-one-line";
    setup({
      agentName,
      model: "custom-model",
      models: [{ id: "custom-model", label: modelLabel }],
    });
    const face = screen.getByRole("button", { name: /^Run settings/ });
    const model = within(face).getByText(modelLabel);
    expect(model.className).toContain("truncate");
    expect(model.className).not.toContain("break-words");
    expect(model.className).not.toContain("hidden");
    // The avatar and the text row must share one flex row. Astryx wraps the
    // button's children in a plain label span, so two sibling spans there
    // are block-level and stack onto two lines; the face wraps both in one
    // row of its own, and that row is the one both children name as parent.
    const avatar = within(face).getByText("C");
    const faceRow = avatar.parentElement;
    expect(faceRow).toBe(model.parentElement!.parentElement);
    expect(faceRow!.className).toContain("flex");
    expect(faceRow!.className).not.toContain("flex-col");
    // On a narrow card the one visible name is the model; the agent's name
    // returns from the composer card's `@xl` width up, where there is room for
    // both. The cut is the card's, not the viewport's: an iPad in portrait
    // draws a 344–396px card inside a ≥640px window.
    const agent = within(face).getByText(agentName);
    expect(agent.className).toContain("hidden");
    expect(agent.className).toContain("@xl:block");
    expect(agent.className).not.toContain("sm:block");
    // One line: neither the values nor the row that holds them may wrap.
    expect(model.parentElement!.className).not.toContain("flex-wrap");
    expect(face.className).toContain("overflow-hidden");
    // The full values survive where a phone can still reach them: the
    // button's accessible name, and the sheet behind it.
    const name = face.getAttribute("aria-label") ?? "";
    expect(name).toContain(agentName);
    expect(name).toContain(modelLabel);
    expect(name).toContain("Ask");
  });

  it("shows the full current values and options inside the sheet", async () => {
    const agentName = "Host agent with a name that wraps";
    const otherName = "Another agent whose name is even longer than the first";
    const modelLabel = "A model label long enough to need a second line";
    const agent = (id: string, name: string): AgentInfo => ({
      id,
      name,
      installed: true,
      available: true,
      default: false,
      model_list_source: "none",
      model_list_status: "default_only",
    });
    setup({
      agentName,
      model: "custom-model",
      models: [{ id: "custom-model", label: modelLabel }],
      agents: [agent("a1", agentName), agent("a2", otherName)],
      onAgentChange: vi.fn(),
    });
    const dialog = await openSheet();
    const agentValue = within(dialog).getByText(agentName);
    const modelValue = within(dialog).getByText(modelLabel);
    assertWraps(agentValue);
    assertWraps(modelValue);

    await userEvent.click(within(dialog).getByRole("button", { name: /^Agent/ }));
    const option = await screen.findByRole("menuitemradio", { name: new RegExp(otherName) });
    // The row trigger above wraps; the shared menu's rows are one line by
    // contract, so what this holds is that the full name reaches the row the
    // reader hears, not that the row grows to fit it.
    expect(option.textContent).toContain(otherName);
  });

  it("opens the sheet with the agent read-only and the two pickers", async () => {
    setup();
    const dialog = await openSheet();
    // Scoped to the sheet: the face behind it now names the same agent.
    expect(within(dialog).getByText("Claude Code")).toBeTruthy();
    // The agent is a fact once the session exists, not a control.
    expect(within(dialog).queryByRole("button", { name: "Agent" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /^Model/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /^Permissions/ })).toBeTruthy();
  });

  it("keeps every row trigger on the 44px touch floor", async () => {
    // A finger at 390px is the case this test is about. The clear's shape is
    // keyed to the pointer now, so the case has to say coarse instead of
    // relying on a `max-sm:` rule that only knew about width.
    setWideScreen(false, true);
    // More than six models is what makes the list long enough to grow a field.
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      label: `Model ${index}`,
    }));
    setup({
      models: many,
      model: "m0",
      agentId: "claude-code",
      agents: [
        { id: "claude-code", name: "Claude Code", available: true },
        { id: "codex", name: "Codex", available: true },
      ] as never,
      onAgentChange: vi.fn(),
    });
    const dialog = await openSheet();
    // jsdom has no layout, so the floor is asserted where it is declared:
    // the shared button ships `min-h-11`, and a row that overrides it with a
    // smaller floor is a tap target a thumb on a 390px phone can miss.
    for (const trigger of dialog.querySelectorAll<HTMLElement>("[data-run-config-trigger]")) {
      expect(trigger.className).toContain("min-h-11");
      expect(trigger.className).not.toContain("min-h-10");
    }

    // The search field's clear is the other thumb-sized control in the sheet:
    // it appears only once a query is typed (and the field only when the
    // catalog is longer than six), so it is asserted here.
    await userEvent.click(within(dialog).getByRole("button", { name: /^Model/ }));
    await userEvent.type(screen.getByLabelText("Search models"), "model");
    const clear = screen.getByRole("button", { name: "Clear" });
    // Whole tokens: the shared Button's `sm:min-h-0` cancels its own floor at
    // this width, so the coarse shape is the explicit 44px box, and the old
    // `max-sm:min-w-11` substring must not be able to satisfy this.
    const clearClasses = clear.className.split(/\s+/);
    expect(clearClasses).toContain("h-11");
    expect(clearClasses).toContain("w-11");
    expect(clearClasses).not.toContain("max-sm:min-w-11");
  });

  it("keys the run-config face's size to the pointer, not the width", () => {
    // TASTE 11: an iPad is ≥640px wide and still a thumb. The face is a 44px
    // target on touch at every width, and the Mac's 28px face returns only
    // when the pointer is fine.
    setWideScreen(false, true);
    const coarse = setup();
    expect(screen.getByRole("button", { name: /^Run settings/ }).className).toContain("min-h-11!");
    coarse.unmount();

    setWideScreen(false, false);
    setup();
    const face = screen.getByRole("button", { name: /^Run settings/ });
    // The facade ships a plain `min-h-11`; the compact shape is our important
    // override, which also wins under a narrow fine-pointer window.
    expect(face.className).toContain("min-h-7!");
    expect(face.className).not.toContain("min-h-11!");
    // No viewport shrink left behind: `sm:` is what made the iPad small.
    expect(face.className).not.toContain("sm:min-h-7");
  });

  it("gives the routine toggle in extraRows a 44px target on a coarse pointer", async () => {
    setWideScreen(false, true);
    setup({
      extraRows: <RoutineToggle pressed={false} onToggle={() => {}} />,
    });
    const dialog = await openSheet();
    const toggle = within(dialog).getByRole("button", { name: t("routines.asRoutine") });
    expect(toggle.className).toContain("h-11");
    expect(toggle.className).toContain("w-11");
    expect(toggle.className).toContain("min-h-11!");
    expect(toggle.className).not.toContain("h-[26px]");
  });

  it("keeps the routine toggle's designed 26px face on a fine pointer", async () => {
    setWideScreen(false, false);
    setup({
      extraRows: <RoutineToggle pressed={false} onToggle={() => {}} />,
    });
    const dialog = await openSheet();
    const toggle = within(dialog).getByRole("button", { name: t("routines.asRoutine") });
    expect(toggle.className).toContain("h-[26px]");
    expect(toggle.className).toContain("w-[26px]");
    expect(toggle.classList.contains("h-11")).toBe(false);
    expect(toggle.classList.contains("w-11")).toBe(false);
  });

  it("opens the agent list as a radio menu and marks the current agent", async () => {
    const onAgentChange = vi.fn();
    setup({
      agentId: "claude-code",
      agents: [
        { id: "claude-code", name: "Claude Code", available: true },
        { id: "codex", name: "Codex", available: true },
      ] as never,
      onAgentChange,
    });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Agent/ }));

    const menu = screen.getByRole("menu", { name: "Agent" });
    // A radio row, not a highlighted one: the reader hears which agent is set
    // while arrowing, the same way the composer's permission chip reads.
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: /Claude Code/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitemradio", { name: /Codex/ }).getAttribute("aria-checked"),
    ).toBe("false");

    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Codex/ }));
    expect(onAgentChange).toHaveBeenCalledTimes(1);
    expect(onAgentChange).toHaveBeenCalledWith("codex");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the model row as a menu with the search field on top", async () => {
    // More than six models is what makes the layer grow a search field.
    setup({ models: MANY_MODELS, model: "m0" });
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await userEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Model" });
    // The current choice is a radio row, the same shape the agent and
    // permission rows already use.
    expect(
      within(menu).getByRole("menuitemradio", { name: "Model 0" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitemradio", { name: "Model 1" }).getAttribute("aria-checked"),
    ).toBe("false");

    // The field is above every row and inside the same layer.
    const search = screen.getByLabelText("Search models");
    expect(menu.contains(search)).toBe(false);
    expect(search.closest('[role="dialog"]')!.contains(menu)).toBe(true);
    const firstRow = within(menu).getAllByRole("menuitemradio")[0]!;
    expect(
      search.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("marks the current model and picks a new one from the menu", async () => {
    const { onModelChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    const menu = screen.getByRole("menu", { name: "Model" });
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: /Sonnet/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Opus/ }));
    expect(onModelChange).toHaveBeenCalledWith("opus");
    // Choosing a value closes the layer; the sheet stays.
    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
  });

  it("typing in the model search never opens the custom-model editor", async () => {
    const { onModelChange } = setup({ models: MANY_MODELS, model: "m0" });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    // "cus" is a prefix of the Custom row's label. A filter that let the
    // sentinel through would leave Enter pointing at it and open the editor.
    const search = screen.getByLabelText("Search models");
    await userEvent.type(search, "cus");
    expect(screen.queryByLabelText("Custom model ID")).toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
    expect(screen.getByText("No matching models")).toBeTruthy();

    await userEvent.clear(search);
    await userEvent.type(search, "Model 5");
    await userEvent.keyboard("{Enter}");
    expect(onModelChange).toHaveBeenCalledWith("m5");
    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.queryByLabelText("Custom model ID")).toBeNull();
  });

  it("keeps a custom model id reachable behind the custom row", async () => {
    const { onModelChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Custom model…" }));

    expect(onModelChange).toHaveBeenCalledWith("");
    const field = screen.getByLabelText("Custom model ID");
    // The layer stays open and the caret is already in the field, so the
    // choice that revealed it did not pull it out from under the reader.
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();
    expect(document.activeElement).toBe(field);
    await userEvent.type(field, "my-model");
    expect(onModelChange).toHaveBeenLastCalledWith("my-model");
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();
  });

  it("puts focus on the search field when the catalog is long, and on the current row when it is short", async () => {
    const long = setup({ models: MANY_MODELS, model: "m0" });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    // A long catalog opens ready to be narrowed: the field has the caret and
    // Down walks into the rows from there.
    expect(document.activeElement).toBe(screen.getByLabelText("Search models"));
    long.unmount();

    setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    // A short catalog has nothing to narrow, so the reader starts on the
    // choice that is set and the next arrow moves relative to it.
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: /Sonnet/ }));
  });

  it("closes the expansion on Escape, and the sheet on the next one", async () => {
    setup();
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
    // Focus goes back to the row that closed, so the keyboard stays where the
    // change was about to be made.
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });

  it("spends one Escape on the layer even when focus never entered it", async () => {
    setup();
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();

    // The layer is portaled out of the sheet, and opening it need not move
    // focus. The sheet's capture-phase listener runs before the layer's own
    // Escape handling and must still count the layer as open inside, or the
    // first Escape closes the sheet under it.
    trigger.focus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
  });

  it("puts focus inside the option layer when a row opens", async () => {
    // The layer is portaled out of the sheet. Without moving focus into it, a
    // hardware keyboard has nowhere to arrow from, and a screen reader whose
    // cursor is confined to the modal never reaches the options.
    setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    const layer = screen.getByRole("menu", { name: "Model" });
    expect(layer.contains(document.activeElement)).toBe(true);
    // And it is the current choice that has it, so the next arrow is relative.
    expect(document.activeElement?.textContent).toContain("Sonnet");
  });

  it("gives the first Back to the layer and the next to the sheet", async () => {
    setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();

    // The system Back gesture, as the browser delivers it: the current entry
    // has already become the one below the sheet when `popstate` arrives.
    act(() => {
      window.history.replaceState({}, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();

    act(() => {
      window.history.replaceState({}, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });

  it("gives its history entry back when the sheet closes itself", async () => {
    setup();
    await openSheet();
    const back = vi.spyOn(window.history, "back");
    // The scrim is the sheet's own close path; closing this way must not leave
    // an entry behind for Back to walk into after the sheet is already gone.
    await userEvent.click(document.querySelector(".kin-scrim-enter") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("closes the layer from inside it, where the rows cannot hear the key", async () => {
    setup();
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    await userEvent.click(trigger);

    // A portal is not a DOM child, so the rows' own key handler never sees an
    // Escape pressed on an option. The document listener is what puts the
    // layer away and returns focus to its row.
    screen.getByRole("menuitemradio", { name: /Sonnet/ }).focus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it("walks out of the option list and back into the search field", async () => {
    setup({ models: MANY_MODELS, model: "m0" });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    const search = screen.getByLabelText("Search models");
    await userEvent.click(search);
    await userEvent.keyboard("{ArrowDown}");
    // Down lands on the row that is set, not the top of the catalog.
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Model 0" }));

    // Up from the first row is the way back to the field ArrowDown left —
    // otherwise the pair is a one-way trip and the field keeps the caret.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Default" }));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(search);
  });

  it("takes the first match when Enter is pressed in the field", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      label: `Model ${index}`,
    }));
    const { onModelChange } = setup({ models: many, model: "m0" });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    await userEvent.type(screen.getByLabelText("Search models"), "Model 5");
    await userEvent.keyboard("{Enter}");
    // Filtering down to the row you want and pressing Enter takes it, the way
    // the desktop `SearchSelect` behaves.
    expect(onModelChange).toHaveBeenCalledWith("m5");
    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
  });

  it("opens the permission list as a menu with each mode's consequence", async () => {
    const { onPermissionChange } = setup();
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Permissions/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await userEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Permissions" });
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows).toHaveLength(3);
    // Each row carries what the mode does, not only its name: choosing YOLO
    // should not be possible without having read what it skips.
    expect(rows[0]!.textContent).toContain(t("permission.defaultHint"));
    expect(rows[1]!.textContent).toContain(t("permission.acceptEditsHint"));
    expect(rows[2]!.textContent).toContain(t("permission.yoloHint"));
    expect(rows[0]!.getAttribute("aria-checked")).toBe("true");
    expect(rows[2]!.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(rows[2]!);
    expect(onPermissionChange).toHaveBeenCalledWith("yolo");
  });

  it("returns focus to the row trigger after a menu choice", async () => {
    setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Auto-edit/ }));

    // The menu is portaled and unmounts on the choice; the keyboard has to
    // land back on the row it was changing, not at the top of the page.
    const trigger = screen.getByRole("button", { name: /^Permissions/ });
    expect(trigger.hasAttribute("data-run-config-trigger")).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("gives the menu the first Escape and the sheet the next", async () => {
    setup();
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Permissions/ });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Permissions" })).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    // One Escape, one layer: the menu goes and the sheet behind it stays.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });

  it("changes the permission mode", async () => {
    const { onPermissionChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /YOLO/ }));
    expect(onPermissionChange).toHaveBeenCalledWith("yolo");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("only offers the modes the machine actually runs", async () => {
    setup({ permissionModes: ["default"] });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.queryByRole("menuitemradio", { name: /YOLO/ })).toBeNull();
  });

  // KIN-CONTINUE-001, step 5: the phone's pickers are a second layer over the
  // sheet. The sheet itself must not grow, and the rows below must not move —
  // the old inline expansion pushed the permission row off the bottom of the
  // sheet exactly when it was about to be used.
  it("floats the model options over the sheet without growing it", async () => {
    setup();
    const dialog = await openSheet();
    const permission = screen.getByRole("button", { name: /^Permissions/ });

    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    const layer = screen.getByRole("menu", { name: "Model" });
    // Measured from the viewport and portaled out of the sheet: an `absolute`
    // layer inside the sheet's scrollport was clipped at its top edge, where
    // no scroll could reach it, so the search field and first options painted
    // nowhere. The positioned element is now the shared popover's dialog; the
    // menu rides inside it.
    const panel = layer.closest('[role="dialog"]');
    expect(panel).toBeTruthy();
    expect(panel!.parentElement).toBe(document.body);
    expect(dialog.contains(layer)).toBe(false);
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBe(dialog);
    // The row below is the same node in the same sheet, not a re-render moved
    // by a taller body.
    expect(screen.getByRole("button", { name: /^Permissions/ })).toBe(permission);
    expect(document.querySelector("select")).toBeNull();
  });

  it("floats the agent options over the sheet too", async () => {
    setup({
      agents: [
        { id: "claude-code", name: "Claude Code", available: true },
        { id: "codex", name: "Codex", available: true },
      ] as never,
      onAgentChange: vi.fn(),
    });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Agent/ }));

    // The agent row opens the shared `Menu`: a second layer portaled to
    // <body> and measured from the row trigger, so the sheet behind it keeps
    // its height and the rows below keep their places.
    const menu = screen.getByRole("menu", { name: "Agent" });
    const panel = menu.closest('[role="dialog"]');
    expect(panel).toBeTruthy();
    expect(panel!.parentElement).toBe(document.body);
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
  });

  it("closes the layer on a tap outside it, leaving the sheet open", async () => {
    setup();
    const dialog = await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();

    // The sheet's own body, not a row and not the layer.
    await userEvent.click(dialog);

    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBe(dialog);
  });

  // #3: agent, model and permission are one toolbar's selectors, so they share
  // one placement rule. The sheet sits at the bottom, so every row prefers
  // upward and the shared hook flips only when the space above is gone. The
  // rows are stubbed at mid-screen — both sides have room there — so what this
  // asserts is the preference itself, not a flip. Before the fix the agent row
  // was hard-coded downward and opened on the opposite side from the other two.
  it("opens the three rows' options on the same side of their row", async () => {
    setViewport(390, 844);
    const rect = {
      top: 300,
      bottom: 330,
      left: 40,
      right: 350,
      width: 310,
      height: 30,
      x: 40,
      y: 300,
      toJSON: () => ({}),
    } as DOMRect;
    // The shared popover anchors to the control that opened the layer, so the
    // trigger's measurement is what decides the side. The row is stubbed too:
    // the three rows are still the cards the layer is about.
    const stubRows = () => {
      for (const row of document.querySelectorAll<HTMLElement>(
        "[data-run-config-row], [data-run-config-trigger]",
      )) {
        row.getBoundingClientRect = () => rect;
      }
    };

    setup({
      agents: [
        { id: "claude-code", name: "Claude Code", available: true },
        { id: "codex", name: "Codex", available: true },
      ] as never,
      onAgentChange: vi.fn(),
    });
    await openSheet();
    stubRows();

    // All three rows are the shared `Menu` now, so the same rule has to hold
    // for the model row too.
    const rows: Array<[RegExp, string]> = [
      [/^Agent/, "Agent"],
      [/^Model/, "Model"],
      [/^Permissions/, "Permissions"],
    ];
    for (const [name, menuName] of rows) {
      await userEvent.click(screen.getByRole("button", { name }));
      const layer = screen.getByRole("menu", { name: menuName });
      // Upward: measured from the bottom, and no `top` on the same element.
      const panel = layer.closest<HTMLElement>('[role="dialog"]');
      expect(panel).toBeTruthy();
      expect(panel!.style.bottom).not.toBe("");
      expect(panel!.style.top).toBe("");
      const left = Number.parseFloat(panel!.style.left);
      const width = Number.parseFloat(panel!.style.width);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + width).toBeLessThanOrEqual(390 - 8);
    }
  });
});

/**
 * The shape of an `extraRows` control the shared layer registry cannot see:
 * `DispatchSelector` and its neighbours portal their own `role="dialog"` to
 * `<body>` instead of building on `Popover`.
 */
function PortaledExtraRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Dispatch
      </button>
      {open
        ? createPortal(
            <div role="dialog" aria-label="Dispatch">
              <button type="button">Inside dispatch</button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The Mac shape: the same rows in an anchored panel instead of the phone's
 * bottom sheet. A panel is a layer over the page, not a navigation entry, so
 * the history contract that belongs to the sheet must not leak into it.
 */
describe("RunConfigControl on a wide screen", () => {
  beforeEach(() => {
    setViewport(1024, 768);
    setWideScreen(true);
  });

  it("opens an anchored panel with the same rows, not the phone sheet", async () => {
    setup();
    const panel = await openSheet();
    // The scrim is the sheet's own shape; the panel has none.
    expect(document.querySelector(".kin-scrim-enter")).toBeNull();
    // The panel is the shared popover's dialog, and it is the only one.
    expect(panel.getAttribute("aria-label")).toBe("Run settings");
    expect(panel.parentElement).toBe(document.body);
    // Scoped to the panel: the face behind it now names the same agent.
    expect(within(panel).getByText("Claude Code")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Model/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Permissions/ })).toBeTruthy();
  });

  it("gives the panel's head and rows a 44px target on a coarse pointer", async () => {
    // The iPad shape: ≥768px wide, so the panel, and still a thumb. The shared
    // Button ships a `sm:` zero-floor variant, and it would collapse every row
    // at this width unless the touch floor is stated with `!`.
    setWideScreen(true, true);
    setup();
    const panel = await openSheet();
    const close = within(panel).getByRole("button", { name: "Close" });
    expect(close.className).toContain("h-11");
    expect(close.className).toContain("w-11");
    for (const trigger of panel.querySelectorAll<HTMLElement>("[data-run-config-trigger]")) {
      expect(trigger.className).toContain("min-h-11!");
    }
  });

  it("keeps the close control a quiet Button with the close name", async () => {
    setup();
    const panel = await openSheet();
    const close = within(panel).getByRole("button", { name: "Close" });
    expect(close.className).toContain("kin-btn");
    expect(close.className).not.toContain("kin-btn-primary");
    expect(close.getAttribute("aria-label")).toBe("Close");
  });

  it("picks a model and keeps the panel open behind the choice", async () => {
    const { onModelChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Opus/ }));

    expect(onModelChange).toHaveBeenCalledWith("opus");
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
  });

  it("opens the model catalog downward, where the panel has room for it", async () => {
    // The Mac panel hangs near the top of the window: the row sits ~170px
    // from the top edge, less than half the 360px band the catalog needs.
    // The menu follows the container, so it uses the page below the row
    // instead of squeezing a hundred models into the strip above it.
    setup({ models: MANY_MODELS, model: "m0" });
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    const rect = {
      top: 171,
      bottom: 196,
      left: 700,
      right: 1060,
      width: 360,
      height: 25,
      x: 700,
      y: 171,
      toJSON: () => ({}),
    } as DOMRect;
    trigger.getBoundingClientRect = () => rect;

    await userEvent.click(trigger);

    const panel = screen
      .getByRole("menu", { name: "Model" })
      .closest<HTMLElement>('[role="dialog"]');
    expect(panel).toBeTruthy();
    // Downward: measured from the top, and no `bottom` on the same element.
    expect(panel!.style.top).not.toBe("");
    expect(panel!.style.bottom).toBe("");
    // The whole 360px band, not the ~150px the top edge would have left.
    expect(Number.parseFloat(panel!.style.maxHeight)).toBe(360);
  });

  it("keeps the panel open when a non-popover extra row layer takes the pointer", async () => {
    setup({ extraRows: <PortaledExtraRow /> });
    const panel = await openSheet();
    await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));

    const layer = screen.getByRole("dialog", { name: "Dispatch" });
    // Portaled out of the panel and not built on `Popover`, so the layer
    // registry cannot see it. Without the panel's pointer reach this press
    // reads as "outside" and unmounts the picker before its click lands.
    expect(panel.contains(layer)).toBe(false);

    fireEvent.pointerDown(within(layer).getByRole("button", { name: "Inside dispatch" }));

    expect(screen.getByRole("dialog", { name: "Run settings" })).toBe(panel);
    expect(screen.getByRole("dialog", { name: "Dispatch" })).toBe(layer);
  });

  it("closes on an outside click without claiming a history entry", async () => {
    setup();
    const push = vi.spyOn(window.history, "pushState");
    await openSheet();
    // A popover is not a navigation layer: it must not put a `kinSheet`
    // entry on the stack the way the phone sheet does.
    expect(
      push.mock.calls.some((call) => Boolean((call[0] as { kinSheet?: string })?.kinSheet)),
    ).toBe(false);

    await userEvent.click(document.body);

    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });

  it("closes on Escape and returns focus to the face", async () => {
    setup();
    await openSheet();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Run settings/ }));
  });

  it("gives Escape to an open row layer even when focus is on the panel header", async () => {
    setup();
    const panel = await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();

    // The layer the reader opened last is the one Escape belongs to, wherever
    // the caret sits. Focus moved to the header, whose handler is outside the
    // option panel's subtree; the shared layer registry still sees the option
    // panel as the topmost one open.
    within(panel).getByRole("button", { name: "Close" }).focus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBe(panel);
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores an Escape that belongs to an IME composition", async () => {
    setup();
    const panel = await openSheet();

    // No preventDefault: the key belongs to the composition the reader is in
    // the middle of typing, so the layer must not read it as a dismissal.
    const notPrevented = fireEvent.keyDown(panel, { key: "Escape", isComposing: true });

    expect(notPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBe(panel);
  });

  it("keeps Tab inside the panel instead of closing it when focus leaves the last control", async () => {
    setup();
    const panel = await openSheet();
    const last = within(panel).getByRole("button", { name: /^Permissions/ });
    last.focus();

    await userEvent.tab();

    // Wraps to the panel's first control instead of walking out to the page,
    // which the old focus-left-the-panel rule read as "close".
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Close" }));
  });
});
