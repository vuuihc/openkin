// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_DEADLINE_MS,
  RELOAD_STAMP_KEY,
  RELOAD_WINDOW_MS,
  bootVerdict,
  installBootGuard,
} from "./bootGuard";

/**
 * R-boot-guard: the splash waits a bounded time, retries once, then hands the
 * decision to the person.
 *
 * These cases drive the real wiring — a real jsdom document, real timers
 * (faked at the clock), real `sessionStorage` — because the defect they guard
 * against was not a wrong return value, it was a page that never did anything.
 * `reload` is the one injected function: jsdom reports navigation as not
 * implemented, and replacing it is also what lets "exactly once" be counted.
 *
 * The module is imported with an empty body, so its auto-arm condition (the
 * splash is present) is false and no guard is installed behind a test's back.
 */

const NOW = new Date("2026-11-20T15:00:00Z").getTime();

/** The document as it reaches a phone before React mounts. */
function splash(): void {
  document.body.innerHTML = [
    '<div id="root">',
    '  <div class="kin-boot" aria-hidden="true">',
    '    <div class="kin-ios-spinner"><span class="kin-ios-spoke"></span></div>',
    "  </div>",
    "</div>",
  ].join("");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sessionStorage.clear();
  document.documentElement.lang = "zh-Hans";
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.lang = "zh-Hans";
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("bootVerdict", () => {
  it("waits until the deadline and never acts on a mounted console", () => {
    expect(bootVerdict({ mounted: false, elapsedMs: 0, attempts: 0 })).toBe("wait");
    expect(bootVerdict({ mounted: false, elapsedMs: BOOT_DEADLINE_MS - 1, attempts: 0 })).toBe(
      "wait",
    );
    expect(bootVerdict({ mounted: false, elapsedMs: BOOT_DEADLINE_MS, attempts: 0 })).toBe(
      "reload",
    );
    // Mounted outranks everything: a console that booted has nothing to do,
    // however long it took.
    expect(bootVerdict({ mounted: true, elapsedMs: BOOT_DEADLINE_MS * 10, attempts: 0 })).toBe(
      "wait",
    );
  });

  it("degrades to the manual state once the automatic retry is spent", () => {
    expect(bootVerdict({ mounted: false, elapsedMs: BOOT_DEADLINE_MS, attempts: 1 })).toBe(
      "manual",
    );
    expect(bootVerdict({ mounted: false, elapsedMs: BOOT_DEADLINE_MS, attempts: 2 })).toBe(
      "manual",
    );
  });
});

describe("installBootGuard", () => {
  it("reloads exactly once, at the deadline, while the splash is still up", () => {
    splash();
    const reload = vi.fn();
    installBootGuard({ reload });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS - 1);
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_STAMP_KEY)).toBe(String(NOW + BOOT_DEADLINE_MS));

    // The page is on its way out: the spent guard must not stack a second
    // reload on top of the first.
    vi.advanceTimersByTime(RELOAD_WINDOW_MS * 2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers a focusable Reload button on the second deadline instead of reloading", () => {
    splash();
    // The stamp the first automatic reload left behind.
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(NOW - 5_000));
    const reload = vi.fn();
    installBootGuard({ reload });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(reload).not.toHaveBeenCalled();
    const button = document.querySelector<HTMLButtonElement>(".kin-boot button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("重新加载");
    // The same wheel stays: the screen still reads as waiting, not as an error
    // page, and the button is the only thing that changed.
    expect(document.querySelector(".kin-boot .kin-ios-spinner")).not.toBeNull();
    // The splash's `aria-hidden` would hide the failure state's one action from
    // assistive technology; the words are the point of this screen.
    expect(document.querySelector(".kin-boot")?.getAttribute("aria-hidden")).toBeNull();
    expect(document.querySelector(".kin-ios-spinner")?.getAttribute("aria-hidden")).toBe("true");

    button?.focus();
    expect(document.activeElement).toBe(button);

    // And it is the person's click that reloads, exactly once.
    button?.click();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RELOAD_WINDOW_MS * 2);
    expect(document.querySelectorAll(".kin-boot button")).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when React replaces the splash before the deadline", () => {
    splash();
    const reload = vi.fn();
    installBootGuard({ reload });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS / 2);
    // React's mount: `createRoot(...).render()` replaces the splash.
    document.querySelector("#root")?.replaceChildren();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS * 3);
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector(".kin-boot")).toBeNull();
    expect(document.querySelector(".kin-boot button")).toBeNull();
    // A healthy boot leaves no stamp behind, so the next open is a first open.
    expect(sessionStorage.getItem(RELOAD_STAMP_KEY)).toBeNull();
  });

  it("does not reload again on a second open inside the 30 s window", () => {
    splash();
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(NOW - 5_000));
    const reload = vi.fn();
    installBootGuard({ reload });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector(".kin-boot button")).not.toBeNull();
  });

  it("retries again once the stamp is older than the window", () => {
    splash();
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(NOW - RELOAD_WINDOW_MS - 1));
    const reload = vi.fn();
    installBootGuard({ reload });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_STAMP_KEY)).toBe(String(NOW + BOOT_DEADLINE_MS));
  });

  it("speaks the document's language on the manual surface", () => {
    document.documentElement.lang = "en";
    splash();
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(NOW));
    installBootGuard({ reload: vi.fn() });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(document.querySelector(".kin-boot-note")?.textContent).toBe(
      "The network is slow — reload to try again.",
    );
    expect(document.querySelector(".kin-boot button")?.textContent).toBe("Reload");
  });

  it("tells a Chinese reader the retry is over and asks for a reload", () => {
    document.documentElement.lang = "zh-Hans";
    splash();
    // The automatic retry is spent, so this screen is the only move left.
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(NOW));
    installBootGuard({ reload: vi.fn() });

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    // The line must ask for the reload, not claim a retry is still running:
    // nothing is retrying once this state is on screen.
    expect(document.querySelector(".kin-boot-note")?.textContent).toBe("网络有点慢，请重新加载");
    expect(document.querySelector(".kin-boot button")?.textContent).toBe("重新加载");
  });
});
