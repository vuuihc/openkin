// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Field from "./Field";

/**
 * The shared field chrome for controls that are not `TextInput`/`Textarea`
 * (a picker, a composed row). It owns exactly three things: the label is tied
 * to the control id, the hint and the error are part of the control's
 * description, and an error marks the control invalid. It adds no second
 * label or description of its own — the child control stays the single source
 * of its visible content.
 */

function describedText(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("the shared field", () => {
  it("renders a label, hint and error with matching ids", () => {
    render(
      <Field id="email" label="Email" hint="We never share it." error="Enter a work email.">
        <input id="email" />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: /Email/ });
    const hint = screen.getByText("We never share it.");
    const error = screen.getByText("Enter a work email.");

    expect(input.getAttribute("aria-describedby")).toContain(hint.id);
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("does not render an error message when there is no error", () => {
    render(
      <Field id="email" label="Email" hint="We never share it.">
        <input id="email" />
      </Field>,
    );

    expect(screen.queryByText("Enter a work email.")).toBeNull();
    expect(screen.getByText("We never share it.")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("the label points at the control id and the hint is part of the description", () => {
    render(
      <Field id="email" label="Email" hint="We never share it.">
        <input id="email" />
      </Field>,
    );

    // Astryx may put the text in a span inside the label; what matters is the
    // label element the control is named by.
    const label = screen.getByText("Email").closest("label");
    expect(label).not.toBeNull();
    expect(label?.getAttribute("for")).toBe("email");

    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(describedText(input)).toContain("We never share it.");
  });
});
