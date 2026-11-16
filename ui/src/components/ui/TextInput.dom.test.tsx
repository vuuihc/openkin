// @vitest-environment jsdom
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import TextInput from "./TextInput";

/**
 * The shared single-line field.
 *
 * The contract is the label and the description, not the styling: a visible
 * label names the control, the hint and the error are part of its accessible
 * description, and an error marks the control invalid for assistive tech as
 * well as for the eye. The Enter guard is the console's shared one — the same
 * `isImeKeyEvent` the Composer uses — because a half-typed Chinese word must
 * never look like a finished one.
 */

const noop = vi.fn();

/** The text of every element the control points at through aria-describedby. */
function describedText(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("the shared text input", () => {
  it("labels the input and wires the hint through aria-describedby", () => {
    render(<TextInput label="Email" hint="We never share it." value="" onChange={noop} />);

    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(describedText(input)).toContain("We never share it.");
  });

  it("an error marks the control invalid and is described by the error text", () => {
    render(
      <TextInput
        label="Email"
        hint="We never share it."
        error="Enter a work email."
        value=""
        onChange={noop}
      />,
    );

    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(input)).toContain("Enter a work email.");
  });

  it("required and disabled reach the native input", () => {
    render(<TextInput label="Email" required disabled value="" onChange={noop} />);

    // Not queried by name: a required marker may be part of the visible label.
    const input = screen.getByRole("textbox");
    expect(input.hasAttribute("required")).toBe(true);
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  it("Enter calls onEnter once, but an IME composition does not", () => {
    const onEnter = vi.fn();
    render(<TextInput label="Search" value="" onChange={noop} onEnter={onEnter} />);

    const input = screen.getByRole("textbox", { name: /Search/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);

    // The standard signal, and the 229 sentinel an IME sends before the
    // composing flag flips.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("forwards the ref and native input props (name, autoComplete, inputMode)", () => {
    const ref = createRef<HTMLInputElement>();
    render(
      <TextInput
        ref={ref}
        label="Email"
        value=""
        onChange={noop}
        name="email"
        autoComplete="email"
        inputMode="email"
      />,
    );

    const input = screen.getByRole("textbox");
    expect(ref.current).toBe(input);
    expect(input.getAttribute("name")).toBe("email");
    expect(input.getAttribute("autocomplete")).toBe("email");
    expect(input.getAttribute("inputmode")).toBe("email");
  });
});
