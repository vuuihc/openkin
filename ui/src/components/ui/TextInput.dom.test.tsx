// @vitest-environment jsdom
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TextInput from "./TextInput";

/**
 * G8: the shared text field every settings form will consume.
 *
 * These are the guarantees the hand-built `<label><span><input>` blocks never
 * had: the visible label is the control's accessible name, the hint and the
 * status message are part of the input's description rather than a sibling
 * sentence a screen reader never reaches, an error is also `aria-invalid`, and
 * `.kin-input` stays on the native input so the stylesheet's visual contract
 * (and the inventory ratchet's count) keeps meaning what it says.
 */

describe("the shared text input", () => {
  it("names the input with its visible label", () => {
    render(<TextInput label="Provider name" value="" onChange={() => {}} />);

    const input = screen.getByLabelText("Provider name");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input).toBe(screen.getByRole("textbox", { name: "Provider name" }));
  });

  it("wires the hint through aria-describedby", () => {
    render(
      <TextInput
        label="Provider name"
        hint="Shown in the provider list"
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Provider name");
    const hint = screen.getByText("Shown in the provider list");
    expect(hint.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(
      screen.getByRole("textbox", { name: "Provider name", description: /provider list/ }),
    ).toBe(input);
  });

  it("announces an error status", () => {
    render(
      <TextInput
        label="Base URL"
        status={{ type: "error", message: "Enter a URL that ends in /v1" }}
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Base URL");
    const message = screen.getByText("Enter a URL that ends in /v1");
    expect(message.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(message.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByRole("textbox", { name: "Base URL", description: /ends in \/v1/ }),
    ).toBe(input);
  });

  it("keeps a warning out of aria-invalid but in the description", () => {
    render(
      <TextInput
        label="Base URL"
        status={{ type: "warning", message: "This host looks unusual" }}
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Base URL");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(
      screen.getByRole("textbox", { name: "Base URL", description: /looks unusual/ }),
    ).toBe(input);
  });

  it("keeps the kin-input contract on the input element", () => {
    render(
      <TextInput
        label="Base URL"
        className="font-mono text-body leading-4"
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Base URL") as HTMLInputElement;
    // The class is the visual contract and the inventory ratchet counts it on
    // the control, not on a wrapper that only looks like the control.
    expect(input.className).toContain("kin-input");
    expect(input.className).toContain("min-h-11");
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("text-body");
  });

  it("lets a compact row replace the default floor, but keeps it for a responsive override", () => {
    const { rerender } = render(
      <TextInput label="Model" className="min-h-9 font-mono" value="" onChange={() => {}} />,
    );

    let input = screen.getByLabelText("Model") as HTMLInputElement;
    // Tailwind emits `.min-h-11` after `.min-h-9`, so concatenating both would
    // leave the compact row at 44px on every screen. The default yields.
    expect(input.className).toContain("min-h-9");
    expect(input.className).not.toContain("min-h-11");

    rerender(
      <TextInput label="Model" className="sm:min-h-0 font-mono" value="" onChange={() => {}} />,
    );
    input = screen.getByLabelText("Model") as HTMLInputElement;
    // A desktop-only override leaves the phone floor in place.
    expect(input.className).toContain("min-h-11");
    expect(input.className).toContain("sm:min-h-0");
  });

  it("focuses through a forwarded ref", async () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} label="Provider name" defaultValue="" />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(screen.getByLabelText("Provider name"));

    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);

    await userEvent.type(ref.current as HTMLInputElement, "Local");
    expect((ref.current as HTMLInputElement).value).toBe("Local");
  });

  it("hides the label without losing the accessible name", () => {
    render(
      <TextInput isLabelHidden label="Role 2 name" value="Review" onChange={() => {}} />,
    );

    const input = screen.getByLabelText("Role 2 name");
    expect(input).toBe(screen.getByRole("textbox", { name: "Role 2 name" }));
    // Visually hidden, still the label element that names the control.
    expect(screen.getByText("Role 2 name").className).toContain("sr-only");
  });
});
