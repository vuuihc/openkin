// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileHeaderButton } from "./MobileHeader";

/**
 * The header control's state dot.
 *
 * It is decoration over a control whose whole meaning is in its `label`, so the
 * two things worth pinning are that it draws in the right colour and that it
 * does not change what the control is called.
 */
describe("MobileHeaderButton's dot", () => {
  const dot = (el: HTMLElement) => el.querySelector('[aria-hidden="true"]');

  it("draws nothing when there is nothing to say", () => {
    render(
      <MobileHeaderButton label="Sessions">
        <span />
      </MobileHeaderButton>,
    );
    expect(dot(screen.getByRole("button", { name: "Sessions" }))).toBeNull();
  });

  it("draws a waiting dot in the same colour the sheet uses", () => {
    render(
      <MobileHeaderButton label="Sessions" dot="waiting">
        <span />
      </MobileHeaderButton>,
    );
    expect(dot(screen.getByRole("button", { name: "Sessions" }))?.className).toContain(
      "bg-kin-orange",
    );
  });

  it("draws an unread dot in the sheet's green", () => {
    render(
      <MobileHeaderButton label="Sessions" dot="unread">
        <span />
      </MobileHeaderButton>,
    );
    expect(dot(screen.getByRole("button", { name: "Sessions" }))?.className).toContain(
      "bg-kin-green",
    );
  });

  it("leaves the control's name exactly the label", () => {
    // The dot is hidden from the accessibility tree; the call site is what puts
    // the state into the label, and that is a separate assertion
    // (`switcherWiring.test.ts`).
    render(
      <MobileHeaderButton label="Sessions" dot="waiting">
        <span />
      </MobileHeaderButton>,
    );
    expect(screen.getByRole("button", { name: "Sessions" })).toBeTruthy();
  });
});
