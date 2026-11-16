// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { MobileScreen } from "./MobileList";

/**
 * The keyed scroll body remembers where the reader was.
 *
 * This is the "离开再回来" half of KIN-CONTINUE-002, and it is already built:
 * the body writes its `scrollTop` to sessionStorage on scroll and unmount, and
 * restores it when a remount asks for the same key. jsdom has no layout, so
 * this test supplies the three numbers the browser would (content height,
 * viewport height, and a `scrollTop` that clamps) and then pins the behaviour
 * the comment in `MobileList.tsx` promises.
 *
 * The important case is the third mount: a short list clamps the restore to 0,
 * and that clamped zero must **not** overwrite the place the reader actually
 * left. Otherwise the retry on the next tall render would restore nothing.
 */

const ROW_HEIGHT = 60;
const VIEWPORT = 200;
const SAVED = 240;

let contentHeight = 0;
let scrollTop = 0;

Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get: () => contentHeight,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => VIEWPORT,
});
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get: () => scrollTop,
  set: (value: number) => {
    scrollTop = Math.max(0, Math.min(value, Math.max(0, contentHeight - VIEWPORT)));
  },
});

function mount(rows: number) {
  contentHeight = rows * ROW_HEIGHT;
  scrollTop = 0;
  const view = render(
    <MobileScreen scrollKey="kin.listScroll" scrollWhen={rows}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} style={{ height: ROW_HEIGHT }}>
          row {index}
        </div>
      ))}
    </MobileScreen>,
  );
  const body = view.container.querySelector<HTMLElement>("[data-phone-scroll]");
  if (!body) throw new Error("the keyed scroll body is not mounted");
  return { view, body };
}

function stored(): string | null {
  return sessionStorage.getItem("kin.listScroll");
}

beforeEach(() => {
  sessionStorage.clear();
  contentHeight = 0;
  scrollTop = 0;
});

describe("the keyed scroll body", () => {
  it("restores the scroll position of a keyed screen after a remount", () => {
    // A tall list: the reader scrolls down and leaves.
    const first = mount(10);
    first.body.scrollTop = SAVED;
    fireEvent.scroll(first.body);
    first.view.unmount();
    expect(stored()).toBe(String(SAVED));

    // Coming back to the same key restores the place.
    const second = mount(10);
    expect(second.body.scrollTop).toBe(SAVED);
    second.view.unmount();

    // A short list cannot reach the mark. The restore clamps to 0, and the
    // clamped value must not be written back.
    const short = mount(2);
    expect(short.body.scrollTop).toBe(0);
    short.view.unmount();
    expect(stored()).toBe(String(SAVED));

    // The mark survived the short visit: the tall list still restores it.
    const third = mount(10);
    expect(third.body.scrollTop).toBe(SAVED);
    third.view.unmount();
  });
});
