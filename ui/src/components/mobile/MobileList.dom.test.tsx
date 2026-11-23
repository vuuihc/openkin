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

/**
 * jsdom has no ResizeObserver, and the fix under test is exactly "retry the
 * restore when the content grows". This stand-in records what the body
 * observes and lets a case deliver the growth the browser would.
 */
type ObserverRecord = {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
};
const observers: ObserverRecord[] = [];

class FakeResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }
}

globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

/** The content grows in place — settled row heights, a wrapping status line. */
function grow(rows: number) {
  contentHeight = rows * ROW_HEIGHT;
  for (const observer of observers) {
    // A fixed-height scroll viewport does not resize when its content grows.
    if (![...observer.targets].some((target) => !target.hasAttribute("data-phone-scroll")))
      continue;
    observer.callback([], observer as unknown as ResizeObserver);
  }
}

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

/**
 * `rows` is the content height; `when` is the caller's row-count signal. They
 * are separate because the bug is content that grows after the signal is final.
 */
function mount(rows: number, when: unknown = rows) {
  contentHeight = rows * ROW_HEIGHT;
  scrollTop = 0;
  const view = render(
    <MobileScreen scrollKey="kin.listScroll" scrollWhen={when}>
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
  observers.length = 0;
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

  it("retries the restore when the content grows without the caller's row signal moving", () => {
    // The reader leaves a tall list at SAVED.
    const first = mount(10);
    first.body.scrollTop = SAVED;
    fireEvent.scroll(first.body);
    first.view.unmount();
    expect(stored()).toBe(String(SAVED));

    // Coming back, the rows are known but their heights are not: the content
    // is short, the restore clamps to the top, and `scrollWhen` is already the
    // final row count — it will never move again on this visit.
    const second = mount(2, 10);
    expect(second.body.scrollTop).toBe(0);

    // The rows settle at their real heights: the content grows, the caller's
    // signal does not. The restore has to be retried against the new height.
    grow(10);
    expect(second.body.scrollTop).toBe(SAVED);

    // Reaching the mark consumes the restore, even if more content arrives.
    second.body.scrollTop = 80;
    fireEvent.scroll(second.body);
    grow(12);
    expect(second.body.scrollTop).toBe(80);
    second.view.unmount();
  });

  it("does not move a reader who scrolled after a clamped restore", () => {
    const first = mount(10);
    first.body.scrollTop = SAVED;
    fireEvent.scroll(first.body);
    first.view.unmount();

    // The clamped restore leaves the reader at the top of a short list.
    const second = mount(2, 10);
    expect(second.body.scrollTop).toBe(0);

    // The reader takes the list: a touch while it is still settling means they
    // have chosen where to be, so a later growth must not yank them back.
    fireEvent.pointerDown(second.body);

    grow(10);
    expect(second.body.scrollTop).toBe(0);
    second.view.unmount();
    // A touch that never scrolled is not a new position to remember.
    expect(stored()).toBe(String(SAVED));
  });
});
