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
function screen(rows: number, when: unknown = rows) {
  return (
    <MobileScreen scrollKey="kin.listScroll" scrollWhen={when}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} style={{ height: ROW_HEIGHT }}>
          row {index}
        </div>
      ))}
    </MobileScreen>
  );
}

function mount(rows: number, when: unknown = rows) {
  contentHeight = rows * ROW_HEIGHT;
  scrollTop = 0;
  const view = render(screen(rows, when));
  const body = view.container.querySelector<HTMLElement>("[data-phone-scroll]");
  if (!body) throw new Error("the keyed scroll body is not mounted");
  return { view, body };
}

/**
 * The browser's own clamp on a body whose content collapsed under the offset:
 * the position snaps to the top and a scroll event reports it. This is what a
 * kept-alive list sees when it is hidden behind a pushed conversation, and
 * what the search list saw when its transient loading skeleton was replaced by
 * the real rows (probe7: `"345"` → `"0"` with no reader input).
 */
function collapse(body: HTMLElement) {
  contentHeight = 0;
  scrollTop = 0;
  fireEvent.scroll(body);
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

  it("keeps the reader's place when the container is clamped before the unmount", () => {
    const first = mount(10);
    first.body.scrollTop = SAVED;
    fireEvent.scroll(first.body);

    // A route change detaches the container before the passive cleanup runs, so
    // the offset is gone without a scroll event: the node reports the clamp (0)
    // by the time the unmount write would read it.
    scrollTop = 0;

    first.view.unmount();
    // The unmount must record what the reader scrolled to, not what the node
    // says after the route change already collapsed it.
    expect(stored()).toBe(String(SAVED));
  });

  it("records a scroll that landed inside the throttle window when the list unmounts", () => {
    const first = mount(10);
    // The first scroll opens the throttle window at the top of the list.
    fireEvent.scroll(first.body);
    first.body.scrollTop = 300;
    // The second one lands inside the 300 ms window, so storage still holds the
    // first value and only the cleanup can record where the reader stopped.
    fireEvent.scroll(first.body);
    expect(stored()).not.toBe("300");

    scrollTop = 0;
    first.view.unmount();
    expect(stored()).toBe("300");
  });

  /**
   * KIN-CONTINUE-004: the search-state path. The three cases below are the
   * paths LESSONS.md requires a list-restore change to enumerate — a
   * kept-alive body, browser Back with late rows, and the pushed
   * conversation's 返回 control — and each one failed before the fix with the
   * shared key rewritten to "0".
   */
  it("KIN-CONTINUE-004 a search-state list never lets a hidden or collapsed body write its clamp into the scroll key", () => {
    // The search list is up with the reader's place restored (the instance a
    // kept-alive shell leaves mounted behind the pushed conversation).
    const first = mount(10);
    first.body.scrollTop = 345;
    fireEvent.scroll(first.body);
    first.view.unmount();
    expect(stored()).toBe("345");

    const kept = mount(10);
    expect(kept.body.scrollTop).toBe(345);
    // The reader taps a result: the touch yields the body but is not a scroll,
    // and the tap is over (pointerup) before the push collapses the list.
    fireEvent.pointerDown(kept.body);
    fireEvent.pointerUp(kept.body);

    // The list is hidden behind the conversation and its content collapses;
    // the browser clamps the offset and fires a scroll event at the top.
    collapse(kept.body);
    // The clamp is not a position the reader chose: the remembered mark must
    // survive it, or the next visit starts at the top.
    expect(stored()).toBe("345");

    // The rows are back: the restore must still reach the mark.
    grow(10);
    expect(kept.body.scrollTop).toBe(345);
    kept.view.unmount();
    expect(stored()).toBe("345");
  });

  it("KIN-CONTINUE-004 a search-state list restores a nonzero offset across browser Back when the rows land late", () => {
    // The reader leaves the search list at 345, then the conversation is opened
    // and browser Back returns to the same query.
    const first = mount(10);
    first.body.scrollTop = 345;
    fireEvent.scroll(first.body);
    first.view.unmount();
    expect(stored()).toBe("345");

    // Back: the mount is empty and still loading, so the caller's row signal
    // is -1 and the restore cannot reach 345 yet (probe7 t=0).
    const back = mount(0, -1);
    expect(back.body.scrollTop).toBe(0);

    // The transient loading skeleton is tall enough for the clamped restore to
    // look reachable for a moment...
    grow(10);
    expect(back.body.scrollTop).toBe(345);

    // ...then it is replaced by the real rows: the content collapses under the
    // offset and the browser fires a scroll event at the top. The key must not
    // take that clamp; this is the write probe7 caught at t=50.
    collapse(back.body);
    expect(stored()).toBe("345");

    // The rows land, and the caller's signal moves off -1 in the same visit.
    back.view.rerender(screen(14, 14));
    grow(14);
    expect(back.body.scrollTop).toBe(345);
    expect(stored()).toBe("345");
    back.view.unmount();
    expect(stored()).toBe("345");
  });

  it("KIN-CONTINUE-004 a search-state list restores across the pushed conversation's 返回 control", () => {
    // The in-app return path starts with the reader's tap on the result row
    // (a pointerdown on the departing surface) and unmounts the list.
    const first = mount(10);
    first.body.scrollTop = 345;
    fireEvent.scroll(first.body);
    fireEvent.pointerDown(first.body);
    fireEvent.pointerUp(first.body);
    first.view.unmount();
    expect(stored()).toBe("345");

    // 返回 pops back to the same query; the empty mount clamps, the skeleton
    // settles the restore, and the swap fires the clamp scroll event.
    const back = mount(0, -1);
    grow(10);
    collapse(back.body);
    expect(stored()).toBe("345");

    // The rows land after the swap; the list must return to the mark.
    back.view.rerender(screen(10, 10));
    grow(10);
    expect(back.body.scrollTop).toBe(345);
    expect(stored()).toBe("345");
    back.view.unmount();
    expect(stored()).toBe("345");
  });

  it("KIN-CONTINUE-004 a reader's own wheel to the top still wins over the remembered mark", () => {
    // The guard above must not swallow a position the reader really chose:
    // wheel to the top after a restore, and the top is what is remembered.
    const first = mount(10);
    first.body.scrollTop = 345;
    fireEvent.scroll(first.body);
    first.view.unmount();
    expect(stored()).toBe("345");

    const back = mount(10);
    expect(back.body.scrollTop).toBe(345);
    fireEvent.wheel(back.body);
    back.body.scrollTop = 0;
    fireEvent.scroll(back.body);
    expect(stored()).toBe("0");

    // Nothing may pull the reader back to the old mark after they moved.
    grow(12);
    expect(back.body.scrollTop).toBe(0);
    back.view.unmount();
    expect(stored()).toBe("0");
  });

  it("KIN-CONTINUE-004 a reader's own touch drag to the top still wins over the remembered mark", () => {
    // A phone drag is taken over by the browser as a pan: it fires
    // `pointercancel` before the first scroll event, so the cancelled gesture
    // is the only movement signal the list gets. The top the reader reached
    // must not be read as the layout's clamp and snapped back to the mark.
    const first = mount(10);
    first.body.scrollTop = 345;
    fireEvent.scroll(first.body);
    first.view.unmount();
    expect(stored()).toBe("345");

    const back = mount(10);
    expect(back.body.scrollTop).toBe(345);
    fireEvent.pointerDown(back.body);
    fireEvent.pointerCancel(back.body);
    back.body.scrollTop = 0;
    fireEvent.scroll(back.body);
    expect(back.body.scrollTop).toBe(0);
    expect(stored()).toBe("0");

    // Nothing may pull the reader back to the old mark after they moved.
    grow(12);
    expect(back.body.scrollTop).toBe(0);
    back.view.unmount();
    expect(stored()).toBe("0");
  });
});
