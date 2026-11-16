// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { t } from "../../i18n";
import { shortPath } from "../../lib/paths";
import ToolStepRow from "./ToolStepRow";
import type { ToolStep } from "./transcriptProjection";

/**
 * C4a parity guards for the tool row: the disclosure, the file chip and the
 * detail block's link moved onto the shared facade, and the behaviour they had
 * — what toggles, what does not, and which path each control sends — is what
 * these assert.
 */

const PATH = "src/components/parser.ts";

const step = (overrides: Partial<ToolStep> = {}): ToolStep => ({
  kind: "tool",
  key: "tool-s-2",
  speaker: "kin",
  name: "edit",
  summary: PATH,
  status: "done",
  input: { path: PATH, old_string: "const a = 1;", new_string: "const a = 2;" },
  output: "applied",
  ...overrides,
});

/** The row's own toggle: the one button in the tree that reports a disclosure. */
const toggle = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("button[aria-expanded]") as HTMLButtonElement;

describe("a tool step row", () => {
  it("toggles its details and reports the new state through aria-expanded", () => {
    const onToggle = vi.fn();
    const view = render(<ToolStepRow tool={step()} index={1} open={false} onToggle={onToggle} />);

    expect(toggle(view.container).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle(view.container));
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(<ToolStepRow tool={step()} index={1} open onToggle={onToggle} />);
    expect(toggle(view.container).getAttribute("aria-expanded")).toBe("true");
  });

  it("a row with no detail does not toggle", () => {
    const onToggle = vi.fn();
    const view = render(
      <ToolStepRow
        tool={step({ input: undefined, output: undefined })}
        index={2}
        open={false}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(toggle(view.container));
    expect(onToggle).not.toHaveBeenCalled();
    expect(toggle(view.container).getAttribute("aria-expanded")).toBe("false");
  });

  it("the file chip opens the path without toggling the row", () => {
    const onToggle = vi.fn();
    const onOpenPath = vi.fn();
    render(
      <ToolStepRow
        tool={step()}
        index={1}
        open={false}
        onToggle={onToggle}
        onOpenPath={onOpenPath}
      />,
    );

    const chip = screen.getByRole("button", { name: shortPath(PATH, 28) });
    expect(chip.getAttribute("title")).toBe(PATH);
    fireEvent.click(chip);

    expect(onOpenPath).toHaveBeenCalledWith(PATH);
    // The chip sits inside the row's button; the path must not also fold it.
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("the detail block's open-file control passes the same path", () => {
    const onOpenPath = vi.fn();
    render(<ToolStepRow tool={step()} index={1} open onToggle={vi.fn()} onOpenPath={onOpenPath} />);

    const openFile = screen.getByRole("button", {
      name: `${t("workspace.openFile")} · ${shortPath(PATH, 48)}`,
    });
    expect(openFile.getAttribute("title")).toBe(PATH);
    fireEvent.click(openFile);

    expect(onOpenPath).toHaveBeenCalledWith(PATH);
  });
});
