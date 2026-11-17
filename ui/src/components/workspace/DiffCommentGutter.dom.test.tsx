// @vitest-environment jsdom
// KIN-RESULT-003 — the comment box that opens under the diff when a changed
// line is pointed at. Tested directly: Monaco is not involved here.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { t } from "../../i18n";
import { AstryxProvider } from "../../design/AstryxProvider";
import DiffCommentGutter from "./DiffCommentGutter";

const ANCHOR = {
  path: "src/settings.ts",
  hunkHeader: "@@ -10,3 +10,4 @@",
  quote: "const title = settings.title;",
  line: 11,
};

function renderBox(initialDraft?: string) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const returnFocus = vi.fn();
  const view = render(
    <AstryxProvider>
      {/* A stand-in for the diff surface the box hands focus back to. */}
      <div data-testid="diff-surface" tabIndex={-1} />
      <DiffCommentGutter
        anchor={ANCHOR}
        initialDraft={initialDraft}
        onSave={onSave}
        onCancel={onCancel}
        returnFocus={returnFocus}
      />
    </AstryxProvider>,
  );
  const textarea = screen.getByLabelText(t("workspace.comments.fieldLabel")) as HTMLTextAreaElement;
  return { onSave, onCancel, returnFocus, textarea, view };
}

describe("the diff comment box", () => {
  it("shows the file, hunk header and quoted line for the line being commented", () => {
    const { textarea } = renderBox();

    expect(screen.getByText("src/settings.ts:11")).toBeTruthy();
    expect(screen.getByText("@@ -10,3 +10,4 @@")).toBeTruthy();
    expect(screen.getByText("const title = settings.title;")).toBeTruthy();
    // Opening the box is opening the keyboard flow: the field already has focus.
    expect(document.activeElement).toBe(textarea);
  });

  it("refuses to save whitespace and says why", () => {
    const { onSave, textarea } = renderBox();

    fireEvent.change(textarea, { target: { value: "   \n\t " } });
    fireEvent.click(screen.getByRole("button", { name: t("workspace.comments.save") }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(t("workspace.comments.empty"))).toBeTruthy();
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });

  it("saves a comment and returns focus to the diff", () => {
    const { onSave, returnFocus, textarea } = renderBox();

    fireEvent.change(textarea, { target: { value: "  Use the default title here.  " } });
    fireEvent.click(screen.getByRole("button", { name: t("workspace.comments.save") }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Use the default title here.");
    expect(returnFocus).toHaveBeenCalledTimes(1);
  });

  it("saves with the keyboard, and keeps what was typed when Esc cancels", () => {
    const { onSave, onCancel, returnFocus, textarea, view } = renderBox();

    fireEvent.change(textarea, { target: { value: "This line is wrong." } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSave).toHaveBeenCalledWith("This line is wrong.");
    expect(returnFocus).toHaveBeenCalledTimes(1);

    // Esc reports the draft upwards instead of discarding it, so reopening the
    // same line's box (the parent's retained draft) still has the words.
    fireEvent.change(textarea, { target: { value: "Second thoughts." } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith("Second thoughts.");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(t("workspace.comments.save"))).toBeTruthy();

    view.rerender(
      <AstryxProvider>
        <DiffCommentGutter
          anchor={ANCHOR}
          initialDraft="Second thoughts."
          onSave={onSave}
          onCancel={onCancel}
          returnFocus={returnFocus}
        />
      </AstryxProvider>,
    );
    expect(
      (screen.getByLabelText(t("workspace.comments.fieldLabel")) as HTMLTextAreaElement).value,
    ).toBe("Second thoughts.");
  });
});
