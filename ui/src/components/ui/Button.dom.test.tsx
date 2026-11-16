// @vitest-environment jsdom
import { createRef, type FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Button, { type ButtonVariant } from "./Button";

/**
 * Q3a: the shared action button the Composer migration will consume.
 *
 * These are native-button guarantees, not styling details: a ref reaches the
 * element, `disabled` is the platform's own disabled state, the accessible
 * name is the caller's, both quiet and default variants stay in the tab order
 * with the console's focus token, and the default `type` cannot submit a form
 * the button happens to sit inside.
 */

describe("the shared button", () => {
  it("forwards ref and preserves native disabled and accessible-name behavior", async () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <Button ref={ref} aria-label="Stop the run" disabled onClick={onClick}>
        Stop
      </Button>,
    );

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    const button = screen.getByRole("button", { name: "Stop the run" });
    expect(button).toBe(ref.current);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Stop the run");

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps quiet and default variants keyboard-focusable with token-based focus styles", async () => {
    render(
      <>
        <Button>Send</Button>
        <Button variant="quiet">Attach</Button>
      </>,
    );

    const primary = screen.getByRole("button", { name: "Send" });
    const quiet = screen.getByRole("button", { name: "Attach" });

    await userEvent.tab();
    expect(document.activeElement).toBe(primary);
    await userEvent.tab();
    expect(document.activeElement).toBe(quiet);

    for (const button of [primary, quiet]) {
      // The base class carries the control's floor and the focus answer; the
      // explicit outline utilities keep the token visible to anyone reading
      // the component rather than only to the generated stylesheet.
      expect(button.className).toContain("kin-btn");
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("focus-visible:outline-kin-focus-ring");
    }
    expect(primary.className).toContain("kin-btn-primary");
    expect(quiet.className).not.toContain("kin-btn-primary");
  });

  it("loading marks the button busy and keeps its accessible name", () => {
    render(<Button isLoading>Saving changes…</Button>);

    const button = screen.getByRole("button", { name: "Saving changes…" });
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("the approve and deny variants keep the kin-btn-approve and kin-btn-deny classes", () => {
    // `FloatingApproval` finds the button that should take focus after a
    // decision with these exact selectors, so the class is part of the
    // variant's contract, not a styling detail.
    render(
      <>
        <Button variant="approve">Approve</Button>
        <Button variant="deny">Deny</Button>
      </>,
    );

    const approve = screen.getByRole("button", { name: "Approve" });
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(approve.className).toContain("kin-btn-approve");
    expect(deny.className).toContain("kin-btn-deny");
    expect(approve.className).toContain("kin-btn");
    expect(deny.className).toContain("kin-btn");
  });

  it("every variant keeps one accessible name, type=button and the disabled attribute", () => {
    const variants: ButtonVariant[] = ["default", "secondary", "quiet", "approve", "deny"];
    render(
      <>
        {variants.map((variant) => (
          <Button key={variant} variant={variant} disabled aria-label={`${variant} action`}>
            {variant}
          </Button>
        ))}
      </>,
    );

    expect(screen.getAllByRole("button")).toHaveLength(variants.length);
    for (const variant of variants) {
      // getByRole throws when a name matches more than one control, so this is
      // also the assertion that each variant has exactly one accessible name.
      const button = screen.getByRole("button", {
        name: `${variant} action`,
      }) as HTMLButtonElement;
      expect(button.getAttribute("type")).toBe("button");
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("aria-label")).toBe(`${variant} action`);
    }
  });

  it("does not submit a surrounding form unless type is explicitly submit", async () => {
    const submit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const { rerender } = render(
      <form onSubmit={submit}>
        <Button>Save</Button>
      </form>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).not.toHaveBeenCalled();

    rerender(
      <form onSubmit={submit}>
        <Button type="submit">Save</Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
