// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { synthesizePhoneParent } from "./phoneDeepLinkParent";

/**
 * KIN-CONTINUE-002, step 4 / NAVIGATION R7: a cold deep link must come back to
 * the list, including through the system Back the app cannot intercept after
 * the fact.
 */

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  viewport(false);
  window.history.replaceState({ idx: 0, key: "seed" }, "", "/routines");
});

afterEach(() => {
  window.history.replaceState({ idx: 0 }, "", "/");
  vi.unstubAllGlobals();
});

describe("the phone's cold deep link", () => {
  it("gets the list as a real parent entry", async () => {
    expect(synthesizePhoneParent()).toBe(true);
    expect(window.location.pathname).toBe("/routines");
    expect((window.history.state as { idx?: number }).idx).toBe(1);

    window.history.back();

    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
  });

  it("does nothing when the app already has history behind it", () => {
    window.history.replaceState({ idx: 1, key: "from-app" }, "", "/routines");
    expect(synthesizePhoneParent()).toBe(false);
    expect(window.location.pathname).toBe("/routines");
    expect((window.history.state as { idx?: number }).idx).toBe(1);
  });

  it("leaves the list and the start route alone", () => {
    window.history.replaceState({ idx: 0 }, "", "/sessions");
    expect(synthesizePhoneParent()).toBe(false);
    window.history.replaceState({ idx: 0 }, "", "/");
    expect(synthesizePhoneParent()).toBe(false);
  });

  it("does nothing on the Mac layout", () => {
    viewport(true);
    expect(synthesizePhoneParent()).toBe(false);
    expect((window.history.state as { idx?: number }).idx).toBe(0);
  });

  it("falls back to the wide layout when matchMedia is missing", () => {
    // An embedder without matchMedia must boot, not throw; `useMinWidth` uses
    // the same fallback.
    vi.stubGlobal("matchMedia", undefined);
    expect(synthesizePhoneParent()).toBe(false);
  });

  it("keeps the hash on the screen it re-pushes", () => {
    window.history.replaceState({ idx: 0 }, "", "/routines#run-now");
    expect(synthesizePhoneParent()).toBe(true);
    expect(window.location.hash).toBe("#run-now");
    expect(window.location.pathname).toBe("/routines");
  });

  it("is actually installed before the router mounts", () => {
    // Without the call, a cold deep link silently loses its parent again while
    // every unit test above still passes.
    const ui = existsSync(join(process.cwd(), "src/pages"))
      ? process.cwd()
      : join(process.cwd(), "ui");
    const main = readFileSync(join(ui, "src/main.tsx"), "utf8");
    const call = main.indexOf("synthesizePhoneParent()");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(main.indexOf("createRoot(root).render"));
  });
});
