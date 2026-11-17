// @vitest-environment jsdom
import { createRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TextArea from "./TextArea";

/**
 * The multi-line sibling of `TextInput`: the same name/hint/status contract,
 * without the single-line height floor.
 *
 * These are the guarantees the settings surfaces hand-wired three times: the
 * label is the textarea's accessible name, the hint and the status message are
 * part of its description, an error is also `aria-invalid`, and `.kin-input`
 * stays on the native control while `rows` and the caller's own height class
 * keep owning the box.
 */

describe("the shared text area", () => {
  it("names the textarea with its visible label", () => {
    render(<TextArea label="Role prompt" value="" onChange={() => {}} />);

    const field = screen.getByLabelText("Role prompt");
    expect(field).toBeInstanceOf(HTMLTextAreaElement);
    expect(field).toBe(screen.getByRole("textbox", { name: "Role prompt" }));
  });

  it("hides the label visually without losing the name", () => {
    render(<TextArea isLabelHidden label="Role prompt" value="" onChange={() => {}} />);

    const field = screen.getByLabelText("Role prompt");
    expect(field).toBe(screen.getByRole("textbox", { name: "Role prompt" }));
    // Visually hidden, still the label element that names the control.
    expect(screen.getByText("Role prompt").className).toContain("sr-only");
  });

  it("merges the caller's aria-describedby before hint and status", () => {
    render(
      <TextArea
        id="notes"
        aria-describedby="page-error"
        label="Release notes"
        hint="Markdown is allowed"
        status={{ type: "error", message: "Too long" }}
        value=""
        onChange={() => {}}
      />,
    );

    const field = screen.getByLabelText("Release notes");
    // The caller's id names the textarea, and the ids derived from it follow it.
    expect(field.id).toBe("notes");
    // Order is the contract: the caller's own description first, then the hint
    // and the status the field appends, so a reader hears them in that order.
    expect(field.getAttribute("aria-describedby")).toBe("page-error notes-hint notes-status");
  });

  it("marks an error invalid and leaves a warning valid", () => {
    const { rerender } = render(
      <TextArea
        label="Release notes"
        status={{ type: "error", message: "Enter at least one line" }}
        value=""
        onChange={() => {}}
      />,
    );

    let field = screen.getByLabelText("Release notes");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter at least one line").className).toContain("text-kin-red-ink");

    rerender(
      <TextArea
        label="Release notes"
        status={{ type: "warning", message: "This looks long" }}
        value=""
        onChange={() => {}}
      />,
    );

    field = screen.getByLabelText("Release notes");
    expect(field.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.getByText("This looks long").className).toContain("text-kin-orange-ink");
  });

  it("keeps kin-input and adds no height floor", () => {
    render(
      <TextArea label="Price table" className="min-h-40 font-mono" value="" onChange={() => {}} />,
    );

    const field = screen.getByLabelText("Price table") as HTMLTextAreaElement;
    // The class is the visual contract and the inventory ratchet counts it on
    // the control. A multi-line field's height is `rows` plus the caller's
    // class; the single-line 44px floor must not leak onto it.
    expect(field.className).toContain("kin-input");
    expect(field.className).toContain("min-h-40");
    expect(field.className).toContain("font-mono");
    expect(field.className).not.toContain("min-h-11");
  });

  it("passes rows, value and onChange through", async () => {
    function Controlled() {
      const [value, setValue] = useState("");
      return (
        <TextArea
          label="Release notes"
          rows={4}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }

    render(<Controlled />);
    const field = screen.getByLabelText("Release notes") as HTMLTextAreaElement;
    expect(field.rows).toBe(4);

    await userEvent.type(field, "Two lines");
    expect(field.value).toBe("Two lines");
  });

  it("focuses through a forwarded ref", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} label="Role prompt" defaultValue="" />);

    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current).toBe(screen.getByLabelText("Role prompt"));

    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });
});
