// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { synthesizePhoneParent } from "./phoneDeepLinkParent";

type ListMarker = { token: string; parentIdx: number | null };

/** The marker React Router will read as this entry's location state (`usr`). */
function markerAtCurrentEntry(): ListMarker | undefined {
  const usr = (window.history.state as { usr?: { kinListParent?: ListMarker } } | null)?.usr;
  return usr?.kinListParent;
}

function recordedLists(): Record<string, { idx: number | null; url: string }> {
  return JSON.parse(window.sessionStorage.getItem("kin.listParents") ?? "{}");
}

function here(): string {
  return window.location.pathname + window.location.search;
}

async function backTo(url: string, idx: number): Promise<void> {
  window.history.back();
  await waitFor(() => expect(here()).toBe(url));
  expect((window.history.state as { idx?: number }).idx).toBe(idx);
}

/** KIN-CONTINUE-002, step 4 / NAVIGATION R7: a cold deep-linked pushed screen
 * comes back to the list. Phone roots are equal peers, including cold ones.
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
  it("keeps every root at the cold launch depth, with no invented list parent", () => {
    for (const path of ["/routines", "/agents", "/settings", "/sessions?scope=archived"]) {
      window.history.replaceState({ idx: 0, key: "seed" }, "", path);
      expect(synthesizePhoneParent()).toBe(false);
      expect(window.location.pathname + window.location.search).toBe(path);
      expect((window.history.state as { idx?: number }).idx).toBe(0);
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

  it("leaves the list and start route alone", () => {
    window.history.replaceState({ idx: 0 }, "", "/sessions?search=alpha");
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

  it("keeps the hash on a detail it re-pushes", () => {
    window.history.replaceState({ idx: 0 }, "", "/tasks/example#run-now");
    expect(synthesizePhoneParent()).toBe(true);
    expect(window.location.hash).toBe("#run-now");
    expect(window.location.pathname).toBe("/tasks/example");
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

/** KIN-RESULT-002's history queue: the file came from a conversation, so Back
 *  from the file detail must stop at the file list and then at that
 *  conversation before the list. A cold launch only has the address to go on,
 *  so the queue is synthesized before the router mounts. */
describe("the phone's cold files deep link", () => {
  it("a cold file deep link gets the conversation and the file list beneath it", async () => {
    window.history.replaceState(
      { idx: 0, key: "seed" },
      "",
      "/tasks/example?panel=files&file=notes.md",
    );
    expect(synthesizePhoneParent()).toBe(true);
    // The address the reader opened is still the top entry.
    expect(here()).toBe("/tasks/example?panel=files&file=notes.md");
    expect((window.history.state as { idx?: number }).idx).toBe(3);

    await backTo("/tasks/example?panel=files", 2);
    await backTo("/tasks/example", 1);
    // The marker sits on the conversation — the entry directly above the list
    // — and names the depth it was minted for; the panel entries above it are
    // ordinary pushes, so a push from the conversation still has a list parent.
    const marker = markerAtCurrentEntry();
    expect(marker?.parentIdx).toBe(0);
    expect(recordedLists()[marker!.token]).toEqual({ idx: 0, url: "/sessions" });

    await backTo("/sessions", 0);
  });

  it("a cold file-list deep link gets the conversation beneath it", async () => {
    window.history.replaceState({ idx: 0, key: "seed" }, "", "/tasks/example?panel=files");
    expect(synthesizePhoneParent()).toBe(true);
    expect(here()).toBe("/tasks/example?panel=files");
    expect((window.history.state as { idx?: number }).idx).toBe(2);
    // The list itself is not marked as the list's child; the conversation
    // below it is.
    expect(markerAtCurrentEntry()).toBeUndefined();

    await backTo("/tasks/example", 1);
    expect(markerAtCurrentEntry()?.parentIdx).toBe(0);
    await backTo("/sessions", 0);
  });

  it("a conversation deep link still gets one list parent", async () => {
    window.history.replaceState({ idx: 0, key: "seed" }, "", "/tasks/example");
    expect(synthesizePhoneParent()).toBe(true);
    expect((window.history.state as { idx?: number }).idx).toBe(1);
    expect(markerAtCurrentEntry()?.parentIdx).toBe(0);
    await backTo("/sessions", 0);
  });

  it("keeps a non-workspace deep link at one parent", async () => {
    window.history.replaceState({ idx: 0, key: "seed" }, "", "/tasks/example?focus=appr-1");
    expect(synthesizePhoneParent()).toBe(true);
    expect((window.history.state as { idx?: number }).idx).toBe(1);
    await backTo("/sessions", 0);
  });

  it("does not read a workspace-shaped query on another route as the files panel", async () => {
    window.history.replaceState(
      { idx: 0, key: "seed" },
      "",
      "/projects/p1?panel=files&file=notes.md",
    );
    expect(synthesizePhoneParent()).toBe(true);
    expect((window.history.state as { idx?: number }).idx).toBe(1);
    await backTo("/sessions", 0);
  });

  it("leaves a Mac's file deep link as ordinary history", () => {
    viewport(true);
    window.history.replaceState(
      { idx: 0, key: "seed" },
      "",
      "/tasks/example?panel=files&file=notes.md",
    );
    expect(synthesizePhoneParent()).toBe(false);
    expect((window.history.state as { idx?: number }).idx).toBe(0);
  });

  it("leaves a file deep link with history behind it alone", () => {
    window.history.replaceState(
      { idx: 2, key: "from-app" },
      "",
      "/tasks/example?panel=files&file=notes.md",
    );
    expect(synthesizePhoneParent()).toBe(false);
    expect((window.history.state as { idx?: number }).idx).toBe(2);
  });
});
