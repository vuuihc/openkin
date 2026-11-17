// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LOCALE, setLocale } from "../../i18n";
import { overlayOwnsKeyboard } from "../../lib/overlayOwnsKeyboard";
import type { WorkspaceGeneration } from "../../api/client";
import WorkspaceGenerationPicker from "./WorkspaceGenerationPicker";
import pickerSource from "./WorkspaceGenerationPicker.tsx?raw";

/**
 * The generation trigger names the workspace the viewer is showing. Its
 * children are elements (a label and a lifecycle badge), so the facade cannot
 * derive an accessible name from them: the trigger has to carry the name
 * explicitly or it ships as an unnamed button.
 *
 * The rows are the console's shared menu, not a private copy of the layer: one
 * `menuitemradio` per choice, arrows and Escape from the facade, focus moving
 * into the panel and back to the chip, and an open panel that owns the
 * keyboard (TASTE 16) so j/k and ⌘F stop acting on the conversation behind it.
 */

function generation(overrides: Partial<WorkspaceGeneration> = {}): WorkspaceGeneration {
  return {
    id: "g2",
    task_id: "task-1",
    generation: 2,
    state: "active",
    source_root: "/work",
    scope: "all",
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

const trigger = (name = "Workspace 2") => screen.getByRole("button", { name });

beforeEach(() => {
  setLocale("en");
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe("the generation picker's trigger", () => {
  it("names the generation trigger and puts it on the facade", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId="g2"
        onChange={onChange}
      />,
    );

    const chip = trigger();
    expect(chip.getAttribute("aria-label")).toBe("Workspace 2");
    expect(chip.textContent).toContain("Workspace 2");
    expect(chip.className).toContain("kin-btn");
    expect(chip.className).toContain("kin-btn-secondary");
    // Astryx's label span is the row: label, badge and chevron share one line
    // (jsdom has no layout, so the class is the pin).
    expect(chip.className).toContain("[&>span>span]:flex");
    expect(chip.className).toContain("[&>span>span]:items-center");

    await user.click(chip);
    // The option rows keep their own row shape; selecting one is unchanged.
    const option = screen.getByRole("menuitemradio", { name: /Workspace 2\s*active/ });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith("g2");
  });
});

describe("the generation picker's menu", () => {
  it("opens the shared menu with the current generation checked", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId="g2"
        onChange={vi.fn()}
      />,
    );

    await user.click(trigger());

    // Named after the control that opened it, not after the row set.
    expect(screen.getByRole("menu", { name: "Workspace 2" })).toBeTruthy();

    const current = screen.getByRole("menuitemradio", { name: /Workspace 2\s*active/i });
    expect(current.getAttribute("aria-checked")).toBe("true");

    // The state stays in the row's own text, so a reader hears the consequence
    // as they move through the choices.
    const source = screen.getByRole("menuitemradio", { name: /Current project\s*read-only/i });
    expect(source.getAttribute("aria-checked")).toBe("false");
  });

  it("starts on the checked row and moves with the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceGenerationPicker
        generations={[
          generation({ id: "g1", generation: 1, state: "integrated" }),
          generation(),
        ]}
        loading={false}
        selectedId="g2"
        onChange={vi.fn()}
      />,
    );

    await user.click(trigger());

    const checked = screen.getByRole("menuitemradio", { name: /Workspace 2/i });
    await waitFor(() => expect(document.activeElement).toBe(checked));

    // Down from the last row wraps to the source row at the top.
    await user.keyboard("{ArrowDown}");
    const source = screen.getByRole("menuitemradio", { name: /Current project/i });
    expect(document.activeElement).toBe(source);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(checked);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(source);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId="g2"
        onChange={vi.fn()}
      />,
    );

    const chip = trigger();
    await user.click(chip);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitemradio", { name: /Workspace 2\s*active/i }),
      ),
    );

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("chooses a generation and the source row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId="g2"
        onChange={onChange}
      />,
    );

    const chip = trigger();
    await user.click(chip);
    await user.click(screen.getByRole("menuitemradio", { name: /Workspace 2\s*active/i }));

    expect(onChange).toHaveBeenCalledWith("g2");
    expect(screen.queryByRole("menu")).toBeNull();
    // The row that had focus unmounted: without the return the next Tab would
    // start from the top of the page.
    expect(document.activeElement).toBe(chip);

    rerender(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId={null}
        onChange={onChange}
      />,
    );

    await user.click(chip);
    const source = screen.getByRole("menuitemradio", { name: /Current project\s*read-only/i });
    expect(source.getAttribute("aria-checked")).toBe("true");

    await user.click(source);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("does not hand-roll the menu layer", () => {
    // The rows, the portal, dismissal and focus return belong to the shared
    // layer; a private copy is what this migration removed.
    expect(pickerSource).not.toContain("<button");
    expect(pickerSource).not.toContain("z-50");
    expect(pickerSource).not.toContain('addEventListener("mousedown"');
    expect(pickerSource).toContain("<Menu");
  });

  it("an open generation menu owns the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId="g2"
        onChange={vi.fn()}
      />,
    );

    expect(overlayOwnsKeyboard()).toBe(false);

    await user.click(trigger());
    expect(overlayOwnsKeyboard()).toBe(true);

    await user.keyboard("{Escape}");
    expect(overlayOwnsKeyboard()).toBe(false);
  });
});
