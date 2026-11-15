// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { synthesizePhoneParent } from "./phoneDeepLinkParent";

/** The signed route/parent table (`ux-unification-story-map.md`): a cold
 *  deep-linked pushed screen comes back to the parent the table names, and a
 *  true area root synthesizes nothing. A conversation's deep link still comes
 *  back to the list (KIN-CONTINUE-002, step 4); the other parents are
 *  KIN-CONTINUE-003, stack rules 2 and 4.
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

function markerRoot(): string | null {
  const usr = (window.history.state as { usr?: Record<string, unknown> } | null)?.usr;
  const marker = usr?.kinListParent as { rootUrl?: string } | undefined;
  return marker?.rootUrl ?? null;
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
  it("cold start synthesizes the parent the signed table names", () => {
    const cases: Array<[string, string]> = [
      ["/tasks/task-1", "/sessions"],
      ["/inbox?focus=appr-1", "/sessions?focus=appr-1"],
      ["/agent-sessions/session-1", "/sessions"],
      ["/projects/p1", "/projects"],
      ["/machines/node-1/tasks/task-1", "/routines?device=node-1"],
      ["/settings?tab=providers", "/settings"],
      ["/agents", "/settings?tab=operations"],
      ["/usage", "/settings?tab=operations"],
    ];
    for (const [url, parent] of cases) {
      window.history.replaceState({ idx: 0, key: "seed" }, "", url);
      expect(synthesizePhoneParent(), url).toBe(true);
      // The deep link itself stays in front; its parent is one entry below.
      expect(window.location.pathname + window.location.search, url).toBe(url);
      expect((window.history.state as { idx?: number }).idx, url).toBe(1);
      expect(markerRoot(), url).toBe(parent);
    }
  });

  it("a root has no synthetic parent", () => {
    for (const url of [
      "/sessions",
      "/projects",
      "/routines",
      "/settings",
      "/settings?tab=general",
      "/sessions?scope=archived",
      "/",
    ]) {
      window.history.replaceState({ idx: 0, key: "seed" }, "", url);
      expect(synthesizePhoneParent(), url).toBe(false);
      expect(window.location.pathname + window.location.search, url).toBe(url);
      expect((window.history.state as { idx?: number }).idx, url).toBe(0);
    }
  });

  it("gives a cold conversation a real list parent", async () => {
    window.history.replaceState({ idx: 0, key: "seed" }, "", "/tasks/example");
    expect(synthesizePhoneParent()).toBe(true);
    expect(window.history.state.idx).toBe(1);
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
  });

  it("does nothing when the app already has history behind it", () => {
    window.history.replaceState({ idx: 1, key: "from-app" }, "", "/routines");
    expect(synthesizePhoneParent()).toBe(false);
    expect(window.location.pathname).toBe("/routines");
    expect((window.history.state as { idx?: number }).idx).toBe(1);
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

  it("keeps the hash on a detail it re-pushes", () => {
    window.history.replaceState({ idx: 0 }, "", "/tasks/example#run-now");
    expect(synthesizePhoneParent()).toBe(true);
    expect(window.location.hash).toBe("#run-now");
    expect(window.location.pathname).toBe("/tasks/example");
    expect(markerRoot()).toBe("/sessions");
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
