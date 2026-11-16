// @vitest-environment jsdom
import { createRef, type FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Button from "./Button";

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
