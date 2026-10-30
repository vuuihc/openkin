// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SwipeReveal from "./SwipeReveal";
import SessionRowActions, { SESSION_ROW_ACTIONS_WIDTH } from "./SessionRowActions";

/**
 * The reveal is sized by the actions a row actually carries. A strip wider
 * than the slide leaves its last chip under the row's own opaque cover —
 * mounted, clickable in the DOM, and invisible. The slide and the strip come
 * from one number, and that number has to equal the chips it uncovers, so
 * this measures the real chips rather than trusting the constant.
 */
describe("SwipeReveal width", () => {
  it("slides the cover exactly as far as the actions it uncovers are wide", () => {
    const { container } = render(
      <SwipeReveal
        open
        onOpenChange={() => {}}
        width={SESSION_ROW_ACTIONS_WIDTH}
        actions={<SessionRowActions onPin={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />}
      >
        <span>row</span>
      </SwipeReveal>,
    );

    const chips = screen.getAllByRole("button");
    const measured = chips.reduce(
      (sum, chip) => sum + parseFloat((chip as HTMLElement).style.width),
      0,
    );
    expect(chips).toHaveLength(3);
    expect(measured).toBe(SESSION_ROW_ACTIONS_WIDTH);
    expect(parseFloat(chips[0].parentElement!.style.width)).toBe(measured);

    // The last child is the opaque cover the row sits on.
    const cover = container.firstElementChild?.lastElementChild as HTMLElement;
    expect(cover.style.transform).toBe(`translateX(-${measured}px)`);
  });

  it("leaves a closed row where it was", () => {
    const { container } = render(
      <SwipeReveal
        open={false}
        onOpenChange={() => {}}
        width={SESSION_ROW_ACTIONS_WIDTH}
        actions={null}
      >
        <span>row</span>
      </SwipeReveal>,
    );
    const cover = container.firstElementChild?.lastElementChild as HTMLElement;
    expect(cover.style.transform).toBe("translateX(0px)");
  });
});
