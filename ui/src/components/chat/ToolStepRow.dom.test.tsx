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

  it("shows a finished call's duration", () => {
    const view = render(
      <ToolStepRow tool={step({ durationMs: 12_000 })} index={1} open={false} onToggle={vi.fn()} />,
    );

    expect(view.container.querySelector("[data-tool-duration]")?.textContent).toBe("12s");
  });

  it("omits the duration while the call is running", () => {
    // A number that does not tick would be a lie, even if a stale one arrived.
    const view = render(
      <ToolStepRow
        tool={step({ status: "running", durationMs: 12_000 })}
        index={1}
        open={false}
        onToggle={vi.fn()}
      />,
    );

    expect(view.container.querySelector("[data-tool-duration]")).toBeNull();
  });

  it("an outside path is a marker in the chip and the detail link, not a control", () => {
    const inside = "/work/a.ts";
    const outside = "/elsewhere/b.ts";
    const onOpenPath = vi.fn();
    const editable = (key: string, path: string) => step({ key, summary: path, input: { path } });
    render(
      <>
        <ToolStepRow
          tool={editable("tool-a", inside)}
          index={1}
          open
          onToggle={vi.fn()}
          onOpenPath={onOpenPath}
          canOpenPath={(path) => path.startsWith("/work/")}
        />
        <ToolStepRow
          tool={editable("tool-b", outside)}
          index={2}
          open
          onToggle={vi.fn()}
          onOpenPath={onOpenPath}
          canOpenPath={(path) => path.startsWith("/work/")}
        />
      </>,
    );

    // Inside the checkout both controls are exactly what they were.
    const chip = screen.getByRole("button", { name: shortPath(inside, 28) });
    const link = screen.getByRole("button", {
      name: `${t("workspace.openFile")} · ${shortPath(inside, 48)}`,
    });
    fireEvent.click(chip);
    fireEvent.click(link);
    expect(onOpenPath.mock.calls).toEqual([[inside], [inside]]);

    // Outside it, neither control names the path; the marker stands where each
    // one was, and carries the full path without being a control itself.
    expect(screen.queryByRole("button", { name: shortPath(outside, 28) })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: `${t("workspace.openFile")} · ${shortPath(outside, 48)}`,
      }),
    ).toBeNull();
    const markers = screen.getAllByText(t("workspace.outsideWorkspace"));
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.tagName).not.toBe("BUTTON");
      expect(marker.closest('[role="button"]')).toBeNull();
      expect(marker.getAttribute("title")).toBe(outside);
    }
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
