// @vitest-environment jsdom
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { panelOpenCount } from "../../lib/panelPresence";
import PanelSurface from "./PanelSurface";

/**
 * A panel registers itself as the screen's topmost surface only while it is
 * painted. The floating approval subscribes to this count, so the two ways it
 * can be wrong are both pinned here: a panel that is mounted but hidden must
 * not suppress the card (the terminal holds a live PTY behind `hidden`), and
 * the register/release pair must survive StrictMode's double-invoked effects
 * without drifting off zero.
 */
describe("PanelSurface presence", () => {
  it("a mounted panel registers; unmounting it clears the count", () => {
    const { unmount } = render(<PanelSurface label="Files">body</PanelSurface>);
    expect(panelOpenCount()).toBe(1);

    unmount();
    expect(panelOpenCount()).toBe(0);
  });

  it("a hidden panel does not register", () => {
    const { rerender } = render(
      <PanelSurface label="Terminal" hidden>
        body
      </PanelSurface>,
    );
    expect(panelOpenCount()).toBe(0);

    rerender(
      <PanelSurface label="Terminal" hidden={false}>
        body
      </PanelSurface>,
    );
    expect(panelOpenCount()).toBe(1);

    // …and it releases again when the reader closes it, which is a `hidden`
    // flip rather than an unmount.
    rerender(
      <PanelSurface label="Terminal" hidden>
        body
      </PanelSurface>,
    );
    expect(panelOpenCount()).toBe(0);
  });

  it("StrictMode double-mount balances back to zero", () => {
    // Dev-mode StrictMode runs the effect, its cleanup, then the effect again.
    // An unpaired register would leave the count at 1 with no panel open, and
    // the floating approval would never show its decision card on that screen.
    const { unmount } = render(
      <StrictMode>
        <PanelSurface label="Files">body</PanelSurface>
      </StrictMode>,
    );
    expect(panelOpenCount()).toBe(1);

    unmount();
    expect(panelOpenCount()).toBe(0);
  });
});
